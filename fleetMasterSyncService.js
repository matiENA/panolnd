/**
 * fleetMasterSyncService.js
 * Servicio de blindaje, sincronización canónica y protección de DB_OT_LIST.
 * 
 * Reglas de Negocio:
 * 1. La planilla mensual (1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8) es la Fuente Única de la Verdad (SSOT)
 *    de la flota activa y sus uniones vigentes (Cols E y F).
 * 2. Se descartan patentes dadas de baja o pares históricos obsoletos.
 * 3. Las OTs se inyectan dinámicamente cruzando con las respuestas más recientes (LIFO) de Formulario 4.
 * 4. DB_OT_LIST queda blindada con exactamente las unidades en operación.
 */

const { extractPlates } = require('./plateNormalizer');

const ID_SHEET_MOVIMIENTOS_DEFAULT = '1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8';
const ID_RESPUESTAS_FORM4_DEFAULT = '1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk';
const ID_TARGET_DEFAULT = '1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc';

const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function getFechaArgentina() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc - (3 * 3600000));
}

function cleanPlate(raw) {
  if (!raw) return '';
  const plates = extractPlates(raw);
  return plates.length > 0 ? plates[0] : '';
}

/**
 * Resuelve dinámicamente el nombre de la pestaña del mes actual en la planilla de movimientos,
 * reutilizando la lógica probada de diagramasnode.
 */
async function getTabName(sheetsClient, spreadsheetId, keyword = "Mov.Unidades", defaultName = "SEPTIEMBRE 2026- Mov.Unidades y Choferes") {
  try {
    const resMeta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const sheets = (resMeta.data.sheets || []).map(s => s.properties.title);
    if (!sheets || sheets.length === 0) return defaultName;

    const hoyAr = getFechaArgentina();
    const mesNombre = mesesLargo[hoyAr.getMonth()].toLowerCase();
    const mesAbrev = mesesAbrev[hoyAr.getMonth()].toLowerCase();
    const normKw = keyword.toLowerCase().replace(/\s+/g, '');

    // Prioridad 1: Pestaña del mes actual que contenga el keyword
    const foundCurrent = sheets.slice().reverse().find(s => {
      const low = s.toLowerCase();
      return (low.includes(mesNombre) || low.includes(mesAbrev)) && low.replace(/\s+/g, '').includes(normKw);
    });
    if (foundCurrent) return foundCurrent;

    // Prioridad 2: Última pestaña que contenga el keyword
    const foundLast = sheets.slice().reverse().find(s => s.toLowerCase().replace(/\s+/g, '').includes(normKw));
    if (foundLast) return foundLast;

    // Prioridad 3: Fallback para "mov"
    if (normKw.includes("mov")) {
      const foundMov = sheets.slice().reverse().find(s => s.toLowerCase().includes("mov"));
      if (foundMov) return foundMov;
    }

    return sheets[0] || defaultName;
  } catch (e) {
    console.warn('Advertencia al resolver pestaña mensual:', e.message);
    return defaultName;
  }
}

/**
 * Extrae la flota activa y sus uniones oficiales desde la planilla mensual.
 */
async function extractCanonicalFleet({ sheetsClient, spreadsheetId }) {
  const movId = spreadsheetId || process.env.MES_MOVIMIENTOS_ID || ID_SHEET_MOVIMIENTOS_DEFAULT;
  const tabName = await getTabName(sheetsClient, movId, "Mov.Unidades");

  console.log(`📋 Leyendo flota canónica desde: [${tabName}] (${movId})...`);

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: movId,
    range: `'${tabName}'!A1:G350`
  });

  const rows = res.data.values || [];
  let currentCategory = 'GENERAL';
  const fleet = [];
  const seenPairs = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    // Detección de encabezado de categoría (LIVIANO, METANOL, CAMPO, etc.)
    if (r.length === 1 && r[0]) {
      const cat = r[0].trim().toUpperCase();
      if (cat && !cat.includes('N°') && !cat.includes('SEPTIEMBRE') && !cat.includes('FECHA')) {
        currentCategory = cat;
      }
      continue;
    }

    const nUte = String(r[2] || '').trim();
    const rawTractor = String(r[4] || '').trim();
    const rawSemi = String(r[5] || '').trim();

    if (!rawTractor && !rawSemi) continue;

    const upperT = rawTractor.toUpperCase();
    const upperS = rawSemi.toUpperCase();
    if (upperT === 'TRACTOR' || upperS === 'SEMI' || upperT.includes('CISNER') || upperS.includes('CISNER')) {
      continue;
    }

    const tractor = cleanPlate(rawTractor);
    const semi = cleanPlate(rawSemi);

    if (!tractor && !semi) continue;

    const pairKey = `${tractor}__${semi}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    fleet.push({
      nUte,
      category: currentCategory,
      tractor,
      semi
    });
  }

  console.log(`✅ Flota canónica extraída: ${fleet.length} unidades/pares en [${tabName}].`);
  return { tabName, fleet };
}

/**
 * Extrae el mapa LIFO de las OTs más recientes desde Respuestas de formulario 4.
 */
async function extractLatestOts({ sheetsClient, spreadsheetId }) {
  const formId = spreadsheetId || ID_RESPUESTAS_FORM4_DEFAULT;
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: formId,
    range: "'Respuestas de formulario 4'!A1:K"
  });

  const rows = res.data.values || [];
  const latestOts = new Map();

  for (let i = rows.length - 1; i >= 1; i--) {
    const rawPlate = rows[i][4];
    const ot = String(rows[i][8] || '').trim();
    if (ot && ot !== '#REF!' && rawPlate) {
      const plates = extractPlates(rawPlate);
      plates.forEach(p => {
        if (!latestOts.has(p)) latestOts.set(p, ot);
      });
    }
  }

  console.log(`✅ OTs históricas indexadas: ${latestOts.size} patentes únicas con OT activa.`);
  return latestOts;
}

/**
 * Función principal: Blindar DB_OT_LIST con la flota canónica mensual e inyectar OTs vigentes.
 */
async function syncCanonicalFleetToDbOtList({
  sheetsClient,
  targetSpreadsheetId = ID_TARGET_DEFAULT,
  movimientosSpreadsheetId = ID_SHEET_MOVIMIENTOS_DEFAULT,
  formSpreadsheetId = ID_RESPUESTAS_FORM4_DEFAULT
}) {
  const startTime = Date.now();
  console.log('🛡️ INICIANDO BLINDAJE DE DB_OT_LIST...');

  // 1. Preservar marcas conocidas y excepciones manuales del sistema (ej: INTERNO TALLER)
  const existingRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A2:G"
  });
  const existingRows = existingRes.data.values || [];
  const brandMap = new Map();
  const manualExceptions = new Map();

  existingRows.forEach(r => {
    const rawT = String(r[0] || '').trim();
    const rawS = String(r[2] || '').trim();
    const ot = String(r[1] || '').trim();
    const semiOt = String(r[3] || '').trim();
    const prod = String(r[4] || '').trim();
    const marcaT = String(r[5] || '').trim();
    const marcaS = String(r[6] || '').trim();

    const tClean = cleanPlate(rawT);
    const sClean = cleanPlate(rawS);
    if (tClean && marcaT) brandMap.set(tClean, marcaT);
    if (sClean && marcaS) brandMap.set(sClean, marcaS);

    // Detectar y preservar excepciones permanentes como INTERNO TALLER
    const upperT = rawT.toUpperCase();
    const upperS = rawS.toUpperCase();
    if (upperT === 'INTERNO TALLER' || upperS === 'INTERNO TALLER' || upperT.startsWith('INTERNO') || upperS.startsWith('INTERNO')) {
      const key = `${upperT}__${upperS}`;
      manualExceptions.set(key, {
        tractor: rawT || 'INTERNO TALLER',
        otNumber: ot,
        semi: rawS || 'INTERNO TALLER',
        semiOt: semiOt,
        producto: prod || 'TALLER',
        marca: marcaT,
        marcaSemi: marcaS
      });
    }
  });

  // Regla fija: Garantizar que la excepción "INTERNO TALLER" siempre esté presente
  if (!manualExceptions.has('INTERNO TALLER__INTERNO TALLER')) {
    manualExceptions.set('INTERNO TALLER__INTERNO TALLER', {
      tractor: 'INTERNO TALLER',
      otNumber: '',
      semi: 'INTERNO TALLER',
      semiOt: '',
      producto: 'TALLER',
      marca: '',
      marcaSemi: ''
    });
  }

  // 2. Extraer Flota Canónica
  const { tabName, fleet } = await extractCanonicalFleet({
    sheetsClient,
    spreadsheetId: movimientosSpreadsheetId
  });

  // 3. Extraer OTs LIFO
  const latestOts = await extractLatestOts({
    sheetsClient,
    spreadsheetId: formSpreadsheetId
  });

  // 4. Construir las filas blindadas de DB_OT_LIST (7 columnas)
  const canonicalRows = [];
  let matchedCount = 0;

  fleet.forEach(unit => {
    const tractor = unit.tractor;
    const semi = unit.semi;

    let otNumber = '';
    if (tractor && latestOts.has(tractor)) {
      otNumber = latestOts.get(tractor);
    } else if (semi && latestOts.has(semi)) {
      otNumber = latestOts.get(semi);
    }

    if (otNumber) matchedCount++;

    const marcaT = brandMap.get(tractor) || '';
    const marcaS = brandMap.get(semi) || '';

    canonicalRows.push([
      tractor,            // Col A: UNIT_ID (Tractor)
      otNumber,           // Col B: OT_NUMBER
      semi,               // Col C: SEMI
      '',                 // Col D: OT_NUMBER (Alt / Semi)
      unit.category,      // Col E: PRODUCTO
      marcaT,             // Col F: MARCA
      marcaS              // Col G: MARCA_SEMI
    ]);
  });

  // Regla de Negocio: Inyectar al final las excepciones manuales del sistema protegidas
  manualExceptions.forEach(ex => {
    canonicalRows.push([
      ex.tractor,
      ex.otNumber || '',
      ex.semi,
      ex.semiOt || '',
      ex.producto || 'TALLER',
      ex.marca || '',
      ex.marcaSemi || ''
    ]);
  });

  // 5. Escritura Atómica en DB_OT_LIST: Limpieza de filas obsoletas + Escritura canónica
  // Limpiar rango A2:Z5000 para remover cualquier residuo anterior
  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId: targetSpreadsheetId,
    range: 'DB_OT_LIST!A2:Z5000'
  });

  // Escribir las filas limpias protegidas
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: targetSpreadsheetId,
    range: `'DB_OT_LIST'!A2:G${canonicalRows.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: canonicalRows }
  });

  const durationMs = Date.now() - startTime;
  console.log(`🛡️ ✅ BLINDAJE COMPLETADO EN ${durationMs}ms:`);
  console.log(`   - Total equipos canónicos en DB_OT_LIST: ${canonicalRows.length}`);
  console.log(`   - Unidades con OT activa asignada: ${matchedCount}`);
  console.log(`   - Unidades sin OT reportada: ${canonicalRows.length - matchedCount}`);
  console.log(`   - Pestaña mensual de origen: ${tabName}`);

  return {
    success: true,
    totalUnits: canonicalRows.length,
    matchedOtCount: matchedCount,
    unmatchedCount: canonicalRows.length - matchedCount,
    monthlyTab: tabName,
    durationMs,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  getTabName,
  extractCanonicalFleet,
  extractLatestOts,
  syncCanonicalFleetToDbOtList,
  ID_SHEET_MOVIMIENTOS_DEFAULT,
  ID_RESPUESTAS_FORM4_DEFAULT,
  ID_TARGET_DEFAULT
};
