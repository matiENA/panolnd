/**
 * otsManagerService.js
 * Servicio para la gestión de OTs vigentes en 'ots', histórico en 'ots_anteriores'
 * y resolución desacoplada con el índice de flota 'DB_OT_LIST'.
 * 
 * Reglas de Negocio:
 * 1. 'DB_OT_LIST' es el índice maestro canónico de unión entre Tractor (Col A) y Semi (Col C).
 * 2. 'ots' contiene ÚNICAMENTE la OT más actual por dominio, determinada por 'FECHA INGRESO' (Col B).
 * 3. Cuando ingresa una nueva OT para un dominio, la OT precedente pasa a 'ots_anteriores'.
 * 4. 'ots_anteriores' preserva el histórico completo con la misma estructura que 'ots'.
 * 5. La App Taller consulta 'findUnitOrOt' resolviendo la unión en 'DB_OT_LIST' y las OTs vigentes en 'ots'.
 */

const fs = require('fs');
const path = require('path');
const { extractPlates } = require('./plateNormalizer');

const OTS_TAB = 'ots';
const OTS_ANTERIORES_TAB = 'ots_anteriores';
const HISTORICO_COLD_TAB = 'HISTORICO_COLD';
const DB_OT_LIST_TAB = 'DB_OT_LIST';

const ARCHIVE_DIR = path.join(__dirname, 'data');
const ARCHIVE_JSON_FILE = path.join(ARCHIVE_DIR, 'ots_historico_cold.json');
const ARCHIVE_CSV_FILE = path.join(ARCHIVE_DIR, 'ots_historico_cold.csv');
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000; // 180 días (~6 meses)

const OTS_HEADERS = [
  'KEY',
  'FECHA INGRESO',
  'ORDEN Nº',
  'DOMINIO',
  'SECTOR / TAREAS',
  'CIERRE / RESPALDO TAREAS',
  'PAYLOAD',
  'CONFIRMACIÓN DE TAREAS'
];

/**
 * Normaliza una patente eliminando espacios, guiones y puntos.
 */
function normalizePlate(plateStr) {
  if (!plateStr) return '';
  const clean = String(plateStr).toUpperCase().replace(/[\s\-_.]/g, '');
  const extracted = extractPlates(clean);
  return extracted.length > 0 ? extracted[0] : clean;
}

/**
 * Normaliza un número de OT eliminando sufijos decimales (.0), ceros a la izquierda y espacios.
 */
function normalizeOt(otStr) {
  if (!otStr) return '';
  let clean = String(otStr).trim().replace(/\.0+$/, '');
  const noLeadingZeros = clean.replace(/^0+/, '');
  return noLeadingZeros || clean;
}

/**
 * Parsea fechas en formatos 'DD/MM/YYYY', 'DD/MM/YYYY HH:mm:ss' o ISO para comparación cronológica.
 * Retorna un timestamp en milisegundos.
 */
function parseDateScore(dateStr, otFallback = '') {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  const s = dateStr.trim();

  // Intento 1: Formato DD/MM/YYYY o DD/MM/YYYY HH:mm:ss
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1; // 0-indexed
    const year = parseInt(dmyMatch[3], 10);
    const hours = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
    const minutes = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
    const seconds = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
    const dt = new Date(year, month, day, hours, minutes, seconds);
    if (!isNaN(dt.getTime())) {
      return dt.getTime();
    }
  }

  // Intento 2: ISO Date
  const parsedIso = Date.parse(s);
  if (!isNaN(parsedIso)) {
    return parsedIso;
  }

  // Fallback secundario: si no tiene fecha válida, usa el número de OT si es numérico
  const otNum = parseInt(String(otFallback).replace(/\D/g, ''), 10);
  return !isNaN(otNum) ? otNum : 0;
}

/**
 * Garantiza que las pestañas 'ots' y 'ots_anteriores' existan con los encabezados correctos.
 */
let otsStructureEnsured = false;

async function ensureOtsStructure(sheetsClient, spreadsheetId, force = false) {
  if (!sheetsClient || !spreadsheetId) return;
  if (!force && otsStructureEnsured) return;

  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const existingSheets = meta.data.sheets.map(s => s.properties.title);
    const requests = [];

    if (!existingSheets.includes(OTS_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: OTS_TAB,
            gridProperties: { rowCount: 1000, columnCount: 10 }
          }
        }
      });
    }

    if (!existingSheets.includes(OTS_ANTERIORES_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: OTS_ANTERIORES_TAB,
            gridProperties: { rowCount: 2000, columnCount: 10 }
          }
        }
      });
    }

    if (!existingSheets.includes(HISTORICO_COLD_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: HISTORICO_COLD_TAB,
            gridProperties: { rowCount: 3000, columnCount: 10 }
          }
        }
      });
    }

    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
      console.log(`✅ [otsManager] Pestañas creadas: ${requests.map(r => r.addSheet.properties.title).join(', ')}`);
    }

    // Asegurar encabezados en 'ots' (A1:H1)
    const otsHeadRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_TAB}'!A1:H1`
    });
    if (!otsHeadRes.data.values || otsHeadRes.data.values.length === 0 || otsHeadRes.data.values[0].length < 8) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_TAB}'!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [OTS_HEADERS] }
      });
    }

    // Asegurar encabezados en 'ots_anteriores' (A1:H1)
    const antHeadRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_ANTERIORES_TAB}'!A1:H1`
    });
    if (!antHeadRes.data.values || antHeadRes.data.values.length === 0 || antHeadRes.data.values[0].length < 8) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_ANTERIORES_TAB}'!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [OTS_HEADERS] }
      });
      console.log(`✅ [otsManager] Encabezados inicializados en ${OTS_ANTERIORES_TAB}`);
    }

    // Asegurar encabezados en 'HISTORICO_COLD' (A1:H1)
    const coldHeadRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${HISTORICO_COLD_TAB}'!A1:H1`
    });
    if (!coldHeadRes.data.values || coldHeadRes.data.values.length === 0 || coldHeadRes.data.values[0].length < 8) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${HISTORICO_COLD_TAB}'!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [OTS_HEADERS] }
      });
      console.log(`✅ [otsManager] Encabezados inicializados en ${HISTORICO_COLD_TAB}`);
    }

    otsStructureEnsured = true;
  } catch (err) {
    console.error('❌ [otsManager] Error en ensureOtsStructure:', err.message);
  }
}

/**
 * Guarda las OTs de más de 6 meses en un archivo local (JSON y CSV) de forma acumulativa y sin duplicados.
 */
function archiveColdOts(rowsToArchive) {
  if (!rowsToArchive || rowsToArchive.length === 0) return { newlyArchived: 0, totalColdCount: 0 };

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }

    let existingData = [];
    if (fs.existsSync(ARCHIVE_JSON_FILE)) {
      try {
        const raw = fs.readFileSync(ARCHIVE_JSON_FILE, 'utf8');
        existingData = JSON.parse(raw);
        if (!Array.isArray(existingData)) existingData = [];
      } catch (errParse) {
        console.warn('⚠️ No se pudo parsear archivo frío previo, reinicializando:', errParse.message);
      }
    }

    const mapByKey = new Map();
    existingData.forEach(item => {
      const key = `${item.dominio}__${item.ot}`;
      mapByKey.set(key, item);
    });

    let newlyAdded = 0;
    rowsToArchive.forEach(r => {
      const keyStr = String(r[0] || '').trim();
      const fecha = String(r[1] || '').trim();
      const rawOt = String(r[2] || '').trim();
      const cleanOt = normalizeOt(rawOt);
      const rawDom = String(r[3] || '').trim();
      const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
      const sectorTareas = String(r[4] || '').trim();
      const cierreRespaldo = String(r[5] || '').trim();
      const payload = r[6] || '';
      const confirmacion = String(r[7] || '').trim();

      if (!cleanDom || !cleanOt) return;

      const uKey = `${cleanDom}__${cleanOt}`;
      if (!mapByKey.has(uKey)) {
        newlyAdded++;
      }
      mapByKey.set(uKey, {
        key: keyStr || `${cleanDom} - ${cleanOt}`,
        fecha,
        rawOt,
        ot: cleanOt,
        dominio: cleanDom,
        sectorTareas,
        cierreRespaldo,
        payload,
        confirmacion,
        archivedAt: new Date().toISOString()
      });
    });

    const combinedList = Array.from(mapByKey.values());
    combinedList.sort((a, b) => parseDateScore(b.fecha, b.ot) - parseDateScore(a.fecha, a.ot));

    fs.writeFileSync(ARCHIVE_JSON_FILE, JSON.stringify(combinedList, null, 2), 'utf8');

    const csvHeader = ['KEY', 'FECHA INGRESO', 'ORDEN Nº', 'DOMINIO', 'SECTOR / TAREAS', 'CIERRE / RESPALDO TAREAS', 'PAYLOAD', 'CONFIRMACIÓN DE TAREAS', 'ARCHIVED_AT'].join(';');
    const csvRows = combinedList.map(item => {
      const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
      return [
        escapeCsv(item.key),
        escapeCsv(item.fecha),
        escapeCsv(item.ot),
        escapeCsv(item.dominio),
        escapeCsv(item.sectorTareas),
        escapeCsv(item.cierreRespaldo),
        escapeCsv(item.payload),
        escapeCsv(item.confirmacion),
        escapeCsv(item.archivedAt)
      ].join(';');
    });
    fs.writeFileSync(ARCHIVE_CSV_FILE, '\ufeff' + [csvHeader, ...csvRows].join('\n'), 'utf8');

    console.log(`❄️ [otsManager ColdArchive] ${newlyAdded} OTs archivadas en '${ARCHIVE_JSON_FILE}'. Total acumulado: ${combinedList.length}.`);
    return { success: true, newlyArchived: newlyAdded, totalColdCount: combinedList.length };
  } catch (err) {
    console.error('❌ Error al archivar en frío:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Depura la pestaña 'ots' y 'ots_anteriores':
 * 1. En 'ots': Retiene ÚNICAMENTE la OT más actual por cada dominio (por FECHA INGRESO).
 * 2. Poka-Yoke: Si hay recarga de la MISMA OT vigente, se descarta el duplicado y NO se pasa a 'ots_anteriores'.
 * 3. En 'ots_anteriores': Preserva el histórico asegurando que cada (DOMINIO, OT) exista exactamente UNA vez (sin duplicados).
 * 4. Retención de 6 meses (Wipe): Solo están disponibles en la hoja las de los últimos 6 meses.
 *    Mayores a 6 meses se purgan de Google Sheets y se resguardan en archivo local / cold archive.
 * 5. Mínimo trabajo de backend: Usa 1 sola lectura HTTP en batchGet para ambas pestañas y solo escribe si hay cambios reales.
 */
async function migrateAndDeduplicateOts(sheetsClient, spreadsheetId) {
  if (!sheetsClient || !spreadsheetId) return { success: false, error: 'Cliente inválido' };

  await ensureOtsStructure(sheetsClient, spreadsheetId);

  // 1. Una sola lectura HTTP en batch para 'ots', 'ots_anteriores' e 'HISTORICO_COLD' (mínimo trabajo de backend)
  const batchRes = await sheetsClient.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [`'${OTS_TAB}'!A2:H1000`, `'${OTS_ANTERIORES_TAB}'!A2:H3000`, `'${HISTORICO_COLD_TAB}'!A2:H5000`]
  });

  const valRanges = batchRes.data.valueRanges || [];
  const otsRows = (valRanges[0] && valRanges[0].values) || [];
  const antRows = (valRanges[1] && valRanges[1].values) || [];
  const coldRows = (valRanges[2] && valRanges[2].values) || [];

  const now = Date.now();
  const cutoffScore = now - SIX_MONTHS_MS;

  // 2. Agrupar filas de 'ots' por DOMINIO normalizado
  const byDomain = new Map();
  otsRows.forEach((r, idx) => {
    const rawDom = String(r[3] || '').trim();
    const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
    if (!cleanDom) return;

    if (!byDomain.has(cleanDom)) {
      byDomain.set(cleanDom, []);
    }
    const rawOt = String(r[2] || '').trim();
    const cleanOt = normalizeOt(rawOt);
    byDomain.get(cleanDom).push({
      originalRow: r,
      rowIndex: idx + 2,
      rawOt,
      cleanOt,
      fecha: String(r[1] || '').trim(),
      score: parseDateScore(String(r[1] || ''), rawOt)
    });
  });

  const rowsToKeepInOts = [];
  const activeOtsByDomain = new Map(); // cleanDom -> Set de OTs activas vigentes
  const trueHistoricalCandidates = [];

  byDomain.forEach((records, domain) => {
    // Ordenar de más reciente a más antiguo (score descendente)
    records.sort((a, b) => b.score - a.score);

    // La primera fila es la OT más actual del dominio
    const topRecord = records[0];
    rowsToKeepInOts.push(topRecord.originalRow);

    if (!activeOtsByDomain.has(domain)) {
      activeOtsByDomain.set(domain, new Set());
    }
    if (topRecord.cleanOt) {
      activeOtsByDomain.get(domain).add(topRecord.cleanOt);
    }

    // Poka-Yoke: Las demás filas del dominio en 'ots' van a histórico solo si representan una OT DISTINTA
    for (let i = 1; i < records.length; i++) {
      const rec = records[i];
      if (rec.cleanOt && rec.cleanOt !== topRecord.cleanOt) {
        trueHistoricalCandidates.push(rec);
      } else {
        console.log(`🧹 [otsManager] Descartada recarga redundante de OT ${rec.cleanOt} para ${domain}.`);
      }
    }
  });

  // 3. Procesar 'ots_anteriores' y clasificar hacia <= 6 meses o > 6 meses
  const seenHistoricalKeys = new Set();
  const within6MonthsRows = [];
  const candidateColdFromAnt = [];

  // A. Depurar las filas ya existentes en 'ots_anteriores'
  antRows.forEach(r => {
    const rawDom = String(r[3] || '').trim();
    const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
    const rawOt = String(r[2] || '').trim();
    const cleanOt = normalizeOt(rawOt);
    if (!cleanDom || !cleanOt) return;

    // Si coincide con la OT activa actual del dominio, removerla de anteriores
    const activeSet = activeOtsByDomain.get(cleanDom);
    if (activeSet && activeSet.has(cleanOt)) {
      console.log(`🧹 [otsManager] Removiendo OT ${cleanOt} de ${OTS_ANTERIORES_TAB} porque es la vigente en '${OTS_TAB}'.`);
      return;
    }

    const uniqueKey = `${cleanDom}__${cleanOt}`;
    if (!seenHistoricalKeys.has(uniqueKey)) {
      seenHistoricalKeys.add(uniqueKey);
      const score = parseDateScore(String(r[1] || ''), cleanOt);
      if (score > 0 && score < cutoffScore) {
        candidateColdFromAnt.push(r);
      } else {
        within6MonthsRows.push(r);
      }
    }
  });

  // B. Clasificar las OTs verdaderamente anteriores provenientes de 'ots'
  let newMovedCount = 0;
  trueHistoricalCandidates.forEach(cand => {
    const rawDom = String(cand.originalRow[3] || '').trim();
    const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
    const uniqueKey = `${cleanDom}__${cand.cleanOt}`;

    if (!seenHistoricalKeys.has(uniqueKey)) {
      seenHistoricalKeys.add(uniqueKey);
      if (cand.score > 0 && cand.score < cutoffScore) {
        candidateColdFromAnt.push(cand.originalRow);
      } else {
        within6MonthsRows.push(cand.originalRow);
      }
      newMovedCount++;
    }
  });

  // C. Procesar 'HISTORICO_COLD' (Misma estructura de 8 columnas A:H)
  const seenColdKeys = new Set();
  const finalColdRows = [];

  coldRows.forEach(r => {
    const rawDom = String(r[3] || '').trim();
    const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
    const rawOt = String(r[2] || '').trim();
    const cleanOt = normalizeOt(rawOt);
    if (!cleanDom || !cleanOt) return;

    const uKey = `${cleanDom}__${cleanOt}`;
    if (!seenColdKeys.has(uKey)) {
      seenColdKeys.add(uKey);
      finalColdRows.push(r);
    }
  });

  let newColdMovedCount = 0;
  candidateColdFromAnt.forEach(r => {
    const rawDom = String(r[3] || '').trim();
    const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
    const rawOt = String(r[2] || '').trim();
    const cleanOt = normalizeOt(rawOt);
    if (!cleanDom || !cleanOt) return;

    const uKey = `${cleanDom}__${cleanOt}`;
    if (!seenColdKeys.has(uKey)) {
      seenColdKeys.add(uKey);
      finalColdRows.push(r);
      newColdMovedCount++;
    }
  });

  // Sincronizar respaldo local acumulativo
  if (finalColdRows.length > 0) {
    archiveColdOts(finalColdRows);
  }

  const finalAntRows = within6MonthsRows;

  console.log(`📋 [otsManager] Estado: ${rowsToKeepInOts.length} vigentes en '${OTS_TAB}', ${finalAntRows.length} semestrales en '${OTS_ANTERIORES_TAB}', ${finalColdRows.length} en '${HISTORICO_COLD_TAB}'.`);

  // 4. Escritura en Google Sheets solo si hay cambios reales

  // ¿Cambió 'ots'?
  const otsChanged = otsRows.length !== rowsToKeepInOts.length;
  if (otsChanged) {
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${OTS_TAB}'!A2:H1000`
    });

    if (rowsToKeepInOts.length > 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_TAB}'!A2:H${rowsToKeepInOts.length + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToKeepInOts }
      });
      console.log(`✨ [otsManager] '${OTS_TAB}' actualizada con ${rowsToKeepInOts.length} OTs vigentes.`);
    }
  }

  // ¿Cambió 'ots_anteriores'?
  const antChanged = antRows.length !== finalAntRows.length || newMovedCount > 0 || candidateColdFromAnt.length > 0;
  if (antChanged) {
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${OTS_ANTERIORES_TAB}'!A2:H3000`
    });

    if (finalAntRows.length > 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_ANTERIORES_TAB}'!A2:H${finalAntRows.length + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: finalAntRows }
      });
      console.log(`📦 [otsManager] '${OTS_ANTERIORES_TAB}' depurada (≤ 6 meses): ${finalAntRows.length} registros.`);
    }
  }

  // ¿Cambió 'HISTORICO_COLD'?
  const coldChanged = coldRows.length !== finalColdRows.length || newColdMovedCount > 0;
  if (coldChanged) {
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${HISTORICO_COLD_TAB}'!A2:H5000`
    });

    if (finalColdRows.length > 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${HISTORICO_COLD_TAB}'!A2:H${finalColdRows.length + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: finalColdRows }
      });
      console.log(`❄️ [otsManager] '${HISTORICO_COLD_TAB}' sincronizada (> 6 meses): ${finalColdRows.length} registros.`);
    }
  }

  invalidateOtsCache();

  return {
    success: true,
    keptCount: rowsToKeepInOts.length,
    antCount: finalAntRows.length,
    coldCount: finalColdRows.length,
    newMovedCount,
    newColdMovedCount,
    otsChanged,
    antChanged,
    coldChanged
  };
}

/**
 * Registra o actualiza una OT recibida.
 * Si ya existe una OT para ese dominio en 'ots':
 * - La anterior se traslada a 'ots_anteriores'.
 * - La nueva queda en 'ots' si es más actual.
 */
async function processNewOtRecord(sheetsClient, spreadsheetId, newOtData) {
  if (!sheetsClient || !spreadsheetId || !newOtData) return { success: false, error: 'Datos insuficientes' };

  await ensureOtsStructure(sheetsClient, spreadsheetId);

  const {
    fecha = '',
    otNumber = '',
    dominio = '',
    sectorTareas = '',
    cierreRespaldo = '',
    payload = '',
    confirmacion = ''
  } = newOtData;

  const cleanDom = normalizePlate(dominio) || String(dominio).trim().toUpperCase();
  const cleanOt = normalizeOt(otNumber);

  if (!cleanDom || !cleanOt) {
    return { success: false, error: 'Dominio y número de OT son obligatorios' };
  }

  const key = `${cleanDom} - ${cleanOt.padStart(8, '0')}`;
  const nowStr = new Date().toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
  const finalFecha = fecha || nowStr;

  const formattedRow = [
    key,
    finalFecha,
    cleanOt.padStart(8, '0'),
    cleanDom,
    sectorTareas || '',
    cierreRespaldo || '',
    typeof payload === 'object' ? JSON.stringify(payload) : (payload || ''),
    confirmacion || ''
  ];

  const now = Date.now();
  const cutoffScore = now - SIX_MONTHS_MS;
  const newScore = parseDateScore(finalFecha, cleanOt);

  // Leer 'ots' actual (8 columnas)
  const otsRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${OTS_TAB}'!A2:H1000`
  });
  const rows = otsRes.data.values || [];

  let existingIndex = -1;
  let existingRow = null;

  for (let i = 0; i < rows.length; i++) {
    const rDom = normalizePlate(rows[i][3]) || String(rows[i][3] || '').trim().toUpperCase();
    if (rDom === cleanDom) {
      existingIndex = i + 2; // Fila 1-indexed en Google Sheets
      existingRow = rows[i];
      break;
    }
  }

  if (existingIndex > 0) {
    const existingScore = parseDateScore(String(existingRow[1] || ''), String(existingRow[2] || ''));
    const existingOt = normalizeOt(existingRow[2]);

    if (existingOt === cleanOt) {
      // Es la misma OT: actualizar la fila en 'ots' por si cambiaron tareas, payload o confirmación
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_TAB}'!A${existingIndex}:H${existingIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [formattedRow] }
      });
      console.log(`🔄 [otsManager] OT ${cleanOt} para ${cleanDom} actualizada en fila ${existingIndex}.`);
      invalidateOtsCache();
      return { success: true, action: 'UPDATED_CURRENT', row: existingIndex, dominio: cleanDom, ot: cleanOt };
    }

    if (newScore >= existingScore) {
      // La nueva es más actual: trasladar la anterior a 'ots_anteriores' (o HISTORICO_COLD si > 6M)
      const targetHistoricalTab = (existingScore > 0 && existingScore < cutoffScore) ? HISTORICO_COLD_TAB : OTS_ANTERIORES_TAB;
      const antGetRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${targetHistoricalTab}'!A2:D3000`
      });
      const antRows = antGetRes.data.values || [];
      const alreadyInAnt = antRows.some(r => {
        const d = normalizePlate(r[3]) || String(r[3] || '').trim().toUpperCase();
        const o = normalizeOt(r[2]);
        return d === cleanDom && o === existingOt;
      });

      if (!alreadyInAnt) {
        const nextAntRow = antRows.length + 2;
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId,
          range: `'${targetHistoricalTab}'!A${nextAntRow}:H${nextAntRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [existingRow] }
        });
        console.log(`⚡ [otsManager] OT anterior ${existingOt} para ${cleanDom} movida a ${targetHistoricalTab} (fila ${nextAntRow}).`);
      }

      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${OTS_TAB}'!A${existingIndex}:H${existingIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [formattedRow] }
      });

      console.log(`✨ [otsManager] Nueva OT ${cleanOt} vigente en 'ots' (fila ${existingIndex}).`);
      invalidateOtsCache();
      return {
        success: true,
        action: 'SUPERSEDED_AND_MOVED',
        dominio: cleanDom,
        newOt: cleanOt,
        archivedOt: existingOt
      };
    } else {
      // La nueva es más vieja que la vigente: entra a 'ots_anteriores' o 'HISTORICO_COLD'
      const targetHistoricalTab = (newScore > 0 && newScore < cutoffScore) ? HISTORICO_COLD_TAB : OTS_ANTERIORES_TAB;
      const antGetRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${targetHistoricalTab}'!A2:D3000`
      });
      const antRows = antGetRes.data.values || [];
      const alreadyInAnt = antRows.some(r => {
        const d = normalizePlate(r[3]) || String(r[3] || '').trim().toUpperCase();
        const o = normalizeOt(r[2]);
        return d === cleanDom && o === cleanOt;
      });

      if (!alreadyInAnt) {
        const nextAntRow = antRows.length + 2;
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId,
          range: `'${targetHistoricalTab}'!A${nextAntRow}:H${nextAntRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [formattedRow] }
        });
        console.log(`📁 [otsManager] OT ${cleanOt} ingresada a ${targetHistoricalTab} (fila ${nextAntRow}).`);
      }
      return { success: true, action: 'ARCHIVED_OLDER', dominio: cleanDom, ot: cleanOt };
    }
  } else {
    // Dominio nuevo: agregar al final de 'ots'
    const nextOtsRow = rows.length + 2;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${OTS_TAB}'!A${nextOtsRow}:H${nextOtsRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [formattedRow] }
    });
    console.log(`🆕 [otsManager] Nueva OT ${cleanOt} para ${cleanDom} agregada a 'ots' en fila ${nextOtsRow}.`);
    invalidateOtsCache();
    return { success: true, action: 'INSERTED_NEW', dominio: cleanDom, ot: cleanOt };
  }
}

// === CACHÉ DE ALTA VELOCIDAD PARA BÚSQUEDAS ===
let otsCache = null;
let lastOtsCacheTime = 0;
const OTS_CACHE_TTL_MS = 20000; // 20 segundos

function invalidateOtsCache() {
  otsCache = null;
  lastOtsCacheTime = 0;
}

/**
/**
 * Obtiene el mapa de OTs vigentes ('ots') y anteriores ('ots_anteriores')
 * indexadas por patente y por OT mediante una única lectura HTTP (batchGet).
 */
async function getCurrentOtsMap(sheetsClient, spreadsheetId, force = false) {
  const now = Date.now();
  if (!force && otsCache && (now - lastOtsCacheTime < OTS_CACHE_TTL_MS)) {
    return otsCache;
  }

  if (!sheetsClient || !spreadsheetId) {
    return { byPlate: new Map(), byOt: new Map(), anterioresByPlate: new Map(), anterioresByOt: new Map() };
  }

  try {
    const res = await sheetsClient.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`'${OTS_TAB}'!A2:H1000`, `'${OTS_ANTERIORES_TAB}'!A2:H2000`]
    });

    const valRanges = res.data.valueRanges || [];
    let rows = (valRanges[0] && valRanges[0].values) || [];
    let antRows = (valRanges[1] && valRanges[1].values) || [];

    // JIT: Si hay dominios duplicados al momento de leer, depurar inmediatamente
    const seenCheck = new Set();
    let needsInstantDeduplication = false;
    for (const r of rows) {
      const rawDom = String(r[3] || '').trim();
      const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
      if (!cleanDom) continue;
      if (seenCheck.has(cleanDom)) {
        needsInstantDeduplication = true;
        break;
      }
      seenCheck.add(cleanDom);
    }

    if (needsInstantDeduplication) {
      console.log('⚡ [otsManager JIT] Dominios duplicados detectados al leer. Ejecutando distribución instantánea...');
      await migrateAndDeduplicateOts(sheetsClient, spreadsheetId);
      const freshRes = await sheetsClient.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [`'${OTS_TAB}'!A2:H1000`, `'${OTS_ANTERIORES_TAB}'!A2:H2000`]
      });
      const freshRanges = freshRes.data.valueRanges || [];
      rows = (freshRanges[0] && freshRanges[0].values) || [];
      antRows = (freshRanges[1] && freshRanges[1].values) || [];
    }

    const byPlate = new Map();
    const byOt = new Map();

    rows.forEach(r => {
      const key = String(r[0] || '').trim();
      const fecha = String(r[1] || '').trim();
      const rawOt = String(r[2] || '').trim();
      const cleanOt = normalizeOt(rawOt);
      const rawDom = String(r[3] || '').trim();
      const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
      const sectorTareas = String(r[4] || '').trim();
      const cierreRespaldo = String(r[5] || '').trim();
      const payload = r[6] || '';
      const confirmacion = String(r[7] || '').trim();

      const item = {
        key,
        fecha,
        rawOt,
        ot: cleanOt,
        dominio: cleanDom,
        sectorTareas,
        cierreRespaldo,
        payload,
        confirmacion
      };

      if (cleanDom) byPlate.set(cleanDom, item);
      if (cleanOt) byOt.set(cleanOt, item);
      if (rawOt && rawOt !== cleanOt) byOt.set(rawOt, item);
    });

    // Indexar OTs anteriores (≤ 6 meses) agrupadas por patente
    const anterioresByPlate = new Map();
    const anterioresByOt = new Map();

    antRows.forEach(r => {
      const key = String(r[0] || '').trim();
      const fecha = String(r[1] || '').trim();
      const rawOt = String(r[2] || '').trim();
      const cleanOt = normalizeOt(rawOt);
      const rawDom = String(r[3] || '').trim();
      const cleanDom = normalizePlate(rawDom) || rawDom.toUpperCase();
      const sectorTareas = String(r[4] || '').trim();
      const cierreRespaldo = String(r[5] || '').trim();
      const payload = r[6] || '';
      const confirmacion = String(r[7] || '').trim();
      const score = parseDateScore(fecha, rawOt);

      if (!cleanDom || !cleanOt) return;

      const item = {
        key,
        fecha,
        rawOt,
        ot: cleanOt,
        dominio: cleanDom,
        sectorTareas,
        cierreRespaldo,
        payload,
        confirmacion,
        score
      };

      if (!anterioresByPlate.has(cleanDom)) {
        anterioresByPlate.set(cleanDom, []);
      }
      anterioresByPlate.get(cleanDom).push(item);
      anterioresByOt.set(cleanOt, item);
    });

    // Ordenar de más reciente a más antigua
    anterioresByPlate.forEach(list => {
      list.sort((a, b) => b.score - a.score);
    });

    otsCache = { byPlate, byOt, anterioresByPlate, anterioresByOt, rawRows: rows, rawAntRows: antRows };
    lastOtsCacheTime = now;
    return otsCache;
  } catch (err) {
    console.error('Error en getCurrentOtsMap:', err.message);
    return otsCache || { byPlate: new Map(), byOt: new Map(), anterioresByPlate: new Map(), anterioresByOt: new Map() };
  }
}

/**
 * Obtiene el historial de OTs anteriores (últimos 6 meses) para una patente específica.
 */
async function getOtsAnterioresForPlate(sheetsClient, spreadsheetId, plate) {
  if (!plate) return [];
  const cleanDom = normalizePlate(plate) || String(plate).trim().toUpperCase();
  const otsData = await getCurrentOtsMap(sheetsClient, spreadsheetId);
  return (otsData.anterioresByPlate && otsData.anterioresByPlate.get(cleanDom)) || [];
}

/**
 * Ejecuta el wipe y purga de OTs con más de 6 meses de antigüedad en 'ots_anteriores',
 * resguardándolas en el cold archive local / Drive.
 */
async function wipeAndArchiveOlderThan6Months(sheetsClient, spreadsheetId) {
  return await migrateAndDeduplicateOts(sheetsClient, spreadsheetId);
}

/**
 * Descarga y exporta el contenido completo de 'HISTORICO_COLD' en CSV.
 */
async function downloadColdStorageOts(sheetsClient, spreadsheetId) {
  await ensureOtsStructure(sheetsClient, spreadsheetId);
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${HISTORICO_COLD_TAB}'!A1:H`
  });
  const rows = res.data.values || [OTS_HEADERS];
  const csvContent = '\ufeff' + rows.map(r => r.map(cell => `"${String(cell || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`).join(';')).join('\n');
  return { rows, csvContent, totalRows: Math.max(0, rows.length - 1) };
}

/**
 * Limpia y vacía las filas de datos de 'HISTORICO_COLD', preservando la fila de encabezados A1:H1.
 * Realiza antes un respaldo en el archivo local de resguardo.
 */
async function clearColdStorageTab(sheetsClient, spreadsheetId) {
  await ensureOtsStructure(sheetsClient, spreadsheetId);
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${HISTORICO_COLD_TAB}'!A2:H`
  });
  const rows = res.data.values || [];
  if (rows.length > 0) {
    archiveColdOts(rows);
  }
  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${HISTORICO_COLD_TAB}'!A2:H`
  });
  console.log(`🧹 [otsManager] Pestaña '${HISTORICO_COLD_TAB}' vaciada exitosamente (${rows.length} filas archivadas y limpiadas).`);
  return { success: true, clearedCount: rows.length };
}

/**
 * Respaldo opcional del archivo CSV en Google Drive si hay un ID de carpeta configurado.
 */
async function syncColdArchiveToDrive(driveClient, folderId = null) {
  const targetFolder = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  if (!driveClient || !targetFolder) {
    return { success: false, reason: 'Sin carpeta de Drive configurada. Resguardo local seguro en data/' };
  }
  try {
    if (!fs.existsSync(ARCHIVE_CSV_FILE)) return { success: false, reason: 'CSV no encontrado' };
    const fileName = 'ots_historico_cold.csv';
    const fileMetadata = {
      name: fileName,
      parents: [targetFolder]
    };
    const media = {
      mimeType: 'text/csv',
      body: fs.createReadStream(ARCHIVE_CSV_FILE)
    };
    const listRes = await driveClient.files.list({
      q: `'${targetFolder}' in parents and name = '${fileName}' and trashed = false`,
      fields: 'files(id, name)'
    });
    let driveFileId = null;
    if (listRes.data.files && listRes.data.files.length > 0) {
      driveFileId = listRes.data.files[0].id;
      await driveClient.files.update({
        fileId: driveFileId,
        media: media
      });
      console.log(`☁️ [otsManager ColdArchive] Archivo actualizado en Google Drive (ID: ${driveFileId})`);
    } else {
      const createRes = await driveClient.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id'
      });
      driveFileId = createRes.data.id;
      console.log(`☁️ [otsManager ColdArchive] Archivo creado en Google Drive (ID: ${driveFileId})`);
    }
    return { success: true, fileId: driveFileId };
  } catch (err) {
    console.warn('⚠️ [otsManager ColdArchive] No se pudo sincronizar a Drive, resguardo local seguro:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Resuelve la búsqueda de unidad u OT combinando:
 * 1. La unión canónica Tractor-Semi desde 'DB_OT_LIST'.
 * 2. La OT más actual de cada patente desde 'ots'.
 * 3. Las OTs históricas de los últimos 6 meses desde 'ots_anteriores'.
 * 
 * @param {object} sheetsClient 
 * @param {string} spreadsheetId 
 * @param {string} query Cadena ingresada por el mecánico (ej. "AG426OG", "11186", "NRM584")
/**
 * Resuelve la búsqueda de unidad u OT combinando:
 * 1. Sistema Principal: 'DB_OT_LIST' (Col A: Tractor, Col B: OT, Col C: Semi, Col D: OT Semi).
 * 2. Sistema Vigente / Fallback: 'ots' (Col C: ORDEN Nº, Col D: DOMINIO).
 * 3. Las OTs históricas de los últimos 6 meses desde 'ots_anteriores'.
 * 
 * Regla de Oro: Cualquiera de los 4 datos ingresados (Patente Tractor, OT Tractor,
 * Patente Semi, OT Semi) completa los otros tres si están disponibles.
 * 
 * @param {object} sheetsClient 
 * @param {string} spreadsheetId 
 * @param {string} query Cadena ingresada por el mecánico (ej. "AG426OG", "11186", "NRM584", "11187")
 * @param {string} type 'TRACTOR', 'UNIT', 'OT', 'OT_TRACTOR', 'SEMI', 'SEMI_OT', o undefined/null
 */
async function findUnitOrOt({ sheetsClient, spreadsheetId, query, type }) {
  if (!sheetsClient || !spreadsheetId || !query) return { success: false };

  const q = String(query).trim().toUpperCase();
  const qNorm = normalizePlate(q);
  const qOtNorm = normalizeOt(q);

  if (qNorm.length < 2 && qOtNorm.length < 2) return { success: false };

  const tUpper = String(type || '').trim().toUpperCase();
  const isTractorContext = ['TRACTOR', 'UNIT', 'TRACTOR_PLATE'].includes(tUpper);
  const isSemiContext = ['SEMI', 'SEMI_PLATE'].includes(tUpper);
  const isTractorOtContext = ['OT', 'TRACTOR_OT', 'OT_TRACTOR'].includes(tUpper);
  const isSemiOtContext = ['SEMI_OT', 'OT_SEMI'].includes(tUpper);

  try {
    // 1. Obtener OTs vigentes y anteriores desde 'ots' y 'ots_anteriores'
    const otsData = await getCurrentOtsMap(sheetsClient, spreadsheetId);

    // 2. Obtener índice de unión Tractor-Semi desde 'DB_OT_LIST'
    const dbOtRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${DB_OT_LIST_TAB}'!A2:G`
    });
    const dbRows = dbOtRes.data.values || [];

    let matchedPair = null;
    let matchedDbRow = null;
    let tractorOt = '';
    let semiOt = '';

    // Paso 1: Búsqueda PRINCIPAL en 'DB_OT_LIST' (Tractor Col A, Semi Col C, OT Col B, OT Semi Col D)
    for (let i = 0; i < dbRows.length; i++) {
      const r = dbRows[i];
      const t = String(r[0] || '').trim();
      const s = String(r[2] || '').trim();
      const tNorm = normalizePlate(t);
      const sNorm = normalizePlate(s);
      const bOt = normalizeOt(r[1]);
      const dOt = normalizeOt(r[3]);

      let isMatch = false;
      if (isTractorContext) {
        isMatch = (tNorm === qNorm);
      } else if (isSemiContext) {
        isMatch = (sNorm === qNorm);
      } else if (isTractorOtContext) {
        isMatch = (bOt === qOtNorm);
      } else if (isSemiOtContext) {
        isMatch = (dOt === qOtNorm || bOt === qOtNorm);
      } else {
        isMatch = (tNorm === qNorm || sNorm === qNorm || bOt === qOtNorm || dOt === qOtNorm);
      }

      if (isMatch) {
        matchedPair = { tractor: t, semi: s, producto: r[4] || '', marcaT: r[5] || '', marcaS: r[6] || '' };
        matchedDbRow = r;
        tractorOt = bOt;
        semiOt = dOt;
        break;
      }
    }

    // Paso 2: Fallback al sistema vigente 'ots' si no se encontró coincidencia directa en 'DB_OT_LIST'
    if (!matchedPair) {
      // 2a. ¿Es una OT conocida en 'ots'?
      if (otsData.byOt.has(qOtNorm)) {
        const otObj = otsData.byOt.get(qOtNorm);
        const foundPlate = otObj.dominio;

        // Buscar si esa patente pertenece al Tractor o al Semi en DB_OT_LIST
        for (let i = 0; i < dbRows.length; i++) {
          const r = dbRows[i];
          const tNorm = normalizePlate(r[0]);
          const sNorm = normalizePlate(r[2]);

          if (tNorm === foundPlate) {
            matchedPair = { tractor: r[0], semi: r[2], producto: r[4] || '', marcaT: r[5] || '', marcaS: r[6] || '' };
            matchedDbRow = r;
            tractorOt = normalizeOt(r[1]) || otObj.ot;
            semiOt = normalizeOt(r[3]);
            break;
          } else if (sNorm === foundPlate) {
            matchedPair = { tractor: r[0], semi: r[2], producto: r[4] || '', marcaT: r[5] || '', marcaS: r[6] || '' };
            matchedDbRow = r;
            semiOt = normalizeOt(r[3]) || otObj.ot;
            tractorOt = normalizeOt(r[1]);
            break;
          }
        }

        // Si no tiene par en DB_OT_LIST:
        if (!matchedPair) {
          if (isSemiContext || isSemiOtContext) {
            matchedPair = { tractor: '', semi: foundPlate, producto: '', marcaT: '', marcaS: '' };
            semiOt = otObj.ot;
          } else {
            matchedPair = { tractor: foundPlate, semi: '', producto: '', marcaT: '', marcaS: '' };
            tractorOt = otObj.ot;
          }
        }
      }
      // 2b. ¿Coincide directamente con una patente en 'ots'?
      else if (otsData.byPlate.has(qNorm)) {
        const otObj = otsData.byPlate.get(qNorm);
        if (isSemiContext || isSemiOtContext) {
          matchedPair = { tractor: '', semi: otObj.dominio, producto: '', marcaT: '', marcaS: '' };
          semiOt = otObj.ot;
        } else {
          matchedPair = { tractor: otObj.dominio, semi: '', producto: '', marcaT: '', marcaS: '' };
          tractorOt = otObj.ot;
        }
      }
    }

    // Paso 3: Búsqueda parcial en 'DB_OT_LIST' si no hubo coincidencia exacta y longitud >= 3
    if (!matchedPair && qNorm.length >= 3) {
      for (let i = 0; i < dbRows.length; i++) {
        const r = dbRows[i];
        const t = String(r[0] || '').trim();
        const s = String(r[2] || '').trim();
        const tNorm = normalizePlate(t);
        const sNorm = normalizePlate(s);

        if ((!isSemiContext && tNorm.includes(qNorm)) || (!isTractorContext && sNorm.includes(qNorm))) {
          matchedPair = { tractor: t, semi: s, producto: r[4] || '', marcaT: r[5] || '', marcaS: r[6] || '' };
          matchedDbRow = r;
          tractorOt = normalizeOt(r[1]);
          semiOt = normalizeOt(r[3]);
          break;
        }
      }
    }

    if (!matchedPair) {
      return { success: false, query, type };
    }

    // Paso 4: Resolución final de OTs (PRINCIPAL: DB_OT_LIST -> Fallback: 'ots' -> Fallback Regla: +1)
    const tPlateClean = normalizePlate(matchedPair.tractor);
    const sPlateClean = normalizePlate(matchedPair.semi);

    if (!matchedDbRow) {
      for (let i = 0; i < dbRows.length; i++) {
        const r = dbRows[i];
        const tNorm = normalizePlate(r[0]);
        const sNorm = normalizePlate(r[2]);
        if ((tPlateClean && tNorm === tPlateClean) || (sPlateClean && sNorm === sPlateClean)) {
          matchedDbRow = r;
          if (!matchedPair.tractor && r[0]) matchedPair.tractor = r[0];
          if (!matchedPair.semi && r[2]) matchedPair.semi = r[2];
          if (!matchedPair.producto && r[4]) matchedPair.producto = r[4];
          if (!matchedPair.marcaT && r[5]) matchedPair.marcaT = r[5];
          if (!matchedPair.marcaS && r[6]) matchedPair.marcaS = r[6];
          break;
        }
      }
    }

    const dbTractorOt = matchedDbRow ? normalizeOt(matchedDbRow[1]) : '';
    const dbSemiOt = matchedDbRow ? normalizeOt(matchedDbRow[3]) : '';

    // Resolver Tractor OT: 1. DB_OT_LIST (Principal) -> 2. ots (Fallback)
    if (!tractorOt) {
      if (dbTractorOt) {
        tractorOt = dbTractorOt;
      } else if (tPlateClean && otsData.byPlate.has(tPlateClean)) {
        tractorOt = otsData.byPlate.get(tPlateClean).ot;
      }
    }

    // Resolver Semi OT: 1. DB_OT_LIST (Principal) -> 2. ots (Fallback)
    if (!semiOt) {
      if (dbSemiOt) {
        semiOt = dbSemiOt;
      } else if (sPlateClean && otsData.byPlate.has(sPlateClean)) {
        semiOt = otsData.byPlate.get(sPlateClean).ot;
      }
    }

    const tractorOtsAnteriores = (otsData.anterioresByPlate && otsData.anterioresByPlate.get(tPlateClean)) || [];
    const semiOtsAnteriores = (otsData.anterioresByPlate && otsData.anterioresByPlate.get(sPlateClean)) || [];

    let otsAnteriores = [];
    if (isSemiContext || isSemiOtContext || qNorm === sPlateClean) {
      otsAnteriores = semiOtsAnteriores;
    } else if (isTractorContext || isTractorOtContext || qNorm === tPlateClean) {
      otsAnteriores = tractorOtsAnteriores;
    } else {
      otsAnteriores = tractorOtsAnteriores.length > 0 ? tractorOtsAnteriores : semiOtsAnteriores;
    }

    return {
      success: true,
      unit: matchedPair.tractor || '',
      ot: tractorOt || '',
      semi: matchedPair.semi || '',
      semiOt: semiOt || '',
      producto: matchedPair.producto || '',
      marca: matchedPair.marcaT || '',
      marcaSemi: matchedPair.marcaS || '',
      tractorOtsAnteriores,
      semiOtsAnteriores,
      otsAnteriores
    };
  } catch (err) {
    console.error('Error en findUnitOrOt:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Obtiene el catálogo completo para el autocompletado en tiempo real en los 4 campos:
 * Patente Tractor, OT Tractor, Patente Semi y OT Semi, con 'DB_OT_LIST' como principal y 'ots' vigente/fallback.
 */
async function getFleetSearchCatalog(sheetsClient, spreadsheetId) {
  const otsData = await getCurrentOtsMap(sheetsClient, spreadsheetId);
  const dbOtRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_OT_LIST_TAB}'!A2:G`
  });
  const dbRows = dbOtRes.data.values || [];

  const tractors = new Set();
  const semis = new Set();
  const tractorOts = new Set();
  const semiOts = new Set();
  const allOts = new Set();
  const pairs = [];

  dbRows.forEach(r => {
    const t = String(r[0] || '').trim().toUpperCase();
    const s = String(r[2] || '').trim().toUpperCase();
    if (!t && !s) return;
    if (t) tractors.add(t);
    if (s) semis.add(s);

    const tClean = normalizePlate(t);
    const sClean = normalizePlate(s);

    const tOtObj = otsData.byPlate.get(tClean);
    const sOtObj = otsData.byPlate.get(sClean);

    const dbBOt = normalizeOt(r[1]);
    const dbDOt = normalizeOt(r[3]);

    // Principal: 'DB_OT_LIST' Col B, Fallback: 'ots' Col C
    const tOt = dbBOt || (tOtObj ? tOtObj.ot : '');

    // Principal: 'DB_OT_LIST' Col D, Fallback: 'ots' Col C
    const sOt = dbDOt || (sOtObj ? sOtObj.ot : '');

    if (tOt) { tractorOts.add(tOt); allOts.add(tOt); }
    if (sOt) { semiOts.add(sOt); allOts.add(sOt); }
    if (dbBOt) { tractorOts.add(dbBOt); allOts.add(dbBOt); }
    if (dbDOt) { semiOts.add(dbDOt); allOts.add(dbDOt); }

    pairs.push({
      tractor: t,
      semi: s,
      tractorOt: tOt,
      semiOt: sOt,
      producto: String(r[4] || '').trim(),
      marcaT: String(r[5] || '').trim(),
      marcaS: String(r[6] || '').trim()
    });
  });

  // Integrar unidades o patentes que estén registradas en 'ots' y no estuvieran en DB_OT_LIST
  otsData.byPlate.forEach((otItem, plate) => {
    if (otItem.ot) allOts.add(otItem.ot);
    if (!tractors.has(plate) && !semis.has(plate)) {
      tractors.add(plate);
      if (otItem.ot) tractorOts.add(otItem.ot);
      pairs.push({
        tractor: plate,
        semi: '',
        tractorOt: otItem.ot || '',
        semiOt: '',
        producto: '',
        marcaT: '',
        marcaS: ''
      });
    }
  });

  return {
    pairs,
    tractors: Array.from(tractors).sort(),
    semis: Array.from(semis).sort(),
    tractorOts: Array.from(tractorOts).sort(),
    semiOts: Array.from(semiOts).sort(),
    allOts: Array.from(allOts).sort(),
    unitList: Array.from(new Set([...tractors, ...semis, ...allOts])).sort()
  };
}

let isDistributingOnLoad = false;

/**
 * Ejecuta la distribución y depuración de OTs exclusivamente en el momento de la carga.
 * Sin timers periódicos de segundo plano (cero consumo continuo de cuota de Google Sheets).
 */
async function distribuirOtsEnCarga(sheetsClient, spreadsheetId, io = null) {
  if (isDistributingOnLoad || !sheetsClient || !spreadsheetId) return { movedCount: 0 };
  isDistributingOnLoad = true;

  try {
    console.log('⚡ [otsManager] Ejecutando distribución de OTs en la carga...');
    const migRes = await migrateAndDeduplicateOts(sheetsClient, spreadsheetId);
    if (migRes && migRes.movedCount > 0) {
      console.log(`✅ [otsManager] Distribución en carga completada: ${migRes.movedCount} OTs movidas a '${OTS_ANTERIORES_TAB}'.`);
      if (io) {
        io.emit('ots_migrated', migRes);
        io.emit('ot_updated', {
          action: 'OTS_DISTRIBUTED',
          timestamp: new Date().toISOString()
        });
      }
    }
    return migRes;
  } catch (err) {
    console.error('⚠️ [otsManager] Error en distribuirOtsEnCarga:', err.message);
    return { movedCount: 0, error: err.message };
  } finally {
    isDistributingOnLoad = false;
  }
}

/**
 * Función compatible sin periodicidad:
 * Solo ejecuta la distribución una vez durante la carga inicial, sin dejar timers corriendo.
 */
function startContinuousOtsWatcher({ sheetsClient, spreadsheetId, io }) {
  console.log('👁️ [otsManager] Modo de distribución en carga activo (sin periodicidad en segundo plano).');
  return distribuirOtsEnCarga(sheetsClient, spreadsheetId, io);
}

module.exports = {
  OTS_TAB,
  OTS_ANTERIORES_TAB,
  HISTORICO_COLD_TAB,
  DB_OT_LIST_TAB,
  OTS_HEADERS,
  ARCHIVE_DIR,
  ARCHIVE_JSON_FILE,
  ARCHIVE_CSV_FILE,
  SIX_MONTHS_MS,
  normalizePlate,
  normalizeOt,
  parseDateScore,
  ensureOtsStructure,
  archiveColdOts,
  migrateAndDeduplicateOts,
  wipeAndArchiveOlderThan6Months,
  downloadColdStorageOts,
  clearColdStorageTab,
  distribuirOtsEnCarga,
  processNewOtRecord,
  getCurrentOtsMap,
  getOtsAnterioresForPlate,
  findUnitOrOt,
  getFleetSearchCatalog,
  invalidateOtsCache,
  startContinuousOtsWatcher,
  syncColdArchiveToDrive
};
