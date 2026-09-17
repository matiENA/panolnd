/**
 * taskSyncService.js
 * Servicio integral y automatizado de gestión de tareas operativas de taller para Pañol Cloud / Render.
 * 
 * Reglas de Negocio (Idempotencia, Prägnanz y Poka-Yoke):
 * 1. Automatización continua: Tarea de fondo periódica + gatillos por webhook.
 * 2. CERO SOBREESCRITURA: Las fechas (ASIGNADO, EMPEZO, TERMINO) y datos (UBICACION, OPERARIO) existentes NUNCA se tocan ni sobreescriben.
 * 3. CERO RE-PROCESAMIENTO: Si una tarea ya existe en 'DB_OT_TASKS' o ya fue archivada en 'HISTORICO_COLD', se ignora por completo.
 * 4. Inserción exclusiva por APPEND: Solo se insertan al final de 'DB_OT_TASKS' las tareas genuinamente nuevas.
 * 5. Cold Storage & Hot Purge: Al completarse el 100% de las tareas de una OT, se archiva en 'HISTORICO_COLD' y se purga de la tabla activa.
 */

const { extractPlates } = require('./plateNormalizer');

const DB_TASKS_TAB = 'DB_OT_TASKS';
const COLD_STORAGE_TAB = 'HISTORICO_TAREAS_COLD';
const OTS_SOURCE_TAB = 'ots';

const DB_TASKS_HEADERS = [
  'TASK_ID',
  'OT_NUMBER',
  'DOMINIO',
  'RUBRO',
  'DESCRIPCION',
  'UBICACION',
  'OPERARIO',
  'ASIGNADO',
  'EMPEZO',
  'TERMINO',
  'ESTADO',
  'ORIGEN_TAB',
  'METADATA_JSON'
];

const COLD_STORAGE_HEADERS = [
  'TASK_ID',
  'OT_NUMBER',
  'DOMINIO',
  'RUBRO',
  'DESCRIPCION',
  'UBICACION',
  'OPERARIO',
  'ASIGNADO',
  'EMPEZO',
  'TERMINO',
  'ESTADO',
  'FECHA_ARCHIVADO',
  'DURACION_MINUTOS',
  'OBSERVACIONES'
];

// Mutex de sincronización para evitar ejecuciones concurrentes solapadas
let isSyncRunning = false;
let autoSyncIntervalTimer = null;

/**
 * Valida y crea las pestañas DB_OT_TASKS e HISTORICO_COLD en Google Sheets si no existen.
 */
async function ensureSheetsStructure(sheetsClient, spreadsheetId) {
  if (!sheetsClient || !spreadsheetId) return;

  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
    const existingTitles = meta.data.sheets.map(s => s.properties.title);
    const requests = [];

    if (!existingTitles.includes(DB_TASKS_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: DB_TASKS_TAB,
            gridProperties: { rowCount: 1000, columnCount: 15 }
          }
        }
      });
    }

    if (!existingTitles.includes(COLD_STORAGE_TAB)) {
      requests.push({
        addSheet: {
          properties: {
            title: COLD_STORAGE_TAB,
            gridProperties: { rowCount: 2000, columnCount: 18 }
          }
        }
      });
    }

    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
      console.log(`✅ Pestañas inicializadas: ${requests.map(r => r.addSheet.properties.title).join(', ')}`);
    }

    // Asegurar encabezados en DB_OT_TASKS (13 columnas A1:M1)
    const tasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${DB_TASKS_TAB}'!A1:M1`
    });
    if (!tasksRes.data.values || tasksRes.data.values.length === 0 || tasksRes.data.values[0].length < 13) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A1:M1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [DB_TASKS_HEADERS] }
      });
    }

    // Asegurar encabezados en HISTORICO_COLD (14 columnas A1:N1)
    const coldRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${COLD_STORAGE_TAB}'!A1:N1`
    });
    if (!coldRes.data.values || coldRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${COLD_STORAGE_TAB}'!A1:N1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [COLD_STORAGE_HEADERS] }
      });
    }
  } catch (err) {
    console.error('❌ Error en ensureSheetsStructure:', err.message);
  }
}

/**
 * Desglosa un string de tareas crudo "[RUBRO] Descripcion | [RUBRO] Descripcion" en objetos individuales.
 */
function parseTasksFromString(rawTasksString) {
  if (!rawTasksString || typeof rawTasksString !== 'string') return [];

  const chunks = rawTasksString.split('|').map(s => s.trim()).filter(Boolean);
  const tasks = [];

  chunks.forEach((chunk, idx) => {
    const bracketMatch = chunk.match(/^\[(.*?)\]\s*(.*)$/);
    const colonMatch = chunk.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ0-9\s]{2,25}):\s*(.*)$/);

    if (bracketMatch) {
      tasks.push({
        index: idx + 1,
        rubro: bracketMatch[1].trim().toUpperCase(),
        descripcion: bracketMatch[2].trim(),
        rawText: chunk
      });
    } else if (colonMatch) {
      tasks.push({
        index: idx + 1,
        rubro: colonMatch[1].trim().toUpperCase(),
        descripcion: colonMatch[2].trim(),
        rawText: chunk
      });
    } else {
      tasks.push({
        index: idx + 1,
        rubro: 'GENERAL',
        descripcion: chunk,
        rawText: chunk
      });
    }
  });

  return tasks;
}

/**
 * Parsea el dominio desde cadenas como "AG147LK | 727 (T)", "AG147LK - 00011110" o "AG172II".
 */
function parseDominio(rawDominioString) {
  if (!rawDominioString) return '';
  const extracted = extractPlates(rawDominioString);
  if (extracted.length > 0) return extracted[0];
  const parts = String(rawDominioString).split('|').map(s => s.trim());
  return parts[0] ? parts[0].toUpperCase().replace(/[\s\-_.]/g, '') : '';
}

/**
 * Función de compatibilidad
 */
function parseDominioAndInterno(rawDominioString) {
  const plate = parseDominio(rawDominioString);
  return { plate, interno: '', tipo: 'TRACTOR' };
}

/**
 * Genera clave canónica para verificación de unicidad.
 */
function makeTaskFingerprint(otNumber, plate, rubro, descripcion) {
  const cleanOt = String(otNumber || '').trim().replace(/^0+/, '');
  const cleanPlate = String(plate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
  const cleanRubro = String(rubro || '').trim().toUpperCase();
  const cleanDesc = String(descripcion || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${cleanOt}__${cleanPlate}__${cleanRubro}__${cleanDesc}`;
}

/**
 * SINCRONIZACIÓN AUTOMATIZADA IDEMPOTENTE:
 * - NO sobreescribe ninguna fila existente.
 * - NO toca ninguna fecha ni horario.
 * - NO procesa tareas ya existentes en DB_OT_TASKS ni en HISTORICO_COLD.
 * - Solo inserta (APPEND) tareas nuevas sin columna INTERNO_TIPO.
 */
async function syncOtsToTasksDatabase({ sheetsClient, spreadsheetId }) {
  if (!sheetsClient || !spreadsheetId) throw new Error('Cliente o Spreadsheet ID inválido');

  if (isSyncRunning) {
    console.log('⏳ Sincronización de tareas ya en ejecución. Omitiendo ciclo solapado.');
    return { success: true, status: 'SKIPPED_CONCURRENT' };
  }

  isSyncRunning = true;
  const startTime = Date.now();

  try {
    await ensureSheetsStructure(sheetsClient, spreadsheetId);

    // 1. Leer pestañas 'ots' y 'ots_anteriores' en batch (A2:I)
    const batchOtsRes = await sheetsClient.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [`'${OTS_SOURCE_TAB}'!A2:I1000`, `'ots_anteriores'!A2:I3000`]
    });

    const valRanges = batchOtsRes.data.valueRanges || [];
    const otsRows = (valRanges[0] && valRanges[0].values) || [];
    const antRows = (valRanges[1] && valRanges[1].values) || [];

    if (otsRows.length === 0 && antRows.length === 0) {
      return { success: true, count: 0, message: "No hay datos en 'ots' ni 'ots_anteriores'" };
    }

    // 2. Leer tareas existentes en 'DB_OT_TASKS' (A:E para indexar TASK_ID, OT, DOMINIO, RUBRO, DESCRIPCION)
    const currentTasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${DB_TASKS_TAB}'!A2:E2000`
    });
    const currentTaskRows = currentTasksRes.data.values || [];

    // 3. Leer tareas ya archivadas en 'HISTORICO_COLD' (para no re-crear OTs cerradas)
    const coldTasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${COLD_STORAGE_TAB}'!A2:E3000`
    });
    const coldTaskRows = coldTasksRes.data.values || [];

    // 4. Construir índice de exclusión (Set de IDs y Fingerprints existentes)
    const existingTaskIds = new Set();
    const existingFingerprints = new Set();

    currentTaskRows.forEach(r => {
      const taskId = String(r[0] || '').trim();
      const ot = String(r[1] || '').trim();
      const plate = String(r[2] || '').trim();
      const rubro = String(r[3] || '').trim();
      const desc = String(r[4] || '').trim();
      if (taskId) existingTaskIds.add(taskId);
      if (ot && desc) existingFingerprints.add(makeTaskFingerprint(ot, plate, rubro, desc));
    });

    coldTaskRows.forEach(r => {
      const taskId = String(r[0] || '').trim();
      const ot = String(r[1] || '').trim();
      const plate = String(r[2] || '').trim();
      const rubro = String(r[3] || '').trim();
      const desc = String(r[4] || '').trim();
      if (taskId) existingTaskIds.add(taskId);
      if (ot && desc) existingFingerprints.add(makeTaskFingerprint(ot, plate, rubro, desc));
    });

    // 5. Filtrar estrictamente solo lo NUEVO
    const newRowsToAppend = [];
    let skippedExistingCount = 0;

    const sources = [
      { rows: otsRows, originTab: 'ots' },
      { rows: antRows, originTab: 'ots_anteriores' }
    ];

    for (const source of sources) {
      for (const row of source.rows) {
        const rawOt = String(row[2] || '').trim(); // Col C: ORDEN Nº
        const rawDominio = String(row[3] || '').trim(); // Col D: DOMINIO
        const rawTasks = String(row[4] || '').trim(); // Col E: Sector / Tareas
        const rawColIJson = String(row[8] || '').trim(); // Col I: JSON COORDINACION

        if (!rawOt || !rawTasks) continue;

        const cleanOt = rawOt.replace(/^0+/, '') || rawOt;
        const plate = parseDominio(rawDominio);
        const parsedTaskList = parseTasksFromString(rawTasks);

        let savedColI = null;
        if (rawColIJson) {
          try {
            savedColI = JSON.parse(rawColIJson);
          } catch (e) {}
        }

        parsedTaskList.forEach((item, idx) => {
          const taskId = `${cleanOt}-${plate}-${idx + 1}`;
          const fingerprint = makeTaskFingerprint(cleanOt, plate, item.rubro, item.descripcion);

          // Si ya existe en DB_OT_TASKS o en HISTORICO_COLD, SE SALTEA SIN TOCAR
          if (existingTaskIds.has(taskId) || existingFingerprints.has(fingerprint)) {
            skippedExistingCount++;
            return;
          }

          let colITask = null;
          if (savedColI && Array.isArray(savedColI.tasks)) {
            colITask = savedColI.tasks.find(t => t.id === taskId || t.desc === item.descripcion);
          }

          const ubicacion = (colITask && colITask.ubicacion) || (savedColI && savedColI.ubicacion) || '';
          const operario = (colITask && (colITask.operarios || colITask.operario)) || '';
          const asignado = (colITask && colITask.asignado) || '';
          const empezo = (colITask && colITask.empezo) || '';
          const termino = (colITask && colITask.termino) || '';
          const estado = (colITask && colITask.estado) || (termino ? 'COMPLETADA' : (empezo ? 'EN_CURSO' : (operario ? 'ASIGNADA' : 'PENDIENTE')));

          // 13 columnas (A:M)
          newRowsToAppend.push([
            taskId,
            cleanOt,
            plate,
            item.rubro,
            item.descripcion,
            ubicacion,
            operario,
            asignado,
            empezo,
            termino,
            estado,
            source.originTab,
            '' // Metadata JSON extensible
          ]);

          // Registrar en los sets locales para evitar duplicaciones dentro del mismo lote
          existingTaskIds.add(taskId);
          existingFingerprints.add(fingerprint);
        });
      }
    }

    // 6. Inserción atómica por APPEND (sin reescribir ni tocar filas previas)
    if (newRowsToAppend.length > 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A:M`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: newRowsToAppend }
      });
      console.log(`✨ [AutoSync] ${newRowsToAppend.length} nuevas tareas agregadas a ${DB_TASKS_TAB} desde ots y ots_anteriores. (${skippedExistingCount} existentes preservadas intactas).`);
    } else {
      console.log(`✓ [AutoSync] Sin tareas nuevas (${skippedExistingCount} existentes comprobadas y preservadas intactas).`);
    }

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      newTasksAppended: newRowsToAppend.length,
      skippedExisting: skippedExistingCount,
      durationMs,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('❌ Error en syncOtsToTasksDatabase:', err.message);
    return { success: false, error: err.message };
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Inicia el cron de sincronización automática periódica en segundo plano.
 */
function startAutomaticTaskSync({ sheetsClient, spreadsheetId, io, intervalMinutes = 2 }) {
  if (autoSyncIntervalTimer) {
    clearInterval(autoSyncIntervalTimer);
  }

  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  console.log(`🤖 Automatización iniciada: Sincronizador de DB_OT_TASKS activo cada ${intervalMinutes} minuto(s).`);

  // Primera ejecución inicial
  syncOtsToTasksDatabase({ sheetsClient, spreadsheetId }).then(res => {
    if (res.newTasksAppended > 0 && io) {
      io.emit('tasks_synced', res);
    }
  }).catch(e => console.error('Error en sync inicial:', e.message));

  // Tarea periódica
  autoSyncIntervalTimer = setInterval(async () => {
    try {
      const res = await syncOtsToTasksDatabase({ sheetsClient, spreadsheetId });
      if (res.newTasksAppended > 0 && io) {
        io.emit('tasks_synced', res);
      }
    } catch (e) {
      console.error('Error en autoSyncIntervalTimer:', e.message);
    }
  }, intervalMs);

  return autoSyncIntervalTimer;
}

/**
 * Obtiene todas las tareas activas de 'DB_OT_TASKS' estructuradas en Equipos (Tractor + Semi).
 * La diferenciación y unión entre Tractor y Semi se sirve directamente por la disposición de Col A y Col C en DB_OT_LIST.
 */
async function getActiveTasksBoard({ sheetsClient, spreadsheetId }) {
  if (!sheetsClient || !spreadsheetId) return { units: [] };

  await ensureSheetsStructure(sheetsClient, spreadsheetId);

  // 1. Mapeo maestro de diferenciación y unión Tractor/Semi desde DB_OT_LIST (Cols A y C)
  const plateToType = new Map();
  const pairByPlate = new Map();
  const pairByOt = new Map();

  try {
    const otListRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: "'DB_OT_LIST'!A2:C"
    });
    const otListRows = otListRes.data.values || [];

    otListRows.forEach(r => {
      const tractor = String(r[0] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
      const ot = String(r[1] || '').trim();
      const semi = String(r[2] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

      const pair = { tractor, semi, ot };

      if (tractor) {
        plateToType.set(tractor, 'TRACTOR');
        pairByPlate.set(tractor, pair);
      }
      if (semi) {
        plateToType.set(semi, 'SEMI');
        pairByPlate.set(semi, pair);
      }
      if (ot) {
        pairByOt.set(ot, pair);
      }
    });
  } catch (err) {
    console.error('Error al cargar DB_OT_LIST para mapeo Tractor/Semi:', err.message);
  }

  // 2. Leer tareas activas desde DB_OT_TASKS (11 columnas: A:K)
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A2:K1500`
  });

  const rows = res.data.values || [];
  const unitsMap = new Map();

  rows.forEach(r => {
    const taskId = String(r[0] || '').trim();
    const otNumber = String(r[1] || '').trim();
    const dominio = String(r[2] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
    const rubro = String(r[3] || '').trim();
    const desc = String(r[4] || '').trim();
    const ubicacion = String(r[5] || '').trim();
    const operario = String(r[6] || '').trim();
    const asignado = String(r[7] || '').trim();
    const empezo = String(r[8] || '').trim();
    const termino = String(r[9] || '').trim();
    const estado = String(r[10] || 'PENDIENTE').trim();

    if (!taskId || !otNumber) return;

    // Diferenciación confiable basada en DB_OT_LIST (Cols A y C)
    let type = plateToType.get(dominio);
    const pair = pairByPlate.get(dominio) || pairByOt.get(otNumber) || {};

    if (!type) {
      if (pair.semi === dominio) type = 'SEMI';
      else if (pair.tractor === dominio) type = 'TRACTOR';
      else type = 'TRACTOR'; // Fallback seguro
    }

    const isSemi = (type === 'SEMI');
    const groupKey = otNumber;

    if (!unitsMap.has(groupKey)) {
      unitsMap.set(groupKey, {
        id: `unit_${otNumber}`,
        ot: otNumber,
        status: 'progreso',
        tractor: {
          plate: pair.tractor || (!isSemi ? dominio : ''),
          ot: pair.ot || otNumber,
          tasks: []
        },
        semi: {
          plate: pair.semi || (isSemi ? dominio : ''),
          ot: pair.ot || otNumber,
          tasks: []
        }
      });
    }

    const unit = unitsMap.get(groupKey);

    // Asegurar patentes del par desde DB_OT_LIST
    if (pair.tractor && !unit.tractor.plate) unit.tractor.plate = pair.tractor;
    if (pair.semi && !unit.semi.plate) unit.semi.plate = pair.semi;

    const taskObj = {
      id: taskId,
      sector: rubro,
      desc: desc,
      ubicacion: ubicacion,
      operarios: operario,
      asignado: asignado,
      empezo: empezo,
      termino: termino,
      estado: estado
    };

    if (isSemi) {
      if (!unit.semi.plate) unit.semi.plate = dominio;
      unit.semi.tasks.push(taskObj);
    } else {
      if (!unit.tractor.plate) unit.tractor.plate = dominio;
      unit.tractor.tasks.push(taskObj);
    }
  });

  const unitsList = Array.from(unitsMap.values());

  unitsList.forEach(u => {
    const allTasks = [...u.tractor.tasks, ...u.semi.tasks];
    const allDone = allTasks.length > 0 && allTasks.every(t => t.termino && t.termino.trim() !== '');
    if (allDone) {
      u.status = 'terminado';
    }
  });

  return {
    success: true,
    units: unitsList,
    totalActiveTasks: rows.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Actualiza de forma atómica una tarea específica en 'DB_OT_TASKS' por su TASK_ID.
 */
async function updateTaskExecution({ sheetsClient, spreadsheetId, taskId, ubicacion, operario, asignado, empezo, termino, estado, io }) {
  if (!sheetsClient || !spreadsheetId || !taskId) {
    throw new Error('Parámetros requeridos: sheetsClient, spreadsheetId, taskId');
  }

  // 1. Buscar la fila exacta en DB_OT_TASKS (13 columnas A:M)
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A:M`
  });

  const rows = res.data.values || [];
  let targetRowIndex = -1;
  let currentRowData = null;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === String(taskId).trim()) {
      targetRowIndex = i + 1; // 1-indexed para Sheets
      currentRowData = rows[i];
      break;
    }
  }

  if (targetRowIndex === -1) {
    return { success: false, error: `No se encontró la tarea con ID ${taskId}` };
  }

  // 2. Preservar valores previos si el parámetro no viene definido
  // Indices: 5: UBICACION, 6: OPERARIO, 7: ASIGNADO, 8: EMPEZO, 9: TERMINO, 10: ESTADO
  const newUbicacion = ubicacion !== undefined ? ubicacion : (currentRowData[5] || '');
  const newOperario = operario !== undefined ? operario : (currentRowData[6] || '');
  const newAsignado = asignado !== undefined ? asignado : (currentRowData[7] || '');
  const newEmpezo = empezo !== undefined ? empezo : (currentRowData[8] || '');
  const newTermino = termino !== undefined ? termino : (currentRowData[9] || '');

  let newEstado = estado !== undefined ? estado : (currentRowData[10] || 'PENDIENTE');
  if (newTermino && newTermino.trim() !== '') {
    newEstado = 'COMPLETADA';
  } else if (newEmpezo && newEmpezo.trim() !== '') {
    newEstado = 'EN_CURSO';
  } else if (newOperario || newUbicacion) {
    newEstado = 'ASIGNADA';
  }

  // 3. Escribir actualización en rango F{row}:K{row} de DB_OT_TASKS
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!F${targetRowIndex}:K${targetRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newUbicacion, newOperario, newAsignado, newEmpezo, newTermino, newEstado]]
    }
  });

  console.log(`✅ Tarea ${taskId} actualizada en DB_OT_TASKS fila ${targetRowIndex}: ${newEstado}`);

  // Sincronizar también con Col I de 'ots' o 'ots_anteriores'
  const otNumber = currentRowData[1];
  const plate = currentRowData[2];
  if (otNumber || plate) {
    try {
      const cleanOt = String(otNumber || '').trim().replace(/^0+/, '');
      const cleanPlate = String(plate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
      const tabsToCheck = [OTS_SOURCE_TAB, 'ots_anteriores'];

      for (const tabName of tabsToCheck) {
        const otsGet = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `'${tabName}'!A2:I1000`
        });
        const oRows = otsGet.data.values || [];
        let matchedRowIdx = -1;
        let matchedRow = null;

        for (let ri = 0; ri < oRows.length; ri++) {
          const rOt = String(oRows[ri][2] || '').trim().replace(/^0+/, '');
          const rPlate = String(oRows[ri][3] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
          if ((cleanOt && rOt === cleanOt) || (cleanPlate && rPlate === cleanPlate)) {
            matchedRowIdx = ri + 2;
            matchedRow = oRows[ri];
            break;
          }
        }

        if (matchedRowIdx > 0 && matchedRow) {
          let colIObj = { tasks: [] };
          if (matchedRow[8]) {
            try {
              const parsedI = JSON.parse(matchedRow[8]);
              if (parsedI && typeof parsedI === 'object') colIObj = parsedI;
              if (!Array.isArray(colIObj.tasks)) colIObj.tasks = [];
            } catch (e) {}
          }

          let existingTask = colIObj.tasks.find(t => t.id === taskId);
          if (!existingTask) {
            existingTask = {
              id: taskId,
              sector: currentRowData[3] || '',
              desc: currentRowData[4] || '',
              ubicacion: newUbicacion,
              operarios: newOperario,
              asignado: newAsignado,
              empezo: newEmpezo,
              termino: newTermino,
              estado: newEstado
            };
            colIObj.tasks.push(existingTask);
          } else {
            if (newUbicacion !== undefined) existingTask.ubicacion = newUbicacion;
            if (newOperario !== undefined) existingTask.operarios = newOperario;
            if (newAsignado !== undefined) existingTask.asignado = newAsignado;
            if (newEmpezo !== undefined) existingTask.empezo = newEmpezo;
            if (newTermino !== undefined) existingTask.termino = newTermino;
            existingTask.estado = newEstado;
          }

          await sheetsClient.spreadsheets.values.update({
            spreadsheetId,
            range: `'${tabName}'!I${matchedRowIdx}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[JSON.stringify(colIObj)]] }
          });
          break;
        }
      }
    } catch (eSyncColI) {
      console.warn('⚠️ Nota: Sync secundario a Col I:', eSyncColI.message);
    }
  }

  const updateResult = {
    success: true,
    taskId,
    row: targetRowIndex,
    ubicacion: newUbicacion,
    operario: newOperario,
    asignado: newAsignado,
    empezo: newEmpezo,
    termino: newTermino,
    estado: newEstado,
    timestamp: new Date().toISOString()
  };

  if (io) {
    io.emit('task_updated', updateResult);
    io.emit('task_status_changed', updateResult);
  }

  // 4. Verificar si la OT completa finalizó para enviar a Cold Storage
  if (otNumber) {
    checkAndArchiveIfOtFinished({ sheetsClient, spreadsheetId, otNumber, io }).catch(e => {
      console.error('Error en checkAndArchiveIfOtFinished:', e.message);
    });
  }

  return updateResult;
}

/**
 * Verifica si todas las tareas de una OT están completadas y las traslada a Cold Storage.
 */
async function checkAndArchiveIfOtFinished({ sheetsClient, spreadsheetId, otNumber, io }) {
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A:K`
  });

  const rows = res.data.values || [];
  const otRows = [];
  const otRowIndexes = [];

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim() === String(otNumber).trim()) {
      otRows.push(rows[i]);
      otRowIndexes.push(i + 1);
    }
  }

  if (otRows.length === 0) return { archived: false };

  // Verificar si todas tienen fecha TERMINO o están marcadas completadas/descartadas (Índice 9 y 10)
  const allCompleted = otRows.every(r => {
    const term = String(r[9] || '').trim();
    const st = String(r[10] || '').toUpperCase().trim();
    return term !== '' || st === 'DESCARTADA' || st === 'COMPLETADA';
  });

  if (!allCompleted) {
    return { archived: false, pendingCount: otRows.filter(r => !r[9]).length };
  }

  console.log(`📦 ¡OT ${otNumber} completada al 100%! Archivando en Cold Storage (${COLD_STORAGE_TAB})...`);

  const now = new Date();
  const archiveTimestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const coldRows = otRows.map(r => {
    let duracionMin = 0;
    try {
      if (r[8] && r[9]) {
        const tIni = new Date(r[8]).getTime();
        const tFin = new Date(r[9]).getTime();
        if (!isNaN(tIni) && !isNaN(tFin) && tFin >= tIni) {
          duracionMin = Math.round((tFin - tIni) / 60000);
        }
      }
    } catch (e) {}

    return [
      r[0], // TASK_ID
      r[1], // OT_NUMBER
      r[2], // DOMINIO
      r[3], // RUBRO
      r[4], // DESCRIPCION
      r[5], // UBICACION
      r[6], // OPERARIO
      r[7], // ASIGNADO
      r[8], // EMPEZO
      r[9], // TERMINO
      r[10] || 'COMPLETADA', // ESTADO
      archiveTimestamp, // FECHA_ARCHIVADO
      duracionMin, // DURACION_MINUTOS
      'Archivado automático tras completar 100% de tareas' // OBSERVACIONES
    ];
  });

  // 1. Append a HISTORICO_COLD (14 columnas A:N)
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: `'${COLD_STORAGE_TAB}'!A:N`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: coldRows }
  });

  // 2. Hot Purge: Eliminar las filas de DB_OT_TASKS
  const sheetMeta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const dbSheetObj = sheetMeta.data.sheets.find(s => s.properties.title === DB_TASKS_TAB);
  const sheetIdNum = dbSheetObj?.properties?.sheetId;

  if (sheetIdNum !== undefined) {
    const deleteRequests = otRowIndexes.sort((a, b) => b - a).map(rowNum => ({
      deleteDimension: {
        range: {
          sheetId: sheetIdNum,
          dimension: 'ROWS',
          startIndex: rowNum - 1,
          endIndex: rowNum
        }
      }
    }));

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: deleteRequests }
    });
    console.log(`🧹 Hot Purge completado: ${deleteRequests.length} filas eliminadas de ${DB_TASKS_TAB}.`);
  }

  if (io) {
    io.emit('ot_archived', { otNumber, tasksArchived: coldRows.length, timestamp: archiveTimestamp });
  }

  return {
    archived: true,
    otNumber,
    tasksCount: coldRows.length,
    timestamp: archiveTimestamp
  };
}

/**
 * Obtiene el historial de tareas archivadas desde 'HISTORICO_COLD'.
 */
async function getHistoricalTasks({ sheetsClient, spreadsheetId, limit = 500 }) {
  if (!sheetsClient || !spreadsheetId) return { rows: [] };

  await ensureSheetsStructure(sheetsClient, spreadsheetId);

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${COLD_STORAGE_TAB}'!A2:N${limit + 1}`
  });

  return {
    success: true,
    tasks: res.data.values || []
  };
}

/**
 * DB_STAFF Col M: Obtiene las unidades / OTs en hold para un operario.
 */
async function getOperarioHoldOts({ sheetsClient, spreadsheetId, opId }) {
  if (!sheetsClient || !spreadsheetId || !opId) return { success: false, units: [] };
  const cleanId = String(opId).trim();

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: 'DB_STAFF!A1:M100'
    });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() === cleanId) {
        const rawHold = rows[i][12]; // Col M (index 12)
        let units = [];
        if (rawHold) {
          try {
            units = JSON.parse(rawHold);
            if (!Array.isArray(units)) units = [];
          } catch (e) {
            units = [];
          }
        }
        return { success: true, row: i + 1, units };
      }
    }
    return { success: true, units: [] };
  } catch (err) {
    console.error('Error en getOperarioHoldOts:', err.message);
    return { success: false, error: err.message, units: [] };
  }
}

/**
 * DB_STAFF Col M: Guarda la lista de unidades / OTs en hold para un operario.
 */
async function saveOperarioHoldOts({ sheetsClient, spreadsheetId, opId, units, io }) {
  if (!sheetsClient || !spreadsheetId || !opId) return { success: false };
  const cleanId = String(opId).trim();
  const safeUnits = Array.isArray(units) ? units : [];

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: 'DB_STAFF!A1:A100'
    });
    const rows = res.data.values || [];
    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() === cleanId) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) {
      return { success: false, error: 'Operario no encontrado en DB_STAFF' };
    }

    const jsonVal = JSON.stringify(safeUnits);
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `DB_STAFF!M${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[jsonVal]] }
    });

    console.log(`📌 [DB_STAFF Col M] Operario ${cleanId} (fila ${targetRow}) actualizado con ${safeUnits.length} OTs en hold.`);

    if (io) {
      io.emit('taller_hold_updated', { opId: cleanId, units: safeUnits });
    }

    return { success: true, units: safeUnits };
  } catch (err) {
    console.error('Error en saveOperarioHoldOts:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * ots Col G: Lee o actualiza el payload de ciclo de vida (ASIGNACION, RECIBIDO, TERMINADO).
 * Nota de negocio: ASIGNACION y RECIBIDO quedan inhabilitados / vacíos en esta fase.
 */
async function getOtLifecyclePayload({ sheetsClient, spreadsheetId, otNumber }) {
  if (!sheetsClient || !spreadsheetId || !otNumber) return { asignacion: [], recibido: [], terminado: [] };
  const cleanOt = String(otNumber).trim().replace(/^0+/, '');

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:G500`
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const rowOt = String(rows[i][2] || '').trim().replace(/^0+/, '');
      if (rowOt === cleanOt) {
        const rawPayload = rows[i][6];
        if (rawPayload) {
          try {
            const parsed = JSON.parse(rawPayload);
            return {
              asignacion: Array.isArray(parsed.asignacion) ? parsed.asignacion : [],
              recibido: Array.isArray(parsed.recibido) ? parsed.recibido : [],
              terminado: Array.isArray(parsed.terminado) ? parsed.terminado : []
            };
          } catch(e) {}
        }
        break;
      }
    }
    return { asignacion: [], recibido: [], terminado: [] };
  } catch (err) {
    console.error('Error en getOtLifecyclePayload:', err.message);
    return { asignacion: [], recibido: [], terminado: [] };
  }
}

/**
 * ots Col G: Marca o desmarca una tarea como terminada.
 */
async function updateOtTaskTerminado({ sheetsClient, spreadsheetId, otNumber, taskId, rubro, desc, opId, isCompleted, io }) {
  if (!sheetsClient || !spreadsheetId || !otNumber) return { success: false, error: 'Parámetros inválidos' };
  const cleanOt = String(otNumber).trim().replace(/^0+/, '');

  try {
    let targetTab = OTS_SOURCE_TAB;
    let targetRowIndex = -1;
    let currentRow = null;

    const otsRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:I1000`
    });
    const rows = otsRes.data.values || [];

    for (let i = 0; i < rows.length; i++) {
      const rowOt = String(rows[i][2] || '').trim().replace(/^0+/, '');
      if (rowOt === cleanOt) {
        targetRowIndex = i + 2;
        currentRow = rows[i];
        break;
      }
    }

    if (targetRowIndex === -1) {
      try {
        const antRes = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `'ots_anteriores'!A2:I3000`
        });
        const antRows = antRes.data.values || [];
        for (let i = 0; i < antRows.length; i++) {
          const rowOt = String(antRows[i][2] || '').trim().replace(/^0+/, '');
          if (rowOt === cleanOt) {
            targetRowIndex = i + 2;
            targetTab = 'ots_anteriores';
            currentRow = antRows[i];
            break;
          }
        }
      } catch (eAntSearch) {}
    }

    const nowIso = new Date().toISOString();
    const nowTimeStr = new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const safeTaskId = taskId || `${cleanOt}-${rubro}-${desc}`;

    // Actualizar Col G (payload legado)
    let payload = { asignacion: [], recibido: [], terminado: [] };
    if (currentRow && currentRow[6]) {
      try {
        const parsed = JSON.parse(currentRow[6]);
        if (parsed && typeof parsed === 'object') {
          payload.asignacion = Array.isArray(parsed.asignacion) ? parsed.asignacion : [];
          payload.recibido = Array.isArray(parsed.recibido) ? parsed.recibido : [];
          payload.terminado = Array.isArray(parsed.terminado) ? parsed.terminado : [];
        }
      } catch(e) {}
    }

    if (isCompleted) {
      const already = payload.terminado.some(t => (t.taskId && t.taskId === safeTaskId) || (t.desc === desc && t.rubro === rubro));
      if (!already) {
        payload.terminado.push({
          taskId: safeTaskId,
          rubro: rubro || '',
          desc: desc || '',
          opId: String(opId || ''),
          timestamp: nowIso
        });
      }
    } else {
      payload.terminado = payload.terminado.filter(t => !((t.taskId && t.taskId === safeTaskId) || (t.desc === desc && t.rubro === rubro)));
    }

    // Actualizar Col I (JSON de Coordinación)
    let colIJson = { tasks: [] };
    if (currentRow && currentRow[8]) {
      try {
        const parsedI = JSON.parse(currentRow[8]);
        if (parsedI && typeof parsedI === 'object') colIJson = parsedI;
        if (!Array.isArray(colIJson.tasks)) colIJson.tasks = [];
      } catch (e) {}
    }

    let existingColITask = colIJson.tasks.find(t => (t.id && t.id === safeTaskId) || (t.desc === desc));
    if (!existingColITask) {
      existingColITask = {
        id: safeTaskId,
        sector: rubro || '',
        desc: desc || '',
        operarios: opId || '',
        asignado: nowIso,
        empezo: nowIso,
        termino: isCompleted ? nowIso : '',
        estado: isCompleted ? 'TERMINADO' : 'PENDIENTE'
      };
      colIJson.tasks.push(existingColITask);
    } else {
      if (isCompleted) {
        if (!existingColITask.empezo) existingColITask.empezo = nowIso;
        existingColITask.termino = nowIso;
        existingColITask.estado = 'TERMINADO';
      } else {
        existingColITask.termino = '';
        existingColITask.estado = existingColITask.empezo ? 'EN_CURSO' : 'PENDIENTE';
      }
      if (opId && !existingColITask.operarios) existingColITask.operarios = opId;
    }

    if (targetRowIndex > 0) {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: `'${targetTab}'!G${targetRowIndex}`,
              values: [[JSON.stringify(payload)]]
            },
            {
              range: `'${targetTab}'!I${targetRowIndex}`,
              values: [[JSON.stringify(colIJson)]]
            }
          ]
        }
      });
      console.log(`✅ [${targetTab} Col G e I] OT ${cleanOt} fila ${targetRowIndex}: Estado terminado actualizado.`);
    }

    // Sincronizar también con DB_OT_TASKS
    try {
      const dbTasksRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A2:K2000`
      });
      const taskRows = dbTasksRes.data.values || [];
      for (let i = 0; i < taskRows.length; i++) {
        const tId = String(taskRows[i][0] || '').trim();
        const tOt = String(taskRows[i][1] || '').trim().replace(/^0+/, '');
        const tDesc = String(taskRows[i][4] || '').trim();
        if ((safeTaskId && tId === safeTaskId) || (tOt === cleanOt && tDesc === desc)) {
          const rowNum = i + 2;
          const prevEmpezo = taskRows[i][8] || '';
          const newEmpezo = prevEmpezo || (isCompleted ? nowTimeStr : '');
          const newTermino = isCompleted ? (taskRows[i][9] || nowTimeStr) : '';
          const newEstado = isCompleted ? 'COMPLETADA' : (newEmpezo ? 'EN_CURSO' : 'PENDIENTE');
          await sheetsClient.spreadsheets.values.update({
            spreadsheetId,
            range: `'${DB_TASKS_TAB}'!I${rowNum}:K${rowNum}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[newEmpezo, newTermino, newEstado]] }
          });
          break;
        }
      }
    } catch(e) {
      console.error('Nota: Sync secundario a DB_OT_TASKS:', e.message);
    }

    const resObj = {
      success: true,
      otNumber: cleanOt,
      taskId: safeTaskId,
      isCompleted,
      terminado: payload.terminado
    };

    if (io) {
      io.emit('task_status_changed', resObj);
    }

    return resObj;
  } catch (err) {
    console.error('Error en updateOtTaskTerminado:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Obtiene las tareas estructuradas para el timeline de una unidad (Tractor + Semi).
 */
async function getUnitTimelineTasks({ sheetsClient, spreadsheetId, tractorOt, semiOt, tractorPlate, semiPlate }) {
  if (!sheetsClient || !spreadsheetId) return { success: false, timelineGroups: [] };

  const cleanTractorOt = String(tractorOt || '').trim().replace(/^0+/, '');
  const cleanSemiOt = String(semiOt || '').trim().replace(/^0+/, '');
  const cleanTractorPlate = String(tractorPlate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
  const cleanSemiPlate = String(semiPlate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

  try {
    // 1. Leer tareas directamente desde DB_OT_TASKS (Col A:M) como capa viva única
    let tRows = [];
    try {
      const tasksRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A2:M2000`
      });
      tRows = tasksRes.data.values || [];
    } catch (eTasks) {
      console.warn('⚠️ Error al leer DB_OT_TASKS:', eTasks.message);
    }

    // Mapa de tareas activas para cruzar estados con histórico si aplica
    const dbTasksMap = new Map();
    tRows.forEach(r => {
      const tId = String(r[0] || '').trim();
      if (tId) {
        dbTasksMap.set(tId, {
          ubicacion: String(r[5] || '').trim(),
          operario: String(r[6] || '').trim(),
          asignado: String(r[7] || '').trim(),
          empezo: String(r[8] || '').trim(),
          termino: String(r[9] || '').trim(),
          estado: String(r[10] || 'PENDIENTE').trim()
        });
      }
    });

    // Helper para mapear una fila de DB_OT_TASKS a objeto de tarea
    const mapRowToTask = (r, defaultType) => {
      const taskId = String(r[0] || '').trim();
      const ot = String(r[1] || '').trim().replace(/^0+/, '');
      const dom = parseDominio(r[2]);
      const rubro = String(r[3] || '').trim().toUpperCase();
      const desc = String(r[4] || '').trim();
      const ubicacion = String(r[5] || '').trim();
      const operario = String(r[6] || '').trim();
      const asignado = String(r[7] || '').trim();
      const empezo = String(r[8] || '').trim();
      const termino = String(r[9] || '').trim();
      const estado = String(r[10] || 'PENDIENTE').trim().toUpperCase();

      const isTerminado = !!(termino && termino.trim()) || estado === 'COMPLETADA';
      const isEmpezado = !!(empezo && empezo.trim()) || estado === 'EN_CURSO';

      return {
        id: taskId,
        ot,
        dominio: dom,
        type: defaultType,
        rubro: rubro || 'GENERAL',
        desc: desc || '',
        ubicacion,
        operario,
        asignado,
        empezo,
        termino,
        estado,
        isTerminado,
        isEmpezado
      };
    };

    // Helper para filtrar tareas de DB_OT_TASKS que coincidan con la unidad
    const findTasksInDb = (rows) => {
      const tractorList = [];
      const semiList = [];

      rows.forEach(r => {
        const rowOt = String(r[1] || '').trim().replace(/^0+/, '');
        const rowDom = parseDominio(r[2]);
        if (!rowOt && !rowDom) return;

        const isTractorByOt = cleanTractorOt && (rowOt === cleanTractorOt);
        const isTractorByPlate = cleanTractorPlate && (rowDom === cleanTractorPlate);
        const isSemiByOt = cleanSemiOt && (rowOt === cleanSemiOt);
        const isSemiByPlate = cleanSemiPlate && (rowDom === cleanSemiPlate);

        if (isTractorByOt || isTractorByPlate) {
          tractorList.push(mapRowToTask(r, 'TRACTOR'));
        } else if (isSemiByOt || isSemiByPlate) {
          semiList.push(mapRowToTask(r, 'SEMI'));
        }
      });
      return { tractorList, semiList };
    };

    let { tractorList, semiList } = findTasksInDb(tRows);

    // Si no se encontraron tareas pero hay OTs asignadas, sincronizar desde 'ots' y reintentar
    if (tractorList.length === 0 && semiList.length === 0 && (cleanTractorOt || cleanSemiOt)) {
      try {
        await syncOtsToTasksDatabase({ sheetsClient, spreadsheetId });
        const retryRes = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `'${DB_TASKS_TAB}'!A2:M2000`
        });
        tRows = retryRes.data.values || [];
        const retryFound = findTasksInDb(tRows);
        tractorList = retryFound.tractorList;
        semiList = retryFound.semiList;
      } catch (eRetry) {
        console.warn('⚠️ Reintento de sincronización DB_OT_TASKS:', eRetry.message);
      }
    }

    const timelineGroups = [];

    // Agrupar tareas por OT para TRACTOR y SEMI
    const groupTasksByOt = (tasks, defaultOt, defaultType) => {
      if (!tasks || tasks.length === 0) return;
      const byOt = new Map();
      tasks.forEach(t => {
        const key = t.ot || defaultOt || 'S/OT';
        if (!byOt.has(key)) byOt.set(key, []);
        byOt.get(key).push(t);
      });

      byOt.forEach((taskList, otNum) => {
        let dateLabel = '';
        for (const t of taskList) {
          if (t.asignado) {
            dateLabel = t.asignado.slice(0, 5);
            break;
          } else if (t.empezo) {
            dateLabel = t.empezo.slice(0, 5);
            break;
          }
        }
        if (!dateLabel) {
          const now = new Date();
          dateLabel = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
        }

        timelineGroups.push({
          ot: otNum,
          type: defaultType,
          date: dateLabel,
          tasks: taskList
        });
      });
    };

    groupTasksByOt(tractorList, cleanTractorOt, 'TRACTOR');
    groupTasksByOt(semiList, cleanSemiOt, 'SEMI');

    // Leer OTs históricas (últimos 6 meses) desde ots_anteriores con TODAS sus columnas (A2:I)
    const historicalNodes = [];
    try {
      const antRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'ots_anteriores'!A2:I2000`
      });
      const antRows = antRes.data.values || [];
      const seenAntKeys = new Set();

      antRows.forEach(r => {
        const rawOt = String(r[2] || '').trim();
        const cleanOt = rawOt.replace(/^0+/, '') || rawOt;
        const dom = parseDominio(r[3]);
        if (!cleanOt || !dom) return;

        // No incluir la OT vigente si ya está arriba en timelineGroups
        const isCurrentOt = timelineGroups.some(g => String(g.ot).trim() === cleanOt);
        if (isCurrentOt) return;

        const isTractorMatch = cleanTractorPlate && dom === cleanTractorPlate;
        const isSemiMatch = cleanSemiPlate && dom === cleanSemiPlate;

        if (!isTractorMatch && !isSemiMatch) return;

        const otType = isTractorMatch ? 'TRACTOR' : 'SEMI';
        const key = `${cleanOt}__${dom}`;
        if (seenAntKeys.has(key)) return;
        seenAntKeys.add(key);

        const rawDate = String(r[1] || '').trim();
        const dateLabel = rawDate ? rawDate.slice(0, 5) : 'dd/mm';
        const rawTasks = String(r[4] || '').trim();
        const parsedTasks = parseTasksFromString(rawTasks);

        // Leer payload de Col G para estados 'terminado'
        let payload = { asignacion: [], recibido: [], terminado: [] };
        if (r[6]) {
          try {
            payload = JSON.parse(r[6]);
          } catch (e) {}
        }
        const terminadoList = Array.isArray(payload.terminado) ? payload.terminado : [];
        const colFStatus = String(r[5] || '').trim();

        // Leer Col I para ots_anteriores
        let colI = null;
        if (r[8]) {
          try {
            colI = JSON.parse(r[8]);
          } catch(e) {}
        }

        const tasks = parsedTasks.map((t, idx) => {
          const taskId = `${cleanOt}-${dom}-${idx + 1}`;
          const dbState = dbTasksMap.get(taskId) || {};
          let colITask = null;
          if (colI && Array.isArray(colI.tasks)) {
            colITask = colI.tasks.find(item => item.id === taskId || (item.desc && item.desc.toLowerCase() === t.descripcion.toLowerCase()));
          }

          const operario = (colITask && (colITask.operarios || colITask.operario)) || dbState.operario || '';
          const asignado = (colITask && colITask.asignado) || dbState.asignado || '';
          const empezo = (colITask && colITask.empezo) || dbState.empezo || '';
          const termino = (colITask && colITask.termino) || dbState.termino || '';

          const isTerminado = !!termino || (colFStatus.toUpperCase() === 'TERMINADO' || colFStatus.toUpperCase() === 'CERRADA') ||
            terminadoList.some(item => 
              (item.taskId && item.taskId === taskId) || 
              (item.desc && item.desc.toLowerCase() === t.descripcion.toLowerCase())
            );

          return {
            id: taskId,
            ot: cleanOt,
            dominio: dom,
            type: otType,
            rubro: t.rubro,
            desc: t.descripcion,
            operario,
            asignado,
            empezo,
            termino,
            isTerminado: !!isTerminado
          };
        });

        historicalNodes.push({
          ot: cleanOt,
          type: otType,
          dominio: dom,
          date: dateLabel,
          status: colFStatus || 'FINALIZADA',
          tasks,
          taskCount: tasks.length
        });
      });
    } catch (eAnt) {
      console.warn('⚠️ [taskSyncService] Error al leer ots_anteriores:', eAnt.message);
    }

    return {
      success: true,
      timelineGroups,
      historicalNodes,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('Error en getUnitTimelineTasks:', err.message);
    return { success: false, error: err.message, timelineGroups: [], historicalNodes: [] };
  }
}

/**
 * DB_STAFF: Obtiene la lista de operarios (Col B) y ubicaciones/boxes (Cols G:K).
 */
async function getStaffAndLocations({ sheetsClient, spreadsheetId }) {
  const defaultStaff = [
    { opId: '1', name: 'Carlos Gómez', role: 'MECANICO' },
    { opId: '2', name: 'Mario Benítez', role: 'MECANICO' },
    { opId: '3', name: 'Juan Pérez', role: 'ENGRASE' },
    { opId: '4', name: 'Lucas Silva', role: 'GOMERIA' },
    { opId: '5', name: 'Roberto Díaz', role: 'LAVADERO' },
    { opId: '6', name: 'Martín Alvarez', role: 'ELECTRICIDAD' },
    { opId: '7', name: 'Alejandro Ruiz', role: 'TALLER' }
  ];

  const defaultLocations = [
    'Fosa 1', 'Fosa 2', 'Fosa 3', 'Box Mecánica', 'Box Electricidad',
    'Lavadero 1', 'Lavadero 2', 'Gomería', 'Lubricentro', 'Patio / Tránsito'
  ];

  if (!sheetsClient || !spreadsheetId) {
    return { staff: defaultStaff, locations: defaultLocations };
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: 'DB_STAFF!A1:K100'
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) {
      return { staff: defaultStaff, locations: defaultLocations };
    }

    const staffMap = new Map();
    const locSet = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const opId = String(row[0] || '').trim();
      const name = String(row[1] || '').trim();
      const role = String(row[2] || 'TALLER').trim();

      if (name) {
        staffMap.set(name, { opId: opId || String(i), name, role });
      }

      // Cols G a K (índices 6 a 10)
      for (let colIdx = 6; colIdx <= 10; colIdx++) {
        const loc = String(row[colIdx] || '').trim();
        if (loc && loc !== '' && loc !== '0' && loc !== '-') {
          locSet.add(loc.startsWith('Box') || loc.startsWith('Fosa') || loc.startsWith('Lav') || loc.startsWith('Gom') ? loc : `Box ${loc}`);
        }
      }
    }

    const staffList = staffMap.size > 0 ? Array.from(staffMap.values()) : defaultStaff;
    const locList = locSet.size > 0 ? Array.from(locSet) : defaultLocations;

    return { staff: staffList, locations: locList };
  } catch (err) {
    console.warn('⚠️ [getStaffAndLocations] Error al leer DB_STAFF:', err.message);
    return { staff: defaultStaff, locations: defaultLocations };
  }
}

/**
 * COORDINACIÓN: Lee y renderiza las OTs de la pestaña 'ots' vinculadas con 'DB_OT_LIST',
 * e integra las asignaciones y JSON guardado en la Columna I de cada fila.
 */
async function getCoordinacionBoard({ sheetsClient, spreadsheetId }) {
  if (!sheetsClient || !spreadsheetId) {
    return { success: false, units: [], staff: [], locations: [], message: 'No hay conexión con Google Sheets' };
  }

  try {
    // 1. Obtener operarios y ubicaciones
    const { staff, locations } = await getStaffAndLocations({ sheetsClient, spreadsheetId });

    // 2. Mapeo de pares Tractor / Semi desde DB_OT_LIST
    const plateToType = new Map();
    const pairByPlate = new Map();
    const pairByOt = new Map();

    try {
      const otListRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: "'DB_OT_LIST'!A2:G500"
      });
      const otListRows = otListRes.data.values || [];

      otListRows.forEach(r => {
        const tractor = String(r[0] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
        const otTractor = String(r[1] || '').trim();
        const semi = String(r[2] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
        const otSemi = String(r[3] || '').trim();

        const pair = { tractor, semi, otTractor, otSemi };

        if (tractor) {
          plateToType.set(tractor, 'TRACTOR');
          pairByPlate.set(tractor, pair);
        }
        if (semi) {
          plateToType.set(semi, 'SEMI');
          pairByPlate.set(semi, pair);
        }
        if (otTractor) pairByOt.set(otTractor, pair);
        if (otSemi) pairByOt.set(otSemi, pair);
      });
    } catch (eList) {
      console.warn('⚠️ Error al leer DB_OT_LIST para Coordinación:', eList.message);
    }

    // 3. Leer pestaña 'ots' (Cols A a I)
    const otsRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:I500`
    });
    const otsRows = otsRes.data.values || [];

    // 4. Leer tareas activas desde DB_OT_TASKS como capa de estado en caliente
    let dbTasksMap = new Map();
    try {
      const tasksRes = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A2:K1500`
      });
      const tRows = tasksRes.data.values || [];
      tRows.forEach(r => {
        const tId = String(r[0] || '').trim();
        if (tId) {
          dbTasksMap.set(tId, {
            ubicacion: String(r[5] || '').trim(),
            operarios: String(r[6] || '').trim(),
            asignado: String(r[7] || '').trim(),
            empezo: String(r[8] || '').trim(),
            termino: String(r[9] || '').trim(),
            estado: String(r[10] || 'PENDIENTE').trim()
          });
        }
      });
    } catch (eTasks) {}

    const unitsMap = new Map();

    otsRows.forEach((row, rowIdx) => {
      const rowNumber = rowIdx + 2;
      const rawOt = String(row[2] || '').trim(); // Col C: ORDEN Nº
      const rawDominio = String(row[3] || '').trim(); // Col D: DOMINIO
      const rawTasks = String(row[4] || '').trim(); // Col E: Sector / Tareas
      const rawColIJson = String(row[8] || '').trim(); // Col I: JSON COORDINACIÓN

      if (!rawOt && !rawDominio) return;

      const cleanOt = rawOt.replace(/^0+/, '') || rawOt;
      const plate = parseDominio(rawDominio);
      const parsedTaskList = parseTasksFromString(rawTasks);

      // Parsear JSON existente en Col I si lo hay
      let savedColI = null;
      if (rawColIJson) {
        try {
          savedColI = JSON.parse(rawColIJson);
        } catch (eJson) {}
      }

      // Determinar si es tractor o semi
      let type = plateToType.get(plate);
      const pair = pairByPlate.get(plate) || pairByOt.get(cleanOt) || {};
      if (!type) {
        if (pair.semi === plate) type = 'SEMI';
        else if (pair.tractor === plate) type = 'TRACTOR';
        else type = 'TRACTOR';
      }

      const isSemi = (type === 'SEMI');
      // Identificador de par o grupo
      const groupKey = pair.tractor && pair.semi ? `${pair.tractor}_${pair.semi}` : (pair.tractor || pair.semi || plate || cleanOt);

      if (!unitsMap.has(groupKey)) {
        unitsMap.set(groupKey, {
          id: `unit_${groupKey.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ot: cleanOt,
          status: 'progreso',
          isExpanded: true,
          tractor: {
            plate: pair.tractor || (!isSemi ? plate : ''),
            ot: pair.otTractor || (!isSemi ? cleanOt : ''),
            rowNumber: !isSemi ? rowNumber : null,
            jsonColI: !isSemi ? savedColI : null,
            tasks: []
          },
          semi: {
            plate: pair.semi || (isSemi ? plate : ''),
            ot: pair.otSemi || (isSemi ? cleanOt : ''),
            rowNumber: isSemi ? rowNumber : null,
            jsonColI: isSemi ? savedColI : null,
            tasks: []
          }
        });
      }

      const unit = unitsMap.get(groupKey);
      const targetSub = isSemi ? unit.semi : unit.tractor;
      targetSub.plate = plate || targetSub.plate;
      targetSub.ot = cleanOt || targetSub.ot;
      targetSub.rowNumber = rowNumber;
      if (savedColI) targetSub.jsonColI = savedColI;

      parsedTaskList.forEach((item, idx) => {
        const taskId = `${cleanOt}-${plate}-${idx + 1}`;
        const dbState = dbTasksMap.get(taskId) || {};
        
        // Buscar si existe en el JSON guardado en Col I
        let colITaskState = null;
        if (savedColI && Array.isArray(savedColI.tasks)) {
          colITaskState = savedColI.tasks.find(t => t.id === taskId || t.desc === item.descripcion);
        }

        const ubicacion = (colITaskState && colITaskState.ubicacion) || dbState.ubicacion || (savedColI && savedColI.ubicacion) || '';
        const operarios = (colITaskState && (colITaskState.operarios || colITaskState.operario)) || dbState.operarios || '';
        const asignado = (colITaskState && colITaskState.asignado) || dbState.asignado || '';
        const empezo = (colITaskState && colITaskState.empezo) || dbState.empezo || '';
        const termino = (colITaskState && colITaskState.termino) || dbState.termino || '';
        const estado = (colITaskState && colITaskState.estado) || dbState.estado || (termino ? 'TERMINADO' : (empezo ? 'EN_CURSO' : 'PENDIENTE'));

        targetSub.tasks.push({
          id: taskId,
          ot: cleanOt,
          dominio: plate,
          sector: item.rubro,
          desc: item.descripcion,
          ubicacion,
          operarios,
          asignado,
          empezo,
          termino,
          estado
        });
      });
    });

    const unitsList = Array.from(unitsMap.values());

    // Calcular estado general por unidad
    unitsList.forEach(u => {
      const allTasks = [...u.tractor.tasks, ...u.semi.tasks];
      const allDone = allTasks.length > 0 && allTasks.every(t => t.termino && t.termino.trim() !== '');
      if (allDone) {
        u.status = 'terminado';
      }
    });

    return {
      success: true,
      units: unitsList,
      staff,
      locations,
      totalUnits: unitsList.length,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('❌ Error en getCoordinacionBoard:', err.message);
    return { success: false, error: err.message, units: [], staff: [], locations: [] };
  }
}

/**
 * COORDINACIÓN: Guarda el JSON de coordinación en la Columna I de la pestaña 'ots'.
 */
async function saveOtCoordinacionJson({ sheetsClient, spreadsheetId, otNumber, plate, data, io }) {
  if (!sheetsClient || !spreadsheetId || (!otNumber && !plate)) {
    return { success: false, error: 'Parámetros inválidos' };
  }

  const cleanOt = String(otNumber || '').trim().replace(/^0+/, '');
  const cleanPlateStr = String(plate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:I500`
    });
    const rows = res.data.values || [];
    let targetRow = -1;

    let targetTab = OTS_SOURCE_TAB;

    for (let i = 0; i < rows.length; i++) {
      const rowOt = String(rows[i][2] || '').trim().replace(/^0+/, '');
      const rowPlate = String(rows[i][3] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

      if ((cleanOt && rowOt === cleanOt) || (cleanPlateStr && rowPlate === cleanPlateStr)) {
        targetRow = i + 2;
        break;
      }
    }

    if (targetRow === -1) {
      // Buscar fallback en 'ots_anteriores'
      try {
        const antRes = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `'ots_anteriores'!A2:I3000`
        });
        const antRows = antRes.data.values || [];
        for (let i = 0; i < antRows.length; i++) {
          const rowOt = String(antRows[i][2] || '').trim().replace(/^0+/, '');
          const rowPlate = String(antRows[i][3] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');
          if ((cleanOt && rowOt === cleanOt) || (cleanPlateStr && rowPlate === cleanPlateStr)) {
            targetRow = i + 2;
            targetTab = 'ots_anteriores';
            break;
          }
        }
      } catch (eAntSearch) {
        console.warn('⚠️ Error al buscar en ots_anteriores:', eAntSearch.message);
      }
    }

    if (targetRow === -1) {
      return { success: false, error: `No se encontró la OT ${cleanOt || cleanPlateStr} en 'ots' ni en 'ots_anteriores'` };
    }

    const jsonString = typeof data === 'string' ? data : JSON.stringify(data);

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${targetTab}'!I${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[jsonString]]
      }
    });

    console.log(`✅ [Coordinación] JSON guardado exitosamente en '${targetTab}'!I${targetRow} para OT ${cleanOt || cleanPlateStr}`);

    // Sincronizar tareas individuales a DB_OT_TASKS si data contiene tasks
    if (data && Array.isArray(data.tasks)) {
      try {
        for (const t of data.tasks) {
          if (t.id) {
            await updateTaskExecution({
              sheetsClient,
              spreadsheetId,
              taskId: t.id,
              ubicacion: t.ubicacion,
              operario: t.operarios || t.operario,
              asignado: t.asignado,
              empezo: t.empezo,
              termino: t.termino,
              estado: t.estado
            });
          }
        }
      } catch (eSyncTasks) {
        console.warn('⚠️ Nota: Sync secundario de tareas a DB_OT_TASKS:', eSyncTasks.message);
      }
    }

    if (io) {
      io.emit('coordinacion_ot_updated', {
        otNumber: cleanOt,
        plate: cleanPlateStr,
        tab: targetTab,
        rowNumber: targetRow,
        data
      });
    }

    return {
      success: true,
      tab: targetTab,
      rowNumber: targetRow,
      otNumber: cleanOt,
      plate: cleanPlateStr
    };
  } catch (err) {
    console.error('❌ Error en saveOtCoordinacionJson:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * COORDINACIÓN: Guarda en bloque el estado de todas las unidades en la Columna I de 'ots'.
 */
async function saveAllCoordinacionBatch({ sheetsClient, spreadsheetId, units, io }) {
  if (!sheetsClient || !spreadsheetId || !Array.isArray(units)) {
    return { success: false, error: 'Parámetros inválidos' };
  }

  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:D500`
    });
    const rows = res.data.values || [];
    const updateData = [];

    units.forEach(unit => {
      ['tractor', 'semi'].forEach(subKey => {
        const sub = unit[subKey];
        if (!sub || (!sub.ot && !sub.plate)) return;

        const cleanOt = String(sub.ot || '').trim().replace(/^0+/, '');
        const cleanPlateStr = String(sub.plate || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

        for (let i = 0; i < rows.length; i++) {
          const rowOt = String(rows[i][2] || '').trim().replace(/^0+/, '');
          const rowPlate = String(rows[i][3] || '').trim().toUpperCase().replace(/[\s\-_.]/g, '');

          if ((cleanOt && rowOt === cleanOt) || (cleanPlateStr && rowPlate === cleanPlateStr)) {
            const rowNumber = i + 2;
            const payload = {
              ot: cleanOt || rowOt,
              plate: cleanPlateStr || rowPlate,
              type: subKey.toUpperCase(),
              tasks: sub.tasks || [],
              updatedAt: new Date().toISOString()
            };

            updateData.push({
              range: `'${OTS_SOURCE_TAB}'!I${rowNumber}`,
              values: [[JSON.stringify(payload)]]
            });
            break;
          }
        }
      });
    });

    if (updateData.length > 0) {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData
        }
      });
      console.log(`✅ [Coordinación] Guardado en lote exitoso: ${updateData.length} filas actualizadas en Col I.`);
    }

    if (io) {
      io.emit('coordinacion_board_synced', { totalUpdated: updateData.length, timestamp: new Date().toISOString() });
    }

    return { success: true, updatedCount: updateData.length };
  } catch (err) {
    console.error('❌ Error en saveAllCoordinacionBatch:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  DB_TASKS_TAB,
  COLD_STORAGE_TAB,
  OTS_SOURCE_TAB,
  ensureSheetsStructure,
  parseTasksFromString,
  parseDominio,
  parseDominioAndInterno,
  syncOtsToTasksDatabase,
  startAutomaticTaskSync,
  getActiveTasksBoard,
  updateTaskExecution,
  checkAndArchiveIfOtFinished,
  getHistoricalTasks,
  getOperarioHoldOts,
  saveOperarioHoldOts,
  getOtLifecyclePayload,
  updateOtTaskTerminado,
  getUnitTimelineTasks,
  getStaffAndLocations,
  getCoordinacionBoard,
  saveOtCoordinacionJson,
  saveAllCoordinacionBatch
};

