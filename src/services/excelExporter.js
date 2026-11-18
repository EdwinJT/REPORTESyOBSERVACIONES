/**
 * M6 — Servicio de Exportación a Excel (.xlsx OpenXML Estándar compatible con SheetJS / Excel / Calc)
 * Reglas Obligatorias de M6 y Escenario P10:
 *  1. Exporta ÚNICAMENTE los registros que coinciden con los filtros activos en pantalla.
 *  2. Incluye todas las columnas operativas completas (ID UUID, Código Equipo, Origen, Fecha Lima, Hora,
 *     Tipo, Prioridad, Observación Principal, Seguimientos ↳, Cantidad de Fotos, Rutas Internas de Storage,
 *     Estado de Sincronización, Autor y Dispositivo).
 *  3. PROHIBIDO incluir URLs firmadas (`createSignedUrl` con `?token=...`) que caducan. Solo se exportan
 *     las rutas internas permanentes en el bucket `fotos` (`{user_id}/{id}/{n}.jpg`).
 *  4. Funciona 100 % Offline (Modo Avión) generando un paquete binario `.xlsx` (OpenXML SpreadsheetML ZIP)
 *     válido para Microsoft Excel, LibreOffice Calc y Google Sheets sin requerir CDN externo.
 */

import { getFechaHoyPeru } from '../utils/datePeru.js';

export const EXCEL_COLUMNS = [
  { key: 'id', header: 'ID Reporte (UUID Dispositivo)', width: 38 },
  { key: 'codigo_equipo', header: 'Código de Equipo', width: 18 },
  { key: 'origen_unificado', header: 'Origen en Historial Unificado', width: 28 },
  { key: 'fuera_catalogo', header: 'Creado en Campo (Catálogo Dinámico)', width: 22 },
  { key: 'fecha', header: 'Fecha Local (America/Lima)', width: 18 },
  { key: 'hora_peru', header: 'Hora Registro (Lima)', width: 16 },
  { key: 'tipo', header: 'Tipo', width: 16 },
  { key: 'prioridad', header: 'Prioridad', width: 14 },
  { key: 'observacion', header: 'Observación Principal', width: 55 },
  { key: 'cant_seguimientos', header: 'Cant. Seguimientos (↳)', width: 18 },
  { key: 'resumen_seguimientos', header: 'Detalle de Seguimientos (↳)', width: 48 },
  { key: 'cant_fotos', header: 'Cant. Fotos (1..5)', width: 16 },
  { key: 'rutas_storage_sin_url_firmada', header: 'Rutas Permanentes Storage (SIN URL Firmada)', width: 48 },
  { key: 'video_ruta', header: 'Video Opcional (Ruta Storage)', width: 30 },
  { key: 'calidad_compresion', header: 'Perfil de Compresión', width: 20 },
  { key: 'estado_sync', header: 'Estado Sincronización', width: 20 },
  { key: 'registrado_por', header: 'Registrado Por (Usuario / Email)', width: 30 },
  { key: 'dispositivo', header: 'Dispositivo Emisor', width: 28 },
  { key: 'creado_en', header: 'Timestamp Creación (ISO)', width: 26 },
  { key: 'actualizado_en', header: 'Última Actualización (ISO)', width: 26 }
];

/**
 * Sanitiza cualquier ruta para garantizar que JAMÁS se filtre una URL firmada caducable (`?token=...`)
 * dentro del archivo Excel exportado.
 */
export function stripExpiringSignedUrl(pathOrUrl = '') {
  const raw = String(pathOrUrl || '').trim();
  if (!raw) return '';

  // Si alguien pasara por error una URL firmada completa, extraemos únicamente la ruta interna {user_id}/{id}/{n}.jpg
  const withoutQuery = raw.split('?')[0];
  const signMarker = '/storage/v1/object/sign/fotos/';
  const publicMarker = '/storage/v1/object/public/fotos/';

  if (withoutQuery.includes(signMarker)) {
    return withoutQuery.split(signMarker)[1] || '';
  }
  if (withoutQuery.includes(publicMarker)) {
    return withoutQuery.split(publicMarker)[1] || '';
  }
  return withoutQuery.replace(/^fotos\//, '');
}

/**
 * Transforma un reporte unificado (Local + Supabase) en una fila estructurada lista para Excel,
 * verificando que no contenga ninguna URL firmada temporal.
 */
export function mapUnifiedReportToExcelRow(rep) {
  const rawPhotoPaths =
    Array.isArray(rep.fotos_rutas) && rep.fotos_rutas.length > 0
      ? rep.fotos_rutas
      : Array.isArray(rep.fotos) && rep.fotos.length > 0
        ? rep.fotos
        : Array.isArray(rep.fotos_locales)
          ? rep.fotos_locales.map(
              (f, idx) => f.ruta_remota || `local_pendiente/${rep.id}/${f.indice || idx + 1}.jpg`
            )
          : [];

  const cleanPhotoPaths = rawPhotoPaths.map((p) => stripExpiringSignedUrl(p)).filter(Boolean);
  const fotosCount =
    cleanPhotoPaths.length ||
    (Array.isArray(rep.fotos_locales) ? rep.fotos_locales.length : 0) ||
    (Array.isArray(rep.fotos) ? rep.fotos.length : 0);

  const rawVideoPath = rep.video_ruta || rep.video || rep.video_local?.ruta_remota || '';
  const cleanVideoPath = rawVideoPath
    ? stripExpiringSignedUrl(rawVideoPath)
    : rep.video_local
      ? `local_pendiente/${rep.id}/video.mp4`
      : 'Sin video';

  const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
  const resumenSeguimientos =
    seguimientos.length === 0
      ? 'Sin seguimientos adicionales'
      : seguimientos
          .map(
            (s, i) =>
              `[#${i + 1} ${s.fecha || ''} - ${s.estado_seguimiento || 'Seguimiento'}]: ${s.comentario || ''}`
          )
          .join(' | ');

  let origenLabel = 'Local + Nube (Sincronizado)';
  if (rep.origen_unificado === 'solo_nube') {
    origenLabel = 'Supabase Cloud (Otro Dispositivo del Equipo)';
  } else if (rep.origen_unificado === 'solo_local') {
    origenLabel = `Solo Local en Dispositivo (${(rep.estado || 'pendiente').toUpperCase()})`;
  }

  return {
    id: String(rep.id || ''),
    codigo_equipo: String(rep.codigo_equipo || ''),
    origen_unificado: origenLabel,
    fuera_catalogo: rep.es_nuevo_codigo || rep.fuera_catalogo ? 'SÍ (Creado en campo)' : 'Catálogo Base',
    fecha: String(rep.fecha || ''),
    hora_peru: String(rep.hora_peru || '--:--'),
    tipo: String(rep.tipo || 'Observación'),
    prioridad: String(rep.prioridad || 'Media'),
    observacion: String(rep.observacion || ''),
    cant_seguimientos: seguimientos.length,
    resumen_seguimientos: resumenSeguimientos,
    cant_fotos: fotosCount,
    rutas_storage_sin_url_firmada: cleanPhotoPaths.join(' ; ') || 'En cola local (pendiente de subir)',
    video_ruta: cleanVideoPath,
    calidad_compresion:
      rep.calidad_compresion === 'alta'
        ? 'Alta Nitidez (2048px / <800KB)'
        : 'Estándar (1600px / <400KB)',
    estado_sync: String(rep.estado || 'sincronizado').toUpperCase(),
    registrado_por: String(rep.creado_por_email || rep.creado_por || 'operador.mina@operacion.pe'),
    dispositivo: String(rep.dispositivo || 'PWA Mina'),
    creado_en: String(rep.creado_en || ''),
    actualizado_en: String(rep.actualizado_en || '')
  };
}

/**
 * Construye y audita las filas a exportar, verificando que 0 celdas contengan URLs firmadas (`?token=`).
 */
export function buildExcelExportPayload(filteredReports = [], activeFilters = {}) {
  const rows = filteredReports.map((rep) => mapUnifiedReportToExcelRow(rep));

  // Auditoría estricta de Regla M6 / Escenario P10: 0 URLs firmadas que caducan
  let signedUrlsDetected = 0;
  for (const row of rows) {
    for (const val of Object.values(row)) {
      const str = String(val || '');
      if (str.includes('?token=') || str.includes('/object/sign/')) {
        signedUrlsDetected++;
      }
    }
  }

  const fechaExport = getFechaHoyPeru();
  const eqFilterTag =
    activeFilters.codigoEquipo && activeFilters.codigoEquipo !== 'TODOS'
      ? `_${activeFilters.codigoEquipo}`
      : '_TODOS';
  const fileName = `Reportes_Equipos_Mineros${eqFilterTag}_${fechaExport}.xlsx`;

  return {
    fileName,
    columns: EXCEL_COLUMNS,
    rows,
    totalExportedRows: rows.length,
    signedUrlsDetected,
    passesNoSignedUrlRule: signedUrlsDetected === 0,
    filtersSummary: {
      codigoEquipo: activeFilters.codigoEquipo || 'TODOS',
      fechaDesde: activeFilters.fechaDesde || 'Sin límite',
      fechaHasta: activeFilters.fechaHasta || 'Sin límite',
      tipo: activeFilters.tipo || 'TODOS',
      prioridad: activeFilters.prioridad || 'TODAS',
      origen: activeFilters.origen || 'TODOS',
      busquedaTexto: activeFilters.searchText || '(Ninguna)'
    },
    exportedAtIso: new Date().toISOString()
  };
}

/**
 * ============================================================================
 * GENERADOR NATIVO DE ARCHIVOS .XLSX (OpenXML SpreadsheetML ZIP Estándar)
 * Crea un archivo .xlsx 100 % válido para Microsoft Excel, Google Sheets y Calc
 * sin depender de librerías externas por red (funciona en Modo Avión).
 * ============================================================================
 */
function escapeXml(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
}

function columnNumberToName(colIndex1Based) {
  let num = colIndex1Based;
  let letters = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    num = Math.floor((num - 1) / 26);
  }
  return letters;
}

function buildWorksheetXml(columns, rows) {
  const colsXml = columns
    .map(
      (col, idx) =>
        `<col min="${idx + 1}" max="${idx + 1}" width="${col.width || 22}" customWidth="1"/>`
    )
    .join('');

  // Fila 1: Encabezados con estilo oscuro industrial (s="1")
  const headerCellsXml = columns
    .map((col, idx) => {
      const ref = `${columnNumberToName(idx + 1)}1`;
      return `<c r="${ref}" t="inlineStr" s="1"><is><t>${escapeXml(col.header)}</t></is></c>`;
    })
    .join('');

  let sheetRowsXml = `<row r="1" ht="26" customHeight="1">${headerCellsXml}</row>`;

  // Filas de datos (2..N)
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const rowNumber = rIdx + 2;
    const rowObj = rows[rIdx];

    const cellsXml = columns
      .map((col, cIdx) => {
        const ref = `${columnNumberToName(cIdx + 1)}${rowNumber}`;
        const rawVal = rowObj[col.key];
        if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
          return `<c r="${ref}" s="2"><v>${rawVal}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr" s="2"><is><t>${escapeXml(String(rawVal ?? ''))}</t></is></c>`;
      })
      .join('');

    sheetRowsXml += `<row r="${rowNumber}">${cellsXml}</row>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${colsXml}</cols>
  <sheetData>${sheetRowsXml}</sheetData>
</worksheet>`;
}

/**
 * Empaquetador ZIP sin compresión (STORE method = 0) con cálculo exacto de CRC32 para generar el contenedor `.xlsx` OpenXML.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Bytes(uint8Arr) {
  let crc = 0xffffffff;
  for (let i = 0; i < uint8Arr.length; i++) {
    const byte = uint8Arr[i];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBlobFromEntries(entries) {
  const encoder = new TextEncoder();
  const localFileChunks = [];
  const centralDirChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes =
      entry.content instanceof Uint8Array ? entry.content : encoder.encode(entry.content);
    const crc = crc32Bytes(dataBytes);
    const size = dataBytes.length;

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, 0, true); // Compression method 0 (STORE)
    lv.setUint16(10, 0, true); // File time
    lv.setUint16(12, 0x5772, true); // File date
    lv.setUint32(14, crc, true); // CRC-32
    lv.setUint32(18, size, true); // Compressed size
    lv.setUint32(22, size, true); // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // File name length
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    localFileChunks.push(localHeader, dataBytes);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central file header signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
    cv.setUint16(10, 0, true); // Compression method 0
    cv.setUint16(12, 0, true); // Time
    cv.setUint16(14, 0x5772, true); // Date
    cv.setUint32(16, crc, true); // CRC-32
    cv.setUint32(20, size, true); // Compressed size
    cv.setUint32(24, size, true); // Uncompressed size
    cv.setUint16(28, nameBytes.length, true); // File name length
    cv.setUint16(30, 0, true); // Extra field length
    cv.setUint16(32, 0, true); // File comment length
    cv.setUint16(34, 0, true); // Disk number start
    cv.setUint16(36, 0, true); // Internal file attributes
    cv.setUint32(38, 0, true); // External file attributes
    cv.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralDirChunks.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirSize = centralDirChunks.reduce((acc, c) => acc + c.length, 0);

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // Number of this disk
  ev.setUint16(6, 0, true); // Disk where central directory starts
  ev.setUint16(8, entries.length, true); // Number of central directory records on this disk
  ev.setUint16(10, entries.length, true); // Total number of central directory records
  ev.setUint32(12, centralDirSize, true); // Size of central directory
  ev.setUint32(16, offset, true); // Offset of start of central directory
  ev.setUint16(20, 0, true); // Comment length

  return new Blob([...localFileChunks, ...centralDirChunks, eocd], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

export function generateXlsxWorkbookBlob(columns, rows) {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Historial Reportes Mina" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFBBF24"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center" wrapText="1"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="top" wrapText="1"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  const sheet1Xml = buildWorksheetXml(columns, rows);

  return createZipBlobFromEntries([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheet1Xml }
  ]);
}

/**
 * Ejecuta la exportación a Excel (.xlsx) de los registros filtrados y dispara la descarga en el navegador
 * (a menos que options.skipBrowserDownload === true, útil en pruebas automatizadas).
 */
export function exportFilteredReportsToExcel(filteredReports = [], activeFilters = {}, options = {}) {
  const payload = buildExcelExportPayload(filteredReports, activeFilters);
  const blob = generateXlsxWorkbookBlob(payload.columns, payload.rows);

  if (!options.skipBrowserDownload && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return {
    ...payload,
    blobSizeBytes: blob.size
  };
}
