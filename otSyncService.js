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
 * Soporta formato Mercosur (AA123BB, AA 123 BB, AA-123-BB) y Tradicional (AAA123, AAA 123, AAA-123).
 * Descarta falsos positivos de nombres de maquinaria o palabras compuestas.
 * @param {string} rawString 
 * @returns {string[]} Lista de patentes limpias únicas
 */
function extractPlates(rawString) {
  if (!rawString) return [];
  const upper = String(rawString).toUpperCase().trim();

  // Filtrar nombres y términos de maquinaria común
  const cleaned = upper
    .replace(/\b(BOBCAT|CATERPILLAR|CARGADORA|MOTO|MOTONIVELADORA|MANITU|ELEVADOR|IZUZU|CHASIS|INTERNO|TALLER|ACOPLADO|PALA|GRUPO)\b/g, ' ')
    .trim();

  // Dividir por delimitadores estándar de formularios y combinaciones
  const tokens = cleaned.split(/[\/+,;\n\r\t()\[\]]+/);
  const plates = [];

  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;

    // 1. Mercosur (2 letras, 3 números, 2 letras)
    const mercosurMatch = t.match(/\b([A-Z]{2})[\s\-_.]*(\d{3})[\s\-_.]*([A-Z]{2})\b/);
    if (mercosurMatch) {
      const p = `${mercosurMatch[1]}${mercosurMatch[2]}${mercosurMatch[3]}`;
      if (!plates.includes(p)) plates.push(p);
      continue;
    }

    // 2. Tradicional (3 letras, 3 números)
    const tradMatch = t.match(/\b([A-Z]{3})[\s\-_.]*(\d{3})\b/);
    if (tradMatch) {
      const p = `${tradMatch[1]}${tradMatch[2]}`;
      if (!plates.includes(p)) plates.push(p);
      continue;
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

  // Leer rango A:G de DB_OT_LIST para verificar existencia completa
  const getRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A:G"
  });

  const dbData = getRes.data.values || [];
  let dbUpdated = false;
  let targetRow = null;
  let matchedType = null;
  let matchedPlate = null;

  const tractorPlate = matches[0];
  const semiPlate = matches.length > 1 ? matches[1] : "";

  // Prägnanz: Unificación de búsqueda - Comparamos con Tractor (Col A) y Semi (Col C)
  for (let i = 1; i < dbData.length; i++) {
    const dbTractor = String(dbData[i][0] || '').toUpperCase().replace(/[\s\-_.]/g, ''); // Col A
    const dbSemi = String(dbData[i][2] || '').toUpperCase().replace(/[\s\-_.]/g, '');    // Col C

    const found = matches.find(p => (dbTractor && p === dbTractor) || (dbSemi && p === dbSemi));
    if (found) {
      targetRow = i + 1; // Fila exacta en Google Sheets (1-indexed)
      matchedPlate = found;
      matchedType = (dbTractor && found === dbTractor) ? "TRACTOR" : "SEMI";

      // 1. Sobreescribimos la Columna B (Índice 2)
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: targetSpreadsheetId,
        range: `'DB_OT_LIST'!B${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[cleanOt]] }
      });

      // Si la fila tenía el Tractor vacío y ahora vino emparejado con un Semi conocido, completamos Col A
      if (!dbTractor && tractorPlate && tractorPlate !== dbSemi) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: targetSpreadsheetId,
          range: `'DB_OT_LIST'!A${targetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[tractorPlate]] }
        });
      }

      dbUpdated = true;
      break; // Poka-Yoke: Detenemos el bucle al instante para evitar cualquier duplicación
    }
  }

  // Si no hubo coincidencias en la flota canónica activa, BLINDAMOS DB_OT_LIST y omitimos inserción
  if (!dbUpdated) {
    console.warn(`🛡️ [Blindaje DB_OT_LIST] Patente (${dirtyPlate} -> ${matches.join(', ')}) no pertenece a la flota canónica activa. Inserción omitida.`);
    return {
      success: false,
      action: 'IGNORED_NOT_IN_CANONICAL_FLEET',
      detectedPlates: matches,
      otNumber: cleanOt,
      message: 'La patente no pertenece a la flota canónica activa de DB_OT_LIST'
    };
  }

  return {
    success: true,
    action: 'UPDATED',
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
 * Extrae todas las respuestas históricas y recientes, actualiza OTs existentes,
 * completa celdas vacías e inyecta nuevas patentes/unidades que no existían en DB_OT_LIST.
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

  // 1. Leer columnas de formulario origen (Rango A:K para capturar Fecha, Patente y OT)
  const sourceRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sourceSpreadsheetId,
    range: "'Respuestas de formulario 4'!A1:K"
  });

  const sourceData = sourceRes.data.values || [];
  if (sourceData.length < 2) {
    return { success: false, error: "No se encontraron datos en el formulario origen" };
  }

  // 2. Extracción LIFO (Lo último reportado es lo válido)
  const latestOts = new Map();
  const latestEntryByPlate = new Map();
  const recentFormPairs = [];

  for (let i = sourceData.length - 1; i >= 1; i--) {
    const rawPlateCell = sourceData[i][4]; // Col E (Índice 4)
    const otNumberCell = sourceData[i][8]; // Col I (Índice 8)
    const timestamp = sourceData[i][2];    // Col C (Índice 2)

    const otNumber = String(otNumberCell || '').trim();
    if (otNumber && otNumber !== '#REF!' && rawPlateCell) {
      const plates = extractPlates(rawPlateCell);
      if (plates.length > 0) {
        const tractor = plates[0];
        const semi = plates.length > 1 ? plates[1] : '';

        plates.forEach(plate => {
          if (!latestOts.has(plate)) {
            latestOts.set(plate, otNumber);
            latestEntryByPlate.set(plate, { tractor, semi, otNumber, timestamp });
          }
        });

        recentFormPairs.push({ tractor, semi, otNumber, timestamp });
      }
    }
  }

  // 3. Lectura de la base de datos destino DB_OT_LIST
  const targetRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A1:G"
  });

  const targetData = targetRes.data.values || [];
  if (targetData.length < 2) {
    return { success: false, error: "La pestaña DB_OT_LIST está vacía o sin encabezados" };
  }

  const updatedRows = [];
  const dbPlatesMatched = new Set();
  let updatedCount = 0;
  let changedCount = 0;
  let filledTractorCount = 0;

  // 4. Actualizar filas existentes en DB_OT_LIST
  for (let i = 1; i < targetData.length; i++) {
    const row = [...targetData[i]];
    while (row.length < 7) row.push('');

    const originalTractor = String(row[0] || '').trim();
    const originalOt = String(row[1] || '').trim();
    const originalSemi = String(row[2] || '').trim();
    const originalSemiOt = String(row[3] || '').trim();
    const originalProd = String(row[4] || '').trim();
    const originalMarca = String(row[5] || '').trim();
    const originalMarcaSemi = String(row[6] || '').trim();

    const cleanTractor = extractPlates(originalTractor)[0] || '';
    const cleanSemi = extractPlates(originalSemi)[0] || '';

    let updatedTractor = originalTractor;
    let updatedOt = originalOt;

    // Coincidencia por Tractor o por Semi
    if (cleanTractor && latestOts.has(cleanTractor)) {
      updatedOt = latestOts.get(cleanTractor);
      dbPlatesMatched.add(cleanTractor);
      if (cleanSemi) dbPlatesMatched.add(cleanSemi);
      updatedCount++;
    } else if (cleanSemi && latestOts.has(cleanSemi)) {
      updatedOt = latestOts.get(cleanSemi);
      dbPlatesMatched.add(cleanSemi);
      updatedCount++;

      // Si el Tractor estaba vacío y el Semi fue reportado con un Tractor conocido, completar Col A
      if (!originalTractor && latestEntryByPlate.has(cleanSemi)) {
        const pair = latestEntryByPlate.get(cleanSemi);
        if (pair.tractor && pair.tractor !== cleanSemi) {
          updatedTractor = pair.tractor;
          dbPlatesMatched.add(pair.tractor);
          filledTractorCount++;
        }
      }
    }

    if (updatedOt !== originalOt || updatedTractor !== originalTractor) {
      changedCount++;
    }

    updatedRows.push([
      updatedTractor,
      updatedOt,
      originalSemi,
      originalSemiOt,
      originalProd,
      originalMarca,
      originalMarcaSemi
    ]);
  }

  // 5. Detectar nuevas patentes e inyectar filas para unidades no registradas en DB_OT_LIST
  const newRowsToAppend = [];
  const addedPlates = new Set();

  for (const pair of recentFormPairs) {
    const t = pair.tractor;
    const s = pair.semi;

    const tExists = dbPlatesMatched.has(t) || addedPlates.has(t);
    const sExists = s ? (dbPlatesMatched.has(s) || addedPlates.has(s)) : true;

    if (!tExists) {
      addedPlates.add(t);
      if (s) addedPlates.add(s);

      newRowsToAppend.push([
        t,
        pair.otNumber,
        s || '',
        '',
        'GENERAL',
        '',
        ''
      ]);
    }
  }

  // 6. Transacción Atómica en bloque sobre DB_OT_LIST!A2:G
  if (updatedRows.length > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: targetSpreadsheetId,
      range: `'DB_OT_LIST'!A2:G${updatedRows.length + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: updatedRows }
    });
  }

  // 7. Si hay filas nuevas, inyectarlas al final de la tabla
  if (newRowsToAppend.length > 0) {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: targetSpreadsheetId,
      range: "'DB_OT_LIST'!A:G",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRowsToAppend }
    });
  }

  const durationMs = Date.now() - startTime;
  console.log(`✅ Sincronización masiva de OTs completada en ${durationMs}ms: ${updatedRows.length} filas actualizadas (${changedCount} cambios, ${filledTractorCount} tractores completados), ${newRowsToAppend.length} nuevas patentes añadidas.`);

  return {
    success: true,
    totalRows: updatedRows.length + newRowsToAppend.length,
    existingRowsUpdated: updatedRows.length,
    changedCount: changedCount,
    filledTractorCount: filledTractorCount,
    newRowsAppended: newRowsToAppend.length,
    uniqueExtractedPlates: latestOts.size,
    durationMs: durationMs,
    timestamp: new Date().toISOString()
  };
}

const { syncCanonicalFleetToDbOtList } = require('./fleetMasterSyncService');

module.exports = {
  extractPlates,
  processSingleOtUpdate,
  syncFullOtDatabase,
  syncCanonicalFleetToDbOtList
};

