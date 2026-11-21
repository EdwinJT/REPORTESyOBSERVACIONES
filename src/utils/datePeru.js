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

/**
 * Convierte una fecha YYYY-MM-DD (o DD/MM/YYYY) al formato visible DD/MM/AAAA.
 */
export function formatFechaDDMMYYYY(fechaStr) {
  if (!fechaStr || typeof fechaStr !== 'string') return '';
  const trimmed = fechaStr.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

/**
 * Calcula los días calendario transcurridos entre fechaInicialStr (YYYY-MM-DD) y hoyStr.
 */
export function calcularDiasTranscurridos(fechaInicialStr, hoyStr = getFechaHoyPeru()) {
  if (!fechaInicialStr || !hoyStr) return 0;
  const parseUtcMs = (str) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str).trim());
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const iniMs = parseUtcMs(fechaInicialStr);
  const hoyMs = parseUtcMs(hoyStr);
  if (iniMs === null || hoyMs === null) return 0;
  const diffDays = Math.floor((hoyMs - iniMs) / 86400000);
  return Math.max(0, diffDays);
}

/**
 * Devuelve una etiqueta legible con los días transcurridos desde la fecha inicial.
 */
export function formatDiasTranscurridos(fechaInicialStr, hoyStr = getFechaHoyPeru()) {
  const dias = calcularDiasTranscurridos(fechaInicialStr, hoyStr);
  if (dias === 0) return '0 días (Hoy)';
  if (dias === 1) return '1 día';
  return `${dias} días`;
}
