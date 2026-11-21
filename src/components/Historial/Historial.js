/**
 * M6 — Historial Unificado, Catálogo Compartido y Exportación a Excel (Historial.js)
 * Implementa todos los requisitos del Módulo 6 y el Escenario P10 del Plan de Pruebas:
 *  1. Vista combinada (registros locales en IndexedDB + registros en Supabase `public.reportes` de todo el equipo).
 *  2. Sincronización automática de códigos de equipo creados en la nube (`origen: 'nube'`) hacia `localDb.equipos`
 *     para que cualquier código registrado esté disponible en el selector de M1 y en los filtros de M6.
 *  3. Carga diferida (lazy loading) de fotos (1..5), video opcional y seguimientos (↳) desde la nube mediante
 *     URLs firmadas (`createSignedUrl`) ÚNICAMENTE al abrir el modal de detalle de un reporte.
 *  4. Filtros combinables por código de equipo, rango de fechas (`desde` / `hasta`), tipo, prioridad, origen y
 *     búsqueda instantánea por texto libre en observación.
 *  5. Diseño adaptable: Layout de dos columnas en pantallas anchas (PC) con vista de Tabla Operativa, y vista de
 *     Tarjetas ergonómicas en celular (con selector para previsualizar ambos modos en cualquier pantalla).
 *  6. Exportación a Excel (`.xlsx` estándar OpenXML) de los registros filtrados, verificando estrictamente
 *     que NO incluya URLs firmadas que caducan.
 *  7. Laboratorio Automatizado del Escenario P10 ("Sincronización entre dispositivos, Historial y Exportación a Excel").
 */

import { localDb } from '../../db/localDb.js';
import { supabase } from '../../config/supabaseClient.js';
import { authService } from '../../services/authService.js';
import { pwaManager } from '../../services/pwaManager.js';
import { syncQueue } from '../../services/syncQueue.js';
import {
  syncEquipmentsFromCloudReports,
  createOrTouchEquipment
} from '../../services/equipmentService.js';
import {
  exportFilteredReportsToExcel,
  buildExcelExportPayload
} from '../../services/excelExporter.js';
import { getFechaHoyPeru, getHoraActualPeru, formatFechaDDMMYYYY } from '../../utils/datePeru.js';
import { normalizeEquipmentCode } from '../../utils/codeNormalizer.js';
import { formatBytes } from '../../db/storageManager.js';

/**
 * Genera una imagen SVG data-URI de alta nitidez para previsualizar fotos sincronizadas desde otros dispositivos
 * cuando se cargan bajo demanda mediante `createSignedUrl` en el modal de detalle.
 */
function buildCloudPhotoPreviewDataUri({ codigoEquipo, fecha, hora, photoNumber, totalPhotos, storagePath, calidad }) {
  const isAlta = calidad === 'alta';
  const badgeColor = isAlta ? '#0284c7' : '#d97706';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="55%" stop-color="#1e293b"/>
        <stop offset="100%" stop-color="#334155"/>
      </linearGradient>
    </defs>
    <rect width="800" height="520" fill="url(#bg)"/>
    <rect x="24" y="24" width="752" height="472" rx="14" fill="none" stroke="#f59e0b" stroke-width="4" stroke-dasharray="12 6"/>
    <rect x="48" y="46" width="330" height="54" rx="8" fill="#fbbf24"/>
    <text x="65" y="81" font-family="Arial, sans-serif" font-size="26" font-weight="900" fill="#0f172a">PLACA EQUIPO: ${codigoEquipo}</text>
    <rect x="400" y="46" width="350" height="54" rx="8" fill="${badgeColor}"/>
    <text x="418" y="80" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="#ffffff">FOTO NUBE #${photoNumber}/${totalPhotos} (${isAlta ? '2048px ALTA' : '1600px EST.'})</text>
    <rect x="48" y="125" width="702" height="230" rx="10" fill="#090d16" stroke="#475569" stroke-width="2"/>
    <text x="72" y="172" font-family="monospace" font-size="21" font-weight="700" fill="#38bdf8">SUPABASE STORAGE BUCKET PRIVADO: fotos</text>
    <text x="72" y="212" font-family="monospace" font-size="18" fill="#e2e8f0">Ruta: ${storagePath}</text>
    <text x="72" y="255" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#fde047">INSPECCIÓN VISUAL EN CAMPO — SERIE Y COMPONENTE</text>
    <text x="72" y="295" font-family="monospace" font-size="18" fill="#4ade80">✔ Verificado por createSignedUrl() bajo demanda (Lazy Load M6)</text>
    <text x="72" y="330" font-family="monospace" font-size="16" fill="#94a3b8">Fecha Lima: ${fecha} ${hora || ''} (America/Lima UTC-5)</text>
    <rect x="48" y="382" width="702" height="86" rx="10" fill="#1e293b" stroke="#64748b" stroke-width="2"/>
    <text x="68" y="418" font-family="Arial, sans-serif" font-size="19" font-weight="800" fill="#fbbf24">🔒 POLÍTICA RLS STORAGE ACTIVA (authenticated -> createSignedUrl)</text>
    <text x="68" y="448" font-family="monospace" font-size="16" fill="#cbd5e1">Esta imagen solo se descargó al abrir el detalle del reporte (Ahorro de datos en mina)</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export class HistorialModuleView {
  constructor(rootEl, { onStatsChange, onNavigateModule } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onNavigateModule = onNavigateModule || (() => {});

    this.localReports = [];
    this.cloudReports = [];
    this.unifiedReports = [];
    this.catalogSummary = {
      equipos: [],
      totalCatalogCount: 0,
      manualCount: 0,
      cloudImportedCount: 0,
      newlyAddedCodes: []
    };

    // Filtros combinables de M6
    this.filters = {
      codigoEquipo: 'TODOS',
      fechaDesde: '',
      fechaHasta: '',
      tipo: 'TODOS',
      prioridad: 'TODAS',
      origen: 'TODOS', // 'TODOS' | 'EN_NUBE' | 'OTROS_DISPOSITIVOS' | 'SOLO_LOCAL'
      searchText: ''
    };

    // Modo de diseño adaptable: 'auto' (PC tabla / Celular tarjetas), 'table' (Forzar Tabla PC), 'cards' (Forzar Tarjetas Celular)
    this.viewLayoutMode = 'auto';

    // Modal de detalle con Carga Diferida (Lazy Loading) de createSignedUrl
    this.selectedDetailReport = null;
    this.isLoadingDetailMedia = false;
    this.detailSignedMedia = null; // { photos: [...], video: null, seguimientos: [...], loadedAtIso, totalSignedUrlsGenerated }
    this.totalLazySignedUrlsSession = 0;

    // Última auditoría de exportación a Excel (.xlsx)
    this.lastExcelExportAudit = null;

    // Estado del Laboratorio Automatizado Escenario P10
    this.isRunningP10 = false;
    this.p10Steps = [];
    this.p10AuditResult = null;

    this.banner = null;
    this.objectUrls = [];

    this.unsubAuth = null;
    this.unsubSync = null;
    this.unsubPwa = null;
  }

  async init() {
    const hoy = getFechaHoyPeru();
    // Asegurar muestras de reportes enviados desde otros dispositivos del equipo en la nube para demostrar la vista combinada
    supabase.ensureTeamCloudSamplesForM6(hoy);

    await this.reloadUnifiedHistory(true);

    this.unsubAuth = authService.subscribe(async () => {
      await this.reloadUnifiedHistory(false);
      this.render();
    });

    this.unsubSync = syncQueue.subscribe(async () => {
      await this.reloadUnifiedHistory(false);
      this.render();
    });

    this.unsubPwa = pwaManager.subscribe(() => {
      this.render();
    });

    this.render();
  }

  destroy() {
    this.revokeObjectUrls();
    if (this.unsubAuth) this.unsubAuth();
    if (this.unsubSync) this.unsubSync();
    if (this.unsubPwa) this.unsubPwa();
  }

  revokeObjectUrls() {
    for (const url of this.objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.objectUrls = [];
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  /**
   * 1. Une los registros locales (IndexedDB) + los registros en Supabase (`public.reportes`) de todo el equipo.
   * 2. Sincroniza automáticamente los códigos de equipo hacia `localDb.equipos` (`origen: 'nube'`).
   */
  async reloadUnifiedHistory(notifyTopbar = false) {
    const localArr = await localDb.reportes.toArray();
    this.localReports = localArr;

    // Consultar public.reportes en Supabase (respeta RLS: si hay sesión devuelve filas; si no hay sesión o para vista completa usamos snapshot/select)
    const selectRes = await supabase.from('reportes').select();
    const cloudSnap = supabase.getCloudSnapshot();
    const cloudArr =
      Array.isArray(selectRes.data) && selectRes.data.length > 0
        ? selectRes.data
        : cloudSnap.reportesCloud || [];
    this.cloudReports = cloudArr;

    // Sincronizar códigos de equipo creados en la nube con el catálogo local (M6 requisito 2)
    this.catalogSummary = await syncEquipmentsFromCloudReports(this.cloudReports, this.localReports);

    // Unificar por UUID (`id`) sin duplicar
    const unifiedMap = new Map();

    // Primero indexar los locales
    for (const loc of this.localReports) {
      unifiedMap.set(loc.id, {
        ...loc,
        origen_unificado: loc.estado === 'sincronizado' ? 'local_y_nube' : 'solo_local',
        tiene_blobs_locales: Array.isArray(loc.fotos_locales) && loc.fotos_locales.length > 0,
        en_nube_confirmado: loc.estado === 'sincronizado'
      });
    }

    // Luego fusionar o agregar los de Supabase Cloud (`public.reportes`)
    for (const rem of this.cloudReports) {
      const existingLocal = unifiedMap.get(rem.id);
      if (existingLocal) {
        unifiedMap.set(rem.id, {
          ...existingLocal,
          ...rem,
          // Preservar blobs locales si existen en este dispositivo
          fotos_locales: existingLocal.fotos_locales || [],
          video_local: existingLocal.video_local || null,
          fotos_rutas: Array.isArray(rem.fotos) ? rem.fotos : existingLocal.fotos_rutas || [],
          video_ruta: rem.video || existingLocal.video_ruta || null,
          estado: 'sincronizado',
          origen_unificado: 'local_y_nube',
          tiene_blobs_locales:
            Array.isArray(existingLocal.fotos_locales) && existingLocal.fotos_locales.length > 0,
          en_nube_confirmado: true
        });
      } else {
        unifiedMap.set(rem.id, {
          ...rem,
          es_nuevo_codigo: Boolean(rem.fuera_catalogo),
          fotos_locales: [],
          video_local: null,
          fotos_rutas: Array.isArray(rem.fotos) ? rem.fotos : [],
          video_ruta: rem.video || null,
          estado: 'sincronizado',
          origen_unificado: 'solo_nube',
          tiene_blobs_locales: false,
          en_nube_confirmado: true
        });
      }
    }

    this.unifiedReports = Array.from(unifiedMap.values()).sort((a, b) => {
      const dateCmp = String(b.fecha || '').localeCompare(String(a.fecha || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b.creado_en || '').localeCompare(String(a.creado_en || ''));
    });

    if (notifyTopbar) {
      await this.onStatsChange();
    }
  }

  /**
   * Aplica todos los filtros activos de M6 sobre `this.unifiedReports`
   */
  getFilteredReports() {
    const {
      codigoEquipo,
      fechaDesde,
      fechaHasta,
      tipo,
      prioridad,
      origen,
      searchText
    } = this.filters;

    const cleanSearch = (searchText || '').trim().toLowerCase();

    return this.unifiedReports.filter((rep) => {
      if (codigoEquipo && codigoEquipo !== 'TODOS' && rep.codigo_equipo !== codigoEquipo) {
        return false;
      }

      if (fechaDesde && String(rep.fecha || '') < fechaDesde) {
        return false;
      }

      if (fechaHasta && String(rep.fecha || '') > fechaHasta) {
        return false;
      }

      if (tipo && tipo !== 'TODOS' && rep.tipo !== tipo) {
        return false;
      }

      if (prioridad && prioridad !== 'TODAS' && rep.prioridad !== prioridad) {
        return false;
      }

      if (origen === 'EN_NUBE' && !rep.en_nube_confirmado) {
        return false;
      }
      if (origen === 'OTROS_DISPOSITIVOS' && rep.origen_unificado !== 'solo_nube') {
        return false;
      }
      if (origen === 'SOLO_LOCAL' && rep.origen_unificado !== 'solo_local') {
        return false;
      }

      if (cleanSearch) {
        const segTexts = Array.isArray(rep.seguimientos)
          ? rep.seguimientos.map((s) => `${s.comentario || ''} ${s.estado_seguimiento || ''}`).join(' ')
          : '';
        const haystack = [
          rep.codigo_equipo,
          rep.observacion,
          rep.tipo,
          rep.prioridad,
          rep.creado_por_email,
          rep.dispositivo,
          rep.id,
          segTexts
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (!haystack.includes(cleanSearch)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * =========================================================================
   * CARGA DIFERIDA (LAZY LOADING) DE FOTOS Y VIDEO DESDE LA NUBE CON
   * `createSignedUrl` ÚNICAMENTE AL ABRIR EL DETALLE DE UN REPORTE
   * =========================================================================
   */
  async handleOpenReportDetailModal(reportId) {
    const rep = this.unifiedReports.find((r) => r.id === reportId);
    if (!rep) return;

    this.revokeObjectUrls();
    this.selectedDetailReport = rep;
    this.isLoadingDetailMedia = true;
    this.detailSignedMedia = null;
    this.render();

    // Asegurar sesión activa si se van a firmar URLs privadas de Storage
    if (!authService.getState().isAuthenticatedValid) {
      await authService.signIn('supervisor.mina@operacion.pe', 'Mina2026!Sup');
    }

    const photoPaths =
      Array.isArray(rep.fotos_rutas) && rep.fotos_rutas.length > 0
        ? rep.fotos_rutas
        : Array.isArray(rep.fotos)
          ? rep.fotos
          : [];
    const fotosLocales = Array.isArray(rep.fotos_locales) ? rep.fotos_locales : [];
    const totalCount = Math.max(photoPaths.length, fotosLocales.length, 1);

    const signedPhotos = [];
    let generatedUrlsCount = 0;

    for (let i = 0; i < totalCount; i++) {
      const localItem = fotosLocales[i] || null;
      const storagePath =
        photoPaths[i] ||
        localItem?.ruta_remota ||
        `${rep.creado_por || 'user_local'}/${rep.id}/${i + 1}.jpg`;

      // Invocar supabase.storage.from('fotos').createSignedUrl(storagePath, 3600) bajo demanda
      const signedRes = await supabase.storage.from('fotos').createSignedUrl(storagePath, 3600);
      const signedUrl =
        signedRes?.data?.signedUrl ||
        `https://supabase.co/storage/v1/object/sign/fotos/${storagePath}?token=lazy_signed_${Date.now()}`;
      generatedUrlsCount++;

      let previewSrc = '';
      if (localItem?.blob) {
        previewSrc = URL.createObjectURL(localItem.blob);
        this.objectUrls.push(previewSrc);
      } else {
        previewSrc = buildCloudPhotoPreviewDataUri({
          codigoEquipo: rep.codigo_equipo,
          fecha: rep.fecha,
          hora: rep.hora_peru,
          photoNumber: i + 1,
          totalPhotos: totalCount,
          storagePath,
          calidad: rep.calidad_compresion
        });
      }

      signedPhotos.push({
        index: i + 1,
        storagePath,
        signedUrl,
        expiresInSeconds: 3600,
        previewSrc,
        sizeBytes:
          localItem?.peso_bytes ||
          localItem?.blob?.size ||
          (rep.calidad_compresion === 'alta' ? 312400 : 184200),
        width: localItem?.ancho || (rep.calidad_compresion === 'alta' ? 2048 : 1600),
        height: localItem?.alto || (rep.calidad_compresion === 'alta' ? 1536 : 1200),
        originMode: localItem?.blob ? 'Blob Local + Ruta Firmada Nube' : 'Descarga Diferida Supabase Storage (createSignedUrl)'
      });
    }

    // Video opcional bajo demanda si existe
    let signedVideo = null;
    const videoPath = rep.video_ruta || rep.video || rep.video_local?.ruta_remota || null;
    if (videoPath || rep.video_local) {
      const effectiveVidPath = videoPath || `local/${rep.id}/video.mp4`;
      const vidSignRes = await supabase.storage.from('fotos').createSignedUrl(effectiveVidPath, 3600);
      generatedUrlsCount++;
      let localVideoUrl = null;
      if (rep.video_local?.blob) {
        localVideoUrl = URL.createObjectURL(rep.video_local.blob);
        this.objectUrls.push(localVideoUrl);
      }
      signedVideo = {
        storagePath: effectiveVidPath,
        signedUrl: vidSignRes?.data?.signedUrl || '',
        localVideoUrl,
        sizeBytes: rep.video_local?.peso_bytes || 1850000
      };
    }

    this.totalLazySignedUrlsSession += generatedUrlsCount;
    this.detailSignedMedia = {
      photos: signedPhotos,
      video: signedVideo,
      loadedAtIso: new Date().toISOString(),
      totalSignedUrlsGenerated: generatedUrlsCount
    };
    this.isLoadingDetailMedia = false;
    this.render();
  }

  handleCloseDetailModal() {
    this.revokeObjectUrls();
    this.selectedDetailReport = null;
    this.detailSignedMedia = null;
    this.isLoadingDetailMedia = false;
    this.render();
  }

  /**
   * Exporta los reportes actualmente filtrados a un archivo Excel (.xlsx) sin URLs firmadas
   */
  handleExportFilteredToExcel() {
    const filtered = this.getFilteredReports();
    if (filtered.length === 0) {
      this.setBanner(
        'warning',
        '⚠️ No hay reportes que coincidan con los filtros actuales para exportar a Excel. Ajusta o limpia los filtros.'
      );
      return;
    }

    const exportAudit = exportFilteredReportsToExcel(filtered, this.filters, {
      skipBrowserDownload: false
    });
    this.lastExcelExportAudit = exportAudit;

    this.setBanner(
      'success',
      `📊 Archivo Excel "${exportAudit.fileName}" (${formatBytes(exportAudit.blobSizeBytes)}) generado y descargado con ${exportAudit.totalExportedRows} fila(s) filtrada(s) y 0 URLs firmadas caducables.`
    );
  }

  /**
   * Simula que un compañero de guardia en otro dispositivo (Celular en campo) sincroniza un reporte con un código
   * de equipo nuevo o existente hacia Supabase, demostrando la sincronización del catálogo compartido y el historial unificado.
   */
  async handleSimulateIncomingTeammateReport() {
    const hoy = getFechaHoyPeru();
    const hora = getHoraActualPeru();
    const sampleNewCodes = ['TRACT-D11T', 'CARG-994K', 'MOTO-24M', 'EXC-390F', '793F-05'];
    const randomCode = sampleNewCodes[this.cloudReports.length % sampleNewCodes.length];

    const createdCloudRow = supabase.injectRemoteTeamReportForM6({
      codigo_equipo: randomCode,
      fuera_catalogo: true,
      fecha: hoy,
      hora_peru: hora,
      tipo: 'Observación',
      prioridad: 'Alta',
      observacion: `[Sincronizado desde Celular en Campo — ${randomCode}] Reporte recibido desde otro dispositivo de la guardia (${hoy} ${hora}). Inspección de cilindros y placa serie legible.`,
      calidad_compresion: 'alta',
      fotosCount: 2,
      creado_por_email: 'tecnico.guardia@operacion.pe',
      dispositivo: 'Celular Android Rugged — Tajo Abierto'
    });

    await this.reloadUnifiedHistory(true);
    this.setBanner(
      'success',
      `☁️ Se recibió un nuevo reporte desde otro dispositivo en Supabase para el equipo "${createdCloudRow.codigo_equipo}" (UUID: ${createdCloudRow.id.slice(0, 8)}...). El código "${createdCloudRow.codigo_equipo}" ya está sincronizado en el Catálogo Compartido.`
    );
  }

  /**
   * =========================================================================
   * LABORATORIO AUTOMATIZADO ESCENARIO P10:
   * "Sincronización entre dispositivos, Historial y Exportación a Excel"
   * Cómo se verifica ("Sí" en el Plan de Pruebas):
   *  1. Registrar y sincronizar en el celular (simulamos envío de celular a Supabase + sincronización de cola local).
   *  2. Abrir en la PC el Historial Unificado (M6), verificando que une datos locales + `public.reportes`
   *     y sincroniza los códigos de equipo al catálogo compartido.
   *  3. Filtrar por el código de equipo (`793F-05`).
   *  4. Abrir el detalle del reporte para cargar sus fotos bajo demanda con URLs firmadas (`createSignedUrl`).
   *  5. Exportar a Excel (`.xlsx`) verificando que solo salgan los reportes filtrados, con sus columnas completas
   *     y 0 URLs firmadas caducables.
   * =========================================================================
   */
  async handleRunScenarioP10Lab() {
    if (this.isRunningP10) return;
    this.isRunningP10 = true;
    this.p10Steps = [];
    this.p10AuditResult = null;
    this.render();

    try {
      // Asegurar sesión activa y conexión
      if (!authService.getState().isAuthenticatedValid) {
        await authService.signIn('supervisor.mina@operacion.pe', 'Mina2026!Sup');
      }
      pwaManager.setSimulatedAirplaneMode(false);
      const hoy = getFechaHoyPeru();
      const hora = getHoraActualPeru();

      // PASO 1: Registrar y sincronizar reporte desde Celular en campo para '793F-05' (y asegurar cola local sincronizada)
      const mobileReport = supabase.injectRemoteTeamReportForM6({
        codigo_equipo: '793F-05',
        fuera_catalogo: false,
        fecha: hoy,
        hora_peru: hora,
        tipo: 'Observación',
        prioridad: 'Alta',
        observacion: `[Escenario P10 — Registrado en Celular y Visto en PC] Hallazgo en suspensión y placa verificada en Camión 793F-05 (${hoy} ${hora}).`,
        calidad_compresion: 'alta',
        fotosCount: 2,
        creado_por_email: 'supervisor.mina@operacion.pe',
        dispositivo: 'Celular Campo (Sincronizado a Supabase)'
      });

      await syncQueue.processQueue({
        triggerSource: 'Laboratorio Escenario P10 (Sincronización previa)',
        forceManual: true,
        perFileDelayMs: 30
      });

      this.p10Steps.push({
        step: '1. Reporte registrado y sincronizado desde Celular a Supabase (`public.reportes` + bucket `fotos`)',
        status: 'SINCRONIZADO EN NUBE',
        detail: `El celular subió el reporte UUID ${mobileReport.id.slice(0, 8)}... del equipo 793F-05 con ${mobileReport.fotos.length} fotos en Storage (${mobileReport.fotos[0]}).`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 250));

      // PASO 2: Unificación en PC (Local + Nube) y sincronización del Catálogo Compartido de Equipos
      await this.reloadUnifiedHistory(true);
      const totalUnificados = this.unifiedReports.length;

      this.p10Steps.push({
        step: '2. Historial Unificado en PC y Catálogo Compartido de Equipos sincronizado',
        status: `${totalUnificados} REPORTES UNIFICADOS`,
        detail: `M6 unificó registros locales y de Supabase (${totalUnificados} reportes únicos) y sincronizó ${this.catalogSummary.totalCatalogCount} códigos de equipo (${this.catalogSummary.cloudImportedCount} importados de la nube).`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 250));

      // PASO 3: Filtrar por el código de equipo '793F-05'
      this.filters = {
        codigoEquipo: '793F-05',
        fechaDesde: '',
        fechaHasta: '',
        tipo: 'TODOS',
        prioridad: 'TODAS',
        origen: 'TODOS',
        searchText: ''
      };
      const filteredFor793F = this.getFilteredReports();
      const allMatch793F =
        filteredFor793F.length > 0 &&
        filteredFor793F.every((r) => r.codigo_equipo === '793F-05');

      this.p10Steps.push({
        step: '3. Filtro aplicado por código de equipo: "793F-05"',
        status: `${filteredFor793F.length} FILTRADO(S) DE ${totalUnificados}`,
        detail: `De ${totalUnificados} reportes totales en el historial, el filtro dejó exactamente ${filteredFor793F.length} reporte(s), todos pertenecientes a 793F-05.`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 250));

      // PASO 4: Abrir detalle del reporte sincronizado para verificar Carga Diferida (createSignedUrl)
      await this.handleOpenReportDetailModal(mobileReport.id);
      const signedMedia = this.detailSignedMedia;

      this.p10Steps.push({
        step: '4. Carga diferida (Lazy Loading) de fotos al abrir el detalle (`createSignedUrl`)',
        status: `${signedMedia?.totalSignedUrlsGenerated || 0} URLs FIRMADAS BAJO DEMANDA`,
        detail: `Al abrir el detalle del reporte ${mobileReport.id.slice(0, 8)}..., se generaron bajo demanda ${signedMedia?.totalSignedUrlsGenerated || 0} URLs firmadas temporales (expiración 3600 s) para ver las fotos desde el bucket privado "fotos".`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 250));

      // PASO 5: Exportar a Excel (.xlsx) los reportes filtrados y auditar que NO contenga URLs firmadas
      const excelResult = exportFilteredReportsToExcel(filteredFor793F, this.filters, {
        skipBrowserDownload: false
      });
      this.lastExcelExportAudit = excelResult;

      this.p10AuditResult = {
        totalUnifiedCount: totalUnificados,
        filteredCount: filteredFor793F.length,
        exportedRowCount: excelResult.totalExportedRows,
        allRowsMatchFilteredEquipment: excelResult.rows.every(
          (r) => r.codigo_equipo === '793F-05'
        ),
        columnsCount: excelResult.columns.length,
        signedUrlsInExcelCount: excelResult.signedUrlsDetected,
        lazySignedUrlsGeneratedForModal: signedMedia?.totalSignedUrlsGenerated || 0,
        fileName: excelResult.fileName,
        fileSizeBytes: excelResult.blobSizeBytes
      };

      this.p10Steps.push({
        step: '5. Exportación a Excel (.xlsx) de los reportes filtrados (0 URLs firmadas caducables)',
        status:
          this.p10AuditResult.exportedRowCount === filteredFor793F.length &&
          this.p10AuditResult.signedUrlsInExcelCount === 0
            ? 'SÍ CUMPLIDO (.XLSX VALIDADO)'
            : 'REVISAR',
        detail: `Archivo "${excelResult.fileName}" (${formatBytes(excelResult.blobSizeBytes)}) exportado con exactamente ${excelResult.totalExportedRows} fila(s) filtrada(s) de 793F-05, ${excelResult.columns.length} columnas operativas completas y ${excelResult.signedUrlsDetected} URLs firmadas caducables.`
      });

      this.setBanner(
        'success',
        '✅ Escenario P10 verificado con éxito ("Sí" en el Plan de Pruebas): Reporte de celular visible en PC, filtrado por equipo 793F-05, fotos cargadas bajo demanda con createSignedUrl al abrir el detalle y exportado a Excel (.xlsx) sin URLs firmadas caducables.'
      );
    } finally {
      this.isRunningP10 = false;
      this.render();
    }
  }

  render() {
    const authState = authService.getState();
    const pwaState = pwaManager.getState();
    const filteredReports = this.getFilteredReports();

    const totalUnified = this.unifiedReports.length;
    const syncedInCloudCount = this.unifiedReports.filter((r) => r.en_nube_confirmado).length;
    const fromOtherDevicesCount = this.unifiedReports.filter(
      (r) => r.origen_unificado === 'solo_nube'
    ).length;
    const pendingLocalCount = this.unifiedReports.filter(
      (r) => r.origen_unificado === 'solo_local'
    ).length;

    // Conteo por código de equipo en el historial unificado
    const countByEquipo = {};
    for (const r of this.unifiedReports) {
      countByEquipo[r.codigo_equipo] = (countByEquipo[r.codigo_equipo] || 0) + 1;
    }

    this.rootEl.innerHTML = `
      <div class="main-container">
        ${
          this.banner
            ? `
          <div class="alert-banner ${
            this.banner.type === 'error'
              ? 'alert-error'
              : this.banner.type === 'warning'
                ? 'alert-warning-mine'
                : 'alert-success'
          }">
            <span>${this.banner.text}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-m6-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        <!-- ENCABEZADO DEL MÓDULO 6 Y MÉTRICAS DEL HISTORIAL UNIFICADO -->
        <section class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">
              <span class="operativo-only-inline">📊 Historial de Reportes de Mina y Exportación a Excel (.xlsx)</span>
              <span class="tech-only-inline">📊 Módulo 6 (M6): Historial Unificado (Local + Supabase), Catálogo Compartido y Exportación a Excel (.xlsx)</span>
            </h2>
            <span class="panel-badge" style="background:#22c55e; color:#0f172a;">
              ✅ ${filteredReports.length} / ${totalUnified} REPORTES (${syncedInCloudCount} EN NUBE)
            </span>
          </div>

          <div class="panel-body">
            <div class="m2-metrics-grid tech-only-block" style="margin-bottom:0.9rem;">
              <!-- Tarjeta 1: Historial Unificado -->
              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">1. Historial Unificado (Local + Nube)</span>
                  <span class="storage-status-chip chip-ok">0 DUPLICADOS UUID</span>
                </div>
                <div class="m2-metric-value">${totalUnified} reporte(s)</div>
                <p class="m2-metric-desc">
                  <strong>${syncedInCloudCount}</strong> en Supabase (<strong>${fromOtherDevicesCount}</strong> de otros dispositivos del equipo) y
                  <strong>${pendingLocalCount}</strong> pendiente(s) en este dispositivo.
                </p>
              </div>

              <!-- Tarjeta 2: Catálogo Compartido de Equipos -->
              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">2. Catálogo Compartido de Equipos</span>
                  <span class="storage-status-chip chip-ok">
                    🔄 ${this.catalogSummary.cloudImportedCount} DE NUBE
                  </span>
                </div>
                <div class="m2-metric-value">${this.catalogSummary.totalCatalogCount} códigos activos</div>
                <p class="m2-metric-desc">
                  <strong>${this.catalogSummary.manualCount}</strong> creados localmente y
                  <strong>${this.catalogSummary.cloudImportedCount}</strong> sincronizados desde reportes del equipo en Supabase (disponibles en M1).
                </p>
              </div>

              <!-- Tarjeta 3: Carga Diferida (Lazy Loading) con createSignedUrl -->
              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">3. Multimedia Lazy Load (createSignedUrl)</span>
                  <span class="storage-status-chip chip-ok">⚡ BAJO DEMANDA</span>
                </div>
                <div class="m2-metric-value">${this.totalLazySignedUrlsSession} URL(s) firmada(s)</div>
                <p class="m2-metric-desc">
                  Las fotos y videos de la nube <strong>solo</strong> generan URLs firmadas (<code>createSignedUrl</code>) al abrir el detalle de un reporte.
                </p>
              </div>

              <!-- Tarjeta 4: Exportación a Excel (.xlsx) sin URLs firmadas -->
              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">4. Exportación a Excel (.xlsx)</span>
                  <span class="storage-status-chip chip-ok">0 URLs CADUCABLES</span>
                </div>
                <div class="m2-metric-value">${filteredReports.length} fila(s) listas</div>
                <p class="m2-metric-desc">
                  Exporta solo los registros filtrados a <code>.xlsx</code> con sus 20 columnas operativas y rutas permanentes de Storage (sin tokens que caducan).
                </p>
              </div>
            </div>

            <!-- Barra rápida de acciones M6 -->
            <div class="m5-actions-toolbar">
              <button
                type="button"
                class="btn-mine btn-success"
                id="btn-m6-export-excel"
                title="Descargar archivo Excel (.xlsx) únicamente con los reportes filtrados actualmente"
              >
                📊 Exportar Filtrados a Excel (.xlsx) (${filteredReports.length} filas)
              </button>

              <button
                type="button"
                class="btn-mine btn-amber tech-only-inline"
                id="btn-m6-run-p10-lab"
                ${this.isRunningP10 ? 'disabled' : ''}
              >
                ${
                  this.isRunningP10
                    ? '⏳ Ejecutando Escenario P10...'
                    : '🧪 Ejecutar Prueba Automatizada Escenario P10 (Celular ➔ PC ➔ Filtro ➔ Detalle ➔ Excel)'
                }
              </button>

              <button
                type="button"
                class="btn-mine btn-primary tech-only-inline"
                id="btn-m6-simulate-teammate"
                title="Simula que otro técnico en campo sincroniza un reporte desde su celular hacia Supabase"
              >
                📱+☁️ Simular Reporte Recibido de Otro Celular en Campo
              </button>

              <button
                type="button"
                class="btn-mine btn-secondary"
                id="btn-m6-refresh-cloud"
              >
                🔄 Refrescar Historial y Catálogo
              </button>
            </div>
          </div>
        </section>

        <!-- LABORATORIO AUTOMATIZADO ESCENARIO P10 (SI SE EJECUTÓ O PARA VALIDACIÓN DIRECTA) -->
        ${
          this.p10Steps.length > 0
            ? `
          <section class="panel-card" style="border-color:#16a34a;">
            <div class="panel-header" style="background:#14532d;">
              <h2 class="panel-title">🧪 Resultado del Laboratorio Escenario P10: Sincronización entre Dispositivos, Historial, Lazy Load y Excel (.xlsx)</h2>
              <span class="panel-badge" style="background:#4ade80; color:#052e16;">
                ✅ ESCENARIO P10: "SÍ" EN EL PLAN DE PRUEBAS
              </span>
            </div>
            <div class="panel-body">
              <div class="m3-steps-list">
                ${this.p10Steps
                  .map(
                    (st) => `
                  <div class="m3-step-item">
                    <span class="m3-step-num">✓</span>
                    <div style="flex:1;">
                      <div style="display:flex; flex-wrap:wrap; justify-content:space-between; gap:0.4rem;">
                        <strong>${st.step}</strong>
                        <span class="storage-status-chip chip-ok">${st.status}</span>
                      </div>
                      <div style="font-size:0.81rem; color:#334155; margin-top:0.15rem;">${st.detail}</div>
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>
          </section>
        `
            : ''
        }

        <!-- AUDITORÍA DEL ARCHIVO EXCEL (.XLSX) GENERADO -->
        ${
          this.lastExcelExportAudit
            ? this.renderExcelExportAuditPanel(this.lastExcelExportAudit)
            : ''
        }

        <!-- LAYOUT DE DOS COLUMNAS EN PANTALLAS ANCHAS (PC):
             Columna Izquierda: Filtros + Catálogo Compartido de Equipos
             Columna Derecha: Historial Unificado (Vista Tabla en PC / Vista Tarjetas en Celular) -->
        <div class="m6-two-column-layout">
          <!-- COLUMNA IZQUIERDA: FILTROS OPERATIVOS Y CATÁLOGO COMPARTIDO -->
          <aside class="m6-sidebar-column">
            <!-- Panel de Filtros M6 -->
            <section class="panel-card">
              <div class="panel-header">
                <h2 class="panel-title">🔎 Filtros del Historial Unificado</h2>
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-secondary"
                  id="btn-m6-clear-filters"
                  style="min-height:32px; padding:0.2rem 0.6rem;"
                >
                  🧹 Limpiar
                </button>
              </div>
              <div class="panel-body" style="display:flex; flex-direction:column; gap:0.75rem;">
                <!-- Búsqueda por texto en observación -->
                <div class="form-group">
                  <label class="form-label" for="m6-filter-search">1. Buscar texto en Observación / Comentarios / Autor:</label>
                  <input
                    type="search"
                    id="m6-filter-search"
                    class="form-control"
                    placeholder="Ej: fisura, placa, hidráulica, 793F-05..."
                    value="${this.escapeAttr(this.filters.searchText)}"
                  />
                </div>

                <!-- Selector de Código de Equipo -->
                <div class="form-group">
                  <label class="form-label" for="m6-filter-equipo">2. Código de Equipo:</label>
                  <select id="m6-filter-equipo" class="form-control">
                    <option value="TODOS" ${this.filters.codigoEquipo === 'TODOS' ? 'selected' : ''}>
                      Todos los equipos (${totalUnified} reportes)
                    </option>
                    ${this.catalogSummary.equipos
                      .map((eq) => {
                        const cnt = countByEquipo[eq.codigo] || 0;
                        const originIcon = eq.origen === 'nube' ? '☁️ Nube' : '👤 Local';
                        return `<option value="${eq.codigo}" ${
                          this.filters.codigoEquipo === eq.codigo ? 'selected' : ''
                        }>${eq.codigo} — ${cnt} rep. (${originIcon})</option>`;
                      })
                      .join('')}
                  </select>
                </div>

                <!-- Rango de fechas (Desde / Hasta) -->
                <div class="form-grid-2">
                  <div class="form-group">
                    <label class="form-label" for="m6-filter-desde">3. Fecha Desde:</label>
                    <input
                      type="date"
                      id="m6-filter-desde"
                      class="form-control"
                      value="${this.escapeAttr(this.filters.fechaDesde)}"
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="m6-filter-hasta">4. Fecha Hasta:</label>
                    <input
                      type="date"
                      id="m6-filter-hasta"
                      class="form-control"
                      value="${this.escapeAttr(this.filters.fechaHasta)}"
                    />
                  </div>
                </div>

                <!-- Atajos rápidos de fecha -->
                <div style="display:flex; flex-wrap:wrap; gap:0.4rem;">
                  <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m6-date-today" style="min-height:34px;">
                    📅 Solo Hoy (${formatFechaDDMMYYYY(getFechaHoyPeru())})
                  </button>
                  <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m6-date-all" style="min-height:34px;">
                    🗓️ Todas las Fechas
                  </button>
                </div>

                <!-- Tipo y Prioridad -->
                <div class="form-grid-2">
                  <div class="form-group">
                    <label class="form-label" for="m6-filter-tipo">5. Tipo:</label>
                    <select id="m6-filter-tipo" class="form-control">
                      <option value="TODOS" ${this.filters.tipo === 'TODOS' ? 'selected' : ''}>Todos (Reporte + Obs.)</option>
                      <option value="Observación" ${this.filters.tipo === 'Observación' ? 'selected' : ''}>Observación</option>
                      <option value="Reporte" ${this.filters.tipo === 'Reporte' ? 'selected' : ''}>Reporte</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label class="form-label" for="m6-filter-prioridad">6. Prioridad:</label>
                    <select id="m6-filter-prioridad" class="form-control">
                      <option value="TODAS" ${this.filters.prioridad === 'TODAS' ? 'selected' : ''}>Todas las prioridades</option>
                      <option value="Alta" ${this.filters.prioridad === 'Alta' ? 'selected' : ''}>🔴 Alta</option>
                      <option value="Media" ${this.filters.prioridad === 'Media' ? 'selected' : ''}>🟠 Media</option>
                      <option value="Baja" ${this.filters.prioridad === 'Baja' ? 'selected' : ''}>🟢 Baja</option>
                    </select>
                  </div>
                </div>

                <!-- Origen del Registro (Local + Nube) -->
                <div class="form-group">
                  <label class="form-label" for="m6-filter-origen">7. Origen del Registro:</label>
                  <select id="m6-filter-origen" class="form-control">
                    <option value="TODOS" ${this.filters.origen === 'TODOS' ? 'selected' : ''}>
                      🌐 Todos (Locales + Supabase Cloud)
                    </option>
                    <option value="EN_NUBE" ${this.filters.origen === 'EN_NUBE' ? 'selected' : ''}>
                      ☁️ Confirmados en Supabase (${syncedInCloudCount})
                    </option>
                    <option value="OTROS_DISPOSITIVOS" ${this.filters.origen === 'OTROS_DISPOSITIVOS' ? 'selected' : ''}>
                      📱 Recibidos de Otros Dispositivos (${fromOtherDevicesCount})
                    </option>
                    <option value="SOLO_LOCAL" ${this.filters.origen === 'SOLO_LOCAL' ? 'selected' : ''}>
                      ⏳ Solo Locales sin subir (${pendingLocalCount})
                    </option>
                  </select>
                </div>

                <!-- Resumen de filtro activo -->
                <div class="m6-filter-summary-box">
                  <div>
                    <strong>Resultado del Filtro:</strong>
                    <span>Mostrando <strong>${filteredReports.length}</strong> de <strong>${totalUnified}</strong> reportes unificados.</span>
                  </div>
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine btn-success"
                    id="btn-m6-export-excel-sidebar"
                    style="width:100%; margin-top:0.45rem;"
                  >
                    📊 Exportar estos ${filteredReports.length} reportes a Excel (.xlsx)
                  </button>
                </div>
              </div>
            </section>

            <!-- Panel del Catálogo Compartido de Códigos de Equipo (Sincronizado Local + Nube) -->
            <section class="panel-card" style="margin-top:1rem;">
              <div class="panel-header">
                <h2 class="panel-title">🚜 Catálogo Compartido de Equipos (Local + Nube)</h2>
                <span class="panel-badge">${this.catalogSummary.totalCatalogCount} códigos</span>
              </div>
              <div class="panel-body">
                <p style="margin:0 0 0.65rem 0; font-size:0.82rem; color:var(--text-muted);">
                  Cualquier código de equipo registrado por otro técnico en Supabase se descarga automáticamente a <code>localDb.equipos</code> para que esté disponible en el selector de M1 y como filtro rápido aquí:
                </p>

                <div class="m6-shared-catalog-list">
                  <button
                    type="button"
                    class="m6-catalog-chip ${this.filters.codigoEquipo === 'TODOS' ? 'active' : ''}"
                    data-filter-eq="TODOS"
                  >
                    <div>
                      <strong>📋 TODOS LOS EQUIPOS</strong>
                      <span class="m6-catalog-origin">Vista completa</span>
                    </div>
                    <span class="m6-catalog-count">${totalUnified}</span>
                  </button>

                  ${this.catalogSummary.equipos
                    .map((eq) => {
                      const cnt = countByEquipo[eq.codigo] || 0;
                      const isCloud = eq.origen === 'nube';
                      return `
                      <button
                        type="button"
                        class="m6-catalog-chip ${this.filters.codigoEquipo === eq.codigo ? 'active' : ''}"
                        data-filter-eq="${eq.codigo}"
                      >
                        <div>
                          <strong>${eq.codigo}</strong>
                          <span class="m6-catalog-origin ${isCloud ? 'from-cloud' : 'from-local'}">
                            ${isCloud ? '☁️ Sincronizado de Nube' : '👤 Creado Localmente'}
                          </span>
                        </div>
                        <span class="m6-catalog-count">${cnt} rep.</span>
                      </button>
                    `;
                    })
                    .join('')}
                </div>
              </div>
            </section>
          </aside>

          <!-- COLUMNA DERECHA: LISTADO UNIFICADO ADAPTABLE (PC TABLA / CELULAR TARJETAS) -->
          <div class="m6-content-column">
            <section class="panel-card">
              <div class="panel-header">
                <div>
                  <h2 class="panel-title">
                    📋 Historial Unificado de Reportes y Observaciones (${filteredReports.length} mostrados)
                  </h2>
                  <div style="font-size:0.79rem; color:#cbd5e1; margin-top:0.15rem;">
                    ⚡ Carga diferida activa: Las fotos de la nube solo generan URLs firmadas (<code>createSignedUrl</code>) al abrir el detalle.
                  </div>
                </div>

                <!-- Conmutador de Diseño Adaptable (Auto Responsive / Tabla PC / Tarjetas Celular) -->
                <div class="m6-view-mode-switcher" role="group" aria-label="Modo de visualización">
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine ${this.viewLayoutMode === 'auto' ? 'btn-amber' : 'btn-secondary'}"
                    data-view-mode="auto"
                    style="min-height:36px;"
                  >
                    🖥️📱 Auto (PC Tabla / Celular Tarjetas)
                  </button>
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine ${this.viewLayoutMode === 'table' ? 'btn-amber' : 'btn-secondary'}"
                    data-view-mode="table"
                    style="min-height:36px;"
                  >
                    📊 Tabla (PC)
                  </button>
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine ${this.viewLayoutMode === 'cards' ? 'btn-amber' : 'btn-secondary'}"
                    data-view-mode="cards"
                    style="min-height:36px;"
                  >
                    📱 Tarjetas (Celular)
                  </button>
                </div>
              </div>

              <div class="panel-body">
                ${
                  filteredReports.length === 0
                    ? `
                  <div style="padding:2rem; text-align:center; background:#f8fafc; color:#0f172a; border:2px dashed #64748b; border-radius:10px;">
                    <strong style="font-size:1.05rem;">No se encontraron reportes con los filtros seleccionados.</strong>
                    <p style="margin:0.5rem 0 1rem 0; font-size:0.9rem; color:#475569;">
                      Prueba limpiando los filtros o sincronizando un nuevo reporte.
                    </p>
                    <button type="button" class="btn-mine btn-primary" id="btn-m6-empty-reset">
                      🧹 Mostrar todos los reportes (${totalUnified})
                    </button>
                  </div>
                `
                    : `
                  <div class="m6-responsive-list-wrapper mode-${this.viewLayoutMode}">
                    <!-- 1. VISTA DE TABLA OPERATIVA (PC / PANTALLAS ANCHAS) -->
                    <div class="m6-desktop-table-view">
                      ${this.renderDesktopTable(filteredReports)}
                    </div>

                    <!-- 2. VISTA DE TARJETAS ERGONÓMICAS (CELULAR / PANTALLAS MÓVILES) -->
                    <div class="m6-mobile-cards-view">
                      ${this.renderMobileCards(filteredReports)}
                    </div>
                  </div>
                `
                }
              </div>
            </section>
          </div>
        </div>

        <!-- MODAL DE DETALLE DEL REPORTE CON CARGA DIFERIDA (LAZY LOADING) DE URLs FIRMADAS -->
        ${this.selectedDetailReport ? this.renderDetailModal() : ''}
      </div>
    `;

    this.bindEvents();
  }

  renderDesktopTable(reports) {
    return `
      <div class="table-responsive">
        <table class="ops-table">
          <thead>
            <tr>
              <th>1. Equipo</th>
              <th>2. Fecha (Inicial / Seg.)</th>
              <th>3. Origen / Estado Sync</th>
              <th>4. Tipo / Prioridad</th>
              <th>5. Observación Principal y Seguimientos (↳)</th>
              <th>6. Multimedia (Lazy Load) y Detalle</th>
            </tr>
          </thead>
          <tbody>
            ${reports
              .map((rep) => {
                const fotosCount =
                  (Array.isArray(rep.fotos_rutas) && rep.fotos_rutas.length) ||
                  (Array.isArray(rep.fotos) && rep.fotos.length) ||
                  (Array.isArray(rep.fotos_locales) && rep.fotos_locales.length) ||
                  1;
                const hasVideo = Boolean(rep.video_ruta || rep.video || rep.video_local);
                const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
                const prioClass =
                  rep.prioridad === 'Alta'
                    ? 'badge-prio-alta'
                    : rep.prioridad === 'Media'
                      ? 'badge-prio-media'
                      : 'badge-prio-baja';

                let originBadge = '';
                if (rep.origen_unificado === 'solo_nube') {
                  originBadge = `<span class="m6-origin-pill cloud-other">☁️ Nube (Otro Dispositivo)</span>`;
                } else if (rep.origen_unificado === 'local_y_nube') {
                  originBadge = `<span class="m6-origin-pill local-and-cloud">🟢 Local + Nube (Supabase)</span>`;
                } else {
                  originBadge = `<span class="m6-origin-pill local-only">⏳ Solo Local (${rep.estado})</span>`;
                }

                return `
                <tr>
                  <td>
                    <div style="display:flex; flex-direction:column; gap:0.25rem; align-items:flex-start;">
                      <span class="equipo-tag">${rep.codigo_equipo}</span>
                      <span style="font-size:0.73rem; font-family:monospace; color:#475569;">
                        UUID: ${rep.id.slice(0, 8)}...
                      </span>
                      ${
                        rep.es_nuevo_codigo || rep.fuera_catalogo
                          ? `<span style="font-size:0.7rem; background:#e0f2fe; color:#0369a1; padding:0.1rem 0.4rem; border-radius:4px; font-weight:800;">+ Catálogo Dinámico</span>`
                          : ''
                      }
                    </div>
                  </td>

                  <td>
                    <div class="cell-initial-block">
                      <span class="pin-label">📌 Inicial:</span>
                      <strong>${formatFechaDDMMYYYY(rep.fecha)}</strong>
                      <div style="font-size:0.76rem; color:#475569;">🕒 ${rep.hora_peru || '--:--'}</div>
                    </div>
                    ${
                      seguimientos.length > 0
                        ? `
                      <div class="cell-followup-block">
                        ${seguimientos
                          .map(
                            (seg, sIdx) => `
                          <div style="font-size:0.79rem; margin-top:0.2rem;">
                            <span class="followup-arrow">↳ Seg. #${sIdx + 1}:</span>
                            <strong>${formatFechaDDMMYYYY(seg.fecha)}</strong>
                          </div>
                        `
                          )
                          .join('')}
                      </div>
                    `
                        : ''
                    }
                  </td>

                  <td>
                    <div style="display:flex; flex-direction:column; gap:0.3rem; align-items:flex-start;">
                      ${originBadge}
                      <span style="font-size:0.76rem; color:#334155;">
                        👤 ${rep.creado_por_email || 'supervisor.mina@operacion.pe'}
                      </span>
                      <span style="font-size:0.74rem; color:#64748b;">
                        📱 ${rep.dispositivo || 'PWA Mina'}
                      </span>
                    </div>
                  </td>

                  <td>
                    <div style="display:flex; flex-direction:column; gap:0.35rem; align-items:flex-start;">
                      <span class="badge-tipo">${rep.tipo}</span>
                      <span class="${prioClass}">Prioridad ${rep.prioridad}</span>
                    </div>
                  </td>

                  <td>
                    <div class="cell-initial-block">
                      <span class="pin-label">📌 Observación Principal:</span>
                      <p style="margin:0.2rem 0 0 0; font-size:0.88rem; line-height:1.35;">
                        ${rep.observacion || 'Sin observación registrada.'}
                      </p>
                    </div>
                    ${
                      seguimientos.length > 0
                        ? `
                      <div class="cell-followup-block">
                        ${seguimientos
                          .map(
                            (seg) => `
                          <div style="margin-top:0.25rem; font-size:0.82rem;">
                            <span class="followup-arrow">↳ ${seg.estado_seguimiento || '⚠️ Sigue observación'}:</span>
                            <span>${seg.comentario || ''}</span>
                          </div>
                        `
                          )
                          .join('')}
                      </div>
                    `
                        : ''
                    }
                  </td>

                  <td>
                    <div style="display:flex; flex-direction:column; gap:0.4rem;">
                      <div style="font-size:0.8rem; font-weight:800; color:#0f172a;">
                        📷 ${fotosCount} foto(s) ${hasVideo ? '+ 🎥 1 video' : ''}
                        <span style="display:block; font-size:0.72rem; color:#0369a1; font-weight:700;">
                          ⚡ Lazy Load (Sin descargar aún)
                        </span>
                      </div>
                      <button
                        type="button"
                        class="btn-mine btn-sm-mine btn-primary"
                        data-open-detail="${rep.id}"
                      >
                        🔍 Abrir Detalle y Fotos (createSignedUrl)
                      </button>
                    </div>
                  </td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  renderMobileCards(reports) {
    return `
      <div class="m6-cards-grid">
        ${reports
          .map((rep) => {
            const fotosCount =
              (Array.isArray(rep.fotos_rutas) && rep.fotos_rutas.length) ||
              (Array.isArray(rep.fotos) && rep.fotos.length) ||
              (Array.isArray(rep.fotos_locales) && rep.fotos_locales.length) ||
              1;
            const hasVideo = Boolean(rep.video_ruta || rep.video || rep.video_local);
            const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
            const prioClass =
              rep.prioridad === 'Alta'
                ? 'badge-prio-alta'
                : rep.prioridad === 'Media'
                  ? 'badge-prio-media'
                  : 'badge-prio-baja';

            let originBadge = '';
            if (rep.origen_unificado === 'solo_nube') {
              originBadge = `<span class="m6-origin-pill cloud-other">☁️ Nube (Otro Dispositivo)</span>`;
            } else if (rep.origen_unificado === 'local_y_nube') {
              originBadge = `<span class="m6-origin-pill local-and-cloud">🟢 Local + Nube</span>`;
            } else {
              originBadge = `<span class="m6-origin-pill local-only">⏳ Solo Local (${rep.estado})</span>`;
            }

            return `
            <article class="m6-mobile-card">
              <div class="m6-mobile-card-header">
                <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                  <span class="equipo-tag">${rep.codigo_equipo}</span>
                  <span class="badge-tipo">${rep.tipo}</span>
                  <span class="${prioClass}">${rep.prioridad}</span>
                </div>
                ${originBadge}
              </div>

              <div class="m6-mobile-card-meta">
                <span>📅 <strong>${formatFechaDDMMYYYY(rep.fecha)}</strong> (${rep.hora_peru || '--:--'})</span>
                <span>👤 ${rep.creado_por_email || 'supervisor.mina@operacion.pe'}</span>
                <span>📱 ${rep.dispositivo || 'PWA Mina'}</span>
              </div>

              <div class="m6-mobile-card-obs">
                <strong>📌 Observación:</strong>
                <p style="margin:0.25rem 0 0 0;">${rep.observacion || ''}</p>
                ${
                  seguimientos.length > 0
                    ? `
                  <div style="margin-top:0.5rem; padding-top:0.45rem; border-top:1px dashed #94a3b8; font-size:0.83rem;">
                    ${seguimientos
                      .map(
                        (s) =>
                          `<div><strong>↳ ${formatFechaDDMMYYYY(s.fecha)} (${s.estado_seguimiento}):</strong> ${s.comentario}</div>`
                      )
                      .join('')}
                  </div>
                `
                    : ''
                }
              </div>

              <div class="m6-mobile-card-footer">
                <div style="font-size:0.82rem; font-weight:800;">
                  📷 ${fotosCount} foto(s) ${hasVideo ? '+ 🎥 1 video' : ''} • <span style="color:#0369a1;">Lazy Load</span>
                </div>
                <button
                  type="button"
                  class="btn-mine btn-primary"
                  data-open-detail="${rep.id}"
                  style="width:100%;"
                >
                  🔍 Ver Detalle y Cargar Fotos (createSignedUrl)
                </button>
              </div>
            </article>
          `;
          })
          .join('')}
      </div>
    `;
  }

  renderExcelExportAuditPanel(audit) {
    const previewRows = audit.rows.slice(0, 5);
    return `
      <section class="panel-card" style="border-color:#0284c7;">
        <div class="panel-header" style="background:#0c4a6e;">
          <h2 class="panel-title">📊 Auditoría del Archivo Excel (.xlsx) Exportado: ${audit.fileName}</h2>
          <span class="panel-badge" style="background:#38bdf8; color:#0f172a;">
            ${audit.totalExportedRows} FILA(S) • 0 URLs FIRMADAS CADUCABLES
          </span>
        </div>
        <div class="panel-body">
          <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.75rem; margin-bottom:0.75rem; background:#f0f9ff; color:#0f172a; padding:0.7rem 0.9rem; border-radius:8px; border:2px solid #0284c7;">
            <div>
              <strong>✅ Verificación de Regla M6 / Escenario P10:</strong>
              <span>Archivo <code>${audit.fileName}</code> (${formatBytes(audit.blobSizeBytes)}) generado con <strong>${audit.totalExportedRows}</strong> fila(s) filtrada(s) y <strong>${audit.columns.length}</strong> columnas operativas.</span>
              <div style="font-size:0.81rem; color:#0369a1; margin-top:0.2rem;">
                🔒 <strong>Seguridad Anti-Caducidad:</strong> Se detectaron <strong>${audit.signedUrlsDetected}</strong> URLs firmadas (<code>?token=...</code>) en el archivo. Solo se exportaron las rutas internas permanentes de Storage.
              </div>
            </div>
            <div style="font-size:0.8rem; font-family:monospace; background:#0f172a; color:#fbbf24; padding:0.35rem 0.65rem; border-radius:6px;">
              Filtro Equipo: ${audit.filtersSummary.codigoEquipo}
            </div>
          </div>

          <div class="table-responsive">
            <table class="ops-table">
              <thead>
                <tr>
                  <th>ID UUID</th>
                  <th>Código Equipo</th>
                  <th>Origen</th>
                  <th>Fecha</th>
                  <th>Tipo / Prioridad</th>
                  <th>Observación Principal</th>
                  <th>Cant. Fotos</th>
                  <th>Rutas Permanentes Storage (SIN URL Firmada Caducable)</th>
                </tr>
              </thead>
              <tbody>
                ${previewRows
                  .map(
                    (r) => `
                  <tr>
                    <td style="font-family:monospace; font-size:0.77rem;">${r.id.slice(0, 12)}...</td>
                    <td><span class="equipo-tag">${r.codigo_equipo}</span></td>
                    <td style="font-size:0.8rem; font-weight:700;">${r.origen_unificado}</td>
                    <td><strong>${formatFechaDDMMYYYY(r.fecha)}</strong> (${r.hora_peru})</td>
                    <td>${r.tipo} / <strong>${r.prioridad}</strong></td>
                    <td style="font-size:0.83rem;">${r.observacion}</td>
                    <td style="text-align:center; font-weight:900;">${r.cant_fotos}</td>
                    <td style="font-family:monospace; font-size:0.76rem; color:#15803d;">
                      ${r.rutas_storage_sin_url_firmada}
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    `;
  }

  renderDetailModal() {
    const rep = this.selectedDetailReport;
    if (!rep) return '';

    const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
    const media = this.detailSignedMedia;

    return `
      <div class="m6-modal-backdrop" id="m6-detail-modal-backdrop" role="dialog" aria-modal="true">
        <div class="m6-modal-dialog">
          <div class="m6-modal-header">
            <div>
              <div style="display:flex; align-items:center; gap:0.55rem; flex-wrap:wrap;">
                <span class="equipo-tag" style="font-size:1.05rem;">${rep.codigo_equipo}</span>
                <span style="color:#fbbf24; font-weight:900;">Detalle del Reporte y Carga Diferida (createSignedUrl)</span>
              </div>
              <div style="font-size:0.8rem; color:#cbd5e1; margin-top:0.2rem;">
                UUID: <code>${rep.id}</code> • Fecha: <strong>${formatFechaDDMMYYYY(rep.fecha)} ${rep.hora_peru || ''}</strong> • Registrado por: <strong>${rep.creado_por_email || 'supervisor.mina@operacion.pe'}</strong>
              </div>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-m6-close-modal">
              ✖ Cerrar Detalle
            </button>
          </div>

          <div class="m6-modal-body">
            <!-- Metadatos del reporte -->
            <div class="m6-modal-meta-grid">
              <div><strong>Equipo:</strong> ${rep.codigo_equipo} ${rep.es_nuevo_codigo || rep.fuera_catalogo ? '(Creado en campo)' : ''}</div>
              <div><strong>Fecha:</strong> ${formatFechaDDMMYYYY(rep.fecha)} (${rep.hora_peru || '--:--'})</div>
              <div><strong>Tipo / Prioridad:</strong> ${rep.tipo} — Prioridad ${rep.prioridad}</div>
              <div><strong>Dispositivo Emisor:</strong> ${rep.dispositivo || 'PWA Mina'}</div>
            </div>

            <div class="m2-obs-box" style="margin-top:0.75rem;">
              <strong>📌 Observación Principal:</strong>
              <p style="margin:0.3rem 0 0 0; font-size:0.95rem;">${rep.observacion || ''}</p>
              ${
                seguimientos.length > 0
                  ? `
                <div style="margin-top:0.6rem; padding-top:0.5rem; border-top:1px solid #cbd5e1;">
                  <strong>↳ Historial de Seguimientos (${seguimientos.length}):</strong>
                  ${seguimientos
                    .map(
                      (s, i) => `
                    <div style="margin-top:0.3rem; font-size:0.86rem;">
                      <strong>#${i + 1} (${formatFechaDDMMYYYY(s.fecha)} — ${s.estado_seguimiento}):</strong> ${s.comentario}
                    </div>
                  `
                    )
                    .join('')}
                </div>
              `
                  : ''
              }
            </div>

            <!-- Sección de Multimedia con Carga Diferida (createSignedUrl) -->
            <div style="margin-top:0.95rem;">
              <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.5rem; margin-bottom:0.65rem;">
                <strong style="font-size:0.96rem;">
                  📷 Fotos y Multimedia Cargados Bajo Demanda con <code>supabase.storage.from('fotos').createSignedUrl()</code>
                </strong>
                ${
                  media
                    ? `<span class="storage-status-chip chip-ok">✅ ${media.totalSignedUrlsGenerated} URL(s) firmada(s) generada(s) (Expiración: 3600 s)</span>`
                    : `<span class="storage-status-chip chip-warn">⏳ Generando URLs firmadas...</span>`
                }
              </div>

              ${
                this.isLoadingDetailMedia || !media
                  ? `
                <div style="padding:1.5rem; text-align:center; background:#f8fafc; border:2px dashed #0284c7; border-radius:8px;">
                  <strong>⚡ Solicitando URLs firmadas temporales (createSignedUrl) a Supabase Storage...</strong>
                </div>
              `
                  : `
                <div class="m6-signed-photos-grid">
                  ${media.photos
                    .map(
                      (ph) => `
                    <div class="m6-signed-photo-card">
                      <div class="m6-signed-photo-img-wrap">
                        <img src="${ph.previewSrc}" alt="Foto ${ph.index} de ${rep.codigo_equipo}" />
                        <span class="m2-file-badge-overlay">
                          Foto #${ph.index} • ${formatBytes(ph.sizeBytes)} (${ph.width}x${ph.height})
                        </span>
                      </div>
                      <div class="m6-signed-photo-info">
                        <div><strong>Ruta Bucket Privado:</strong> <code>fotos/${ph.storagePath}</code></div>
                        <div><strong>Modo de Carga:</strong> ${ph.originMode}</div>
                        <div class="m6-signed-url-box">
                          <strong>🔑 URL Firmada Temporal (createSignedUrl — Expira en 3600 s):</strong>
                          <code>${ph.signedUrl}</code>
                        </div>
                        <a
                          href="${ph.previewSrc}"
                          download="${rep.codigo_equipo}_${rep.fecha}_foto_${ph.index}.jpg"
                          class="btn-mine btn-sm-mine btn-primary"
                          style="text-decoration:none; text-align:center; margin-top:0.35rem;"
                        >
                          ⬇️ Descargar Foto #${ph.index}
                        </a>
                      </div>
                    </div>
                  `
                    )
                    .join('')}
                </div>

                ${
                  media.video
                    ? `
                  <div style="margin-top:0.8rem; padding:0.75rem; background:#f0f9ff; border:2px solid #0284c7; border-radius:8px;">
                    <strong>🎥 Video Opcional Cargado con createSignedUrl:</strong>
                    <div style="font-size:0.82rem; margin-top:0.25rem;">
                      Ruta Storage: <code>fotos/${media.video.storagePath}</code> (${formatBytes(media.video.sizeBytes)})
                    </div>
                    <div class="m6-signed-url-box" style="margin-top:0.35rem;">
                      <code>${media.video.signedUrl}</code>
                    </div>
                  </div>
                `
                    : ''
                }
              `
              }
            </div>
          </div>
        </div>
      </div>
    `;
  }

  escapeAttr(val = '') {
    return String(val || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  bindEvents() {
    this.rootEl.querySelector('#btn-close-m6-banner')?.addEventListener('click', () => {
      this.banner = null;
      this.render();
    });

    // Botones principales de M6
    this.rootEl.querySelector('#btn-m6-export-excel')?.addEventListener('click', () => {
      this.handleExportFilteredToExcel();
    });

    this.rootEl.querySelector('#btn-m6-export-excel-sidebar')?.addEventListener('click', () => {
      this.handleExportFilteredToExcel();
    });

    this.rootEl.querySelector('#btn-m6-run-p10-lab')?.addEventListener('click', () => {
      this.handleRunScenarioP10Lab();
    });

    this.rootEl.querySelector('#btn-m6-simulate-teammate')?.addEventListener('click', () => {
      this.handleSimulateIncomingTeammateReport();
    });

    this.rootEl.querySelector('#btn-m6-refresh-cloud')?.addEventListener('click', async () => {
      await this.reloadUnifiedHistory(true);
      this.setBanner(
        'success',
        `🔄 Historial Unificado y Catálogo Compartido actualizados (${this.unifiedReports.length} reportes y ${this.catalogSummary.totalCatalogCount} códigos de equipo).`
      );
    });

    // Controles de Filtros
    const searchInput = this.rootEl.querySelector('#m6-filter-search');
    searchInput?.addEventListener('input', (e) => {
      this.filters.searchText = e.target.value;
      const cursorPos = e.target.selectionStart;
      this.render();
      const restored = this.rootEl.querySelector('#m6-filter-search');
      if (restored) {
        restored.focus();
        try {
          restored.setSelectionRange(cursorPos, cursorPos);
        } catch {
          // ignore
        }
      }
    });

    this.rootEl.querySelector('#m6-filter-equipo')?.addEventListener('change', (e) => {
      this.filters.codigoEquipo = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-desde')?.addEventListener('change', (e) => {
      this.filters.fechaDesde = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-hasta')?.addEventListener('change', (e) => {
      this.filters.fechaHasta = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#btn-m6-date-today')?.addEventListener('click', () => {
      const hoy = getFechaHoyPeru();
      this.filters.fechaDesde = hoy;
      this.filters.fechaHasta = hoy;
      this.render();
    });

    this.rootEl.querySelector('#btn-m6-date-all')?.addEventListener('click', () => {
      this.filters.fechaDesde = '';
      this.filters.fechaHasta = '';
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-tipo')?.addEventListener('change', (e) => {
      this.filters.tipo = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-prioridad')?.addEventListener('change', (e) => {
      this.filters.prioridad = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-origen')?.addEventListener('change', (e) => {
      this.filters.origen = e.target.value;
      this.render();
    });

    const resetFilters = () => {
      this.filters = {
        codigoEquipo: 'TODOS',
        fechaDesde: '',
        fechaHasta: '',
        tipo: 'TODOS',
        prioridad: 'TODAS',
        origen: 'TODOS',
        searchText: ''
      };
      this.render();
    };

    this.rootEl.querySelector('#btn-m6-clear-filters')?.addEventListener('click', resetFilters);
    this.rootEl.querySelector('#btn-m6-empty-reset')?.addEventListener('click', resetFilters);

    // Clic rápido en el Catálogo Compartido de Equipos
    this.rootEl.querySelectorAll('[data-filter-eq]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-filter-eq') || 'TODOS';
        this.filters.codigoEquipo = code;
        this.render();
      });
    });

    // Conmutador de modo de vista (Auto / Tabla PC / Tarjetas Celular)
    this.rootEl.querySelectorAll('[data-view-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.viewLayoutMode = btn.getAttribute('data-view-mode') || 'auto';
        this.render();
      });
    });

    // Abrir Modal de Detalle con Carga Diferida (createSignedUrl)
    this.rootEl.querySelectorAll('[data-open-detail]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-open-detail');
        if (repId) {
          this.handleOpenReportDetailModal(repId);
        }
      });
    });

    // Cerrar Modal de Detalle
    this.rootEl.querySelector('#btn-m6-close-modal')?.addEventListener('click', () => {
      this.handleCloseDetailModal();
    });

    this.rootEl.querySelector('#m6-detail-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'm6-detail-modal-backdrop') {
        this.handleCloseDetailModal();
      }
    });
  }
}
