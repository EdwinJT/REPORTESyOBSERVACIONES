/**
 * Cálculo estricto de fecha local en Perú (America/Lima, UTC-5)
 * Regla Obligatoria 5 (Escenario P1):
 * PROHIBIDO usar new Date().toISOString().slice(0, 10) porque después de las 19:00 h
 * en Perú (00:00 UTC del día siguiente) adelantaría la fecha al día de mañana.
 */

export function getFechaHoyPeru(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(dateObj);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

export function getHoraActualPeru(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return formatter.format(dateObj);
}

export function esFechaValida(fechaStr) {
  if (!fechaStr || typeof fechaStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) return false;
  const [y, m, d] = fechaStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  return true;
}
