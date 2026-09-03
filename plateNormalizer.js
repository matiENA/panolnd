function extractCleanPlate(dirtyString) {
  const plates = extractPlates(dirtyString);
  return plates.length > 0 ? plates[0] : null;
}

/**
 * Extrae patentes válidas argentinas desde cualquier string crudo o sucio.
 * Soporta formato Mercosur (AA123BB) y Tradicional (AAA123).
 * Descarta falsos positivos de nombres de maquinaria o palabras compuestas.
 * @param {string} rawString 
 * @returns {string[]} Lista de patentes limpias únicas
 */
function extractPlates(rawString) {
  if (!rawString) return [];
  const upper = String(rawString).toUpperCase().trim();

  // Excepción permanente para pedidos no destinados a unidad (Taller / General)
  if (upper.includes('INTERNO TALLER')) {
    return ['INTERNO TALLER'];
  }

  const cleaned = upper
    .replace(/\b(BOBCAT|CATERPILLAR|CARGADORA|MOTO|MOTONIVELADORA|MANITU|ELEVADOR|IZUZU|CHASIS|INTERNO|TALLER|ACOPLADO|PALA|GRUPO)\b/g, ' ')
    .trim();

  const tokens = cleaned.split(/[\/+,;\n\r\t()\[\]]+/);
  const plates = [];

  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;

    const mercosurMatch = t.match(/\b([A-Z]{2})[\s\-_.]*(\d{3})[\s\-_.]*([A-Z]{2})\b/);
    if (mercosurMatch) {
      const p = `${mercosurMatch[1]}${mercosurMatch[2]}${mercosurMatch[3]}`;
      if (!plates.includes(p)) plates.push(p);
      continue;
    }

    const tradMatch = t.match(/\b([A-Z]{3})[\s\-_.]*(\d{3})\b/);
    if (tradMatch) {
      const p = `${tradMatch[1]}${tradMatch[2]}`;
      if (!plates.includes(p)) plates.push(p);
      continue;
    }
  }

  return plates;
}

module.exports = { extractCleanPlate, extractPlates };