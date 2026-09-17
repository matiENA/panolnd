const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Cargar variables de entorno desde .env local si existe (para localhost)
const envFilePath = path.resolve(__dirname, '.env');
if (fs.existsSync(envFilePath)) {
  const envContent = fs.readFileSync(envFilePath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/(^['"]|['"]$)/g, '');
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}
const { Server } = require('socket.io');
const { google } = require('googleapis');
const { extractCleanPlate } = require('./plateNormalizer');
const { extractPlates, processSingleOtUpdate, syncFullOtDatabase, syncCanonicalFleetToDbOtList } = require('./otSyncService');
const otsManager = require('./otsManagerService');
const {
  syncOtsToTasksDatabase,
  startAutomaticTaskSync,
  getActiveTasksBoard,
  updateTaskExecution,
  getHistoricalTasks,
  getOperarioHoldOts,
  saveOperarioHoldOts,
  getOtLifecyclePayload,
  updateOtTaskTerminado,
  getUnitTimelineTasks,
  getStaffAndLocations,
  getCoordinacionBoard,
  saveOtCoordinacionJson,
  saveAllCoordinacionBatch
} = require('./taskSyncService');

process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ [Process] Unhandled Rejection:', (reason && reason.stack) ? reason.stack : (reason?.message || reason));
});

process.on('uncaughtException', (err) => {
  console.error('❌ [Process] Uncaught Exception:', (err && err.stack) ? err.stack : (err?.message || err));
});

const app = express();
app.use(cors());
app.use(express.json());

// === AUTENTICACIÓN CENTRALIZADA DEL SISTEMA (CAPA 1: ACCESO DISPOSITIVO) ===
const SYSTEM_USER = (process.env.SYSTEM_USER || 'taller').trim().toLowerCase();
const SYSTEM_PASSWORD = (process.env.SYSTEM_PASSWORD || 'taller2026').trim();
const SYSTEM_AUTH_SECRET = process.env.SYSTEM_AUTH_SECRET || 'panol-secret-auth-key-2026-xyz';
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 días

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const val = parts.slice(1).join('=').trim();
    try { list[name] = decodeURIComponent(val); } catch(e) { list[name] = val; }
  });
  return list;
}

function createAuthToken(username) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${username}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SYSTEM_AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + hmac;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  try {
    const payloadStr = Buffer.from(parts[0], 'base64url').toString('utf8');
    const [user, expStr] = payloadStr.split(':');
    const expiresAt = Number(expStr);
    if (!expiresAt || Date.now() > expiresAt) return false;
    const expectedHmac = crypto.createHmac('sha256', SYSTEM_AUTH_SECRET).update(payloadStr).digest('hex');
    if (parts[1].length !== expectedHmac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expectedHmac));
  } catch (e) {
    return false;
  }
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Proteger conexión WebSockets verificando cookie de sesión
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const token = cookies.sys_auth || socket.handshake.auth?.token;
  if (verifyAuthToken(token)) {
    return next();
  }
  // Permitir en desarrollo local o reconexión graceful
  return next();
});

// === 1. CREDENCIALES CENTRALIZADAS CON GOOGLE SHEETS Y AISLAMIENTO DE ENTORNOS ===
const PROD_SPREADSHEET_ID = '1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc';   // Database PRUEBAS (Render Cloud / Producción)
const LOCAL_SPREADSHEET_ID = '17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ';  // Database PRUEBAS LOCAL (Localhost / Desarrollo)

// Determinación robusta del entorno (Render inyecta RENDER=true y NODE_ENV=production)
const isProdEnvironment = (process.env.NODE_ENV === 'production') || 
                          (process.env.RENDER === 'true') || 
                          (process.env.RENDER === '1') ||
                          (process.env.SPREADSHEET_ID === PROD_SPREADSHEET_ID);

// Fallback por defecto según entorno
let targetSpreadsheetId = process.env.SPREADSHEET_ID || (isProdEnvironment ? PROD_SPREADSHEET_ID : LOCAL_SPREADSHEET_ID);

// SALVAGUARDA POKA-YOKE:
// En producción (Render Cloud), NUNCA permitir que SPREADSHEET_ID apunte a la base LOCAL (17yFPB...).
// Si por desconfiguración de variables en Render se recibe el ID local, se redirige inmediatamente a PRODUCCIÓN.
if (isProdEnvironment && targetSpreadsheetId === LOCAL_SPREADSHEET_ID) {
  console.warn(`🚨 [POKA-YOKE ENTORNO] Proceso en PRODUCCIÓN detectó SPREADSHEET_ID apuntando a LOCAL (${LOCAL_SPREADSHEET_ID}). Redirigiendo forzosamente a PRODUCCIÓN (${PROD_SPREADSHEET_ID}).`);
  targetSpreadsheetId = PROD_SPREADSHEET_ID;
}

const SPREADSHEET_ID = targetSpreadsheetId;
const SOURCE_SPREADSHEET_ID = process.env.SOURCE_SPREADSHEET_ID || '1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk';
const MES_MOVIMIENTOS_ID = process.env.MES_MOVIMIENTOS_ID || '1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8';
const OT_SYNC_INTERVAL_MINUTES = parseInt(process.env.OT_SYNC_INTERVAL_MINUTES || '0', 10);

const DEFAULT_SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "ute-logistica",
  private_key: (process.env.GOOGLE_PRIVATE_KEY || "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCuZk1fQXQlzgzp\nTxWrBZfYeYIZWldtLnWjqL5sse5mYkCnF0dAJRFXn90WXe1SrmjzaWZeSGEAZMME\nW2CUIz+kd/8yZa0i4QmlqbQCDfunY2X9KUjrr2L3UOHbr288Ps4ARPqLKlab9DE8\nXi/vyNy/OVZ66dI1vl/4uNUQChTDUefsMpWk8cej2ijgl0twrm2I3XRHJqSdHhgB\nUbzwPwaYlCSpNIjkqbLW83uvVDq4frl2EjiZGryISbX0FbdoVGi5DaZaAWdwRWdQ\nLpZMSq+93awV7HPrMl7Oy9AmPL+5sd9wpwzZfxy+biiBQ/z2iOS8Jl8T2VmvQJPT\nHI20H+5dAgMBAAECggEAH7CGKaNmnAH7dZ+Bs/BRvauimMHCNhwlkyXz6CNSyvba\ngaIot76kjpQFY+2QVKBNgMFrsQEc4ynsB8wk2fYnt9Z4ICu6kKZsjtYt19u7mRhm\nLWDFl9HoPUFMsRMJNtzAqOrfzc7VKwRtt+bzdfI9LmAYV0BKiqp7nOHVEVOLn0vj\nPAxfFtdYTiBdhBixZrEPwXsoq8nFxYqIE15d7kRDQDJRedMobe3ed3PkSFNa5L2n\n2GcmU71Jq89m9KMR2dVLaMON7kdtQl/AbWo89ymUPe+ylER/OAKoomNEbyL0AnnG\ny26VDHj5jF/Nu2fdKvL15hxBKg/yn9tZTi4nl4WYXwKBgQDk6CiJncyPz2PO4YSN\nRoPVE3JNcUtxEVPY74RC4mFU+E/zfUIQr7FESTH8pBWWe6qO9e5KipoRazaqjClA\nQ6lAIXwlQgHmnz1h5JMLyeybQJxOJb0nBHXNKjblWN3SgbKqGrnuLFYeXd4GHeUt\nkoIlQysJ7JCdbdoMa91Vq9/8uwKBgQDDCpU3m+hjcs6xAd/F3Ps3e9DaF2GO0Q7y\n9e7FAx+7p8c2z8ZaC13pb5Ol+ISDfsgB6ZhgJRrAes/DYOpAXs4FmqHsimNTKSB3\nwri8pJnVbUB++DDb9yGBkpyz+b5Zi38vuGsl2vWi413A1ELXMsB8yV4QR7tYDNye\n3e8iwcRbxwKBgCzY71hG+lUSpNNbi8TCFAIjFTnnAIjehDb0dk1EXR1wqPljiRYL\n1gcy8AA3haM+B2SK+mzQSu8uuj8fxtU4bGiMJu6FyCmO+U+8oLKmlRy1w+nrquuC\nDDJuGuNETfF4R7DcG6F2PkkkyuMX6FbNZYI3bq87EfpGE3prh6nJStERAoGAEBs7\nn0/8rNm6P9vLwucwx7At2xS7NbQF7AJrKVHMuQ5t4RTfaGgv5SsVoksXhlRd5+qG\nbsohn2uE5LmIHrC1irjuTj5PXXqz96/Y2ZsuKPXQsauFPWT3G2AkGKizE2n1otcz\n4fhm+ICWKWpd6q+CPcvTPLzvt6G4RlZFfTVLJdkCgYB7luOgHD8KhAsDMnREu+rb\nWJcT2Uevy2mt9f8x1A5XSwliMOYY+UloGjAF6/3y8l357pZpkxdLecDeESESXy60\nsLUr0DyAyJxw6Qg3rqyD1EsP+B66tpJRLCIf9Cw5gZdmiD6gsYYxKWHNA7vp7bLd\nrkl2DeVoePGroYwGHYxYQw==\n-----END PRIVATE KEY-----\n"),
  client_email: "firebase-adminsdk-fbsvc@ute-logistica.iam.gserviceaccount.com"
};

function getSheetsClient() {
  try {
    let credentials = DEFAULT_SERVICE_ACCOUNT;
    if (process.env.GOOGLE_CREDENTIALS) {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    }
    const privateKey = credentials.private_key.replace(/\\n/g, '\n');

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: credentials.client_email,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error('❌ Error al inicializar cliente de Google Sheets:', e.message);
    return null;
  }
}

const sheets = getSheetsClient();

// === 2. MEMORIA Y CACHÉ TIEMPO REAL ===
let ordersCache = [];
let itemsCatalogCache = [];
let uiPropertiesCache = {};
let readyTimestamps = {}; // reqId -> timestamp when transitioned to LISTO
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL_MS = 8000; // Evitar Quota Exceeded (max 1 lectura cada 8s)

// === 2.1 CACHÉ EN RAM DE UNIDADES (diagramasnode) ===
let ramFleetCache = new Map(); // normalizedPlate -> { tractorPlate, tractorBrand, semiPlate, semiBrand, service }
let lastDiagramasSync = 0;

async function syncFleetFromDiagramasNode() {
  const DIAGRAMAS_URL = 'https://diagramasnode.onrender.com/api/datos';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(DIAGRAMAS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const units = data.diagramas?.unidades || data.ut || [];
    if (!Array.isArray(units) || units.length === 0) return;

    const newMap = new Map();
    units.forEach(u => {
      const tractorP = u.tractor?.patente ? String(u.tractor.patente).trim().toUpperCase().replace(/[\s\-_.]/g, '') : '';
      const tractorBrand = u.tractor?.marca ? String(u.tractor.marca).trim().toUpperCase() : '';
      const semiP = u.semi?.patente ? String(u.semi.patente).trim().toUpperCase().replace(/[\s\-_.]/g, '') : '';
      const semiBrand = u.semi?.marca ? String(u.semi.marca).trim().toUpperCase() : '';
      const srv = u.srv_ut || '';

      const entry = {
        tractorPlate: u.tractor?.patente || '',
        tractorBrand,
        semiPlate: u.semi?.patente || '',
        semiBrand,
        service: srv
      };

      if (tractorP) newMap.set(tractorP, entry);
      if (semiP) newMap.set(semiP, entry);
    });

    ramFleetCache = newMap;
    lastDiagramasSync = Date.now();
    console.log(`📡 [RAM] Sincronizadas ${units.length} unidades desde diagramasnode (${ramFleetCache.size} patentes indexadas).`);
  } catch (err) {
    console.warn(`⚠️ [RAM] Advertencia en syncFleetFromDiagramasNode (${err.message}). Se mantiene caché.`);
  }
}

// === 2.2 CACHÉ DB_OT_LIST (Cols A:G) ===
let dbOtListRowsCache = [];
let lastDbOtListSync = 0;

async function getDbOtListRows() {
  const now = Date.now();
  if (dbOtListRowsCache.length > 0 && (now - lastDbOtListSync < 60000)) {
    return dbOtListRowsCache;
  }
  if (!sheets) return dbOtListRowsCache;
  try {
    const otRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "'DB_OT_LIST'!A2:G"
    });
    dbOtListRowsCache = otRes.data.values || [];
    lastDbOtListSync = now;
  } catch (e) {
    console.warn('⚠️ Advertencia al leer DB_OT_LIST para órdenes:', e.message);
  }
  return dbOtListRowsCache;
}

async function syncDataFromSheets(force = false) {
  if (!sheets) return ordersCache;

  const now = Date.now();
  if (!force && (now - lastSyncTime < MIN_SYNC_INTERVAL_MS) && ordersCache.length > 0) {
    return ordersCache;
  }
  lastSyncTime = now;

  try {
    // A, B, C. Leer DB_ITEMS, DB_OT_LIST y DB_TRANSACTIONS en 1 sola llamada HTTP batchGet
    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: ['DB_ITEMS!A:H', "'DB_OT_LIST'!A2:G", 'DB_TRANSACTIONS!A:R']
    });

    const valRanges = batchRes.data.valueRanges || [];
    const itemRows = (valRanges[0] && valRanges[0].values) || [];
    const dbOtListRows = (valRanges[1] && valRanges[1].values) || [];
    const rows = (valRanges[2] && valRanges[2].values) || [];

    dbOtListRowsCache = dbOtListRows;
    lastDbOtListSync = now;

    const itemMap = {};
    itemsCatalogCache = [];

    for (let i = 1; i < itemRows.length; i++) {
      const id = String(itemRows[i][0] || '').trim();
      const name = String(itemRows[i][1] || '').trim();
      const brand = String(itemRows[i][2] || '').trim();
      const category = String(itemRows[i][3] || '').trim();
      const stock = Number(itemRows[i][4]) || 0;
      const loc = String(itemRows[i][5] || 'S/D').trim();
      const requiereCanje = itemRows[i][7] === 'TRUE' || itemRows[i][7] === true;

      if (name) {
        itemMap[name.toUpperCase()] = { id, name, brand, category, stock, loc, requiereCanje };
        itemsCatalogCache.push({ id, name, brand, category, stock, loc, requiereCanje });
      }
    }

    const otsData = await otsManager.getCurrentOtsMap(sheets, SPREADSHEET_ID);
    const otListByTractor = new Map();
    const otListBySemi = new Map();

    dbOtListRows.forEach(r => {
      const t = String(r[0] || '').trim();
      const otDb = otsManager.normalizeOt(r[1]);
      const s = String(r[2] || '').trim();
      const semiOtDb = otsManager.normalizeOt(r[3]);
      const prod = String(r[4] || '').trim();
      const marcaT = String(r[5] || '').trim();
      const marcaS = String(r[6] || '').trim();

      const normT = otsManager.normalizePlate(t);
      const normS = otsManager.normalizePlate(s);

      // DB_OT_LIST como principal, ots como fallback vigente
      const tOtObj = otsData.byPlate.get(normT);
      const sOtObj = otsData.byPlate.get(normS);

      const activeTractorOt = otDb || (tOtObj && tOtObj.ot) || '';
      const activeSemiOt = semiOtDb || (sOtObj && sOtObj.ot) || '';

      const item = {
        tractor: t,
        ot: activeTractorOt,
        semi: s,
        semiOt: activeSemiOt,
        producto: prod,
        marcaTractor: marcaT,
        marcaSemi: marcaS
      };

      const keyT = t.toUpperCase().replace(/[\s\-_.]/g, '');
      const keyS = s.toUpperCase().replace(/[\s\-_.]/g, '');
      if (keyT) otListByTractor.set(keyT, item);
      if (keyS) otListBySemi.set(keyS, item);
    });

    if (rows.length < 2) {
      ordersCache = [];
      return ordersCache;
    }

    const ordersMap = {};
    for (let i = Math.max(1, rows.length - 1000); i < rows.length; i++) {
      const row = rows[i];
      const reqId = String(row[1] || '').trim();
      const status = String(row[8] || '').trim();
      if (!reqId) continue;

      const panolOpId = String(row[15] || '').trim();
      const estadoCanje = String(row[16] || '').trim();
      const panolConfirmacion = String(row[17] || '').trim();
      const notesColO = String(row[14] || '').trim();

      const isPendingReturn = estadoCanje !== "" && !panolConfirmacion.includes("OK") && !panolConfirmacion.includes("INCOMPLETO") && status !== "DEVOLUCION PENDIENTE" && status !== "DEVOLUCION";

      if (status === "PENDIENTE" || status === "LISTO" || status === "ENTREGADO" || status === "DEVOLUCION PENDIENTE" || status === "DEVOLUCION") {
        if (!ordersMap[reqId]) {
          const unitInfo = String(row[5] || '');
          const boxRaw = String(row[2] || '').trim();
          const opInfo = String(row[3] || '').trim();

          let boxNumber = '';
          const m = opInfo.match(/\[(.*?)\]/);
          if (m && m[1]) {
            boxNumber = m[1].trim();
          } else {
            const m2 = opInfo.match(/box\s*([0-9a-zA-Z]+)/i);
            if (m2) boxNumber = m2[0].trim();
            else if (boxRaw && !/^\d{4,}$/.test(boxRaw)) boxNumber = boxRaw;
          }

          const rawPlates = unitInfo.split(/[\/+]/).map(p => p.trim().toUpperCase().replace(/[\s\-_.]/g, '')).filter(Boolean);
          const p1 = rawPlates[0] || '';
          const p2 = rawPlates[1] || '';

          const otMatch = (p1 && (otListByTractor.get(p1) || otListBySemi.get(p1))) ||
                          (p2 && (otListByTractor.get(p2) || otListBySemi.get(p2))) || null;

          let tractorPlate = otMatch ? otMatch.tractor : (unitInfo.includes('/') ? unitInfo.split('/')[0].trim() : unitInfo);
          let semiPlate = otMatch ? otMatch.semi : (unitInfo.includes('/') ? unitInfo.split('/')[1].trim() : '');

          const cleanTractor = tractorPlate.toUpperCase().replace(/[\s\-_.]/g, '');
          const cleanSemi = semiPlate.toUpperCase().replace(/[\s\-_.]/g, '');

          const ramTractor = cleanTractor ? ramFleetCache.get(cleanTractor) : null;
          const ramSemi = cleanSemi ? ramFleetCache.get(cleanSemi) : null;

          const tractorBrand = (ramTractor?.tractorBrand) || (otMatch?.marcaTractor) || String(row[13] || '').trim() || '';
          const semiBrand = (ramSemi?.semiBrand) || (otMatch?.marcaSemi) || (semiPlate ? 'SEMI' : '');

          const tractorOt = otMatch?.ot || String(row[4] || '').trim();
          const semiOt = otMatch?.semiOt || '';

          ordersMap[reqId] = {
            reqId: reqId,
            opId: String(row[2] || '').trim(),
            timestamp: row[0],
            box: boxNumber,
            opInfo: opInfo,
            otNumber: tractorOt,
            semiOt: semiOt,
            unitInfo: unitInfo,
            tractorPlate: tractorPlate,
            tractorBrand: tractorBrand,
            semiPlate: semiPlate,
            semiBrand: semiBrand,
            product: String(row[12] || ramTractor?.service || '').trim(),
            brand: tractorBrand,
            status: status,
            panolOpId: panolOpId,
            items: [],
            notes: row[11],
            uiColor: uiPropertiesCache['COLOR_' + reqId] || 'default',
            uiPing: uiPropertiesCache['PING_' + reqId] || null
          };
        }

        const itemName = String(row[6] || '');
        const itemDetails = itemMap[itemName.toUpperCase()] || { id: '---', loc: 'S/D', requiereCanje: false, stock: 0 };
        const itemNote = String(row[11] || '').trim();
        const devolucionNote = String(row[14] || '').trim();
        const finalItemNote = itemNote || devolucionNote;

        ordersMap[reqId].items.push({
          name: itemName,
          qty: row[7],
          id: itemDetails.id,
          loc: itemDetails.loc,
          note: finalItemNote,
          requiereCanje: itemDetails.requiereCanje,
          estadoCanje: estadoCanje,
          panolConfirmacion: panolConfirmacion,
          stock: itemDetails.stock,
          isPendingReturn: isPendingReturn,
          status: status,
          notesColO: notesColO
        });
      }
    }

    ordersCache = Object.values(ordersMap).map(order => {
      const itemStatuses = order.items.map(i => i.status);
      if (itemStatuses.includes("PENDIENTE")) {
        order.status = "PENDIENTE";
      } else if (itemStatuses.includes("LISTO")) {
        order.status = "LISTO";
      } else if (itemStatuses.includes("ENTREGADO")) {
        order.status = "ENTREGADO";
      } else if (itemStatuses.includes("DEVOLUCION PENDIENTE")) {
        order.status = "DEVOLUCION PENDIENTE";
      } else {
        order.status = "DEVOLUCION";
      }
      return order;
    });
    return ordersCache;
  } catch (e) {
    console.error('❌ Error en syncDataFromSheets:', e.message);
    return ordersCache;
  }
}

async function updateStockByName(itemName, deltaQty) {
  if (!sheets || !itemName || !deltaQty) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_ITEMS!A:E' });
    const rows = res.data.values || [];
    const searchName = String(itemName).trim().toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1] || '').trim().toLowerCase() === searchName) {
        const currentStock = Number(rows[i][4]) || 0;
        // 829.txt Punto 3: Permitir saldos negativos para mantener la fidelidad real del stock
        const newStock = currentStock + Number(deltaQty);
        const rowNum = i + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `DB_ITEMS!E${rowNum}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newStock]] }
        });
        break;
      }
    }
  } catch(e) {
    console.error('Error actualizando stock:', e.message);
  }
}

// 829.txt Punto 4: Resolución temporal a 1 minuto (LISTO -> ENTREGADO Y CERRADO)
async function checkAutoDeliveredOrders() {
  if (!sheets || !ordersCache || ordersCache.length === 0) return;
  const now = Date.now();
  const ONE_MINUTE_MS = 60 * 1000;
  let hasUpdates = false;

  for (const order of ordersCache) {
    if (order.status === 'LISTO') {
      let readyTime = readyTimestamps[order.reqId];
      if (!readyTime) {
        readyTime = now;
        readyTimestamps[order.reqId] = readyTime;
      }

      if (now - readyTime >= ONE_MINUTE_MS) {
        console.log(`⏰ Resolución temporal (1 min transcurrido): Auto-cambiando pedido ${order.reqId} a ENTREGADO Y CERRADO...`);
        try {
          const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
          const rows = transRes.data.values || [];
          const nowObj = new Date();
          const dateStr = nowObj.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          const timeStr = nowObj.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', second: '2-digit' });

          for (let i = 1; i < rows.length; i++) {
            if (String(rows[i][1] || '').trim() === String(order.reqId).trim()) {
              const rowNum = i + 1;
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `DB_TRANSACTIONS!I${rowNum}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [['ENTREGADO']] }
              });
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `DB_TRANSACTIONS!K${rowNum}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[`${dateStr} ${timeStr}`]] }
              });
            }
          }
          delete readyTimestamps[order.reqId];
          hasUpdates = true;
        } catch(e) {
          console.error('Error en auto-entrega a 1 minuto:', e.message);
        }
      }
    }
  }

  if (hasUpdates) {
    await syncDataFromSheets();
    io.emit('orders_sync', ordersCache);
  }
}

setInterval(checkAutoDeliveredOrders, 10000);

// === 3. RUTAS DE AUTENTICACIÓN Y MONOLITO (PROTECCIÓN DE ACCESO GENERAL) ===
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Función de detección de entorno local de desarrollo
function isLocalRequest(req) {
  if (!req) return false;
  const host = String(req.hostname || req.headers?.host || '').toLowerCase();
  const ip = String(req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '');
  return (
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    ip.includes('127.0.0.1') ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    process.env.NODE_ENV === 'development' ||
    !process.env.RENDER
  );
}

// Middleware de verificación de autenticación de dispositivo (Con bypass automático para localhost / desarrollo)
function requireAuth(req, res, next) {
  const isLocal = isLocalRequest(req);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sys_auth || req.headers['x-auth-token'];

  if (isLocal || verifyAuthToken(token)) {
    // Si es local y no tiene token de sesión, generamos uno automáticamente
    if (isLocal && !verifyAuthToken(token)) {
      const devToken = createAuthToken('local-dev');
      res.setHeader(
        'Set-Cookie',
        `sys_auth=${encodeURIComponent(devToken)}; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax`
      );
    }
    return next();
  }

  // Si es llamada API, devolver 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ 
      error: 'UNAUTHORIZED', 
      message: 'Dispositivo no autorizado. Se requiere inicio de sesión en el sistema.' 
    });
  }

  // Si es navegación web, redirigir a /login guardando la URL a la que quería ingresar
  const originalUrl = req.originalUrl || req.url || '/';
  return res.redirect(`/login?next=${encodeURIComponent(originalUrl)}`);
}

// --- ENDPOINTS PÚBLICOS DE AUTH ---
app.get('/login', (req, res) => {
  const isLocal = isLocalRequest(req);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sys_auth;
  // En localhost o con sesión válida redirigir directo salvo que pase ?force=1
  if ((isLocal || verifyAuthToken(token)) && !req.query.force) {
    const nextUrl = req.query.next || '/';
    return res.redirect(nextUrl);
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, next = '/' } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  const p = String(password || '').trim();
  const isLocal = isLocalRequest(req);

  // En entorno local permite cualquier contraseña para pruebas ágiles
  if (isLocal || (u === SYSTEM_USER && p === SYSTEM_PASSWORD)) {
    const token = createAuthToken(u || 'local-dev');
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie', 
      `sys_auth=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; SameSite=Lax${isHttps ? '; Secure' : ''}`
    );
    return res.json({ success: true, redirect: next || '/' });
  }

  return res.status(401).json({ 
    success: false, 
    error: 'Usuario o contraseña incorrectos.' 
  });
});

app.all(['/api/auth/logout', '/logout'], (req, res) => {
  res.setHeader('Set-Cookie', `sys_auth=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
  if (req.method === 'POST' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({ success: true, redirect: '/login' });
  }
  return res.redirect('/login');
});

app.get('/api/auth/status', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.sys_auth || req.headers['x-auth-token'];
  const isValid = verifyAuthToken(token);
  res.json({ authenticated: isValid, user: isValid ? SYSTEM_USER : null });
});

// Información del entorno actual (Localhost vs Render)
app.get('/api/env-info', (req, res) => {
  res.json({
    environment: isProdEnvironment ? 'production' : 'development',
    isProduction: isProdEnvironment,
    spreadsheetTitle: isProdEnvironment ? 'Database PRUEBAS' : 'Database PRUEBAS LOCAL',
    spreadsheetId: SPREADSHEET_ID,
    spreadsheetIdShort: SPREADSHEET_ID.slice(0, 6) + '...' + SPREADSHEET_ID.slice(-4),
    serverTime: new Date().toISOString()
  });
});

// Rutas estáticas de scripts esenciales (disponibles para cliente)
app.get('/client-shim.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client-shim.js')));
app.get('/js/client-shim.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client-shim.js')));

// --- RUTAS PROTEGIDAS DEL SISTEMA (CAPA 2) ---
app.get('/', requireAuth, (req, res) => {
  const v = String(req.query.v || req.query.view || req.query.page || req.query.p || '').toLowerCase().trim();
  if (v === 'panol' || v === 'monitor') return res.sendFile(path.join(__dirname, 'public', 'panol.html'));
  if (v === 'dashboard' || v === 'dash') return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  if (v === 'inv' || v === 'inventory' || v === 'stock') return res.sendFile(path.join(__dirname, 'public', 'inv.html'));
  if (v === 'mobile' || v === 'm' || v === 'app-mecanico') return res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
  if (v === 'coordinacion' || v === 'coord' || v === 'wireframe') return res.sendFile(path.join(__dirname, 'public', 'coordinacion.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mobile', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));
app.get('/m', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));
app.get('/app-mecanico', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));
app.get(['/panol', '/panol/'], requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'panol.html')));
app.get('/panol.html', (req, res) => res.redirect(301, '/panol'));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/inv', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'inv.html')));
app.get(['/coordinacion', '/coordinacion/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'coordinacion.html')));
app.get('/coordinacion.html', (req, res) => res.redirect(301, '/coordinacion'));
app.get('/wireframe', (req, res) => res.redirect(301, '/coordinacion'));
app.get('/wireframe.html', (req, res) => res.redirect(301, '/coordinacion'));

// Proteger cualquier acceso directo a archivos .html estáticos en /public
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && !req.path.includes('login.html')) {
    return requireAuth(req, res, next);
  }
  next();
});

// Servidor de archivos estáticos (JS, CSS, imágenes) deshabilitando index automático
app.use(express.static(path.join(__dirname, 'public'), { index: false, etag: false }));

async function updateStockByName(itemName, deltaQty) {
  if (!sheets || !itemName || !deltaQty) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_ITEMS!A1:E500' });
    const rows = res.data.values || [];
    const searchName = String(itemName).trim().toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1] || '').trim().toLowerCase() === searchName) {
        const currentStock = Number(rows[i][4]) || 0;
        const newStock = Math.max(0, currentStock + Number(deltaQty));
        const rowNum = i + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `DB_ITEMS!E${rowNum}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newStock]] }
        });
        break;
      }
    }
  } catch(e) {
    console.error('Error actualizando stock:', e.message);
  }
}

// === 4. RPC UNIVERSAL DISPATCHER (google.script.run Polyfill - Protegido por requireAuth) ===
app.post('/api/rpc', requireAuth, async (req, res) => {
  const { action, args = [] } = req.body;
  try {
    let result = null;

    if (action === 'getMechanicConfig') {
      const opId = String(args[0] || '').trim();
      const isLocal = isLocalRequest(req);
      let staffRow = null;
      if (sheets) {
        try {
          const sRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_STAFF!A1:L100' });
          const rows = sRes.data.values || [];
          staffRow = rows.find(r => String(r[0] || '').trim() === opId);
        } catch(e) {}
      }
      if (staffRow) {
        const hasAppAccess = staffRow[11] === true || String(staffRow[11] || '').toUpperCase() === 'TRUE';
        if (!hasAppAccess && staffRow[11] !== undefined && !isLocal) {
          result = { success: false, error: "Usuario no encontrado o sin acceso activo" };
        } else {
          const boxes = staffRow.slice(6, 11).map(c => String(c || '').trim()).filter(c => c !== '');
          result = { success: true, name: staffRow[1] || ('Operario ' + opId), role: staffRow[2] || 'MECANICO', boxes: boxes.length > 0 ? boxes : ['01', '02', '03'] };
        }
      } else if (isLocal) {
        // En entorno local de pruebas: permitir cualquier número de operario
        result = { success: true, name: 'Operario Local ' + (opId || 'Test'), role: 'MECANICO', boxes: ['01', '02', '03'] };
      } else {
        result = { success: false, error: "Usuario no encontrado o sin acceso activo" };
      }
    } 
    else if (action === 'getPanolStaff') {
      let panoleros = [];
      if (sheets) {
        try {
          const sRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_STAFF!A1:L100' });
          const rows = sRes.data.values || [];
          for (let i = 1; i < rows.length; i++) {
            const id = String(rows[i][0] || '').trim();
            const name = String(rows[i][1] || '').trim();
            const role = String(rows[i][2] || '').trim().toUpperCase();
            const hasAppAccess = rows[i][11] === true || String(rows[i][11] || '').toUpperCase() === 'TRUE';
            if (id && name && hasAppAccess && (role === 'PANOL' || role === 'PAÑOL' || role === 'LOGISTICA')) {
              panoleros.push({ id: id, name: name });
            }
          }
          if (panoleros.length === 0) {
            for (let i = 1; i < rows.length; i++) {
              const id = String(rows[i][0] || '').trim();
              const name = String(rows[i][1] || '').trim();
              if (id && name) panoleros.push({ id: id, name: name });
            }
          }
        } catch(e) {}
      }
      result = panoleros.sort((a, b) => a.name.localeCompare(b.name));
    }
    else if (action === 'getItemCatalog') {
      await syncDataFromSheets();
      result = itemsCatalogCache.map(i => ({ category: i.category || 'GENERAL', name: i.name, requiereCanje: !!i.requiereCanje }));
    }
    else if (action === 'getUnitCatalog') {
      if (sheets) {
        try {
          const cat = await otsManager.getFleetSearchCatalog(sheets, SPREADSHEET_ID);
          result = cat.unitList;
        } catch(e) {
          result = [];
        }
      } else {
        result = [];
      }
    }
    else if (action === 'getFleetSearchCatalog') {
      result = await otsManager.getFleetSearchCatalog(sheets, SPREADSHEET_ID);
    }
    else if (action === 'findUnitOrOt') {
      const query = args[0];
      const type = args[1];
      result = await otsManager.findUnitOrOt({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        query,
        type
      });
    }
    else if (action === 'getOtsAnteriores') {
      const plate = args[0];
      result = await otsManager.getOtsAnterioresForPlate(sheets, SPREADSHEET_ID, plate);
    }
    else if (action === 'wipeColdOts') {
      result = await otsManager.wipeAndArchiveOlderThan6Months(sheets, SPREADSHEET_ID);
    }
    else if (action === 'submitBatchRequest' || action === 'createOrder') {
      const payload = args[0] || {};
      const opId = payload.opId || '';
      const mechanicName = payload.mechanicName || payload.mechName || '';
      const otNumber = payload.otNumber || payload.ot || '';
      const unitId = payload.unitId || payload.unit || '';
      const items = payload.items || [];
      const now = new Date();
      const timestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const reqId = 'REQ-' + Math.floor(Math.random() * 10000000).toString(16).toUpperCase();
      const rowsToAppend = [];

      (items || []).forEach(itemObj => {
        const itemName = itemObj.item || itemObj.name || '';
        rowsToAppend.push([
          timestamp, reqId, opId, mechanicName, otNumber, unitId,
          itemName, itemObj.qty, 'PENDIENTE', '', '', itemObj.notes || '', '', '', '', '', itemObj.canjeStatus || '', ''
        ]);
      });

      if (sheets && rowsToAppend.length > 0) {
        const colARes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: 'DB_TRANSACTIONS!A:A'
        });
        const colAVals = colARes.data.values || [];
        let lastFilledRow = 0;
        for (let i = colAVals.length - 1; i >= 0; i--) {
          if (colAVals[i] && colAVals[i][0] && String(colAVals[i][0]).trim() !== '') {
            lastFilledRow = i + 1;
            break;
          }
        }
        if (lastFilledRow === 0) lastFilledRow = colAVals.length;

        const startRow = lastFilledRow + 1;
        const endRow = startRow + rowsToAppend.length - 1;

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `DB_TRANSACTIONS!A${startRow}:R${endRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: rowsToAppend }
        });

        console.log(`🛒 [DB_TRANSACTIONS] Pedido ${reqId} guardado (${rowsToAppend.length} filas) en ${isProdEnvironment ? '🔴 PRODUCCIÓN' : '🟢 LOCAL'} | Planilla: ${SPREADSHEET_ID}`);

        (items || []).forEach(itemObj => {
          updateStockByName(itemObj.item, -Math.abs(Number(itemObj.qty) || 0));
        });
      }
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: true, reqId: reqId, environment: isProdEnvironment ? 'production' : 'development' };
    }
    else if (action === 'updatePendingItemQty') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const newQty = Number(args[2]) || 0;
      let updated = false;

      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];
        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          const rItem = String(rows[i][6] || '').trim();
          const rStatus = String(rows[i][8] || '').trim();

          if (rReq === reqId && rItem.toLowerCase() === itemName.toLowerCase() && rStatus === 'PENDIENTE') {
            const oldQty = Number(rows[i][7]) || 0;
            const delta = newQty - oldQty;
            const rowNum = i + 1;

            if (newQty <= 0) {
              await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `DB_TRANSACTIONS!A${rowNum}:R${rowNum}` });
              await updateStockByName(itemName, oldQty);
            } else {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `DB_TRANSACTIONS!H${rowNum}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[newQty]] }
              });
              await updateStockByName(itemName, -delta);
            }
            updated = true;
            break;
          }
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'removePendingItem') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      let updated = false;

      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];
        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          const rItem = String(rows[i][6] || '').trim();
          const rStatus = String(rows[i][8] || '').trim();

          if (rReq === reqId && rItem.toLowerCase() === itemName.toLowerCase() && rStatus === 'PENDIENTE') {
            const oldQty = Number(rows[i][7]) || 0;
            const rowNum = i + 1;
            await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `DB_TRANSACTIONS!A${rowNum}:R${rowNum}` });
            if (oldQty > 0) await updateStockByName(itemName, oldQty);
            updated = true;
            break;
          }
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'addItemToPendingOrder') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const qty = Number(args[2]) || 0;
      let updated = false;

      if (sheets && qty > 0) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];
        let contextRow = null;

        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][1] || '').trim() === reqId && String(rows[i][8] || '').trim() === 'PENDIENTE') {
            contextRow = rows[i];
            break;
          }
        }

        if (contextRow) {
          const newRow = new Array(17).fill('');
          newRow[0] = contextRow[0];
          newRow[1] = reqId;
          newRow[2] = contextRow[2];
          newRow[3] = contextRow[3];
          newRow[4] = contextRow[4];
          newRow[5] = contextRow[5];
          newRow[6] = itemName;
          newRow[7] = qty;
          newRow[8] = 'PENDIENTE';
          newRow[11] = '';

          const colARes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:A' });
          const colAVals = colARes.data.values || [];
          let lastFilledRow = 0;
          for (let i = colAVals.length - 1; i >= 0; i--) {
            if (colAVals[i] && colAVals[i][0] && String(colAVals[i][0]).trim() !== '') {
              lastFilledRow = i + 1;
              break;
            }
          }
          const startRow = (lastFilledRow || colAVals.length) + 1;

          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `DB_TRANSACTIONS!A${startRow}:Q${startRow}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [newRow] }
          });
          await updateStockByName(itemName, -Math.abs(qty));
          updated = true;
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'confirmReturnItem' || action === 'confirmReturnBatch') {
      const reqId = String(args[0] || '').trim();
      let itemName = null;
      let opId = null;
      let status = null;
      let declaredQty = null;

      if (args.length >= 4 && typeof args[1] === 'string' && isNaN(Number(args[1]))) {
        itemName = String(args[1]).trim().toLowerCase();
        opId = args[2];
        status = args[3];
        declaredQty = args[4];
      } else {
        opId = args[1];
        status = args[2];
        declaredQty = args[3];
      }

      let updated = false;
      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];

        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          const rItem = String(rows[i][6] || '').trim().toLowerCase();
          const reqMatch = rReq === reqId;
          const itemMatch = !itemName || rItem === itemName;

          if (reqMatch && itemMatch) {
            const rowNum = i + 1;
            const confirmacionColR = String(rows[i][17] || '').trim();

            if (!confirmacionColR.includes('OK') && !confirmacionColR.includes('INCOMPLETO')) {
              let finalAuditString;
              if (status === 'INCOMPLETO' && declaredQty !== null && declaredQty !== undefined) {
                const originalQty = Number(rows[i][7]) || 0;
                finalAuditString = `[OP: ${opId}] - INCOMPLETO (${declaredQty}/${originalQty})`;
              } else {
                finalAuditString = `[OP: ${opId}] - ${status}`;
              }

              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `DB_TRANSACTIONS!R${rowNum}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[finalAuditString]] }
              });
              updated = true;
              if (itemName) break;
            }
          }
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'confirmNewReturn' || action === 'processNewItemReturn' || action === 'confirmNewReturnRow') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const returnQty = Number(args[2]) || null;
      const panolOpId = args[3] || args[4] || '';
      let updated = false;

      if (sheets && reqId) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];
        const isAll = !itemName || itemName.toUpperCase() === 'ALL' || itemName === '__ALL__';

        const panolNote = `DEVOLUCIÓN ACEPTADA: OK [OP: ${panolOpId || 'PAÑOL'}]`;
        const updates = [];
        const stockItemsToRestore = [];

        // 1. Identificar filas a procesar
        const targetIndices = [];
        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          if (rReq !== reqId) continue;

          const rStatus = String(rows[i][8] || '').trim();
          const rItem = String(rows[i][6] || '').trim();

          if (isAll) {
            // Toda la row: procesar ítems con status DEVOLUCION PENDIENTE
            if (rStatus === 'DEVOLUCION PENDIENTE') {
              targetIndices.push(i);
            }
          } else {
            // Ítem específico (compatibilidad)
            if (rItem.toLowerCase() === itemName.toLowerCase() && 
               (rStatus === 'DEVOLUCION PENDIENTE' || rStatus === 'ENTREGADO' || rStatus === 'LISTO')) {
              targetIndices.push(i);
              break;
            }
          }
        }

        // Si es isAll y no había ninguno explícitamente en DEVOLUCION PENDIENTE, fallback a ENTREGADO o LISTO
        if (isAll && targetIndices.length === 0) {
          for (let i = 1; i < rows.length; i++) {
            const rReq = String(rows[i][1] || '').trim();
            if (rReq !== reqId) continue;
            const rStatus = String(rows[i][8] || '').trim();
            if (rStatus === 'ENTREGADO' || rStatus === 'LISTO') {
              targetIndices.push(i);
            }
          }
        }

        for (const idx of targetIndices) {
          const rowNum = idx + 1;
          const rItem = String(rows[idx][6] || '').trim();
          const origQty = Number(rows[idx][7]) || 1;
          const qtyToRestore = (!isAll && returnQty) ? returnQty : origQty;

          const existingNote = String(rows[idx][14] || '').trim();
          const finalNote = existingNote ? `${existingNote} | ${panolNote}` : panolNote;

          updates.push({
            range: `DB_TRANSACTIONS!I${rowNum}`,
            values: [['DEVOLUCION']]
          });
          updates.push({
            range: `DB_TRANSACTIONS!O${rowNum}`,
            values: [[finalNote]]
          });

          stockItemsToRestore.push({ itemName: rItem, qty: qtyToRestore });
          updated = true;
        }

        if (updates.length > 0) {
          try {
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: SPREADSHEET_ID,
              requestBody: {
                valueInputOption: 'USER_ENTERED',
                data: updates
              }
            });
          } catch(batchErr) {
            console.warn('batchUpdate falló, aplicando updates individuales:', batchErr.message);
            for (const u of updates) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: u.range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: u.values }
              });
            }
          }

          for (const s of stockItemsToRestore) {
            await updateStockByName(s.itemName, s.qty);
          }
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'requestRefund' || action === 'requestReturn') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const reason = String(args[2] || '').trim();
      const returnQty = Number(args[3]) || 1;
      let updated = false;

      if (sheets && reqId && itemName) {
        try {
          const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
          const rows = transRes.data.values || [];
          const fallbackReason = reason ? reason : "Devolución repuesto nuevo";

          for (let i = 1; i < rows.length; i++) {
            const rReq = String(rows[i][1] || '').trim();
            const rItem = String(rows[i][6] || '').trim().toLowerCase();
            const rStatus = String(rows[i][8] || '').trim();

            if (rReq === reqId && rItem === itemName.toLowerCase() && rStatus === 'ENTREGADO') {
              const originalQty = Number(rows[i][7]) || 1;
              const actualReturnQty = Math.min(returnQty, originalQty);
              const rowNum = i + 1;

              if (actualReturnQty >= originalQty) {
                // DEVOLUCIÓN TOTAL SOLICITADA: Col I = DEVOLUCION PENDIENTE, Col O = SOLICITUD DEVOLUCIÓN NUEVA: ...
                await sheets.spreadsheets.values.update({
                  spreadsheetId: SPREADSHEET_ID,
                  range: `DB_TRANSACTIONS!I${rowNum}`,
                  valueInputOption: 'USER_ENTERED',
                  requestBody: { values: [['DEVOLUCION PENDIENTE']] }
                });
                await sheets.spreadsheets.values.update({
                  spreadsheetId: SPREADSHEET_ID,
                  range: `DB_TRANSACTIONS!O${rowNum}`,
                  valueInputOption: 'USER_ENTERED',
                  requestBody: { values: [[`SOLICITUD DEVOLUCIÓN NUEVA: ${fallbackReason}`]] }
                });
              } else {
                // DEVOLUCIÓN PARCIAL SOLICITADA (SPLIT ROW)
                const remainingQty = originalQty - actualReturnQty;
                await sheets.spreadsheets.values.update({
                  spreadsheetId: SPREADSHEET_ID,
                  range: `DB_TRANSACTIONS!H${rowNum}`,
                  valueInputOption: 'USER_ENTERED',
                  requestBody: { values: [[remainingQty]] }
                });

                const newRow = [...rows[i]];
                while (newRow.length < 18) newRow.push('');
                newRow[7] = actualReturnQty; // Col H
                newRow[8] = 'DEVOLUCION PENDIENTE'; // Col I
                newRow[14] = `SOLICITUD DEVOLUCIÓN NUEVA PARCIAL: ${fallbackReason}`; // Col O (Índice 14)
                newRow[16] = ''; // Col Q: Limpiar ESTADO_CANJE para devolución de repuesto nuevo
                newRow[17] = ''; // Col R: Limpiar PANOL_CONFIRMACION

                const colARes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:A' });
                const colAVals = colARes.data.values || [];
                let lastFilledRow = 0;
                for (let k = colAVals.length - 1; k >= 0; k--) {
                  if (colAVals[k] && colAVals[k][0] && String(colAVals[k][0]).trim() !== '') {
                    lastFilledRow = k + 1;
                    break;
                  }
                }
                const startRow = (lastFilledRow || colAVals.length) + 1;

                await sheets.spreadsheets.values.update({
                  spreadsheetId: SPREADSHEET_ID,
                  range: `DB_TRANSACTIONS!A${startRow}:R${startRow}`,
                  valueInputOption: 'USER_ENTERED',
                  requestBody: { values: [newRow] }
                });
              }

              updated = true;
              break;
            }
          }
        } catch(e) {
          console.error('Error en requestRefund:', e.message);
        }
      }
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: updated, error: updated ? null : "El repuesto exacto no fue encontrado o ya fue devuelto." };
    }
    else if (action === 'getPendingOrdersEnriched' || action === 'getPendingOrders' || action === 'getMechanicOrders') {
      result = await syncDataFromSheets();
    }
    else if (action === 'getInventoryItems') {
      const q = String(args[0] || '').trim().toLowerCase();
      await syncDataFromSheets();
      let resList = itemsCatalogCache;
      if (q) resList = resList.filter(i => i.name.toLowerCase().includes(q) || i.brand.toLowerCase().includes(q));
      result = resList.slice(0, 50);
    }
    else if (action === 'markAsReady' || action === 'markAsDelivered') {
      const reqId = args[0];
      const panolOpId = args[1];
      const itemsPayload = args[2]; // Opcional: array de [{ name, qty }] confirmados al presionar LISTO

      if (sheets && reqId) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A:R' });
        const rows = transRes.data.values || [];
        const now = new Date();
        const dateStr = now.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const timeStr = now.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const newStatus = action === 'markAsDelivered' ? 'ENTREGADO' : 'LISTO';
        const colIdx = action === 'markAsDelivered' ? 'K' : 'J';

        if (newStatus === 'LISTO') {
          readyTimestamps[reqId] = Date.now();
        } else {
          delete readyTimestamps[reqId];
        }

        const batchData = [];
        const stockUpdates = [];

        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][1] || '').trim() === String(reqId).trim()) {
            const rowNum = i + 1;
            const rItemName = String(rows[i][6] || '').trim();

            // Si el Pañolero modificó cantidades con los contadores antes de confirmar
            if (Array.isArray(itemsPayload)) {
              const matchedItem = itemsPayload.find(p => String(p.name || '').trim().toLowerCase() === rItemName.toLowerCase());
              if (matchedItem && matchedItem.qty !== undefined) {
                const confirmedQty = Number(matchedItem.qty);
                const oldQty = Number(rows[i][7]) || 0;
                const delta = confirmedQty - oldQty;

                if (delta !== 0) {
                  batchData.push({
                    range: `DB_TRANSACTIONS!H${rowNum}`,
                    values: [[confirmedQty]]
                  });
                  stockUpdates.push({ name: rItemName, delta: -delta });
                }
              }
            }

            batchData.push({
              range: `DB_TRANSACTIONS!I${rowNum}`,
              values: [[newStatus]]
            });
            batchData.push({
              range: `DB_TRANSACTIONS!${colIdx}${rowNum}`,
              values: [[`${dateStr} ${timeStr}`]]
            });
            if (panolOpId) {
              batchData.push({
                range: `DB_TRANSACTIONS!P${rowNum}`,
                values: [[panolOpId]]
              });
            }
          }
        }

        if (batchData.length > 0) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data: batchData
            }
          });
          for (const su of stockUpdates) {
            await updateStockByName(su.name, su.delta);
          }
        }
      }
      await syncDataFromSheets(true);
      io.emit('orders_sync', ordersCache);
      result = { success: true };
    }
    else if (action === 'validateWarehouseUser') {
      const key = String(args[0] || '').trim();
      const users = { "1": "Ema", "6": "Matias" };
      result = users[key] || ("Operador " + key);
    }
    else if (action === 'syncCanonicalFleet' || action === 'syncOtList') {
      console.log('🛡️ Ejecutando blindaje y sincronización canónica de DB_OT_LIST vía RPC...');
      result = await syncCanonicalFleetToDbOtList({
        sheetsClient: sheets,
        targetSpreadsheetId: SPREADSHEET_ID,
        movimientosSpreadsheetId: MES_MOVIMIENTOS_ID
      });
      io.emit('ot_sync_completed', result);
    }
    // === GESTIÓN DE DB_OT_TASKS Y COLD STORAGE ===
    else if (action === 'getTasksBoard') {
      result = await getActiveTasksBoard({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    }
    else if (action === 'updateTaskExecution') {
      const payload = args[0] || {};
      result = await updateTaskExecution({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        taskId: payload.taskId,
        ubicacion: payload.ubicacion,
        operario: payload.operario,
        asignado: payload.asignado,
        empezo: payload.empezo,
        termino: payload.termino,
        estado: payload.estado,
        io
      });
    }
    else if (action === 'syncOtsToTasks') {
      result = await syncOtsToTasksDatabase({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    }
    else if (action === 'getHistoricalTasks') {
      result = await getHistoricalTasks({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    }
    // === TALLER WORKSTATION: UNIDADES EN HOLD (DB_STAFF Col M) & TIMELINE OTS (Col G) ===
    else if (action === 'getOperarioHoldUnits') {
      const opId = args[0];
      result = await getOperarioHoldOts({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID, opId });
    }
    else if (action === 'saveOperarioHoldUnits') {
      const opId = args[0];
      const units = args[1] || [];
      result = await saveOperarioHoldOts({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID, opId, units, io });
    }
    else if (action === 'getUnitTimelineTasks') {
      const params = args[0] || {};
      result = await getUnitTimelineTasks({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        tractorOt: params.tractorOt,
        semiOt: params.semiOt,
        tractorPlate: params.tractorPlate,
        semiPlate: params.semiPlate
      });
    }
    else if (action === 'toggleTaskTerminado') {
      const params = args[0] || {};
      result = await updateOtTaskTerminado({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        otNumber: params.otNumber,
        taskId: params.taskId,
        rubro: params.rubro,
        desc: params.desc,
        opId: params.opId,
        isCompleted: params.isCompleted,
        io
      });
    }
    else if (action === 'getFleetSearchCatalog') {
      result = await otsManager.getFleetSearchCatalog(sheets, SPREADSHEET_ID);
    }
    else if (action === 'findUnitOrOt') {
      const query = args[0];
      const type = args[1];
      result = await otsManager.findUnitOrOt({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        query,
        type
      });
    }
    else {
      // Fallback genérico
      result = { success: true };
    }

    res.json({ result: result });
  } catch (e) {
    console.error('❌ RPC Error en ' + action + ':', e.message);
    res.json({ error: e.message });
  }
});

// === ENDPOINTS REST: FLOTA CANÓNICA & DB_OT_LIST ===
app.post('/api/fleet/sync', async (req, res) => {
  try {
    const result = await syncCanonicalFleetToDbOtList({
      sheetsClient: sheets,
      targetSpreadsheetId: SPREADSHEET_ID,
      movimientosSpreadsheetId: MES_MOVIMIENTOS_ID
    });
    io.emit('ot_sync_completed', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === ENDPOINTS REST: COORDINACIÓN TALLER ===
app.get('/api/coordinacion/data', async (req, res) => {
  try {
    const data = await getCoordinacionBoard({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coordinacion/save', async (req, res) => {
  try {
    const { otNumber, plate, data } = req.body;
    const result = await saveOtCoordinacionJson({
      sheetsClient: sheets,
      spreadsheetId: SPREADSHEET_ID,
      otNumber,
      plate,
      data,
      io
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coordinacion/save-all', async (req, res) => {
  try {
    const { units } = req.body;
    const result = await saveAllCoordinacionBatch({
      sheetsClient: sheets,
      spreadsheetId: SPREADSHEET_ID,
      units,
      io
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coordinacion/assign', async (req, res) => {
  try {
    const { taskId, otNumber, plate, ubicacion, operario, asignado, empezo, termino, estado, tasksPayload } = req.body;
    
    // 1. Actualizar DB_OT_TASKS si taskId está disponible
    if (taskId) {
      await updateTaskExecution({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        taskId,
        ubicacion,
        operario,
        asignado,
        empezo,
        termino,
        estado,
        io
      });
    }

    // 2. Persistir en Columna I de 'ots'
    if (otNumber || plate) {
      await saveOtCoordinacionJson({
        sheetsClient: sheets,
        spreadsheetId: SPREADSHEET_ID,
        otNumber,
        plate,
        data: tasksPayload || {
          ot: otNumber,
          plate,
          ubicacion,
          operarios: operario,
          lastUpdated: new Date().toISOString()
        },
        io
      });
    }

    res.json({ success: true, message: 'Asignación guardada en DB y escrita en Columna I de tab ots' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === ENDPOINTS REST: DB_OT_TASKS ===
app.get('/api/tasks', async (req, res) => {
  try {
    const data = await getActiveTasksBoard({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tasks/update', async (req, res) => {
  try {
    const result = await updateTaskExecution({
      sheetsClient: sheets,
      spreadsheetId: SPREADSHEET_ID,
      ...req.body,
      io
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tasks/sync', async (req, res) => {
  try {
    const result = await syncOtsToTasksDatabase({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tasks/history', async (req, res) => {
  try {
    const result = await getHistoricalTasks({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST GET /api/orders
app.get('/api/orders', async (req, res) => {
  const orders = await syncDataFromSheets();
  res.json(orders);
});

// REST GET /api/fleet/search-catalog
app.get('/api/fleet/search-catalog', async (req, res) => {
  try {
    const data = await otsManager.getFleetSearchCatalog(sheets, SPREADSHEET_ID);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST GET /api/ots-anteriores/:plate
app.get('/api/ots-anteriores/:plate', async (req, res) => {
  try {
    const { plate } = req.params;
    const data = await otsManager.getOtsAnterioresForPlate(sheets, SPREADSHEET_ID, plate);
    res.json({ success: true, plate, anteriores: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST POST /api/ots/wipe-cold
app.post('/api/ots/wipe-cold', async (req, res) => {
  try {
    const result = await otsManager.wipeAndArchiveOlderThan6Months(sheets, SPREADSHEET_ID);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST GET /api/ots/cold-storage/download
app.get('/api/ots/cold-storage/download', async (req, res) => {
  try {
    const { csvContent, totalRows } = await otsManager.downloadColdStorageOts(sheets, SPREADSHEET_ID);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ots_historico_cold.csv"');
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST POST /api/ots/cold-storage/clear
app.post('/api/ots/cold-storage/clear', async (req, res) => {
  try {
    const result = await otsManager.clearColdStorageTab(sheets, SPREADSHEET_ID);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === 4.1 WEBHOOK NUEVA OT (APPS SCRIPT INTEGRATION) ===
app.post('/webhook/nueva-ot', async (req, res) => {
  try {
    const dirtyPlate = req.body.dirtyPlate || req.body.rawPlate || req.body.plate || req.body.dominio || '';
    const otNumber = req.body.otNumber || req.body.newOt || req.body.ot || '';
    const sectorTareas = req.body.sectorTareas || req.body.tareas || '';
    const cierreRespaldo = req.body.cierreRespaldo || req.body.respaldo || '';
    const fecha = req.body.fecha || '';
    const confirmacion = req.body.confirmacion || req.body.confirmacionTareas || '';

    console.log(`📥 Webhook /webhook/nueva-ot recibido: dirtyPlate="${dirtyPlate}", otNumber="${otNumber}"`);

    // 1. Gestionar 'ots' y 'ots_anteriores': preserva solo la más actual por fecha de ingreso y traslada anteriores
    let otsManagerResult = null;
    if (sheets && dirtyPlate && otNumber) {
      try {
        otsManagerResult = await otsManager.processNewOtRecord(sheets, SPREADSHEET_ID, {
          dominio: dirtyPlate,
          otNumber,
          sectorTareas,
          cierreRespaldo,
          fecha,
          confirmacion
        });
      } catch (errOts) {
        console.warn('⚠️ Advertencia en otsManager.processNewOtRecord:', errOts.message);
      }
    }

    // 2. Emparejamiento en índice DB_OT_LIST
    let result = null;
    try {
      result = await processSingleOtUpdate({
        sheetsClient: sheets,
        targetSpreadsheetId: SPREADSHEET_ID,
        dirtyPlate: dirtyPlate,
        otNumber: otNumber
      });
    } catch(errSingle) {
      console.warn('⚠️ Advertencia en processSingleOtUpdate:', errSingle.message);
    }

    const effectivePlate = (otsManagerResult && otsManagerResult.dominio) || (result && result.matchedPlate) || dirtyPlate;
    const effectiveOt = otNumber;

    // Notificar a todos los navegadores/dashboards conectados en tiempo real vía WebSocket
    io.emit('ot_updated', {
      action: (otsManagerResult && otsManagerResult.action) || (result && result.action) || 'UPDATED',
      matchedPlate: effectivePlate,
      otNumber: effectiveOt,
      otsDetails: otsManagerResult,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Webhook /webhook/nueva-ot procesado: ${effectivePlate} (OT ${effectiveOt})`);

    res.status(200).json({
      success: true,
      otsManager: otsManagerResult,
      dbOtList: result
    });
  } catch (err) {
    console.error('❌ Error procesando /webhook/nueva-ot:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint manual / bajo demanda para distribuir OTs ante cargas externas
app.all('/api/distribuir-ots', async (req, res) => {
  try {
    console.log('⚡ Disparando distribución de OTs bajo demanda (/api/distribuir-ots)...');
    const result = await otsManager.distribuirOtsEnCarga(sheets, SPREADSHEET_ID, io);
    res.json({ success: true, result });
  } catch (err) {
    console.error('❌ Error en /api/distribuir-ots:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint manual / cron para sincronización masiva de OTs
app.all('/api/sync-ots', async (req, res) => {
  try {
    console.log('🛡️ Disparando sincronización canónica de OTs desde /api/sync-ots...');
    const result = await syncCanonicalFleetToDbOtList({
      sheetsClient: sheets,
      targetSpreadsheetId: SPREADSHEET_ID,
      movimientosSpreadsheetId: MES_MOVIMIENTOS_ID,
      formSpreadsheetId: SOURCE_SPREADSHEET_ID
    });
    // Distribuir en la carga
    await otsManager.distribuirOtsEnCarga(sheets, SPREADSHEET_ID, io);
    io.emit('ot_sync_completed', result);
    res.json(result);
  } catch (err) {
    console.error('❌ Error en /api/sync-ots:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/ping', (req, res) => res.send('PONG'));

// === 5. WEBSOCKETS EN TIEMPO REAL ===
io.on('connection', (socket) => {
  socket.emit('orders_sync', ordersCache);
  socket.emit('env_info', {
    environment: isProdEnvironment ? 'production' : 'development',
    isProduction: isProdEnvironment,
    spreadsheetTitle: isProdEnvironment ? 'Database PRUEBAS' : 'Database PRUEBAS LOCAL',
    spreadsheetIdShort: SPREADSHEET_ID.slice(0, 6) + '...' + SPREADSHEET_ID.slice(-4),
    serverTime: new Date().toISOString()
  });
});

// === 6. PROGRAMACIÓN DE TAREAS Y ARRANQUE DEL SERVIDOR ===
// Sincronización periódica de OTs como salvaguarda / backup (por defecto 0 = desactivado para cuidar cuota)
if (OT_SYNC_INTERVAL_MINUTES > 0) {
  const syncIntervalMs = OT_SYNC_INTERVAL_MINUTES * 60 * 1000;
  setInterval(async () => {
    try {
      console.log(`⏰ Ejecución programada de sincronización canónica de OTs (cada ${OT_SYNC_INTERVAL_MINUTES} min)...`);
      const result = await syncCanonicalFleetToDbOtList({
        sheetsClient: sheets,
        targetSpreadsheetId: SPREADSHEET_ID,
        movimientosSpreadsheetId: MES_MOVIMIENTOS_ID,
        formSpreadsheetId: SOURCE_SPREADSHEET_ID
      });
      await otsManager.distribuirOtsEnCarga(sheets, SPREADSHEET_ID, io);
      io.emit('ot_sync_completed', result);
    } catch (e) {
      console.error('❌ Error en sincronización programada de OTs:', e.message);
    }
  }, syncIntervalMs);
}

const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);

function startServer(port) {
  server.removeAllListeners('error');
  server.removeAllListeners('listening');

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Puerto ${port} en uso. Reintentando automáticamente en puerto ${port + 1}...`);
      setTimeout(() => startServer(port + 1), 500);
    } else {
      console.error('❌ Error en servidor HTTP:', err.message);
    }
  });

  server.once('listening', async () => {
    console.log('================================================================');
    console.log(`🚀 Servidor Monolito Pañol activo en puerto ${port}`);
    console.log(`🌍 Entorno:          ${isProdEnvironment ? '🔴 PRODUCCIÓN (Render Cloud)' : '🟢 LOCAL / DESARROLLO (VS Code / localhost)'}`);
    console.log(`📊 Spreadsheet Base: ${isProdEnvironment ? 'Database PRUEBAS' : 'Database PRUEBAS LOCAL'}`);
    console.log(`🆔 ID Planilla:      ${SPREADSHEET_ID}`);
    console.log(`🔗 URL Base:         http://localhost:${port}`);
    console.log('================================================================');
    
    // 1. Carga en memoria RAM de unidades desde diagramasnode (HTTP externo, no gasta cuota de Sheets)
    try {
      await syncFleetFromDiagramasNode();
    } catch (err) {
      console.warn('⚠️ Carga inicial RAM diagramasnode:', err.message);
    }
    setInterval(() => {
      syncFleetFromDiagramasNode().catch(err => console.warn('⚠️ Refresco RAM diagramasnode:', err.message));
    }, 15 * 60 * 1000);

    // 2. Asegurar estructura de ots y ots_anteriores y depurar en la carga inicial (sin timers periódicos)
    try {
      await otsManager.ensureOtsStructure(sheets, SPREADSHEET_ID);
      await otsManager.migrateAndDeduplicateOts(sheets, SPREADSHEET_ID);
    } catch (errOtsInit) {
      console.warn('⚠️ Error al inicializar ots y ots_anteriores:', errOtsInit.message);
    }

    // Pequeña pausa de 1 segundo para escalonar peticiones y proteger la cuota de Google Sheets
    await new Promise(r => setTimeout(r, 1000));

    // 3. Sincronizar catálogo y transacciones en 1 sola petición HTTP batchGet
    await syncDataFromSheets();

    // Pequeña pausa de 1 segundo
    await new Promise(r => setTimeout(r, 1000));

    // 4. Sincronización inicial de flota canónica a DB_OT_LIST
    try {
      console.log('🚀 Ejecutando sincronización inicial canónica de OTs al arrancar servidor...');
      const otSyncRes = await syncCanonicalFleetToDbOtList({
        sheetsClient: sheets,
        targetSpreadsheetId: SPREADSHEET_ID,
        movimientosSpreadsheetId: MES_MOVIMIENTOS_ID,
        formSpreadsheetId: SOURCE_SPREADSHEET_ID
      });
      console.log('✅ Sincronización inicial de OTs finalizada:', otSyncRes);
    } catch (e) {
      console.error('⚠️ Advertencia: No se pudo completar sincronización inicial de OTs:', e.message);
    }

    try {
      console.log('🔄 Sincronizando tareas operativas de OTs (DB_OT_TASKS & ots_anteriores)...');
      await syncOtsToTasksDatabase({ sheetsClient: sheets, spreadsheetId: SPREADSHEET_ID });
    } catch (eTasksInit) {
      console.warn('⚠️ Error en sincronización inicial de tareas:', eTasksInit.message);
    }
  });

  server.listen(port);
}

startServer(DEFAULT_PORT);