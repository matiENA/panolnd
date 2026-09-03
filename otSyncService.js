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
 * Sincronización de OTs delimitada estrictamente por la planilla mensual de Movimientos.
 * Regla de Oro: DB_OT_LIST está 100% delimitada por la flota activa de 1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8.
 * No se permite la inyección sistemática de patentes viejas o dadas de baja.
 */
async function syncFullOtDatabase({
  sheetsClient,
  sourceSpreadsheetId,
  targetSpreadsheetId,
  movimientosSpreadsheetId
}) {
  return syncCanonicalFleetToDbOtList({
    sheetsClient,
    targetSpreadsheetId,
    movimientosSpreadsheetId: movimientosSpreadsheetId || process.env.MES_MOVIMIENTOS_ID,
    formSpreadsheetId: sourceSpreadsheetId
  });
}

const { syncCanonicalFleetToDbOtList } = require('./fleetMasterSyncService');

module.exports = {
  extractPlates,
  processSingleOtUpdate,
  syncFullOtDatabase,
  syncCanonicalFleetToDbOtList
};

