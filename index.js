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