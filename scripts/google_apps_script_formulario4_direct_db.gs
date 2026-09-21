/**
 * ==============================================================================
 * PROYECTO GOOGLE APPS SCRIPT: 1AajOnkM3LCRZ6Rfoe7FIKnxCiR4Ei86if2P6naBfybCRABq-tnKjfq7w
 * PLANILLA ORIGEN: 1HKXGsRC149Kw4aBXQwGcPVpAvObvTUFis6YV6R5cTXk (Respuestas de formulario 4)
 * 
 * PROCESO DIRECTO DE GAS A LA BASE DE DATOS (SIN NODE COMO INTERMEDIARIO)
 * 
 * Mapeo Canónico en 'DB_OT_LIST':
 *   - Col A: UNIT_ID (Tractor)   --> Col B: OT_NUMBER (OT Tractor)
 *   - Col C: SEMI (Semi remolque) --> Col D: OT_NUMBER (OT Semi)
 * 
 * Bases de datos destino (Google Sheets):
 *   - Producción: 1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc (Database PRUEBAS)
 *   - Local:      17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ (Database PRUEBAS LOCAL)
 * ==============================================================================
 */

const TARGET_SS_IDS = [
  "1aKptNgy8a9Ca3rDW-HSlWEiriMRJMOIJuFsdViwEGFc", // Database PRUEBAS (Producción)
  "17yFPBMz8ExHf53e6ssh9LyDTjKCCJApoiCNXP-4KINQ"  // Database PRUEBAS LOCAL (Desarrollo)
];

/**
 * Normaliza y extrae patentes argentinas válidas (Mercosur y Tradicional)
 * Tolera cadenas compuestas como "AD355XY / AD413LI" o "AG088KS / AF887GI".
 * @param {string} rawString
 * @returns {string[]} Lista de patentes limpias en mayúsculas
 */
function extraerPatentes(rawString) {
  if (!rawString) return [];
  const upper = String(rawString).toUpperCase().trim();
  const clean = upper.replace(/[\s\-_.]/g, '');
  const regex = /([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})/g;
  const matches = clean.match(regex);
  return matches || [];
}

/**
 * Trigger ejecutado al recibir un nuevo formulario (o editable manualmente).
 * Actualiza en tiempo real DB_OT_LIST directamente en las bases de datos de Sheets.
 * @param {object} e Evento de Google Sheets (onFormSubmit o manual)
 */
function onNuevaOTFormulario(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName("Respuestas de formulario 4") || ss.getActiveSheet();
    
    let rowData = null;
    let targetRowNum = 0;

    if (e && e.range) {
      targetRowNum = e.range.getRow();
      rowData = sourceSheet.getRange(targetRowNum, 1, 1, sourceSheet.getLastColumn()).getValues()[0];
    } else {
      // Si se ejecuta de prueba manual, toma la última fila con datos
      targetRowNum = sourceSheet.getLastRow();
      if (targetRowNum < 2) return;
      rowData = sourceSheet.getRange(targetRowNum, 1, 1, sourceSheet.getLastColumn()).getValues()[0];
    }

    if (!rowData) return;

    const rawPlate = String(rowData[4] || '').toUpperCase().trim(); // Col E (Índice 4): Dom Tractor / Semi
    const newOt = String(rowData[8] || '').trim();                  // Col I (Índice 8): N° Orden

    if (!rawPlate || !newOt) {
      Logger.log("Fila " + targetRowNum + " no contiene patente u OT válida. Omitiendo.");
      return;
    }

    const matches = extraerPatentes(rawPlate);
    if (matches.length === 0) {
      Logger.log("No se detectaron patentes válidas en fila " + targetRowNum + ": " + rawPlate);
      return;
    }

    Logger.log("⚡ Procesando nueva OT " + newOt + " para patentes: " + matches.join(', '));

    // ACTUALIZACIÓN DIRECTA EN AMBAS BASES DE DATOS (SIN NODE COMO INTERMEDIARIO)
    TARGET_SS_IDS.forEach(function(targetId) {
      try {
        const targetSS = SpreadsheetApp.openById(targetId);
        const targetSheet = targetSS.getSheetByName("DB_OT_LIST");
        if (!targetSheet) {
          console.warn("⚠️ No se encontró la pestaña DB_OT_LIST en spreadsheet: " + targetId);
          return;
        }

        const lastRow = targetSheet.getLastRow();
        if (lastRow < 2) return;

        // Leer A2:D de DB_OT_LIST (Col A: Tractor, Col B: OT, Col C: Semi, Col D: OT Semi)
        const rangeData = targetSheet.getRange(2, 1, lastRow - 1, 4);
        const values = rangeData.getValues();
        let modified = false;

        for (let i = 0; i < values.length; i++) {
          const dbTractor = String(values[i][0] || '').toUpperCase().replace(/[\s\-_.]/g, ''); // Col A: Tractor
          const dbSemi = String(values[i][2] || '').toUpperCase().replace(/[\s\-_.]/g, '');    // Col C: Semi

          // Verificar si alguna de las patentes coincide con el Tractor o el Semi
          const isTractorMatch = matches.some(function(p) { return dbTractor && p === dbTractor; });
          const isSemiMatch = matches.some(function(p) { return dbSemi && p === dbSemi; });

          if (isTractorMatch) {
            values[i][1] = newOt; // Col B: OT Tractor
            modified = true;
          }
          if (isSemiMatch) {
            values[i][3] = newOt; // Col D: OT Semi
            modified = true;
          }
        }

        if (modified) {
          rangeData.setValues(values);
          SpreadsheetApp.flush();
          Logger.log("✅ DB_OT_LIST actualizada exitosamente en " + targetId);
        } else {
          Logger.log("ℹ️ Patente(s) " + matches.join(', ') + " no encontrada(s) en la flota activa de " + targetId);
        }
      } catch (errDb) {
        console.error("❌ Error al actualizar directamente DB_OT_LIST en " + targetId + ": " + errDb.message);
      }
    });

  } catch (err) {
    console.error("❌ Error en onNuevaOTFormulario: " + err.message);
  }
}

/**
 * SINCRONIZACIÓN MASIVA DIRECTA DE OTs (FORMULARIO 4 -> DB_OT_LIST)
 * Lee de forma interna y ultrarrápida todas las respuestas de Formulario 4,
 * extrae la última OT emitida por patente (LIFO) y actualiza en 1 sola llamada
 * en lote (batch) la pestaña DB_OT_LIST en Producción y Local.
 * 
 * Sin pasar por Node.js ni agotar cuotas HTTP externas.
 */
function syncMasivoFormularioADbOtList() {
  const startTime = new Date().getTime();
  Logger.log("🚀 Iniciando sincronización masiva directa Formulario 4 -> DB_OT_LIST...");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("Respuestas de formulario 4");
  if (!sourceSheet) {
    throw new Error("No se encontró la pestaña 'Respuestas de formulario 4'");
  }

  const lastRow = sourceSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("La pestaña de respuestas está vacía.");
    return;
  }

  // Leer en bloque columnas A:I (hasta N° Orden)
  const sourceData = sourceSheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const latestOtByPlate = {};
  let totalValidSubmissions = 0;

  // Recorrer en orden inverso (LIFO: de más reciente a más antiguo)
  for (let i = sourceData.length - 1; i >= 0; i--) {
    const row = sourceData[i];
    const rawPlate = String(row[4] || '').toUpperCase().trim(); // Col E
    const ot = String(row[8] || '').trim();                     // Col I

    if (!ot || ot === '#REF!' || !rawPlate) continue;

    const plates = extraerPatentes(rawPlate);
    if (plates.length > 0) {
      totalValidSubmissions++;
      plates.forEach(function(p) {
        if (!latestOtByPlate[p]) {
          latestOtByPlate[p] = ot;
        }
      });
    }
  }

  const uniquePlatesCount = Object.keys(latestOtByPlate).length;
  Logger.log("📊 Formulario 4 indexado: " + uniquePlatesCount + " patentes únicas con OT vigente (de " + totalValidSubmissions + " envíos).");

  // Inyectar atómicamente en ambas bases de datos
  TARGET_SS_IDS.forEach(function(targetId) {
    try {
      const targetSS = SpreadsheetApp.openById(targetId);
      const targetSheet = targetSS.getSheetByName("DB_OT_LIST");
      if (!targetSheet) {
        console.warn("⚠️ No se encontró la pestaña DB_OT_LIST en spreadsheet: " + targetId);
        return;
      }

      const dbLastRow = targetSheet.getLastRow();
      if (dbLastRow < 2) return;

      // Leer A2:D (Tractor, OT Tractor, Semi, OT Semi)
      const dbRange = targetSheet.getRange(2, 1, dbLastRow - 1, 4);
      const dbValues = dbRange.getValues();
      let matchedTractors = 0;
      let matchedSemis = 0;

      for (let i = 0; i < dbValues.length; i++) {
        const tractor = String(dbValues[i][0] || '').toUpperCase().replace(/[\s\-_.]/g, '');
        const semi = String(dbValues[i][2] || '').toUpperCase().replace(/[\s\-_.]/g, '');

        if (tractor && latestOtByPlate[tractor]) {
          dbValues[i][1] = latestOtByPlate[tractor];
          matchedTractors++;
        }
        if (semi && latestOtByPlate[semi]) {
          dbValues[i][3] = latestOtByPlate[semi];
          matchedSemis++;
        }
      }

      // Escritura en 1 solo batch
      dbRange.setValues(dbValues);
      SpreadsheetApp.flush();

      Logger.log("✅ Sincronización masiva completada en " + targetId + ":");
      Logger.log("   - OTs asignadas a Tractores: " + matchedTractors);
      Logger.log("   - OTs asignadas a Semis:     " + matchedSemis);
    } catch (errTarget) {
      console.error("❌ Error en sync masivo hacia " + targetId + ": " + errTarget.message);
    }
  });

  const durationSec = ((new Date().getTime() - startTime) / 1000).toFixed(2);
  Logger.log("🏁 Proceso completado exitosamente en " + durationSec + " segundos.");
}
