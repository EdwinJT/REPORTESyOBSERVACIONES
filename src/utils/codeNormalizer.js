/**
 * Normalización de Códigos de Equipos Mineros (Escenario P2)
 * Convierte entradas con minúsculas, espacios múltiples o guiones bajos
 * al formato estándar en MAYÚSCULAS separado por guion.
 * Ejemplo: "793f 05" -> "793F-05", "  pala  02 " -> "PALA-02"
 */

export function normalizeEquipmentCode(rawInput = '') {
  if (!rawInput || typeof rawInput !== 'string') return '';

  // 1. Limpiar espacios extremos y pasar a MAYÚSCULAS
  let cleaned = rawInput.trim().toUpperCase();

  // 2. Eliminar caracteres especiales no permitidos (conservar letras, números, espacios y guiones)
  cleaned = cleaned.replace(/[^A-Z0-9\s\-_]/g, '');

  // 3. Reemplazar espacios múltiples, guiones bajos o guiones repetidos por un único guion '-'
  cleaned = cleaned
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned;
}
