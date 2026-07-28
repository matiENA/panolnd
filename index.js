const express = require('express');
const http = require('http');
const cors = require('cors');
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

// === 1. AUTENTICACIÓN CENTRALIZADA CON GOOGLE SHEETS ===
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1grLJZIYdWLRtjxK0kXobcaxj-1nZQaNnz23NU4oUDko';

function getSheetsClient() {
  try {
    if (!process.env.GOOGLE_CREDENTIALS) {
      console.warn('⚠️ Variable GOOGLE_CREDENTIALS no encontrada en entorno.');
      return null;
    }
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
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

// === 2. CACHE Y CONTROLADOR EN TIEMPO REAL (WEBSOCKETS + MEMORY) ===
let ordersCache = [];
let itemsCatalogCache = [];
let lastFetchTime = 0;

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

      if (['PENDIENTE', 'LISTO', 'ENTREGADO', 'DEVOLUCION PENDIENTE', 'DEVOLUCION'].includes(status)) {
        if (!ordersMap[reqId]) {
          ordersMap[reqId] = {
            reqId,
            timestamp: row[0],
            opInfo: row[3] || 'Desconocido',
            otNumber: row[4] || '--',
            unitInfo: row[5] || 'S/D',
            status,
            panolOpId,
            notes: row[11] || '',
            items: []
          };
        }

        const itemName = String(row[6] || '');
        const details = itemMap[itemName.toUpperCase()] || { id: '---', loc: 'S/D', stock: 0, requiereCanje: false };

        ordersMap[reqId].items.push({
          name: itemName,
          qty: Number(row[7]) || 0,
          id: details.id,
          loc: details.loc,
          stock: details.stock,
          requiereCanje: details.requiereCanje,
          estadoCanje,
          panolConfirmacion,
          status,
          notesColO,
          isPendingReturn
        });
      }
    }

    ordersCache = Object.values(ordersMap).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    lastFetchTime = Date.now();

    return ordersCache;
  } catch (err) {
    console.error('❌ Error sincronizando con Google Sheets:', err.message);
    return ordersCache;
  }
}

// Sincronización periódica en segundo plano cada 5 segundos
setInterval(async () => {
  const updated = await syncDataFromSheets();
  io.emit('orders_sync', updated);
}, 5000);

// === 3. ENDPOINTS PAÑOL MONITOR & SISTEMA DE PEDIDOS ===

app.get('/ping', (req, res) => res.send('Servidor Operativo (Pañol Microservice)'));

app.get('/api/orders', async (req, res) => {
  if (Date.now() - lastFetchTime > 4000) {
    await syncDataFromSheets();
  }
  res.json(ordersCache);
});

app.get('/api/inventory', (req, res) => {
  res.json(itemsCatalogCache);
});

// Modificar cantidad de ítem en pedido
app.post('/api/orders/update-item-qty', async (req, res) => {
  try {
    const { reqId, itemName, newQty } = req.body;
    
    // Actualización local rápida para transmisión WebSockets en < 10ms
    const order = ordersCache.find(o => String(o.reqId) === String(reqId));
    if (order) {
      const item = order.items.find(i => String(i.name).toLowerCase() === String(itemName).toLowerCase());
      if (item) item.qty = Number(newQty);
    }
    io.emit('orders_sync', ordersCache);

    // Escribir en Google Sheets en segundo plano
    if (sheets) {
      const transRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A:I'
      });
      const rows = transRes.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]).trim() === String(reqId).trim() &&
            String(rows[i][6]).trim().toLowerCase() === String(itemName).trim().toLowerCase() &&
            String(rows[i][8]).trim() === 'PENDIENTE') {
          
          const rowNum = i + 1;
          if (Number(newQty) <= 0) {
            // Nota: Se marca la fila o se actualiza la cantidad
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!H${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[0]] }
            });
          } else {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `DB_TRANSACTIONS!H${rowNum}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[newQty]] }
            });
          }
          break;
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error update-item-qty:', err);
    res.status(500).json({ error: err.message });
  }
});

// Marcar Listo / Entregado
app.post('/api/orders/mark-ready', async (req, res) => {
  try {
    const { reqId, panolOpId } = req.body;

    const order = ordersCache.find(o => String(o.reqId) === String(reqId));
    if (order) {
      order.status = 'ENTREGADO';
      order.panolOpId = panolOpId;
    }
    io.emit('orders_sync', ordersCache);

    if (sheets) {
      const transRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A:P'
      });
      const rows = transRes.data.values || [];
      const nowStr = new Date().toLocaleString();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]).trim() === String(reqId).trim()) {
          const rowNum = i + 1;
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `DB_TRANSACTIONS!I${rowNum}:K${rowNum}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['ENTREGADO', nowStr, nowStr]] }
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

    res.json({ success: true });
  } catch (err) {
    console.error('Error mark-ready:', err);
    res.status(500).json({ error: err.message });
  }
});

// Solicitar Devolución (Mecánico)
app.post('/api/orders/request-return', async (req, res) => {
  try {
    const { reqId, itemName, reason, returnQty } = req.body;

    const order = ordersCache.find(o => String(o.reqId) === String(reqId));
    if (order) {
      const item = order.items.find(i => String(i.name).toLowerCase() === String(itemName).toLowerCase());
      if (item) {
        item.status = 'DEVOLUCION PENDIENTE';
        item.notesColO = `SOLICITUD DEVOLUCIÓN NUEVA: ${reason || 'Sin motivo'}`;
      }
    }
    io.emit('orders_sync', ordersCache);

    if (sheets) {
      const transRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A:O'
      });
      const rows = transRes.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]).trim() === String(reqId).trim() &&
            String(rows[i][6]).trim().toLowerCase() === String(itemName).trim().toLowerCase()) {
          const rowNum = i + 1;
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
            requestBody: { values: [[`SOLICITUD DEVOLUCIÓN NUEVA: ${reason || 'Sin motivo'}`]] }
          });
          break;
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error request-return:', err);
    res.status(500).json({ error: err.message });
  }
});

// Aceptar Devolución (Pañol) -> Cambia a DEVOLUCION y preserva la nota Col O
app.post('/api/orders/process-new-return', async (req, res) => {
  try {
    const { reqId, itemName, returnQty, reason, panolOpId } = req.body;

    const order = ordersCache.find(o => String(o.reqId) === String(reqId));
    if (order) {
      const item = order.items.find(i => String(i.name).toLowerCase() === String(itemName).toLowerCase());
      if (item) {
        item.status = 'DEVOLUCION';
        const existing = item.notesColO || '';
        const panolNote = `DEVOLUCIÓN ACEPTADA: ${reason || 'OK'} [OP: ${panolOpId}]`;
        item.notesColO = existing ? `${existing} | ${panolNote}` : panolNote;
      }
    }
    io.emit('orders_sync', ordersCache);

    if (sheets) {
      const transRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB_TRANSACTIONS!A:O'
      });
      const rows = transRes.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]).trim() === String(reqId).trim() &&
            String(rows[i][6]).trim().toLowerCase() === String(itemName).trim().toLowerCase()) {
          const rowNum = i + 1;
          const existingNote = String(rows[i][14] || '').trim();
          const panolNote = `DEVOLUCIÓN ACEPTADA: ${reason || 'OK'} [OP: ${panolOpId}]`;
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
          break;
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error process-new-return:', err);
    res.status(500).json({ error: err.message });
  }
});

// === 4. WEBHOOK EXISTENTE (NORMALIZACIÓN DE PATENTES Y REGISTRO OT) ===

app.post('/webhook/nueva-ot', async (req, res) => {
  try {
    const { dirtyPlate, otNumber } = req.body;
    if (!otNumber || !dirtyPlate) return res.status(400).json({ error: "Faltan datos." });

    const normalizedString = String(dirtyPlate).toUpperCase().replace(/[\s\-_.]/g, '');
    const plateRegex = /([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})/g;
    const matchedPlates = normalizedString.match(plateRegex);

    if (!matchedPlates || matchedPlates.length === 0) {
      return res.status(400).json({ error: "Patente inválida o no reconocida." });
    }

    if (!sheets) {
      return res.status(500).json({ error: "Cliente de Google Sheets no disponible." });
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_OT_LIST!A:B',
    });

    const rows = response.data.values || [];
    const dataToUpdate = [];

    matchedPlates.forEach(plateToUpdate => {
      const rowIndex = rows.findIndex(row => {
        const dbPlateRaw = String(row[0] || '').toUpperCase().replace(/[\s\-_.]/g, '');
        const matchDb = dbPlateRaw.match(plateRegex);
        const cleanDbPlate = matchDb ? matchDb[0] : dbPlateRaw;
        return cleanDbPlate === plateToUpdate;
      });

      if (rowIndex !== -1) {
        const sheetRow = rowIndex + 1;
        dataToUpdate.push({
          range: `DB_OT_LIST!B${sheetRow}`,
          values: [[otNumber]]
        });
      }
    });

    if (dataToUpdate.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: dataToUpdate
        }
      });
    }

    res.status(200).json({ 
      success: true, 
      updatedPlates: matchedPlates, 
      ot: otNumber 
    });

  } catch (error) {
    console.error('Error procesando Webhook OT:', error);
    res.status(500).json({ error: "Fallo interno en el servidor Node." });
  }
});

// === 5. WEBSOCKET REALTIME CONNECTION HANDLER ===
io.on('connection', (socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);
  socket.emit('orders_sync', ordersCache);

  socket.on('disconnect', () => {
    console.log(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

// === 6. INICIO DEL SERVIDOR HTTP + WEBSOCKETS ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Microservicio Unificado de Logística & Pañol activo en puerto ${PORT}`);
  if (sheets) {
    await syncDataFromSheets();
  }
});