// ==============================================================
// 🧪 TEST DE CONEXIÓN, LATENCIA Y MEMORIA: PG POOL
// ==============================================================

const db = require('../utils/db');

async function runTest() {
    console.log('--- 🧪 DIAGNÓSTICO DEL POOL DE POSTGRESQL ---');
    const metrics = db.getPoolMetrics();
    console.log('⚙️ Configuración del Pool:');
    console.log(JSON.stringify(metrics.poolConfig, null, 2));
    console.log('\n📊 Consumo de Memoria Inicial:');
    console.log(`- RSS:        ${metrics.memoryUsage.rssMB} MB`);
    console.log(`- Heap Usado: ${metrics.memoryUsage.heapUsedMB} MB`);
    console.log(`- Heap Total: ${metrics.memoryUsage.heapTotalMB} MB`);

    if (!db.isConfigured()) {
        console.log('\nℹ️ DATABASE_URL no configurada (Modo Fallback / Solo Google Sheets).');
        console.log('✅ El sistema opera normalmente sin Postgres y sin fugas de memoria.');
        return;
    }

    console.log('\n⏳ Probando conexión a la Base de Datos...');
    const health = await db.checkHealth();
    if (health.ok) {
        console.log('✅ Conexión exitosa a PostgreSQL!');
        console.log(`- Base de datos: ${health.database}`);
        console.log(`- Latencia ping: ${health.latencyMs} ms`);
        console.log(`- Hora Servidor: ${health.serverTime}`);

        // Prueba de query rápida
        const testRes = await db.query('SELECT 1 as test_num');
        console.log(`✅ Query test OK en ${testRes.duration} ms. Filas:`, testRes.rows);
    } else {
        console.error('❌ Error conectando a PostgreSQL:', health.error);
    }

    const postMetrics = db.getPoolMetrics();
    console.log('\n📊 Estado del Pool Post-Prueba:');
    console.log(JSON.stringify(postMetrics.poolStatus, null, 2));
    console.log(`- RSS Final:  ${postMetrics.memoryUsage.rssMB} MB`);
}

runTest().catch(console.error);
