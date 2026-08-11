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

// === 3. RUTAS ESTÁTICAS DEL MONOLITO ===
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const v = (req.query.v || req.query.view || '').toLowerCase();
  if (v === 'panol') return res.sendFile(path.join(__dirname, 'public', 'panol.html'));
  if (v === 'dashboard') return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  if (v === 'inv') return res.sendFile(path.join(__dirname, 'public', 'inv.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panol', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panol.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/inv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inv.html')));

// === 4. REST API ENDPOINTS ===

// GET /api/orders: Obtener lista enriquecida de pedidos
app.get('/api/orders', async (req, res) => {
  const orders = await syncDataFromSheets();
  res.json(orders);
});

// GET /api/inventory: Catálogo de repuestos
app.get('/api/inventory', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  await syncDataFromSheets();
  let results = itemsCatalogCache;
  if (q) {
    results = results.filter(i => i.name.toLowerCase().includes(q) || i.brand.toLowerCase().includes(q));
  }
  res.json(results.slice(0, 30));
});

// POST /api/orders/create: Crear nuevo pedido de mecánico
app.post('/api/orders/create', async (req, res) => {
  try {
    const { opId, mechanicName, otNumber, unitId, items } = req.body;
    if (!opId || !items || !items.length) {
      return res.status(400).json({ success: false, error: 'Datos de pedido incompletos.' });
    }

    const timestamp = new Date().toISOString();
    const reqId = 'REQ-' + Date.now();
    const rowsToAppend = [];

    items.forEach(itemObj => {
      rowsToAppend.push([
        timestamp, reqId, opId, mechanicName, otNumber, unitId,
        itemObj.item, itemObj.qty, 'PENDIENTE', '', '', itemObj.notes || '', '', '', '', '', '', ''
      ]);
    });

    if (sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A:R',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAppend }
      });
    }

    await syncDataFromSheets();
    io.emit('orders_sync', ordersCache);
    res.json({ success: true, reqId });
  } catch (e) {
    console.error('❌ Error creando pedido:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/orders/mark-ready: Marcar listo para retirar
app.post('/api/orders/mark-ready', async (req, res) => {
  try {
    const { reqId, panolOpId } = req.body;
    if (!reqId) return res.status(400).json({ success: false, error: 'REQ-ID requerido.' });

    // Actualizamos en memoria optimista
    const target = ordersCache.find(o => String(o.reqId) === String(reqId));
    if (target) {
      target.status = 'LISTO';
      target.panolOpId = panolOpId;
    }
    io.emit('orders_sync', ordersCache);

    // Persistir en Sheets de fondo
    if (sheets) {
      const transRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A1:R500'
      });
      const rows = transRes.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1] || '').trim() === String(reqId).trim()) {
          const rowNum = i + 1;
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: 'DB_TRANSACTIONS!I' + rowNum + ':P' + rowNum,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['LISTO', '', '', '', '', '', '', panolOpId]] }
          });
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/orders/update-item-qty: Actualizar cantidad de un ítem
app.post('/api/orders/update-item-qty', async (req, res) => {
  try {
    const { reqId, itemName, newQty } = req.body;
    await syncDataFromSheets();
    io.emit('orders_sync', ordersCache);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/orders/remove-item: Eliminar ítem
app.post('/api/orders/remove-item', async (req, res) => {
  try {
    const { reqId, itemName } = req.body;
    await syncDataFromSheets();
    io.emit('orders_sync', ordersCache);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/orders/set-color & Pings
app.post('/api/orders/set-color', (req, res) => {
  const { reqId, color } = req.body;
  uiPropertiesCache['COLOR_' + reqId] = color;
  const target = ordersCache.find(o => String(o.reqId) === String(reqId));
  if (target) target.uiColor = color;
  io.emit('orders_sync', ordersCache);
  res.json({ success: true });
});

app.post('/api/orders/send-ping', (req, res) => {
  const { reqId } = req.body;
  const pingVal = Date.now();
  uiPropertiesCache['PING_' + reqId] = pingVal;
  const target = ordersCache.find(o => String(o.reqId) === String(reqId));
  if (target) target.uiPing = pingVal;
  io.emit('orders_sync', ordersCache);
  res.json({ success: true });
});

// === SERVICIO DE OTS Y BÚSQUEDA DE UNIDADES ===
app.post('/api/ot/search', async (req, res) => {
  try {
    const { query, type } = req.body;
    if (!query || query.length < 2) return res.json({ success: false });
    if (!sheets) return res.json({ success: false, error: 'Sin cliente de Sheets' });

    const otRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_OT_LIST!A1:G1000'
    });

    const data = otRes.data.values || [];
    const q = String(query).trim().toUpperCase();

    for (let i = 1; i < data.length; i++) {
      const unit = String(data[i][0] || '').toUpperCase().trim();
      const ot = String(data[i][1] || '').toUpperCase().trim();
      const semi = String(data[i][2] || '').toUpperCase().trim();
      const semiOt = String(data[i][3] || '').toUpperCase().trim();

      let isMatch = false;
      if (type === 'OT') isMatch = (ot === q);
      else if (type === 'UNIT') isMatch = (unit === q || unit.includes(q));
      else if (type === 'SEMI_OT') isMatch = (semiOt === q || ot === q);
      else if (type === 'SEMI') isMatch = (semi === q || semi.includes(q));
      else isMatch = (unit.includes(q) || semi.includes(q) || ot === q || semiOt === q);

      if (isMatch) {
        return res.json({
          success: true,
          unit: unit,
          ot: ot,
          semi: semi,
          semiOt: semiOt || ot
        });
      }
    }

    res.json({ success: false });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WEBHOOK NUEVA OT (Normalización con plateNormalizer.js)
app.post('/webhook/nueva-ot', async (req, res) => {
  try {
    const { unitId, otNumber, semi, semiOt, product, brand, brandSemi } = req.body;
    const cleanUnit = extractCleanPlate(unitId);
    const cleanSemi = extractCleanPlate(semi);

    if (sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_OT_LIST!A:G',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[cleanUnit, otNumber, cleanSemi, semiOt || '', product || '', brand || '', brandSemi || '']]
        }
      });
    }

    res.json({ success: true, unit: cleanUnit, ot: otNumber });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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