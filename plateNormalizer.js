/**
 * Extrae una patente válida ignorando texto basura.
 * @param {string} dirtyString - El valor crudo del formulario
 * @returns {string|null} - La patente limpia o null
 */
function extractCleanPlate(dirtyString) {
  if (!dirtyString) return null;

  // Sanitización: Mayúsculas y eliminación de espacios, guiones y puntos
  const normalizedString = String(dirtyString).toUpperCase().replace(/[\s\-_.]/g, '');

  // Regex para Patentes Argentinas (Mercosur o Tradicionales)
  const plateRegex = /([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})/g;

  const match = normalizedString.match(plateRegex);
  return match ? match[0] : null;
}

module.exports = { extractCleanPlate };