const express = require('express');
const { google } = require('googleapis');
const { extractCleanPlate } = require('./plateNormalizer');

const app = express();
app.use(express.json());

// === 1. AUTENTICACIÓN CENTRALIZADA ===
// Render inyectará el JSON de Firebase desde tus Environment Variables
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// ID de tu documento "Database"
const SPREADSHEET_ID = '1grLJZIYdWLRtjxK0kXobcaxj-1nZQaNnz23NU4oUDko'; 

// Endpoint de control de salud para Render
app.get('/ping', (req, res) => res.send('Servidor Operativo'));

// === 2. FLUJO DE SERVICIO (WEBHOOK) ===
app.post('/webhook/nueva-ot', async (req, res) => {
  try {
    const { dirtyPlate, otNumber } = req.body;
    
    // Filtro Poka-Yoke
    const cleanPlate = extractCleanPlate(dirtyPlate);
    if (!cleanPlate) {
      return res.status(400).json({ error: "No se detectó una patente válida." });
    }

    // Escritura Atómica en DB_OT_LIST
    // Asumiendo que la Columna A es Patente y la Columna B es OT
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_OT_LIST!A:B', 
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[cleanPlate, otNumber]]
      }
    });

    res.status(200).json({ success: true, plate: cleanPlate, ot: otNumber });

  } catch (error) {
    console.error('Error procesando OT:', error);
    res.status(500).json({ error: "Fallo en la sincronización con la base de datos." });
  }
});

// === 3. INICIO DEL SERVIDOR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Microservicio de logística activo en puerto ${PORT}`);
});

// === AÑADIR A index.js EN RENDER ===

app.post('/webhook/nueva-ot', async (req, res) => {
  try {
    const { dirtyPlate, otNumber } = req.body;
    if (!otNumber || !dirtyPlate) return res.status(400).json({ error: "Faltan datos." });

    // 1. NORMALIZACIÓN (Gestalt: Extraer la Figura del Fondo)
    // Buscamos TODAS las patentes válidas en el string sucio (Ej: Tractor y Semi)
    const normalizedString = String(dirtyPlate).toUpperCase().replace(/[\s\-_.]/g, '');
    const plateRegex = /([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})/g;
    const matchedPlates = normalizedString.match(plateRegex); // Devuelve un array: ['AG629YS', 'AC044HC']

    if (!matchedPlates || matchedPlates.length === 0) {
      return res.status(400).json({ error: "Patente inválida o no reconocida." });
    }

    // 2. LECTURA DE LA DB (Destino)
    const SPREADSHEET_ID = '1grLJZIYdWLRtjxK0kXobcaxj-1nZQaNnz23NU4oUDko'; 
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB_OT_LIST!A:B', // Solo leemos Patente (A) y OT (B)
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.status(404).send('DB_OT_LIST vacía.');

    // 3. MAPEO DE ACTUALIZACIÓN
    const dataToUpdate = [];

    // Buscamos en qué fila de la base de datos está cada patente ingresada
    matchedPlates.forEach(plateToUpdate => {
      const rowIndex = rows.findIndex(row => {
        // Limpiamos la base de datos temporalmente por si alguien escribió con espacios ahí
        const dbPlateRaw = String(row[0]).toUpperCase().replace(/[\s\-_.]/g, '');
        const matchDb = dbPlateRaw.match(plateRegex);
        const cleanDbPlate = matchDb ? matchDb[0] : dbPlateRaw;
        
        return cleanDbPlate === plateToUpdate;
      });

      // Si la patente existe en la base, preparamos el paquete de actualización
      if (rowIndex !== -1) {
        const sheetRow = rowIndex + 1; // Google Sheets usa índice base 1 (A1, A2...)
        dataToUpdate.push({
          range: `DB_OT_LIST!B${sheetRow}`, // Escribimos SOLO en la Columna B (OT)
          values: [[otNumber]]
        });
      }
    });

    // 4. ESCRITURA ATÓMICA (Batch Update)
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
    console.error('Error procesando el Webhook:', error);
    res.status(500).json({ error: "Fallo interno en el servidor Node." });
  }
});