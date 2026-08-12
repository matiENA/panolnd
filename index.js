const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const { extractCleanPlate } = require('./plateNormalizer');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// === 1. CREDENCIALES CENTRALIZADAS CON GOOGLE SHEETS ===
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc';

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

async function syncDataFromSheets() {
  if (!sheets) return ordersCache;

  try {
    // A. Leer catálogo de ítems y stock desde DB_ITEMS
    const itemRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_ITEMS!A1:H500'
    });
    const itemRows = itemRes.data.values || [];
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

    // B. Leer transacciones de pedidos desde DB_TRANSACTIONS
    const transRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_TRANSACTIONS!A1:R500'
    });

    const rows = transRes.data.values || [];
    if (rows.length < 2) return [];

    const ordersMap = {};
    for (let i = Math.max(1, rows.length - 200); i < rows.length; i++) {
      const row = rows[i];
      const reqId = String(row[1] || '').trim();
      const status = String(row[8] || '').trim();
      if (!reqId) continue;

      const panolOpId = String(row[15] || '').trim();
      const estadoCanje = String(row[16] || '').trim();
      const panolConfirmacion = String(row[17] || '').trim();
      const notesColO = String(row[14] || '').trim();

      const isPendingReturn = estadoCanje !== "" && !panolConfirmacion.includes("OK") && !panolConfirmacion.includes("INCOMPLETO");

      if (status === "PENDIENTE" || status === "LISTO" || status === "ENTREGADO" || status === "DEVOLUCION PENDIENTE" || status === "DEVOLUCION") {
        if (!ordersMap[reqId]) {
          const unitInfo = String(row[5] || '');
          ordersMap[reqId] = {
            reqId: reqId,
            timestamp: row[0],
            opInfo: row[3],
            otNumber: row[4],
            unitInfo: unitInfo,
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

        ordersMap[reqId].items.push({
          name: itemName,
          qty: row[7],
          id: itemDetails.id,
          loc: itemDetails.loc,
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

    ordersCache = Object.values(ordersMap);
    return ordersCache;
  } catch (e) {
    console.error('❌ Error en syncDataFromSheets:', e.message);
    return ordersCache;
  }
}

// === 3. RUTAS ESTÁTICAS DEL MONOLITO Y QUERY PARAMS ===
app.get('/', (req, res) => {
  const v = String(req.query.v || req.query.view || req.query.page || req.query.p || '').toLowerCase().trim();
  if (v === 'panol' || v === 'monitor') return res.sendFile(path.join(__dirname, 'public', 'panol.html'));
  if (v === 'dashboard' || v === 'dash') return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  if (v === 'inv' || v === 'inventory' || v === 'stock') return res.sendFile(path.join(__dirname, 'public', 'inv.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panol', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panol.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/inv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inv.html')));

// Servidor de archivos estáticos (JS, CSS, imágenes) deshabilitando index automático
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

// === 4. RPC UNIVERSAL DISPATCHER (google.script.run Polyfill) ===
app.post('/api/rpc', async (req, res) => {
  const { action, args = [] } = req.body;
  try {
    let result = null;

    if (action === 'getMechanicConfig') {
      const opId = String(args[0] || '').trim();
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
        if (!hasAppAccess && staffRow[11] !== undefined) {
          result = { success: false, error: "Usuario no encontrado o sin acceso activo" };
        } else {
          const boxes = staffRow.slice(6, 11).map(c => String(c || '').trim()).filter(c => c !== '');
          result = { success: true, name: staffRow[1] || ('Operario ' + opId), role: staffRow[2] || 'MECANICO', boxes: boxes };
        }
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
      let units = new Set();
      if (sheets) {
        try {
          const otRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_OT_LIST!A1:D500' });
          (otRes.data.values || []).slice(1).forEach(r => {
            if (r[0]) units.add(String(r[0]).trim().toUpperCase());
            if (r[2]) units.add(String(r[2]).trim().toUpperCase());
          });
        } catch(e) {}
      }
      result = Array.from(units).sort();
    }
    else if (action === 'findUnitOrOt') {
      const query = String(args[0] || '').trim().toUpperCase();
      const type = args[1];
      let match = null;
      if (sheets && query.length >= 2) {
        try {
          const otRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_OT_LIST!A1:G500' });
          const data = otRes.data.values || [];
          for (let i = 1; i < data.length; i++) {
            const unit = String(data[i][0] || '').toUpperCase().trim();
            const ot = String(data[i][1] || '').toUpperCase().trim();
            const semi = String(data[i][2] || '').toUpperCase().trim();
            const semiOt = String(data[i][3] || '').toUpperCase().trim();
            let isMatch = false;
            if (type === 'OT') isMatch = (ot === query);
            else if (type === 'UNIT') isMatch = (unit === query || unit.includes(query));
            else if (type === 'SEMI_OT') isMatch = (semiOt === query || ot === query);
            else if (type === 'SEMI') isMatch = (semi === query || semi.includes(query));
            else isMatch = (unit.includes(query) || semi.includes(query) || ot === query || semiOt === query);

            if (isMatch) {
              match = { success: true, unit: unit, ot: ot, semi: semi, semiOt: semiOt || ot };
              break;
            }
          }
        } catch(e) {}
      }
      result = match || { success: false };
    }
    else if (action === 'submitBatchRequest' || action === 'createOrder') {
      const payload = args[0] || {};
      const { opId, mechanicName, otNumber, unitId, items } = payload;
      const now = new Date();
      const timestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const reqId = 'REQ-' + Math.floor(Math.random() * 10000000).toString(16).toUpperCase();
      const rowsToAppend = [];

      (items || []).forEach(itemObj => {
        rowsToAppend.push([
          timestamp, reqId, opId, mechanicName, otNumber, unitId,
          itemObj.item, itemObj.qty, 'PENDIENTE', '', '', itemObj.notes || '', '', '', '', '', itemObj.canjeStatus || '', ''
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

        (items || []).forEach(itemObj => {
          updateStockByName(itemObj.item, -Math.abs(Number(itemObj.qty) || 0));
        });
      }
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: true, reqId: reqId };
    }
    else if (action === 'updatePendingItemQty') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const newQty = Number(args[2]) || 0;
      let updated = false;

      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
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
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'removePendingItem') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      let updated = false;

      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
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
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'addItemToPendingOrder') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const qty = Number(args[2]) || 0;
      let updated = false;

      if (sheets && qty > 0) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
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
      await syncDataFromSheets();
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
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
        const rows = transRes.data.values || [];

        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          const rItem = String(rows[i][6] || '').trim().toLowerCase();
          const reqMatch = rReq === reqId;
          const itemMatch = !itemName || rItem === itemName;

          if (reqMatch && itemMatch) {
            const rowNum = i + 1;
            const estadoCanjeColQ = String(rows[i][16] || '').trim();
            const confirmacionColR = String(rows[i][17] || '').trim();

            if (estadoCanjeColQ !== '' && !confirmacionColR.includes('OK') && !confirmacionColR.includes('INCOMPLETO')) {
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
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
    }
    else if (action === 'confirmNewReturn' || action === 'processNewItemReturn') {
      const reqId = String(args[0] || '').trim();
      const itemName = String(args[1] || '').trim();
      const returnQty = Number(args[2]) || 1;
      const panolOpId = args[3] || args[4];
      let updated = false;

      if (sheets) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
        const rows = transRes.data.values || [];

        for (let i = 1; i < rows.length; i++) {
          const rReq = String(rows[i][1] || '').trim();
          const rItem = String(rows[i][6] || '').trim().toLowerCase();
          const rStatus = String(rows[i][8] || '').trim();

          if (rReq === reqId && rItem === itemName.toLowerCase() && (rStatus === 'DEVOLUCION PENDIENTE' || rStatus === 'ENTREGADO' || rStatus === 'LISTO')) {
            const originalQty = Number(rows[i][7]) || 0;
            const rowNum = i + 1;
            const panolNote = `DEVOLUCIÓN ACEPTADA: OK [OP: ${panolOpId || 'PAÑOL'}]`;
            const existingNote = String(rows[i][14] || '').trim();
            const finalNote = existingNote ? `${existingNote} | ${panolNote}` : panolNote;

            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!I${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [['DEVOLUCION']] }
            });
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!O${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[finalNote]] }
            });
            await updateStockByName(itemName, returnQty || originalQty);
            updated = true;
            break;
          }
        }
      }
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: updated };
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
      if (sheets && reqId) {
        const transRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DB_TRANSACTIONS!A1:R500' });
        const rows = transRes.data.values || [];
        const now = new Date();
        const dateStr = now.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const timeStr = now.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const newStatus = action === 'markAsDelivered' ? 'ENTREGADO' : 'LISTO';
        const colIdx = action === 'markAsDelivered' ? 'K' : 'J';

        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][1] || '').trim() === String(reqId).trim()) {
            const rowNum = i + 1;
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!I${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[newStatus]] }
            });
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!${colIdx}${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[`${dateStr} ${timeStr}`]] }
            });
            if (panolOpId) {
              await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `DB_TRANSACTIONS!P${rowNum}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[panolOpId]] }
              });
            }
          }
        }
      }
      await syncDataFromSheets();
      io.emit('orders_sync', ordersCache);
      result = { success: true };
    }
    else if (action === 'validateWarehouseUser') {
      const key = String(args[0] || '').trim();
      const users = { "1": "Ema", "6": "Matias" };
      result = users[key] || ("Operador " + key);
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

// REST GET /api/orders
app.get('/api/orders', async (req, res) => {
  const orders = await syncDataFromSheets();
  res.json(orders);
});

// Health check
app.get('/ping', (req, res) => res.send('PONG'));

// === 5. WEBSOCKETS EN TIEMPO REAL ===
io.on('connection', (socket) => {
  socket.emit('orders_sync', ordersCache);
});

// === 6. ARRANQUE DEL SERVIDOR ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('🚀 Servidor Monolito Pañol activo en puerto ' + PORT);
  await syncDataFromSheets();
});