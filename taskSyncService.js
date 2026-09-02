/**
 * taskSyncService.js
 * Servicio integral de gestión de tareas operativas de taller para Pañol Cloud / Render.
 * 
 * Funcionalidades:
 * 1. Mantenimiento y auto-creación de pestañas 'DB_OT_TASKS' e 'HISTORICO_COLD' en Google Sheets.
 * 2. Ingesta y desglose inteligente de la pestaña 'ots' (strings concatenados con '|') a filas atómicas.
 * 3. Identificación precisa de Tractor (T) vs Semi/Acoplado (A).
 * 4. Actualización atómica e independiente de tareas por Box/Fosa (Ubicación, Operario, Asignado, Empezó, Terminó).
 * 5. Cierre automático y archivado en Cold Storage ('HISTORICO_COLD') con depuración en caliente (Hot Purge).
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
      console.log(`✅ Pestañas creadas: ${requests.map(r => r.addSheet.properties.title).join(', ')}`);
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
 * Desglosa un string de tareas crudo "[RUBRO] Descripcion | [RUBRO] Descripcion" en objetos.
 */
function parseTasksFromString(rawTasksString) {
  if (!rawTasksString || typeof rawTasksString !== 'string') return [];

  const chunks = rawTasksString.split('|').map(s => s.trim()).filter(Boolean);
  const tasks = [];

  chunks.forEach((chunk, idx) => {
    // Regex para capturar [RUBRO] y la descripción
    const match = chunk.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
      const rubro = match[1].trim().toUpperCase();
      const desc = match[2].trim();
      tasks.push({
        index: idx + 1,
        rubro: rubro,
        descripcion: desc,
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
    tipo: 'TRACTOR' // TRACTOR o SEMI
  };

  if (!rawDominioString) return result;

  const parts = String(rawDominioString).split('|').map(s => s.trim());
  result.plate = parts[0] || '';

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
 * Sincroniza las OTs desde la pestaña 'ots' hacia la tabla operativa 'DB_OT_TASKS'.
 * Preserva las asignaciones y horarios que los mecánicos ya hayan cargado.
 */
async function syncOtsToTasksDatabase({ sheetsClient, spreadsheetId }) {
  if (!sheetsClient || !spreadsheetId) throw new Error('Cliente o Spreadsheet ID inválido');

  await ensureSheetsStructure(sheetsClient, spreadsheetId);

  // 1. Leer pestaña 'ots'
  const otsRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${OTS_SOURCE_TAB}'!A2:F500`
  });

  const otsRows = otsRes.data.values || [];
  if (otsRows.length === 0) {
    return { success: true, count: 0, message: "No hay filas en la pestaña 'ots'" };
  }

  // 2. Leer tareas actuales en 'DB_OT_TASKS' para preservar estado existente
  const currentTasksRes = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${DB_TASKS_TAB}'!A2:L1500`
  });

  const currentTaskRows = currentTasksRes.data.values || [];
  const existingTaskMap = new Map();

  currentTaskRows.forEach(r => {
    const taskId = String(r[0] || '').trim();
    if (taskId) {
      existingTaskMap.set(taskId, {
        taskId: r[0],
        otNumber: r[1],
        dominio: r[2],
        internoTipo: r[3],
        rubro: r[4],
        descripcion: r[5],
        ubicacion: r[6] || '',
        operario: r[7] || '',
        asignado: r[8] || '',
        empezo: r[9] || '',
        termino: r[10] || '',
        estado: r[11] || 'PENDIENTE'
      });
    }
  });

  // 3. Procesar cada fila de 'ots'
  const updatedRows = [];
  let newTasksCount = 0;
  let preservedCount = 0;

  for (const row of otsRows) {
    const rawOt = String(row[2] || '').trim(); // Col C: ORDEN Nº
    const rawDominio = String(row[3] || '').trim(); // Col D: DOMINIO
    const rawTasks = String(row[4] || '').trim(); // Col E: Sector / Tareas

    if (!rawOt || !rawTasks) continue;

    const cleanOt = rawOt.replace(/^0+/, '') || rawOt;
    const { plate, interno, tipo } = parseDominioAndInterno(rawDominio);
    const parsedTaskList = parseTasksFromString(rawTasks);

    parsedTaskList.forEach((item, idx) => {
      // TASK_ID idempotente: "OT-DOMINIO-INDEX" (ej: "11110-AG147LK-1")
      const taskId = `${cleanOt}-${plate}-${idx + 1}`;
      const existing = existingTaskMap.get(taskId);

      if (existing) {
        // Preservar datos de intervención
        updatedRows.push([
          taskId,
          cleanOt,
          plate,
          `${interno} (${tipo})`,
          item.rubro,
          item.descripcion,
          existing.ubicacion,
          existing.operario,
          existing.asignado,
          existing.empezo,
          existing.termino,
          existing.estado
        ]);
        preservedCount++;
      } else {
        // Nueva tarea lista para ser asignada a un box
        updatedRows.push([
          taskId,
          cleanOt,
          plate,
          `${interno} (${tipo})`,
          item.rubro,
          item.descripcion,
          '', // Ubicación
          '', // Operario
          '', // Asignado
          '', // Empezó
          '', // Terminó
          'PENDIENTE' // Estado
        ]);
        newTasksCount++;
      }
    });
  }

  // 4. Escribir de forma atómica en 'DB_OT_TASKS'
  if (updatedRows.length > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `'${DB_TASKS_TAB}'!A2:L${updatedRows.length + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: updatedRows }
    });
  }

  console.log(`✅ DB_OT_TASKS sincronizada: ${updatedRows.length} tareas totales (${newTasksCount} nuevas, ${preservedCount} preservadas).`);

  return {
    success: true,
    totalTasks: updatedRows.length,
    newTasks: newTasksCount,
    preservedTasks: preservedCount,
    timestamp: new Date().toISOString()
  };
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

  // 1. Buscar la fila en DB_OT_TASKS
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

  // 2. Preparar valores actualizados manteniendo los existentes si no se especifican
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

  // Notificar por WebSockets
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
  getActiveTasksBoard,
  updateTaskExecution,
  checkAndArchiveIfOtFinished,
  getHistoricalTasks
};
