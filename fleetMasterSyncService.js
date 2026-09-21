/**
 * fleetMasterSyncService.js
 * Servicio de blindaje, sincronización canónica y protección de DB_OT_LIST.
 * 
 * Reglas de Negocio:
 * 1. La planilla mensual (1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8) es la Fuente Única de la Verdad (SSOT)
 *    de la flota activa y sus uniones vigentes (Cols E y F).
 * 2. Se descartan patentes dadas de baja o pares históricos obsoletos.
 * 3. DB_OT_LIST es llenada con los números de OT provenientes de Formulario 4 (1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk):
 *    - Col B: OT Tractor
 *    - Col D: OT Semi
 * 4. La pestaña 'ots' (Col C: ORDEN Nº, Col E: SECTOR / TAREAS) sigue siendo surtida por el extractor externo.
 *    La unión entre DB_OT_LIST y 'ots' se realiza exclusivamente para el frontend / consultas de la aplicación.
 * 5. DB_OT_LIST queda blindada con exactamente las unidades de la flota activa.
 */

const { extractPlates } = require('./plateNormalizer');

const ID_SHEET_MOVIMIENTOS_DEFAULT = process.env.MES_MOVIMIENTOS_ID || '1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8';
const ID_RESPUESTAS_FORM4_DEFAULT = process.env.SOURCE_SPREADSHEET_ID || '1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk';

const PROD_SPREADSHEET_ID = '1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc';
const LOCAL_SPREADSHEET_ID = '17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ';
const isProdEnvironment = (process.env.NODE_ENV === 'production') || !!process.env.RENDER || (process.env.SPREADSHEET_ID === PROD_SPREADSHEET_ID);

let defaultTarget = process.env.SPREADSHEET_ID || (isProdEnvironment ? PROD_SPREADSHEET_ID : LOCAL_SPREADSHEET_ID);
if (isProdEnvironment && defaultTarget === LOCAL_SPREADSHEET_ID) {
  defaultTarget = PROD_SPREADSHEET_ID;
}
const ID_TARGET_DEFAULT = defaultTarget;

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
 * Extrae las OTs vigentes indexadas por patente directamente desde la pestaña 'ots'.
 * Cada dominio tiene como máximo una OT vigente irrepetible.
 */
async function extractActiveOtsFromOtsTab({ sheetsClient, targetSpreadsheetId }) {
  const latestOts = new Map();
  try {
    const otsRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: targetSpreadsheetId,
      range: "'ots'!A2:E"
    });
    const otsRows = otsRes.data.values || [];
    otsRows.forEach(r => {
      const ot = String(r[2] || '').trim(); // Col C: ORDEN Nº / OT TRACTOR/SEMI
      const rawDom = String(r[3] || '').trim(); // Col D: DOMINIO / TRACTOR/SEMI
      const p = cleanPlate(rawDom);
      if (p && ot) {
        latestOts.set(p, ot);
      }
    });
    console.log(`✅ OTs vigentes indexadas desde pestaña 'ots': ${latestOts.size} patentes.`);
  } catch (errOts) {
    console.warn('⚠️ Advertencia al leer pestaña "ots":', errOts.message);
  }
  return latestOts;
}

/**
 * Extrae las OTs vigentes indexadas por patente directamente desde Formulario 4 (1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk).
 * Recorre en orden inverso (LIFO: de más reciente a más antiguo) para asegurar que se tome la última OT emitida por dominio.
 */
async function extractLatestOtsFromForm({ sheetsClient, formSpreadsheetId = ID_RESPUESTAS_FORM4_DEFAULT }) {
  const latestOts = new Map();
  const formId = formSpreadsheetId || process.env.SOURCE_SPREADSHEET_ID || ID_RESPUESTAS_FORM4_DEFAULT;
  try {
    console.log(`📋 Leyendo OTs desde Formulario 4 (${formId})...`);
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: formId,
      range: "'Respuestas de formulario 4'!A:K"
    });
    const rows = res.data.values || [];
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const rawPlate = r[4];
      const ot = String(r[8] || '').trim();
      if (!ot || ot === '#REF!' || !rawPlate) continue;

      const plates = extractPlates(rawPlate);
      plates.forEach(p => {
        if (!latestOts.has(p)) {
          latestOts.set(p, ot);
        }
      });
    }
    console.log(`✅ OTs vigentes indexadas desde Formulario 4: ${latestOts.size} patentes únicas.`);
  } catch (errForm) {
    console.warn('⚠️ Advertencia al leer Formulario 4:', errForm.message);
  }
  return latestOts;
}

/**
 * Función principal: Blindar DB_OT_LIST con la flota canónica mensual e inyectar OTs vigentes desde Formulario 4.
 * Flujo:
 * 1. Flota canónica extraída de planilla mensual (1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8) -> Col A (Tractor) y Col C (Semi).
 * 2. OTs vigentes extraídas de Formulario 4 (1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk):
 *    - Tractor (Col A) -> busca en Form 4 -> inyecta en Col B (OT Tractor)
 *    - Semi (Col C) -> busca en Form 4 -> inyecta en Col D (OT Semi)
 * 3. Si no existe en Form 4, la OT queda vacía.
 * 4. La pestaña 'ots' se mantiene para tareas y uso del front-end.
 */
async function syncCanonicalFleetToDbOtList({
  sheetsClient,
  targetSpreadsheetId = ID_TARGET_DEFAULT,
  movimientosSpreadsheetId = ID_SHEET_MOVIMIENTOS_DEFAULT,
  formSpreadsheetId = ID_RESPUESTAS_FORM4_DEFAULT
}) {
  const startTime = Date.now();
  console.log('🛡️ INICIANDO BLINDAJE DE DB_OT_LIST (SSOT: Movimientos + OTs: Formulario 4)...');

  // 1. Preservar marcas conocidas y excepciones manuales del sistema (ej: INTERNO TALLER)
  const existingRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: targetSpreadsheetId,
    range: "'DB_OT_LIST'!A2:G"
  });
  const existingRows = existingRes.data.values || [];
  const brandMap = new Map();
  const manualExceptions = new Map();
  const existingOtTractorMap = new Map();
  const existingOtSemiMap = new Map();

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

    // Preservar OTs canónicas inyectadas directamente por GAS en DB_OT_LIST
    if (tClean && ot) existingOtTractorMap.set(tClean, ot);
    if (sClean && semiOt) existingOtSemiMap.set(sClean, semiOt);

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

  // 2. Extraer Flota Canónica desde la planilla mensual
  const { tabName, fleet } = await extractCanonicalFleet({
    sheetsClient,
    spreadsheetId: movimientosSpreadsheetId
  });

  // 3. OTs de Tractores: Desacopladas de Node.
  // El proceso de Formulario 4 ahora es directo vía Google Apps Script (GAS) a DB_OT_LIST.
  // Node preserva las OTs existentes en DB_OT_LIST sin consultar Formulario 4.
  const formTractorOts = existingOtTractorMap;

  // 4. Extraer OTs de Semis desde DB_OT_LIST existente o fallback en pestaña 'ots'
  const otsTabOts = await extractActiveOtsFromOtsTab({
    sheetsClient,
    targetSpreadsheetId
  });

  // 5. Construir las filas blindadas de DB_OT_LIST (7 columnas)
  const canonicalRows = [];
  let matchedCount = 0;

  fleet.forEach(unit => {
    const tractor = unit.tractor;
    const semi = unit.semi;

    // Preservar OT Tractor directa de GAS
    const otNumber = (tractor && formTractorOts.has(tractor)) ? formTractorOts.get(tractor) : '';

    // Preservar OT Semi directa de GAS o de pestaña 'ots'
    const semiOtNumber = (semi && existingOtSemiMap.has(semi))
      ? existingOtSemiMap.get(semi)
      : ((semi && otsTabOts.has(semi)) ? otsTabOts.get(semi) : '');

    if (otNumber || semiOtNumber) matchedCount++;

    const marcaT = brandMap.get(tractor) || '';
    const marcaS = brandMap.get(semi) || '';

    canonicalRows.push([
      tractor,            // Col A: UNIT_ID (Tractor)
      otNumber,           // Col B: OT_NUMBER (ot tractor desde Form 4)
      semi,               // Col C: SEMI (Semi canónico)
      semiOtNumber,       // Col D: OT_NUMBER (OT SEMI desde ots Col C)
      unit.category,      // Col E: PRODUCTO
      marcaT,             // Col F: MARCA
      marcaS              // Col G: MARCA_SEMI
    ]);
  });

  // Regla de Negocio: Inyectar al final las excepciones manuales del sistema protegidas
  manualExceptions.forEach(ex => {
    const tPlate = cleanPlate(ex.tractor);
    const sPlate = cleanPlate(ex.semi);
    const tOt = (tPlate && formTractorOts.has(tPlate)) ? formTractorOts.get(tPlate) : (ex.otNumber || '');
    const sOt = (sPlate && existingOtSemiMap.has(sPlate))
      ? existingOtSemiMap.get(sPlate)
      : ((sPlate && otsTabOts.has(sPlate)) ? otsTabOts.get(sPlate) : (ex.semiOt || ''));

    canonicalRows.push([
      ex.tractor,
      tOt,
      ex.semi,
      sOt,
      ex.producto || 'TALLER',
      ex.marca || '',
      ex.marcaSemi || ''
    ]);
  });

  // 5. Escritura Atómica en DB_OT_LIST: Limpieza de filas obsoletas + Escritura canónica
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
  extractActiveOtsFromOtsTab,
  extractLatestOtsFromForm,
  syncCanonicalFleetToDbOtList,
  ID_SHEET_MOVIMIENTOS_DEFAULT,
  ID_RESPUESTAS_FORM4_DEFAULT,
  ID_TARGET_DEFAULT
};
