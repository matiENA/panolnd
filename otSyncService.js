/**
 * otSyncService.js
 * Servicio de sincronización y actualización de OTs para Pañol Cloud / Microservicio Render.
 * 
 * Reglas de Negocio (Prägnanz y Poka-Yoke):
 * 1. Extrae y normaliza patentes Mercosur (AA123BB) y tradicionales (AAA123) tolerando texto sucio o compuestos.
 * 2. Realiza matching unificado: compara contra Tractor (Col A) y Semi (Col C).
 * 3. Actualiza exclusivamente la Columna B (OT Tractor) y no toca la Columna D.
 * 4. Si la unidad no existe en la base de datos, crea una nueva fila [patente, ot, "", ""].
 * 5. Soporta tanto webhook en tiempo real (/webhook/nueva-ot) como sincronización masiva en bloque (batch).
 */

/**
 * Extrae patentes válidas argentinas desde cualquier string crudo o sucio.
 * @param {string} rawString 
 * @returns {string[]} Lista de patentes limpias únicas
 */
function extractPlates(rawString) {
  if (!rawString) return [];
  const upper = String(rawString).toUpperCase().trim();

  // 1. Detección por límites de palabra con o sin separadores internos
  const wordRegex = /\b([A-Z]{2}[\s\-_.]*\d{3}[\s\-_.]*[A-Z]{2}|[A-Z]{3}[\s\-_.]*\d{3})\b/g;
  const rawMatches = upper.match(wordRegex) || [];
  const plates = [];

  for (const m of rawMatches) {
    const clean = m.replace(/[\s\-_.]/g, '');
    if (/^[A-Z]{2}\d{3}[A-Z]{2}$|^[A-Z]{3}\d{3}$/.test(clean)) {
      if (!plates.includes(clean)) plates.push(clean);
    }
  }

  // 2. Si no encontró coincidencias con límites de palabra (ej: delimitadores tipo / o +), dividir por tokens
  if (plates.length === 0) {
    const tokens = upper.split(/[\/+,;\n\r\t]+/);
    for (const t of tokens) {
      const cleanToken = t.replace(/[\s\-_.]/g, '');
      const subMatches = cleanToken.match(/([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})/g);
      if (subMatches) {
        for (const sm of subMatches) {
          if (!plates.includes(sm)) plates.push(sm);
        }
      }
    }
  }

  return plates;
}

/**
 * Procesa la notificación en tiempo real de una nueva OT recibida (Webhook).
 * @param {object} params
 * @param {object} params.sheetsClient - Cliente autenticado de Google Sheets
 * @param {string} params.targetSpreadsheetId - ID de la base de datos destino (1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc)
 * @param {string} params.dirtyPlate - Cadena de patente recibida (ej: "AD355XY / AD413LI" o "TRACTOR AG674AQ")
 * @param {string|number} params.otNumber - Número de OT recibido
 * @returns {Promise<object>} Resultado de la operación
 */
async function processSingleOtUpdate({ sheetsClient, targetSpreadsheetId, dirtyPlate, otNumber }) {
  if (!sheetsClient) throw new Error("Cliente de Google Sheets no inicializado");
  if (!targetSpreadsheetId) throw new Error("ID de spreadsheet destino requerido");

  const cleanOt = String(otNumber || '').trim();
  const matches = extractPlates(dirtyPlate);

  if (matches.length === 0) {
    return { success: false, error: "No se detectaron patentes válidas en el input: " + dirtyPlate };
  }
  if (!cleanOt) {
    return { success: false, error: "El número de OT es requerido" };
  }

  // Leer rango A:C de DB_OT_LIST para verificar existencia
  const getRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A:C"
  });

  const dbData = getRes.data.values || [];
  let dbUpdated = false;
  let targetRow = null;
  let matchedType = null;
  let matchedPlate = null;

  // Prägnanz: Unificación de búsqueda - Comparamos con Tractor (Col A) y Semi (Col C)
  for (let i = 1; i < dbData.length; i++) {
    const dbTractor = String(dbData[i][0] || '').toUpperCase().replace(/[\s\-_.]/g, ''); // Col A
    const dbSemi = String(dbData[i][2] || '').toUpperCase().replace(/[\s\-_.]/g, '');    // Col C

    const found = matches.find(p => (dbTractor && p === dbTractor) || (dbSemi && p === dbSemi));
    if (found) {
      targetRow = i + 1; // Fila exacta en Google Sheets (1-indexed)
      matchedPlate = found;
      matchedType = (dbTractor && found === dbTractor) ? "TRACTOR" : "SEMI";

      // 1. Sobreescribimos SOLO la Columna B (Índice 2)
      // 2. IGNORAMOS la Columna D por completo
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: targetSpreadsheetId,
        range: `'DB_OT_LIST'!B${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[cleanOt]] }
      });

      dbUpdated = true;
      break; // Poka-Yoke: Detenemos el bucle al instante para evitar cualquier duplicación
    }
  }

  // Si recorrimos toda la DB y no hubo coincidencias, creamos UNA SOLA fila nueva
  if (!dbUpdated) {
    matchedPlate = matches[0];
    matchedType = "NEW_ENTRY";

    // Append de [matches[0], newOt, "", ""]
    const appendRes = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: targetSpreadsheetId,
      range: "'DB_OT_LIST'!A:D",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[matchedPlate, cleanOt, "", ""]]
      }
    });

    targetRow = appendRes.data.updates ? appendRes.data.updates.updatedRange : 'APPENDED';
    dbUpdated = true;
  }

  return {
    success: true,
    action: matchedType === 'NEW_ENTRY' ? 'INSERTED' : 'UPDATED',
    row: targetRow,
    matchedType: matchedType,
    matchedPlate: matchedPlate,
    detectedPlates: matches,
    otNumber: cleanOt,
    timestamp: new Date().toISOString()
  };
}

/**
 * Sincronización masiva de OTs (Batch / Cron) desde el formulario de origen hacia DB_OT_LIST.
 * @param {object} params
 * @param {object} params.sheetsClient - Cliente autenticado de Google Sheets
 * @param {string} params.sourceSpreadsheetId - ID del spreadsheet de respuestas (1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk)
 * @param {string} params.targetSpreadsheetId - ID de la base de datos destino (1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc)
 * @returns {Promise<object>} Estadísticas de la sincronización
 */
async function syncFullOtDatabase({ sheetsClient, sourceSpreadsheetId, targetSpreadsheetId }) {
  if (!sheetsClient) throw new Error("Cliente de Google Sheets no inicializado");
  if (!sourceSpreadsheetId) throw new Error("ID de spreadsheet origen requerido");
  if (!targetSpreadsheetId) throw new Error("ID de spreadsheet destino requerido");

  const startTime = Date.now();

  // 1. Leer columnas E a I desde 'Respuestas de formulario 4'
  const sourceRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sourceSpreadsheetId,
    range: "'Respuestas de formulario 4'!E:I"
  });

  const sourceData = sourceRes.data.values || [];
  if (sourceData.length < 2) {
    return { success: false, error: "No se encontraron datos en el formulario origen" };
  }

  // 2. Extracción LIFO (Lo último reportado es lo válido)
  const latestOts = new Map();

  for (let i = sourceData.length - 1; i >= 1; i--) {
    const rawPlateCell = sourceData[i][0]; // Col E (Índice 0 dentro del rango E:I)
    const otNumberCell = sourceData[i][4]; // Col I (Índice 4 dentro del rango E:I)

    const otNumber = String(otNumberCell || '').trim();
    if (otNumber && rawPlateCell) {
      const plates = extractPlates(rawPlateCell);
      for (const plate of plates) {
        if (!latestOts.has(plate)) {
          latestOts.set(plate, otNumber);
        }
      }
    }
  }

  // 3. Preparación de la base de datos destino
  const targetRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A:C"
  });

  const targetData = targetRes.data.values || [];
  if (targetData.length < 2) {
    return { success: false, error: "La pestaña DB_OT_LIST está vacía o sin encabezados" };
  }

  const updates = [];
  let updatedCount = 0;
  let changedCount = 0;

  // Recorrer filas de la DB destino
  for (let i = 1; i < targetData.length; i++) {
    const tractorRaw = targetData[i][0];
    const currentOt = String(targetData[i][1] || '').trim();
    const semiRaw = targetData[i][2];

    const tractorPlates = extractPlates(tractorRaw);
    const semiPlates = extractPlates(semiRaw);

    const cleanTractor = tractorPlates[0] || null;
    const cleanSemi = semiPlates[0] || null;

    let targetOt = currentOt;

    // Si coincide el Tractor o el Semi con una OT reciente en el mapa
    if (cleanTractor && latestOts.has(cleanTractor)) {
      targetOt = latestOts.get(cleanTractor);
      updatedCount++;
    } else if (cleanSemi && latestOts.has(cleanSemi)) {
      targetOt = latestOts.get(cleanSemi);
      updatedCount++;
    }

    if (targetOt !== currentOt) {
      changedCount++;
    }

    updates.push([targetOt]);
  }

  // 4. Transacción Atómica en bloque sobre Col B (Rango B2:B)
  if (updates.length > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: targetSpreadsheetId,
      range: `'DB_OT_LIST'!B2:B${updates.length + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: updates }
    });
  }

  const durationMs = Date.now() - startTime;
  console.log(`✅ Sincronización masiva de OTs completada en ${durationMs}ms: ${updates.length} filas procesadas, ${changedCount} cambios aplicados.`);

  return {
    success: true,
    totalRows: updates.length,
    matchedCount: updatedCount,
    changedCount: changedCount,
    uniqueExtractedPlates: latestOts.size,
    durationMs: durationMs,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  extractPlates,
  processSingleOtUpdate,
  syncFullOtDatabase
};
