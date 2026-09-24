/**
 * Generador de Credenciales Únicas de Acceso para Servidor Railway / Render / Local
 * 
 * Uso:
 *   node scripts/generate_keys.js
 *   npm run gen-keys
 */

const crypto = require('crypto');

function generateSecurePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*';
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function generateReadablePassword() {
  const words = ['TALLER', 'PANOL', 'LOGISTICA', 'FLEET', 'MECANICO', 'MOTOR', 'CENTRAL', 'CONTROL'];
  const word = words[crypto.randomInt(0, words.length)];
  const num = crypto.randomInt(1000, 9999);
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${word}-${num}-${suffix}`;
}

function generatePin(digits = 6) {
  return String(crypto.randomInt(100000, 999999));
}

function generateAuthSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function main() {
  const strongPassword = generateSecurePassword(16);
  const readablePassword = generateReadablePassword();
  const numericPin = generatePin(6);
  const authSecret = generateAuthSecret();
  const defaultUser = 'taller';

  console.log('='.repeat(70));
  console.log('🔑 GENERADOR DE CLAVES ÚNICAS DE ACCESO (PAÑOL / TALLER)');
  console.log('='.repeat(70));
  console.log('\n📋 OPCIONES DE CONTRASEÑA (Elige la que mejor se adapte a tu taller):');
  console.log(`   1. Contraseña Fuerte (16 chars):       ${strongPassword}`);
  console.log(`   2. Fácil de Escribir en Tablets/Móvil: ${readablePassword}`);
  console.log(`   3. Código PIN Numérico (6 dígitos):    ${numericPin}`);
  
  console.log('\n🛡️  SECRET CRIPTOGRÁFICO DE SESIÓN (HMAC-SHA256):');
  console.log(`   ${authSecret}`);

  console.log('\n' + '='.repeat(70));
  console.log('🚀 OPCIONES PARA AGREGAR EN RAILWAY (SIN TOCAR RENDER):');
  console.log('='.repeat(70));
  console.log('🔹 Opción 1: Nuevo Usuario y Contraseña (ej. supervisor / admin):');
  console.log(`   EXTRA_USERS=supervisor:${readablePassword}`);
  console.log('\n🔹 Opción 2: Múltiples Usuarios y Contraseñas a la vez:');
  console.log(`   EXTRA_USERS=supervisor:${readablePassword},admin:${strongPassword},guardia:${numericPin}`);
  console.log('\n🔹 Opción 3: Variables Individuales por Usuario:');
  console.log(`   USER_1=supervisor`);
  console.log(`   PASS_1=${readablePassword}`);
  console.log('\n🔹 Opción 4: Solo Claves Adicionales para el usuario taller:');
  console.log(`   RAILWAY_PASSWORDS=${readablePassword},${numericPin}`);
  console.log('='.repeat(70));
  console.log('ℹ️  Nota: El acceso original de Render (usuario "taller", clave "taller2026")');
  console.log('    seguirá funcionando siempre en paralelo sin necesidad de tocar Render.');
  console.log('='.repeat(70));

  console.log('\n📌 INSTRUCCIONES PARA APLICAR EN RAILWAY:');
  console.log(' 1. Abre tu proyecto en https://railway.app');
  console.log(' 2. Selecciona el servicio de tu servidor (ej. panolnd-taller / backend).');
  console.log(' 3. Ve a la pestaña "Variables".');
  console.log(' 4. Haz clic en "RAW Editor" (o añade cada variable individualmente).');
  console.log(' 5. Pega el bloque de arriba y presiona "Update Variables".');
  console.log(' 6. Railway reiniciará el servidor automáticamente con las nuevas claves únicas.\n');
}

main();
