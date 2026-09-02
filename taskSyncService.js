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

const DB_TASKS_TAB = 'DB_OT_TASKS';
const COLD_STORAGE_TAB = 'HISTORICO_COLD';
const OTS_SOURCE_TAB = 'ots';

const DB_TASKS_HEADERS = [
  'TASK_ID',
  'OT_NUMBER',
  'DOMINIO',
  'INTERNO_TIPO',
  'RUBRO',
  'DESCRIPCION',
  'UBICACION',
  'OPERARIO',
  'ASIGNADO',
  'EMPEZO',
  'TERMINO',
  'ESTADO'
];

const COLD_STORAGE_HEADERS = [
  'TASK_ID',
  'OT_NUMBER',
  'DOMINIO',
  'INTERNO_TIPO',
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

    // Asegurar encabezados en DB_OT_TASKS
    const tasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${DB_TASKS_TAB}'!A1:L1`
    });
    if (!tasksRes.data.values || tasksRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A1:L1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [DB_TASKS_HEADERS] }
      });
    }

    // Asegurar encabezados en HISTORICO_COLD
    const coldRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${COLD_STORAGE_TAB}'!A1:O1`
    });
    if (!coldRes.data.values || coldRes.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `'${COLD_STORAGE_TAB}'!A1:O1`,
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
    const match = chunk.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
      tasks.push({
        index: idx + 1,
        rubro: match[1].trim().toUpperCase(),
        descripcion: match[2].trim(),
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
 * Parsea el dominio e interno/tipo desde cadenas como "AG147LK | 727 (T)" o "AG172II | 732 (A)".
 */
function parseDominioAndInterno(rawDominioString) {
  const result = {
    plate: '',
    interno: 'S/D',
    tipo: 'TRACTOR'
  };

  if (!rawDominioString) return result;

  const parts = String(rawDominioString).split('|').map(s => s.trim());
  result.plate = parts[0] ? parts[0].toUpperCase().replace(/[\s\-_.]/g, '') : '';

  if (parts.length > 1) {
    result.interno = parts[1] || '';
    const upper = result.interno.toUpperCase();
    if (upper.includes('(A)') || upper.includes('SEMI') || upper.includes('ACOPLADO')) {
      result.tipo = 'SEMI';
    } else if (upper.includes('(T)') || upper.includes('TRACTOR')) {
      result.tipo = 'TRACTOR';
    }
  } else {
    result.tipo = 'TRACTOR';
  }

  return result;
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
 * - Solo inserta (APPEND) tareas nuevas.
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

    // 1. Leer pestaña 'ots' (Ingesta)
    const otsRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${OTS_SOURCE_TAB}'!A2:F500`
    });

    const otsRows = otsRes.data.values || [];
    if (otsRows.length === 0) {
      return { success: true, count: 0, message: "No hay datos en la pestaña 'ots'" };
    }

    // 2. Leer tareas existentes en 'DB_OT_TASKS'
    const currentTasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${DB_TASKS_TAB}'!A2:F1500`
    });
    const currentTaskRows = currentTasksRes.data.values || [];

    // 3. Leer tareas ya archivadas en 'HISTORICO_COLD' (para no re-crear OTs cerradas)
    const coldTasksRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${COLD_STORAGE_TAB}'!A2:F3000`
    });
    const coldTaskRows = coldTasksRes.data.values || [];

    // 4. Construir índice de exclusión (Set de IDs y Fingerprints existentes)
    const existingTaskIds = new Set();
    const existingFingerprints = new Set();

    currentTaskRows.forEach(r => {
      const taskId = String(r[0] || '').trim();
      const ot = String(r[1] || '').trim();
      const plate = String(r[2] || '').trim();
      const rubro = String(r[4] || '').trim();
      const desc = String(r[5] || '').trim();
      if (taskId) existingTaskIds.add(taskId);
      if (ot && desc) existingFingerprints.add(makeTaskFingerprint(ot, plate, rubro, desc));
    });

    coldTaskRows.forEach(r => {
      const taskId = String(r[0] || '').trim();
      const ot = String(r[1] || '').trim();
      const plate = String(r[2] || '').trim();
      const rubro = String(r[4] || '').trim();
      const desc = String(r[5] || '').trim();
      if (taskId) existingTaskIds.add(taskId);
      if (ot && desc) existingFingerprints.add(makeTaskFingerprint(ot, plate, rubro, desc));
    });

    // 5. Filtrar estrictamente solo lo NUEVO
    const newRowsToAppend = [];
    let skippedExistingCount = 0;

    for (const row of otsRows) {
      const rawOt = String(row[2] || '').trim(); // Col C: ORDEN Nº
      const rawDominio = String(row[3] || '').trim(); // Col D: DOMINIO
      const rawTasks = String(row[4] || '').trim(); // Col E: Sector / Tareas

      if (!rawOt || !rawTasks) continue;

      const cleanOt = rawOt.replace(/^0+/, '') || rawOt;
      const { plate, interno, tipo } = parseDominioAndInterno(rawDominio);
      const parsedTaskList = parseTasksFromString(rawTasks);

      parsedTaskList.forEach((item, idx) => {
        const taskId = `${cleanOt}-${plate}-${idx + 1}`;
        const fingerprint = makeTaskFingerprint(cleanOt, plate, item.rubro, item.descripcion);

        // Si ya existe en DB_OT_TASKS o en HISTORICO_COLD, SE SALTEA SIN TOCAR
        if (existingTaskIds.has(taskId) || existingFingerprints.has(fingerprint)) {
          skippedExistingCount++;
          return;
        }

        // Es una tarea genuinamente nueva
        newRowsToAppend.push([
          taskId,
          cleanOt,
          plate,
          `${interno} (${tipo})`,
          item.rubro,
          item.descripcion,
          '', // Ubicación (vacía para asignar)
          '', // Operario (vacío para asignar)
          '', // Asignado (vacío)
          '', // Empezó (vacío)
          '', // Terminó (vacío)
          'PENDIENTE' // Estado inicial
        ]);

        // Registrar en los sets locales para evitar duplicaciones dentro del mismo lote
        existingTaskIds.add(taskId);
        existingFingerprints.add(fingerprint);
      });
    }

    // 6. Inserción atómica por APPEND (sin reescribir ni tocar filas previas)
    if (newRowsToAppend.length > 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `'${DB_TASKS_TAB}'!A:L`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: newRowsToAppend }
      });
      console.log(`✨ [AutoSync] ${newRowsToAppend.length} nuevas tareas agregadas a ${DB_TASKS_TAB}. (${skippedExistingCount} existentes preservadas intactas).`);
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
 */
async function getActiveTasksBoard({ sheetsClient, spreadsheetId }) {
  if (!sheetsClient || !spreadsheetId) return { units: [] };

  await ensureSheetsStructure(sheetsClient, spreadsheetId);

  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A2:L1500`
  });

  const rows = res.data.values || [];
  const unitsMap = new Map();

  rows.forEach(r => {
    const taskId = String(r[0] || '').trim();
    const otNumber = String(r[1] || '').trim();
    const dominio = String(r[2] || '').trim();
    const internoTipo = String(r[3] || '').trim();
    const rubro = String(r[4] || '').trim();
    const desc = String(r[5] || '').trim();
    const ubicacion = String(r[6] || '').trim();
    const operario = String(r[7] || '').trim();
    const asignado = String(r[8] || '').trim();
    const empezo = String(r[9] || '').trim();
    const termino = String(r[10] || '').trim();
    const estado = String(r[11] || 'PENDIENTE').trim();

    if (!taskId || !otNumber) return;

    const isSemi = internoTipo.toUpperCase().includes('SEMI') || internoTipo.toUpperCase().includes('(A)');
    const groupKey = otNumber;

    if (!unitsMap.has(groupKey)) {
      unitsMap.set(groupKey, {
        id: `unit_${otNumber}`,
        ot: otNumber,
        status: 'progreso',
        tractor: { plate: isSemi ? '' : dominio, ot: otNumber, tasks: [] },
        semi: { plate: isSemi ? dominio : '', ot: otNumber, tasks: [] }
      });
    }

    const unit = unitsMap.get(groupKey);
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

  // 1. Buscar la fila exacta en DB_OT_TASKS
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A:L`
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
  const newUbicacion = ubicacion !== undefined ? ubicacion : (currentRowData[6] || '');
  const newOperario = operario !== undefined ? operario : (currentRowData[7] || '');
  const newAsignado = asignado !== undefined ? asignado : (currentRowData[8] || '');
  const newEmpezo = empezo !== undefined ? empezo : (currentRowData[9] || '');
  const newTermino = termino !== undefined ? termino : (currentRowData[10] || '');

  let newEstado = estado !== undefined ? estado : (currentRowData[11] || 'PENDIENTE');
  if (newTermino && newTermino.trim() !== '') {
    newEstado = 'COMPLETADA';
  } else if (newEmpezo && newEmpezo.trim() !== '') {
    newEstado = 'EN_CURSO';
  } else if (newOperario || newUbicacion) {
    newEstado = 'ASIGNADA';
  }

  // 3. Escribir actualización en rango G{row}:L{row}
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!G${targetRowIndex}:L${targetRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newUbicacion, newOperario, newAsignado, newEmpezo, newTermino, newEstado]]
    }
  });

  console.log(`✅ Tarea ${taskId} actualizada en fila ${targetRowIndex}: ${newEstado}`);

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
  }

  // 4. Verificar si la OT completa finalizó para enviar a Cold Storage
  const otNumber = currentRowData[1];
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
    range: `'${DB_TASKS_TAB}'!A:L`
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

  // Verificar si todas tienen fecha TERMINO o están marcadas completadas/descartadas
  const allCompleted = otRows.every(r => {
    const term = String(r[10] || '').trim();
    const st = String(r[11] || '').toUpperCase().trim();
    return term !== '' || st === 'DESCARTADA' || st === 'COMPLETADA';
  });

  if (!allCompleted) {
    return { archived: false, pendingCount: otRows.filter(r => !r[10]).length };
  }

  console.log(`📦 ¡OT ${otNumber} completada al 100%! Archivando en Cold Storage (${COLD_STORAGE_TAB})...`);

  const now = new Date();
  const archiveTimestamp = now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const coldRows = otRows.map(r => {
    let duracionMin = 0;
    try {
      if (r[9] && r[10]) {
        const tIni = new Date(r[9]).getTime();
        const tFin = new Date(r[10]).getTime();
        if (!isNaN(tIni) && !isNaN(tFin) && tFin >= tIni) {
          duracionMin = Math.round((tFin - tIni) / 60000);
        }
      }
    } catch (e) {}

    return [
      r[0], // TASK_ID
      r[1], // OT_NUMBER
      r[2], // DOMINIO
      r[3], // INTERNO_TIPO
      r[4], // RUBRO
      r[5], // DESCRIPCION
      r[6], // UBICACION
      r[7], // OPERARIO
      r[8], // ASIGNADO
      r[9], // EMPEZO
      r[10], // TERMINO
      r[11] || 'COMPLETADA', // ESTADO
      archiveTimestamp, // FECHA_ARCHIVADO
      duracionMin, // DURACION_MINUTOS
      'Archivado automático tras completar 100% de tareas' // OBSERVACIONES
    ];
  });

  // 1. Append a HISTORICO_COLD
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: `'${COLD_STORAGE_TAB}'!A:O`,
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
    range: `'${COLD_STORAGE_TAB}'!A2:O${limit + 1}`
  });

  return {
    success: true,
    tasks: res.data.values || []
  };
}

module.exports = {
  DB_TASKS_TAB,
  COLD_STORAGE_TAB,
  OTS_SOURCE_TAB,
  ensureSheetsStructure,
  parseTasksFromString,
  parseDominioAndInterno,
  syncOtsToTasksDatabase,
  startAutomaticTaskSync,
  getActiveTasksBoard,
  updateTaskExecution,
  checkAndArchiveIfOtFinished,
  getHistoricalTasks
};
