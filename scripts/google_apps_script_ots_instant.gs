/**
 * GOOGLE APPS SCRIPT PARA GESTIÓN INSTANTÁNEA DE 'ots', 'ots_anteriores' E 'HISTORICO_COLD'
 * Proyecto / Spreadsheet ID: 17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ
 * 
 * Reglas:
 * 1. 'ots': Dominio (Col D) IRREPETIBLE. Solo la OT más actual por patente.
 * 2. 'ots_anteriores': OTs con fecha <= 6 meses (se puede repetir Col D).
 * 3. 'HISTORICO_COLD': OTs con fecha > 6 meses (misma estructura de 8 columnas A:H).
 * 4. Poka-Yoke: Semáforo anti-recursión (CacheService + LockService) para evitar loops ante onSheetChange.
 */

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

function onEdit(e) {
  const sheet = e && e.range ? e.range.getSheet() : SpreadsheetApp.getActiveSheet();
  if (sheet && sheet.getName() === 'ots') {
    distribuirOtsInstantaneo();
  }
}

function onSheetChange(e) {
  distribuirOtsInstantaneo();
}

function parseFechaScore(fechaVal, otStr) {
  if (!fechaVal) return 0;
  if (fechaVal instanceof Date) {
    return fechaVal.getTime();
  }
  const s = String(fechaVal).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const y = parseInt(m[3], 10);
    const h = m[4] ? parseInt(m[4], 10) : 0;
    const min = m[5] ? parseInt(m[5], 10) : 0;
    const sec = m[6] ? parseInt(m[6], 10) : 0;
    return new Date(y, mo, d, h, min, sec).getTime();
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  const num = parseInt(String(otStr).replace(/\D/g, ''), 10);
  return !isNaN(num) ? num : 0;
}

function distribuirOtsInstantaneo() {
  // 1. Semáforo anti-recursión con CacheService
  const cache = CacheService.getScriptCache();
  if (cache.get('IS_DISTRIBUTING') === 'true') {
    return; // Ya se está ejecutando o fue disparado por escritura del propio script
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return; // Evita ejecuciones solapadas
  }

  try {
    cache.put('IS_DISTRIBUTING', 'true', 30); // 30 segundos TTL

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const otsSheet = ss.getSheetByName('ots');
    const antSheet = ss.getSheetByName('ots_anteriores');
    const coldSheet = ss.getSheetByName('HISTORICO_COLD');

    if (!otsSheet || !antSheet) return;

    const lastRow = otsSheet.getLastRow();
    if (lastRow <= 2) return; // Solo encabezado o 1 fila

    // Leer las 8 columnas (A:H)
    const values = otsSheet.getRange(2, 1, lastRow - 1, 8).getValues();

    // Agrupar por dominio (Col D, índice 3)
    const byDomain = {};
    let hasDuplicates = false;

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const dom = String(row[3] || '').toUpperCase().replace(/[\s\-_.]/g, '');
      if (!dom) continue;

      if (!row[0] && row[2]) {
        row[0] = dom + ' - ' + String(row[2]).trim();
      }

      if (!byDomain[dom]) {
        byDomain[dom] = [];
      } else {
        hasDuplicates = true;
      }

      byDomain[dom].push({
        row: row,
        ot: String(row[2] || '').trim(),
        score: parseFechaScore(row[1], row[2])
      });
    }

    if (!hasDuplicates) return; // No hay duplicados en 'ots'

    const now = Date.now();
    const cutoffScore = now - SIX_MONTHS_MS;

    const toKeepInOts = [];
    const toMoveToAnt = [];
    const toMoveToCold = [];

    for (const dom in byDomain) {
      const items = byDomain[dom];
      // Ordenar de más reciente a más antigua
      items.sort((a, b) => b.score - a.score);

      // La primera es la vigente única del dominio
      toKeepInOts.push(items[0].row);

      // Las demás pasan a histórico (<= 6M o > 6M)
      for (let j = 1; j < items.length; j++) {
        const item = items[j];
        if (item.ot && item.ot !== items[0].ot) {
          if (item.score > 0 && item.score < cutoffScore) {
            toMoveToCold.push(item.row);
          } else {
            toMoveToAnt.push(item.row);
          }
        }
      }
    }

    // 1. Mover anteriores (<= 6 meses) a 'ots_anteriores'
    if (toMoveToAnt.length > 0) {
      const antLastRow = antSheet.getLastRow();
      const startRow = Math.max(2, antLastRow + 1);
      antSheet.getRange(startRow, 1, toMoveToAnt.length, 8).setValues(toMoveToAnt);
    }

    // 2. Mover históricas (> 6 meses) a 'HISTORICO_COLD' si la pestaña existe
    if (toMoveToCold.length > 0 && coldSheet) {
      const coldLastRow = coldSheet.getLastRow();
      const startRow = Math.max(2, coldLastRow + 1);
      coldSheet.getRange(startRow, 1, toMoveToCold.length, 8).setValues(toMoveToCold);
    }

    // 3. Limpiar 'ots' y reescribir solo las vigentes (Col D irrepetible)
    otsSheet.getRange(2, 1, Math.max(1, otsSheet.getMaxRows() - 1), 8).clearContent();
    if (toKeepInOts.length > 0) {
      otsSheet.getRange(2, 1, toKeepInOts.length, 8).setValues(toKeepInOts);
    }

    SpreadsheetApp.flush();
    Logger.log('✅ Distribución instantánea completada. Retenidas: ' + toKeepInOts.length + ', Anteriores: ' + toMoveToAnt.length + ', Cold: ' + toMoveToCold.length);
  } catch (err) {
    Logger.log('❌ Error en distribuirOtsInstantaneo: ' + err.message);
  } finally {
    cache.remove('IS_DISTRIBUTING');
    lock.releaseLock();
  }
}
