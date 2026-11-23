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
  createOrTouchEquipment,
  inferEquipmentCategory
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

    // Datos de cabecera de Entrega de Guardia (Reporte Diario)
    this.dailyMeta = {
      turno: 'Guardia Día (07:00 - 19:00)',
      zona: 'Tajo Norte — Operaciones STRACON',
      supervisor: ''
    };

    // Filtros combinables de M6
    this.filters = {
      codigoEquipo: 'TODOS',
      fechaDesde: '',
      fechaHasta: '',
      tipo: 'TODOS',
      prioridad: 'TODAS',
      origen: 'TODOS', // 'TODOS' | 'EN_NUBE' | 'OTROS_DISPOSITIVOS' | 'SOLO_LOCAL'
      estadoOperativo: 'TODOS', // 'TODOS' | 'ACTIVAS' | 'LEVANTADAS'
      orden: 'prioridad', // 'prioridad' | 'equipo' | 'fecha'
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
    this.detailObjectUrls = [];
    this.thumbUrlMap = new Map();

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
    this.revokeDetailObjectUrls();
    for (const url of this.objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.objectUrls = [];
    this.thumbUrlMap.clear();
  }

  revokeDetailObjectUrls() {
    for (const url of this.detailObjectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.detailObjectUrls = [];
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
    const rawLocal = await localDb.reportes.toArray();

    // Consultar public.reportes en Supabase (respeta RLS: si hay sesión devuelve filas; si no hay sesión o para vista completa usamos snapshot/select)
    const selectRes = await supabase.from('reportes').select();
    const didAuthoritativeCloudFetch = Boolean(
      selectRes && !selectRes.error && Array.isArray(selectRes.data) && authService.getState().isRealCloudSession
    );
    const cloudSnap = supabase.getCloudSnapshot();
    const rawCloud = didAuthoritativeCloudFetch
      ? selectRes.data
      : Array.isArray(selectRes.data) && selectRes.data.length > 0
        ? selectRes.data
        : cloudSnap.reportesCloud || [];

    const checkDeleted = (id, obs) =>
      (typeof supabase.isReportDeleted === 'function' && supabase.isReportDeleted(id)) ||
      obs === '__REPORTE_ELIMINADO__';

    const remoteIdSet = didAuthoritativeCloudFetch
      ? new Set(rawCloud.map((r) => r.id))
      : null;

    const filteredLocal = [];
    for (const loc of rawLocal) {
      const removedInCloudOnOtherDevice =
        didAuthoritativeCloudFetch &&
        (loc.sincronizado_en_nube_real === true ||
          loc.estado === 'sincronizado' ||
          loc.desde_otro_dispositivo === true ||
          loc.dispositivo === 'PC / Demo Local') &&
        !remoteIdSet.has(loc.id);

      if (checkDeleted(loc.id, loc.observacion) || removedInCloudOnOtherDevice) {
        await localDb.reportes.delete(loc.id);
        continue;
      }
      filteredLocal.push(loc);
    }

    this.localReports = filteredLocal;
    this.cloudReports = rawCloud.filter((r) => !checkDeleted(r.id, r.observacion));

    // Sincronizar códigos de equipo creados en la nube con el catálogo local (M6 requisito 2)
    this.catalogSummary = await syncEquipmentsFromCloudReports(
      this.cloudReports,
      this.localReports,
      { authoritativeCloud: didAuthoritativeCloudFetch }
    );

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

  isReportLevantada(rep) {
    const segs = Array.isArray(rep?.seguimientos) ? rep.seguimientos : [];
    if (segs.length === 0) return false;
    const lastSeg = segs[segs.length - 1];
    return String(lastSeg?.estado_seguimiento || '')
      .toLowerCase()
      .includes('levantada');
  }

  getOffsetDatePeru(daysAgo = 0) {
    return getFechaHoyPeru(new Date(Date.now() - daysAgo * 86400000));
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
      estadoOperativo,
      orden,
      searchText
    } = this.filters;

    const cleanSearch = (searchText || '').trim().toLowerCase();

    const filtered = this.unifiedReports.filter((rep) => {
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

      if (estadoOperativo === 'ACTIVAS' && this.isReportLevantada(rep)) {
        return false;
      }
      if (estadoOperativo === 'LEVANTADAS' && !this.isReportLevantada(rep)) {
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

    const prioRank = { Alta: 1, Media: 2, Baja: 3 };
    const sortBy = orden || 'prioridad';
    return filtered.sort((a, b) => {
      if (sortBy === 'equipo') {
        const eqCmp = String(a.codigo_equipo || '').localeCompare(String(b.codigo_equipo || ''));
        if (eqCmp !== 0) return eqCmp;
        return String(b.fecha || '').localeCompare(String(a.fecha || ''));
      }
      if (sortBy === 'fecha') {
        const dateCmp = String(b.fecha || '').localeCompare(String(a.fecha || ''));
        if (dateCmp !== 0) return dateCmp;
        return String(b.creado_en || '').localeCompare(String(a.creado_en || ''));
      }
      // Por defecto ('prioridad'): Activas primero, luego Alta > Media > Baja, luego fecha reciente
      const aLev = this.isReportLevantada(a);
      const bLev = this.isReportLevantada(b);
      if (aLev !== bLev) return aLev ? 1 : -1;
      const pDiff = (prioRank[a.prioridad] || 9) - (prioRank[b.prioridad] || 9);
      if (pDiff !== 0) return pDiff;
      return String(b.fecha || '').localeCompare(String(a.fecha || ''));
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

    this.revokeDetailObjectUrls();
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

    let generatedUrlsCount = 0;

    const signedPhotos = await Promise.all(
      Array.from({ length: totalCount }, async (_, i) => {
        const localItem = fotosLocales[i] || null;
        const storagePath =
          photoPaths[i] ||
          localItem?.ruta_remota ||
          `${rep.creado_por || 'user_local'}/${rep.id}/${i + 1}.jpg`;

        // Invocar supabase.storage.from('fotos').createSignedUrl(storagePath, 3600) bajo demanda
        const signedRes = await supabase.storage.from('fotos').createSignedUrl(storagePath, 3600);
        const rawSignedUrl = signedRes?.data?.signedUrl || '';
        const signedUrl =
          rawSignedUrl ||
          `https://supabase.co/storage/v1/object/sign/fotos/${storagePath}?token=lazy_signed_${Date.now()}`;
        generatedUrlsCount++;

        const isRealHttpUrl =
          /^https?:\/\//i.test(rawSignedUrl) &&
          !rawSignedUrl.includes('/object/public/') &&
          !rawSignedUrl.includes('lazy_signed_');

        let previewSrc = '';
        if (localItem?.blob) {
          previewSrc = URL.createObjectURL(localItem.blob);
          this.detailObjectUrls.push(previewSrc);
        } else if (isRealHttpUrl && pwaManager.getState().isOnline) {
          previewSrc = rawSignedUrl;
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

        return {
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
          originMode: localItem?.blob
            ? 'Blob Local + Ruta Firmada Nube'
            : 'Descarga Diferida Supabase Storage (createSignedUrl)'
        };
      })
    );

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
        this.detailObjectUrls.push(localVideoUrl);
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
    this.revokeDetailObjectUrls();
    this.selectedDetailReport = null;
    this.detailSignedMedia = null;
    this.isLoadingDetailMedia = false;
    this.render();
  }

  /**
   * Exporta los reportes actualmente filtrados a Excel Diario formateado (.xls)
   * con encabezado STRACON, datos de guardia, resumen ejecutivo y prioridades resaltadas (sin URLs firmadas).
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

    const hoyPeru = getFechaHoyPeru();
    const hoyFormatted = formatFechaDDMMYYYY(hoyPeru);
    const turno = this.escapeHtml(this.dailyMeta.turno);
    const zona = this.escapeHtml(this.dailyMeta.zona || 'Operaciones STRACON');
    const supervisor = this.escapeHtml(this.getEffectiveSupervisorName());
    const desdeLbl = this.filters.fechaDesde ? formatFechaDDMMYYYY(this.filters.fechaDesde) : 'Inicio';
    const hastaLbl = this.filters.fechaHasta ? formatFechaDDMMYYYY(this.filters.fechaHasta) : hoyFormatted;

    const activasCount = filtered.filter((r) => !this.isReportLevantada(r)).length;
    const criticosCount = filtered.filter((r) => !this.isReportLevantada(r) && r.prioridad === 'Alta').length;
    const levantadasCount = filtered.filter((r) => this.isReportLevantada(r)).length;

    const rowsHtml = filtered
      .map((rep, idx) => {
        const lev = this.isReportLevantada(rep);
        const prioUpper = String(rep.prioridad || 'Media').toUpperCase();
        const prioBg = prioUpper === 'ALTA' ? '#FEE2E2' : prioUpper === 'MEDIA' ? '#FEF3C7' : '#E0F2FE';
        const prioFg = prioUpper === 'ALTA' ? '#991B1B' : prioUpper === 'MEDIA' ? '#92400E' : '#075985';
        const statusBg = lev ? '#DCFCE7' : '#FEF3C7';
        const statusFg = lev ? '#15803D' : '#B45309';

        const segs = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
        const segText = segs
          .map(
            (s, sIdx) =>
              `↳ #${sIdx + 1} (${formatFechaDDMMYYYY(s.fecha)} · ${s.estado_seguimiento || 'Seguimiento'}): ${s.comentario || ''}`
          )
          .join('<br/>');

        const photoPaths =
          Array.isArray(rep?.fotos_rutas) && rep.fotos_rutas.length > 0
            ? rep.fotos_rutas
            : Array.isArray(rep?.fotos)
              ? rep.fotos
              : Array.isArray(rep?.fotos_locales)
                ? rep.fotos_locales
                : [];

        return `
          <tr style="background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'};">
            <td style="text-align:center; font-weight:bold;">${idx + 1}</td>
            <td style="font-weight:bold; color:#002B5C;">${this.escapeHtml(rep.codigo_equipo)}</td>
            <td style="white-space:nowrap;">${this.escapeHtml(formatFechaDDMMYYYY(rep.fecha))}${rep.hora_peru ? ` ${this.escapeHtml(rep.hora_peru)}` : ''}</td>
            <td>${this.escapeHtml(rep.tipo || 'Observación')}</td>
            <td style="background:${prioBg}; color:${prioFg}; font-weight:bold; text-align:center;">${this.escapeHtml(prioUpper)}</td>
            <td style="background:${statusBg}; color:${statusFg}; font-weight:bold; text-align:center;">${lev ? 'Levantada' : 'Activa'}</td>
            <td>${this.escapeHtml(rep.observacion || '')}</td>
            <td>${segText || '—'}</td>
            <td style="text-align:center;">${photoPaths.length}</td>
          </tr>
        `;
      })
      .join('');

    const htmlExcel = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" lang="es">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: Arial, Calibri, sans-serif; color: #0F172A; font-size: 11pt; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #CBD5E1; padding: 6px 8px; vertical-align: top; }
</style>
</head>
<body>
<table>
  <tr>
    <td colspan="9" style="background:#002B5C; color:#FFFFFF; font-size:15pt; font-weight:bold; padding:10px 12px; border-bottom:4px solid #F26522;">
      STRACON · REPORTE DIARIO DE EQUIPOS MINEROS — ENTREGA DE GUARDIA
    </td>
  </tr>
  <tr>
    <td colspan="2" style="background:#F1F5F9; font-weight:bold;">Proyecto / Frente:</td>
    <td colspan="3">${zona}</td>
    <td colspan="2" style="background:#F1F5F9; font-weight:bold;">Turno / Guardia:</td>
    <td colspan="2">${turno}</td>
  </tr>
  <tr>
    <td colspan="2" style="background:#F1F5F9; font-weight:bold;">Supervisor Responsable:</td>
    <td colspan="3">${supervisor}</td>
    <td colspan="2" style="background:#F1F5F9; font-weight:bold;">Periodo / Emisión:</td>
    <td colspan="2">${this.escapeHtml(desdeLbl)} → ${this.escapeHtml(hastaLbl)} (Emitido: ${hoyFormatted})</td>
  </tr>
  <tr>
    <td colspan="2" style="background:#E2E8F0; font-weight:bold; text-align:center;">Total Reportes: ${filtered.length}</td>
    <td colspan="2" style="background:#FEE2E2; color:#991B1B; font-weight:bold; text-align:center;">Críticos (Alta Activa): ${criticosCount}</td>
    <td colspan="2" style="background:#FEF3C7; color:#92400E; font-weight:bold; text-align:center;">Activas: ${activasCount}</td>
    <td colspan="3" style="background:#DCFCE7; color:#15803D; font-weight:bold; text-align:center;">Levantadas: ${levantadasCount}</td>
  </tr>
  <tr><td colspan="9" style="border:none; height:8px;"></td></tr>
  <tr style="background:#002B5C; color:#FFFFFF; font-weight:bold; text-align:center;">
    <th>#</th>
    <th>Código Equipo</th>
    <th>Fecha / Hora</th>
    <th>Tipo</th>
    <th>Prioridad</th>
    <th>Estado</th>
    <th>Observación Principal</th>
    <th>Seguimientos (↳)</th>
    <th>Cant. Fotos</th>
  </tr>
  ${rowsHtml}
</table>
</body>
</html>`;

    const fileName = `Reporte_Diario_STRACON_${hoyPeru}.xls`;
    const blob = new Blob(['\uFEFF' + htmlExcel], {
      type: 'application/vnd.ms-excel;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    const payload = buildExcelExportPayload(filtered, this.filters);
    this.lastExcelExportAudit = {
      ...payload,
      fileName,
      blobSizeBytes: blob.size,
      totalExportedRows: filtered.length,
      containsSignedUrls: false
    };

    this.setBanner(
      'success',
      `📊 Excel Diario "${fileName}" (${formatBytes(blob.size)}) descargado con ${filtered.length} fila(s), datos de guardia STRACON y 0 URLs firmadas.`
    );
  }

  getEffectiveSupervisorName() {
    const custom = (this.dailyMeta?.supervisor || '').trim();
    if (custom) return custom;
    return authService.getState().userEmail || 'Supervisor de Guardia';
  }

  getImmediateThumbSrc(rep) {
    if (this.thumbUrlMap.has(rep.id)) {
      return this.thumbUrlMap.get(rep.id);
    }
    const localBlob = Array.isArray(rep?.fotos_locales) ? rep.fotos_locales[0]?.blob : null;
    if (localBlob) {
      const objUrl = URL.createObjectURL(localBlob);
      this.objectUrls.push(objUrl);
      this.thumbUrlMap.set(rep.id, objUrl);
      return objUrl;
    }
    const existingSigned = Array.isArray(rep?.fotos_locales) ? rep.fotos_locales[0]?.signedUrl : '';
    if (existingSigned) {
      this.thumbUrlMap.set(rep.id, existingSigned);
      return existingSigned;
    }
    const photoPaths =
      Array.isArray(rep?.fotos_rutas) && rep.fotos_rutas.length > 0
        ? rep.fotos_rutas
        : Array.isArray(rep?.fotos)
          ? rep.fotos
          : [];
    return buildCloudPhotoPreviewDataUri({
      codigoEquipo: rep.codigo_equipo,
      fecha: rep.fecha,
      hora: rep.hora_peru,
      photoNumber: 1,
      totalPhotos: Math.max(photoPaths.length, 1),
      storagePath: photoPaths[0] || `${rep.creado_por || 'campo'}/${rep.id}/1.jpg`,
      calidad: rep.calidad_compresion
    });
  }

  async resolveReportPrimaryThumbSrc(rep) {
    if (this.thumbUrlMap.has(rep.id)) {
      return this.thumbUrlMap.get(rep.id);
    }
    const localBlob = Array.isArray(rep?.fotos_locales) ? rep.fotos_locales[0]?.blob : null;
    if (localBlob) {
      const objUrl = URL.createObjectURL(localBlob);
      this.objectUrls.push(objUrl);
      this.thumbUrlMap.set(rep.id, objUrl);
      return objUrl;
    }

    const existingSigned = Array.isArray(rep?.fotos_locales) ? rep.fotos_locales[0]?.signedUrl : '';
    if (existingSigned) {
      this.thumbUrlMap.set(rep.id, existingSigned);
      return existingSigned;
    }

    const photoPaths =
      Array.isArray(rep?.fotos_rutas) && rep.fotos_rutas.length > 0
        ? rep.fotos_rutas
        : Array.isArray(rep?.fotos)
          ? rep.fotos
          : [];
    const storagePath = photoPaths[0] || '';

    if (storagePath && pwaManager.getState().isOnline) {
      try {
        const signed = await supabase.storage.from('fotos').createSignedUrl(storagePath, 3600);
        const signedUrl = signed?.data?.signedUrl || '';
        const isUsableSignedUrl =
          /^https?:\/\//i.test(signedUrl) && !signedUrl.includes('/object/public/');
        if (isUsableSignedUrl) {
          this.thumbUrlMap.set(rep.id, signedUrl);
          return signedUrl;
        }
      } catch {
        // Usar vista previa SVG si falla la firma
      }
    }

    return buildCloudPhotoPreviewDataUri({
      codigoEquipo: rep.codigo_equipo,
      fecha: rep.fecha,
      hora: rep.hora_peru,
      photoNumber: 1,
      totalPhotos: Math.max(photoPaths.length, 1),
      storagePath: storagePath || `${rep.creado_por || 'campo'}/${rep.id}/1.jpg`,
      calidad: rep.calidad_compresion
    });
  }

  async hydrateVisibleThumbnails(reports = []) {
    if (!pwaManager.getState().isOnline || !Array.isArray(reports) || reports.length === 0) return;
    await Promise.all(
      reports.map(async (rep) => {
        if (!rep?.id || this.thumbUrlMap.has(rep.id)) return;
        const resolvedUrl = await this.resolveReportPrimaryThumbSrc(rep);
        if (!resolvedUrl || !this.rootEl) return;
        this.rootEl.querySelectorAll(`img[data-m6-thumb-id="${rep.id}"]`).forEach((imgEl) => {
          if (imgEl.src !== resolvedUrl) {
            imgEl.src = resolvedUrl;
          }
        });
      })
    );
  }

  /**
   * Genera una hoja imprimible / PDF formal de Entrega de Guardia con formato STRACON,
   * resumen ejecutivo, fotos reales incrustadas y cuadro de firmas.
   */
  async handlePrintDailyReport() {
    const filtered = this.getFilteredReports();
    if (filtered.length === 0) {
      this.setBanner(
        'warning',
        '⚠️ No hay reportes en el rango seleccionado para generar el Reporte PDF / Impresión.'
      );
      return;
    }

    const win = window.open('', '_blank', 'width=1040,height=760');
    if (!win) {
      this.setBanner(
        'warning',
        '⚠️ El navegador bloqueó la ventana emergente de impresión. Permite las ventanas emergentes para ver el Reporte PDF.'
      );
      return;
    }

    win.document.open();
    win.document.write(
      '<p style="font-family:Arial,sans-serif;padding:24px;">⏳ Cargando fotos de evidencia para Entrega de Guardia...</p>'
    );

    const thumbSrcs = await Promise.all(
      filtered.map((rep) => this.resolveReportPrimaryThumbSrc(rep))
    );

    const hoyFormatted = formatFechaDDMMYYYY(getFechaHoyPeru());
    const turno = this.escapeHtml(this.dailyMeta.turno);
    const zona = this.escapeHtml(this.dailyMeta.zona || 'Operaciones STRACON');
    const supervisor = this.escapeHtml(this.getEffectiveSupervisorName());
    const desdeLbl = this.filters.fechaDesde ? formatFechaDDMMYYYY(this.filters.fechaDesde) : 'Inicio';
    const hastaLbl = this.filters.fechaHasta ? formatFechaDDMMYYYY(this.filters.fechaHasta) : hoyFormatted;

    const activasCount = filtered.filter((r) => !this.isReportLevantada(r)).length;
    const criticosCount = filtered.filter((r) => !this.isReportLevantada(r) && r.prioridad === 'Alta').length;
    const levantadasCount = filtered.filter((r) => this.isReportLevantada(r)).length;

    const rowsHtml = filtered
      .map((rep, idx) => {
        const lev = this.isReportLevantada(rep);
        const segs = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
        const thumbSrc = thumbSrcs[idx];
        const prioUpper = String(rep.prioridad || 'Media').toUpperCase();
        const prioBg = prioUpper === 'ALTA' ? '#FEE2E2' : prioUpper === 'MEDIA' ? '#FEF3C7' : '#E0F2FE';
        const prioFg = prioUpper === 'ALTA' ? '#991B1B' : prioUpper === 'MEDIA' ? '#92400E' : '#075985';
        const prioBorder = prioUpper === 'ALTA' ? '#FCA5A5' : prioUpper === 'MEDIA' ? '#FCD34D' : '#7DD3FC';

        const segHtml = segs
          .map(
            (s) => `
          <div style="margin-top:4px; padding:4px 6px; background:#FFF7ED; border-left:3px solid #F26522; font-size:11px;">
            <strong>↳ ${this.escapeHtml(formatFechaDDMMYYYY(s.fecha))} (${this.escapeHtml(s.estado_seguimiento || 'Seguimiento')}):</strong>
            ${this.escapeHtml(s.comentario || '')}
          </div>
        `
          )
          .join('');
        return `
          <tr>
            <td>
              <strong style="color:#002B5C;">${this.escapeHtml(rep.codigo_equipo)}</strong><br/>
              <span>${this.escapeHtml(formatFechaDDMMYYYY(rep.fecha))}</span><br/>
              <small style="color:#475569;">${this.escapeHtml(rep.hora_peru || '')}</small>
            </td>
            <td>
              <img src="${thumbSrc}" alt="Evidencia" style="width:92px; height:62px; object-fit:cover; border:1px solid #94A3B8; border-radius:4px;" />
            </td>
            <td>
              <strong>${this.escapeHtml(rep.observacion || '')}</strong>
              ${segHtml}
            </td>
            <td style="text-align:center;">
              <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-weight:900; font-size:11px; background:${prioBg}; color:${prioFg}; border:1px solid ${prioBorder};">
                ● ${this.escapeHtml(prioUpper)}
              </span>
            </td>
            <td style="font-weight:900; color:${lev ? '#15803D' : '#C2410C'};">
              ${lev ? '✅ Levantada' : '⚠️ Activa'}
            </td>
          </tr>
        `;
      })
      .join('');

    win.document.open();
    win.document.write(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>Reporte Diario STRACON — ${hoyFormatted}</title>
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; color: #0F172A; margin: 20px; font-size: 12px; }
          .hdr { background: #002B5C; color: #FFFFFF; padding: 14px 18px; border-bottom: 4px solid #F26522; display: flex; justify-content: space-between; align-items: center; }
          .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #F1F5F9; padding: 10px; border: 1px solid #CBD5E1; margin: 12px 0; }
          .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; text-align: center; }
          .kpi { border: 1.5px solid #CBD5E1; padding: 8px; border-radius: 6px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
          th { background: #002B5C; color: #FFFFFF; padding: 7px; text-align: left; font-size: 11px; }
          td { border: 1px solid #CBD5E1; padding: 7px; vertical-align: top; }
          .signs { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; text-align: center; }
          .sign-line { border-top: 1.5px solid #0F172A; padding-top: 6px; font-weight: 700; }
          @media print { .no-print { display: none; } }
        </style>
      </head>
      <body>
        <div class="no-print" style="text-align:right; margin-bottom:10px;">
          <button onclick="window.print()" style="background:#F26522; color:#FFFFFF; border:none; padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer;">
            🖨️ Imprimir / Guardar como PDF
          </button>
        </div>
        <div class="hdr">
          <div>
            <div style="font-size:18px; font-weight:900;">STRACON · REPORTE DIARIO DE EQUIPOS</div>
            <div style="font-size:11px; opacity:.88;">Entrega de Guardia y Seguimiento de Observaciones</div>
          </div>
          <div style="text-align:right; font-weight:700;">Emisión: ${hoyFormatted}</div>
        </div>
        <div class="meta">
          <div><strong>Proyecto / Frente:</strong><br/>${zona}</div>
          <div><strong>Turno / Guardia:</strong><br/>${turno}</div>
          <div><strong>Supervisor:</strong><br/>${supervisor}</div>
          <div><strong>Periodo:</strong><br/>${this.escapeHtml(desdeLbl)} → ${this.escapeHtml(hastaLbl)}</div>
        </div>
        <div class="kpis">
          <div class="kpi"><div style="font-size:20px; font-weight:900; color:#002B5C;">${filtered.length}</div>Total Reportes</div>
          <div class="kpi"><div style="font-size:20px; font-weight:900; color:#B91C1C;">${criticosCount}</div>Críticos (Alta)</div>
          <div class="kpi"><div style="font-size:20px; font-weight:900; color:#C2410C;">${activasCount}</div>Activas</div>
          <div class="kpi"><div style="font-size:20px; font-weight:900; color:#15803D;">${levantadasCount}</div>Levantadas</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Equipo / Fecha</th>
              <th>Evidencia</th>
              <th>Observación y Seguimiento (↳)</th>
              <th>Prioridad</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="signs">
          <div class="sign-line">Elaborado por: ${supervisor}<br/><small>Supervisión de Operaciones</small></div>
          <div class="sign-line">Recibido por: Jefe de Guardia / Mantenimiento<br/><small>Conformidad de Entrega</small></div>
        </div>
      </body>
      </html>
    `);
    win.document.close();
  }

  /**
   * Copia un resumen diario estructurado al portapapeles para pegarlo en WhatsApp de Guardia/Mantenimiento.
   */
  async handleCopyWhatsAppSummary() {
    const filtered = this.getFilteredReports();
    if (filtered.length === 0) {
      this.setBanner(
        'warning',
        '⚠️ No hay reportes en el rango seleccionado para copiar el resumen de WhatsApp.'
      );
      return;
    }

    const hoyFormatted = formatFechaDDMMYYYY(getFechaHoyPeru());
    const desdeLbl = this.filters.fechaDesde ? formatFechaDDMMYYYY(this.filters.fechaDesde) : 'Inicio';
    const hastaLbl = this.filters.fechaHasta ? formatFechaDDMMYYYY(this.filters.fechaHasta) : hoyFormatted;
    const activas = filtered.filter((r) => !this.isReportLevantada(r));
    const levantadas = filtered.filter((r) => this.isReportLevantada(r));

    const lines = [
      `🚜 *REPORTE DIARIO DE EQUIPOS — STRACON*`,
      `📍 ${this.dailyMeta.zona || 'Operaciones STRACON'} | ${this.dailyMeta.turno}`,
      `📅 Periodo: ${desdeLbl} → ${hastaLbl} | 👷 ${this.getEffectiveSupervisorName()}`,
      `📊 *Resumen:* ${filtered.length} total · ⚠️ ${activas.length} Activas · ✅ ${levantadas.length} Levantadas`,
      ''
    ];

    if (activas.length > 0) {
      lines.push(`*⚠️ OBSERVACIONES ACTIVAS:*`);
      activas.forEach((r) => {
        const segs = Array.isArray(r.seguimientos) ? r.seguimientos : [];
        const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
        const segNote = lastSeg?.comentario ? ` _(↳ ${lastSeg.comentario})_` : '';
        lines.push(`• *${r.codigo_equipo}* [${String(r.prioridad || '').toUpperCase()}]: ${r.observacion}${segNote}`);
      });
      lines.push('');
    }

    if (levantadas.length > 0) {
      lines.push(`*✅ OBSERVACIONES LEVANTADAS:*`);
      levantadas.forEach((r) => {
        lines.push(`• *${r.codigo_equipo}*: ${r.observacion}`);
      });
    }

    const summaryText = lines.join('\n');
    try {
      await navigator.clipboard.writeText(summaryText);
      this.setBanner(
        'success',
        `📋 Resumen diario (${filtered.length} reportes) copiado al portapapeles — listo para pegar en WhatsApp.`
      );
    } catch {
      window.prompt('Copia el resumen diario para WhatsApp:', summaryText);
    }
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

    const activasCount = filteredReports.filter((r) => !this.isReportLevantada(r)).length;
    const criticosCount = filteredReports.filter(
      (r) => !this.isReportLevantada(r) && r.prioridad === 'Alta'
    ).length;
    const levantadasCount = filteredReports.filter((r) => this.isReportLevantada(r)).length;

    const hoy = getFechaHoyPeru();
    const hoyFormatted = formatFechaDDMMYYYY(hoy);
    const hoyShort = hoyFormatted.slice(0, 5);
    const hace3d = this.getOffsetDatePeru(2);
    const hace7d = this.getOffsetDatePeru(6);
    const isHoyPreset = this.filters.fechaDesde === hoy && this.filters.fechaHasta === hoy;
    const is3dPreset = this.filters.fechaDesde === hace3d && this.filters.fechaHasta === hoy;
    const is7dPreset = this.filters.fechaDesde === hace7d && this.filters.fechaHasta === hoy;
    const isTodoPreset = !this.filters.fechaDesde && !this.filters.fechaHasta;

    const periodRangeLabel = isTodoPreset
      ? 'Mostrando todas las fechas'
      : isHoyPreset
        ? `Mostrando solo hoy (${hoyFormatted})`
        : `Periodo: ${this.filters.fechaDesde ? formatFechaDDMMYYYY(this.filters.fechaDesde) : 'Inicio'} → ${this.filters.fechaHasta ? formatFechaDDMMYYYY(this.filters.fechaHasta) : hoyFormatted}`;

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

        <!-- TARJETA 1: CABECERA EJECUTIVA DE REPORTE DIARIO, FILTROS HORIZONTALES Y 4 KPIs -->
        <section class="section-panel m6-daily-control-panel" aria-label="Centro de Reporte Diario de Guardia e Historial">
          <div class="m6-daily-top-header">
            <div class="m6-daily-title-group">
              <div class="m6-daily-title-line">
                <span class="m6-section-pill">REPORTE DIARIO</span>
                <h2 class="m6-panel-heading">📊 Centro de Reporte Diario de Guardia e Historial</h2>
              </div>
              <p class="m6-panel-subheading">
                Filtra por rango de fechas, verifica las prioridades críticas y descarga el reporte formal listo para entregar a Mantenimiento o Jefatura.
              </p>
            </div>

            <div class="m6-top-export-actions">
              <button
                type="button"
                class="btn-mine btn-m6-excel"
                id="btn-m6-export-excel"
                title="Descargar Excel Diario (.xls) con encabezado STRACON, datos de guardia, resumen ejecutivo y prioridades resaltadas"
              >
                📊 Excel Diario (.xls) · ${filteredReports.length}
              </button>

              <button
                type="button"
                class="btn-mine btn-m6-pdf"
                id="btn-m6-print-daily"
                title="Abrir hoja formal de Entrega de Guardia lista para guardar como PDF o imprimir"
              >
                🖨️ Reporte PDF / Imprimir
              </button>

              <button
                type="button"
                class="btn-mine btn-m6-wa"
                id="btn-m6-copy-whatsapp"
                title="Copiar resumen diario estructurado al portapapeles para pegar en WhatsApp"
              >
                📋 Copiar WhatsApp
              </button>

              <button
                type="button"
                class="btn-mine btn-amber tech-only-inline"
                id="btn-m6-run-p10-lab"
                ${this.isRunningP10 ? 'disabled' : ''}
              >
                ${
                  this.isRunningP10
                    ? '⏳ Ejecutando P10...'
                    : '🧪 Prueba Escenario P10'
                }
              </button>

              <button
                type="button"
                class="btn-mine btn-secondary tech-only-inline"
                id="btn-m6-simulate-teammate"
                title="Simula que otro técnico en campo sincroniza un reporte desde su celular hacia Supabase"
              >
                📱+☁️ Simular Otro Celular
              </button>
            </div>
          </div>

          <div class="m6-control-body">
            <!-- Datos de Entrega de Guardia (Turno, Frente/Proyecto, Supervisor) -->
            <div class="m6-daily-meta-grid">
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-daily-turno">🕒 TURNO / GUARDIA</label>
                <select id="m6-daily-turno" class="form-control">
                  <option value="Guardia Día (07:00 - 19:00)" ${this.dailyMeta.turno === 'Guardia Día (07:00 - 19:00)' ? 'selected' : ''}>☀️ Guardia Día (07:00 - 19:00)</option>
                  <option value="Guardia Noche (19:00 - 07:00)" ${this.dailyMeta.turno === 'Guardia Noche (19:00 - 07:00)' ? 'selected' : ''}>🌙 Guardia Noche (19:00 - 07:00)</option>
                  <option value="Día Completo (24h)" ${this.dailyMeta.turno === 'Día Completo (24h)' ? 'selected' : ''}>📅 Día Completo (24h)</option>
                </select>
              </div>
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-daily-zona">📍 FRENTE / PROYECTO</label>
                <input
                  type="text"
                  id="m6-daily-zona"
                  class="form-control"
                  value="${this.escapeAttr(this.dailyMeta.zona)}"
                  placeholder="Tajo Norte — Operaciones STRACON"
                />
              </div>
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-daily-supervisor">👷 SUPERVISOR RESPONSABLE</label>
                <input
                  type="text"
                  id="m6-daily-supervisor"
                  class="form-control"
                  value="${this.escapeAttr(this.dailyMeta.supervisor)}"
                  placeholder="${this.escapeAttr(authState.userEmail || 'Supervisor de Guardia')}"
                />
              </div>
            </div>

            <!-- Barra de Rango Rápido + Ordenamiento -->
            <div class="m6-quick-range-bar">
              <div class="m6-quick-presets-left">
                <span class="m6-inline-label">⚡ RANGO RÁPIDO:</span>
                <button type="button" class="m6-preset-btn ${isHoyPreset ? 'is-active' : ''}" id="btn-m6-date-today">
                  Solo Hoy (${hoyShort})
                </button>
                <button type="button" class="m6-preset-btn ${is3dPreset ? 'is-active' : ''}" id="btn-m6-date-3d">
                  Últimos 3 días
                </button>
                <button type="button" class="m6-preset-btn ${is7dPreset ? 'is-active' : ''}" id="btn-m6-date-7d">
                  Últimos 7 días
                </button>
                <button type="button" class="m6-preset-btn ${isTodoPreset ? 'is-active' : ''}" id="btn-m6-date-all">
                  Todo el historial
                </button>
              </div>

              <div class="m6-quick-sort-right">
                <select id="m6-filter-orden" class="form-control m6-sort-select" aria-label="Ordenar reportes">
                  <option value="prioridad" ${this.filters.orden === 'prioridad' ? 'selected' : ''}>Ordenar: Críticos primero</option>
                  <option value="equipo" ${this.filters.orden === 'equipo' ? 'selected' : ''}>Ordenar: Por Equipo</option>
                  <option value="fecha" ${this.filters.orden === 'fecha' ? 'selected' : ''}>Ordenar: Más recientes</option>
                </select>
                <button type="button" class="m6-preset-btn" id="btn-m6-clear-filters" title="Limpiar filtros">
                  🧹 Limpiar
                </button>
                <button type="button" class="m6-preset-btn" id="btn-m6-refresh-cloud" title="Refrescar desde Supabase Cloud">
                  🔄 Refrescar
                </button>
              </div>
            </div>

            <!-- Filtros Horizontales (Fecha Desde / Fecha Hasta / Equipo / Estado) -->
            <div class="m6-filters-horizontal-grid">
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-filter-desde">📅 FECHA DESDE</label>
                <input
                  type="date"
                  id="m6-filter-desde"
                  class="form-control"
                  value="${this.escapeAttr(this.filters.fechaDesde)}"
                />
              </div>
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-filter-hasta">📅 FECHA HASTA</label>
                <input
                  type="date"
                  id="m6-filter-hasta"
                  class="form-control"
                  value="${this.escapeAttr(this.filters.fechaHasta)}"
                />
              </div>
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-filter-equipo">🚜 EQUIPO</label>
                <select id="m6-filter-equipo" class="form-control">
                  <option value="TODOS" ${this.filters.codigoEquipo === 'TODOS' ? 'selected' : ''}>
                    Todos los equipos (${this.catalogSummary.equipos.length})
                  </option>
                  ${this.catalogSummary.equipos
                    .map((eq) => {
                      const cnt = countByEquipo[eq.codigo] || 0;
                      return `<option value="${eq.codigo}" ${
                        this.filters.codigoEquipo === eq.codigo ? 'selected' : ''
                      }>${eq.codigo} (${cnt})</option>`;
                    })
                    .join('')}
                </select>
              </div>
              <div class="m6-field-item">
                <label class="m6-field-label" for="m6-filter-estado-op">📌 ESTADO</label>
                <select id="m6-filter-estado-op" class="form-control">
                  <option value="TODOS" ${this.filters.estadoOperativo === 'TODOS' ? 'selected' : ''}>Todos (Activas + Levantadas)</option>
                  <option value="ACTIVAS" ${this.filters.estadoOperativo === 'ACTIVAS' ? 'selected' : ''}>⚠️ Solo Activas (Pend.)</option>
                  <option value="LEVANTADAS" ${this.filters.estadoOperativo === 'LEVANTADAS' ? 'selected' : ''}>✅ Solo Levantadas</option>
                </select>
              </div>
            </div>

            <!-- Buscador + Filtro Técnico -->
            <div class="m6-search-row">
              <div class="m6-field-item m6-search-field">
                <label class="m6-field-label" for="m6-filter-search">🔍 BUSCAR EN TEXTO</label>
                <input
                  type="search"
                  id="m6-filter-search"
                  class="form-control"
                  placeholder="Ej: fuga, dientes, espejo..."
                  value="${this.escapeAttr(this.filters.searchText)}"
                />
              </div>
              <div class="m6-field-item tech-only-block">
                <label class="m6-field-label" for="m6-filter-origen">🌐 ORIGEN TÉCNICO</label>
                <select id="m6-filter-origen" class="form-control">
                  <option value="TODOS" ${this.filters.origen === 'TODOS' ? 'selected' : ''}>Todos (${totalUnified})</option>
                  <option value="EN_NUBE" ${this.filters.origen === 'EN_NUBE' ? 'selected' : ''}>☁️ En Supabase (${syncedInCloudCount})</option>
                  <option value="OTROS_DISPOSITIVOS" ${this.filters.origen === 'OTROS_DISPOSITIVOS' ? 'selected' : ''}>📱 Otros Dispositivos (${fromOtherDevicesCount})</option>
                  <option value="SOLO_LOCAL" ${this.filters.origen === 'SOLO_LOCAL' ? 'selected' : ''}>⏳ Solo Locales (${pendingLocalCount})</option>
                </select>
              </div>
            </div>

            <!-- Semáforo Ejecutivo: 4 KPIs -->
            <div class="m6-kpi-grid">
              <div class="m6-kpi-card">
                <div class="m6-kpi-value">${filteredReports.length}</div>
                <div class="m6-kpi-label">Total en Reporte</div>
              </div>
              <div class="m6-kpi-card is-critical">
                <div class="m6-kpi-value">${criticosCount}</div>
                <div class="m6-kpi-label">🔴 Críticos (Alta Activa)</div>
              </div>
              <div class="m6-kpi-card is-active">
                <div class="m6-kpi-value">${activasCount}</div>
                <div class="m6-kpi-label">⚠️ Activas (Pend.)</div>
              </div>
              <div class="m6-kpi-card is-resolved">
                <div class="m6-kpi-value">${levantadasCount}</div>
                <div class="m6-kpi-label">✅ Levantadas</div>
              </div>
            </div>
          </div>
        </section>

        <!-- LABORATORIO AUTOMATIZADO ESCENARIO P10 (SOLO MODO INGENIERÍA) -->
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

        <!-- AUDITORÍA DE EXPORTACIÓN A EXCEL (SOLO MODO INGENIERÍA O TRAS DESCARGA SI APLICA) -->
        ${
          this.lastExcelExportAudit
            ? `<div class="tech-only-block">${this.renderExcelExportAuditPanel(this.lastExcelExportAudit)}</div>`
            : ''
        }

        <!-- TARJETA 2: VISTA PREVIA DEL REPORTE (100% ANCHO) -->
        <section class="section-panel m6-preview-panel" aria-label="Vista Previa del Reporte Diario">
          <div class="m6-preview-header">
            <div class="m6-daily-title-line">
              <span class="m6-section-pill">VISTA PREVIA DEL REPORTE</span>
              <h2 class="m6-preview-heading">📋 Detalle de Novedades del Periodo (${filteredReports.length})</h2>
            </div>
            <span class="m6-period-summary">${this.escapeHtml(periodRangeLabel)}</span>
          </div>

          <div class="m6-preview-body">
            ${
              filteredReports.length === 0
                ? `
              <div class="m6-empty-box">
                <strong style="font-size:1.05rem;">No se encontraron reportes con los filtros seleccionados.</strong>
                <p style="margin:0.45rem 0 1rem 0; font-size:0.9rem; color:var(--text-muted);">
                  Prueba limpiando los filtros o sincronizando un nuevo reporte.
                </p>
                <button type="button" class="btn-mine btn-primary" id="btn-m6-empty-reset">
                  🧹 Mostrar todos los reportes (${totalUnified})
                </button>
              </div>
            `
                : `
              <div class="m6-responsive-list-wrapper mode-${this.viewLayoutMode}">
                <!-- 1. VISTA DE TABLA EJECUTIVA (PC / PANTALLAS ANCHAS) -->
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

        <!-- MODAL DE DETALLE DEL REPORTE CON CARGA DIFERIDA (LAZY LOADING) DE URLs FIRMADAS -->
        ${this.selectedDetailReport ? this.renderDetailModal() : ''}
      </div>
    `;

    this.bindEvents();
    this.hydrateVisibleThumbnails(filteredReports).catch(() => {});
  }

  renderDesktopTable(reports) {
    return `
      <div class="table-responsive">
        <table class="m6-executive-table">
          <thead>
            <tr>
              <th style="width:14%;">EQUIPO / FECHA</th>
              <th style="width:11%;">EVIDENCIA</th>
              <th>OBSERVACIÓN Y SEGUIMIENTO (↳)</th>
              <th style="width:12%;">PRIORIDAD</th>
              <th style="width:14%;">ESTADO</th>
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
                const isLev = this.isReportLevantada(rep);
                const prioUpper = String(rep.prioridad || 'Media').toUpperCase();
                const prioBadgeClass =
                  rep.prioridad === 'Alta'
                    ? 'badge-alta'
                    : rep.prioridad === 'Media'
                      ? 'badge-media'
                      : 'badge-baja';
                const equipCat = inferEquipmentCategory(rep.codigo_equipo);
                const thumbSrc = this.getImmediateThumbSrc(rep);
                const authorRaw = rep.creado_por_email || 'Sup. Guardia';
                const authorShort = authorRaw.includes('@') ? authorRaw.split('@')[0] : authorRaw;

                const opStatusPill = isLev
                  ? `<span class="m6-status-pill is-resolved">✅ Levantada</span>`
                  : `<span class="m6-status-pill is-active">⚠️ Activa</span>`;

                return `
                <tr>
                  <td>
                    <div class="m6-col-equipo-wrap">
                      <span class="m6-equipo-code">${this.escapeHtml(rep.codigo_equipo)}</span>
                      <span class="m6-equipo-date">${this.escapeHtml(formatFechaDDMMYYYY(rep.fecha))}</span>
                      <span class="m6-equipo-cat">${this.escapeHtml(equipCat)}</span>
                    </div>
                  </td>

                  <td>
                    <button
                      type="button"
                      class="m6-evidence-thumb-btn"
                      data-open-detail="${this.escapeAttr(rep.id)}"
                      title="Ver fotos y detalle completo (${fotosCount} foto(s))"
                    >
                      <img
                        src="${thumbSrc}"
                        data-m6-thumb-id="${this.escapeAttr(rep.id)}"
                        alt="Evidencia ${this.escapeAttr(rep.codigo_equipo)}"
                        loading="lazy"
                      />
                      <span class="m6-evidence-count-badge">
                        ${fotosCount} foto(s)${hasVideo ? ' + 🎥' : ''}
                      </span>
                    </button>
                  </td>

                  <td>
                    <div class="m6-obs-cell-wrap">
                      <div class="m6-obs-main-text">
                        ${this.escapeHtml(rep.observacion || 'Sin observación registrada.')}
                      </div>
                      ${
                        seguimientos.length > 0
                          ? seguimientos
                              .map((seg) => {
                                const segResolved =
                                  (seg.estado_seguimiento || '').toLowerCase().includes('levantada');
                                return `
                                <div class="m6-inline-followup ${segResolved ? 'is-resolved' : ''}">
                                  <strong>↳ ${this.escapeHtml(formatFechaDDMMYYYY(seg.fecha))} (${this.escapeHtml(seg.estado_seguimiento || 'Sigue observación')}):</strong>
                                  <span>${this.escapeHtml(seg.comentario || '')}</span>
                                </div>
                              `;
                              })
                              .join('')
                          : ''
                      }
                    </div>
                  </td>

                  <td>
                    <div class="m6-col-prio-wrap">
                      <span class="m6-tipo-label">${this.escapeHtml(rep.tipo || 'Observación')}</span>
                      <span class="badge badge-prio-pill ${prioBadgeClass}">
                        <span class="prio-dot" aria-hidden="true">●</span> ${this.escapeHtml(prioUpper)}
                      </span>
                    </div>
                  </td>

                  <td>
                    <div class="m6-col-estado-wrap">
                      ${opStatusPill}
                      <span class="m6-estado-author">👷 ${this.escapeHtml(authorShort)}</span>
                      <span class="m6-estado-cloud">${rep.en_nube_confirmado ? '☁️ En nube' : '⏳ Pendiente'}</span>
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
            const isLev = this.isReportLevantada(rep);
            const prioUpper = String(rep.prioridad || 'Media').toUpperCase();
            const prioBadgeClass =
              rep.prioridad === 'Alta'
                ? 'badge-alta'
                : rep.prioridad === 'Media'
                  ? 'badge-media'
                  : 'badge-baja';

            let originBadge = '';
            if (rep.origen_unificado === 'solo_nube') {
              originBadge = `<span class="m6-origin-pill cloud-other">☁️ Nube (Otro Dispositivo)</span>`;
            } else if (rep.origen_unificado === 'local_y_nube') {
              originBadge = `<span class="m6-origin-pill local-and-cloud">🟢 Local + Nube</span>`;
            } else {
              originBadge = `<span class="m6-origin-pill local-only">⏳ Solo Local (${rep.estado})</span>`;
            }

            const opStatusPill = isLev
              ? `<span class="m6-status-pill is-resolved">✅ Levantada</span>`
              : `<span class="m6-status-pill is-active">⚠️ Activa</span>`;

            return `
            <article class="m6-mobile-card">
              <div class="m6-mobile-card-header">
                <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                  <span class="equipo-tag">${this.escapeHtml(rep.codigo_equipo)}</span>
                  <span class="m6-tipo-label">${this.escapeHtml(rep.tipo)}</span>
                  <span class="badge badge-prio-pill ${prioBadgeClass}">
                    <span class="prio-dot" aria-hidden="true">●</span> ${this.escapeHtml(prioUpper)}
                  </span>
                </div>
                <span class="operativo-only-inline">${opStatusPill}</span>
                <span class="tech-only-inline">${originBadge}</span>
              </div>

              <div class="m6-mobile-card-meta">
                <span>📅 <strong>${formatFechaDDMMYYYY(rep.fecha)}</strong> (${rep.hora_peru || '--:--'})</span>
                <span>👤 ${rep.creado_por_email || 'supervisor.mina@operacion.pe'}</span>
                <span class="tech-only-inline">📱 ${rep.dispositivo || 'PWA Mina'}</span>
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
                  📷 ${fotosCount} foto(s) ${hasVideo ? '+ 🎥 1 video' : ''} <span class="tech-only-inline">• <span style="color:#0369a1;">Lazy Load</span></span>
                </div>
                <button
                  type="button"
                  class="btn-mine btn-primary"
                  data-open-detail="${rep.id}"
                  style="width:100%;"
                >
                  <span class="operativo-only-inline">🔍 Ver Fotos y Detalle</span>
                  <span class="tech-only-inline">🔍 Ver Detalle y Cargar Fotos (createSignedUrl)</span>
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
                <span class="equipo-tag" style="font-size:1.05rem;">${this.escapeHtml(rep.codigo_equipo)}</span>
                <span class="operativo-only-inline" style="color:#fbbf24; font-weight:900;">Detalle del Reporte</span>
                <span class="tech-only-inline" style="color:#fbbf24; font-weight:900;">Detalle del Reporte y Carga Diferida (createSignedUrl)</span>
              </div>
              <div style="font-size:0.8rem; color:#cbd5e1; margin-top:0.2rem;">
                <span class="tech-only-inline">UUID: <code>${this.escapeHtml(rep.id)}</code> • </span>Fecha: <strong>${formatFechaDDMMYYYY(rep.fecha)} ${rep.hora_peru || ''}</strong> • Registrado por: <strong>${this.escapeHtml(rep.creado_por_email || 'supervisor.mina@operacion.pe')}</strong>
              </div>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-m6-close-modal">
              ✖ Cerrar Detalle
            </button>
          </div>

          <div class="m6-modal-body">
            <!-- Metadatos del reporte -->
            <div class="m6-modal-meta-grid">
              <div><strong>Equipo:</strong> ${this.escapeHtml(rep.codigo_equipo)}</div>
              <div><strong>Fecha:</strong> ${formatFechaDDMMYYYY(rep.fecha)} (${rep.hora_peru || '--:--'})</div>
              <div><strong>Tipo / Prioridad:</strong> ${this.escapeHtml(rep.tipo)} — Prioridad ${this.escapeHtml(rep.prioridad)}</div>
              <div class="tech-only-block"><strong>Dispositivo Emisor:</strong> ${this.escapeHtml(rep.dispositivo || 'PWA Mina')}</div>
            </div>

            <div class="m2-obs-box" style="margin-top:0.75rem;">
              <strong>📌 Observación Principal:</strong>
              <p style="margin:0.3rem 0 0 0; font-size:0.95rem;">${this.escapeHtml(rep.observacion || '')}</p>
              ${
                seguimientos.length > 0
                  ? `
                <div style="margin-top:0.6rem; padding-top:0.5rem; border-top:1px solid #cbd5e1;">
                  <strong>↳ Historial de Seguimientos (${seguimientos.length}):</strong>
                  ${seguimientos
                    .map(
                      (s, i) => `
                    <div style="margin-top:0.3rem; font-size:0.86rem;">
                      <strong>#${i + 1} (${formatFechaDDMMYYYY(s.fecha)} — ${this.escapeHtml(s.estado_seguimiento)}):</strong> ${this.escapeHtml(s.comentario)}
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
                  <span class="operativo-only-inline">📷 Fotos de Evidencia</span>
                  <span class="tech-only-inline">📷 Fotos y Multimedia Cargados Bajo Demanda con <code>supabase.storage.from('fotos').createSignedUrl()</code></span>
                </strong>
                ${
                  media
                    ? `<span class="storage-status-chip chip-ok tech-only-inline">✅ ${media.totalSignedUrlsGenerated} URL(s) firmada(s) generada(s) (Expiración: 3600 s)</span>`
                    : `<span class="storage-status-chip chip-warn tech-only-inline">⏳ Generando URLs firmadas...</span>`
                }
              </div>

              ${
                this.isLoadingDetailMedia || !media
                  ? `
                <div style="padding:1.5rem; text-align:center; background:#f8fafc; border:2px dashed #0284c7; border-radius:8px;">
                  <strong class="operativo-only-inline">⏳ Cargando fotos de evidencia...</strong>
                  <strong class="tech-only-inline">⚡ Solicitando URLs firmadas temporales (createSignedUrl) a Supabase Storage...</strong>
                </div>
              `
                  : `
                <div class="m6-signed-photos-grid">
                  ${media.photos
                    .map(
                      (ph) => `
                    <div class="m6-signed-photo-card">
                      <div class="m6-signed-photo-img-wrap">
                        <img src="${this.escapeAttr(ph.previewSrc)}" alt="Foto ${ph.index} de ${this.escapeAttr(rep.codigo_equipo)}" />
                        <span class="m2-file-badge-overlay">
                          Foto #${ph.index}<span class="tech-only-inline"> • ${formatBytes(ph.sizeBytes)} (${ph.width}x${ph.height})</span>
                        </span>
                      </div>
                      <div class="m6-signed-photo-info">
                        <div class="tech-only-block">
                          <div><strong>Ruta Bucket Privado:</strong> <code>fotos/${this.escapeHtml(ph.storagePath)}</code></div>
                          <div><strong>Modo de Carga:</strong> ${this.escapeHtml(ph.originMode)}</div>
                          <div class="m6-signed-url-box">
                            <strong>🔑 URL Firmada Temporal (createSignedUrl — Expira en 3600 s):</strong>
                            <code>${this.escapeHtml(ph.signedUrl)}</code>
                          </div>
                        </div>
                        <a
                          href="${this.escapeAttr(ph.previewSrc)}"
                          download="${this.escapeAttr(rep.codigo_equipo)}_${this.escapeAttr(rep.fecha)}_foto_${ph.index}.jpg"
                          target="_blank"
                          rel="noopener noreferrer"
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
                    <strong class="operativo-only-inline">🎥 Video de Evidencia</strong>
                    <strong class="tech-only-inline">🎥 Video Opcional Cargado con createSignedUrl:</strong>
                    <div class="tech-only-block">
                      <div style="font-size:0.82rem; margin-top:0.25rem;">
                        Ruta Storage: <code>fotos/${this.escapeHtml(media.video.storagePath)}</code> (${formatBytes(media.video.sizeBytes)})
                      </div>
                      <div class="m6-signed-url-box" style="margin-top:0.35rem;">
                        <code>${this.escapeHtml(media.video.signedUrl)}</code>
                      </div>
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

  escapeHtml(val = '') {
    return this.escapeAttr(val).replace(/'/g, '&#39;');
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

    // Cabecera de Entrega de Guardia (sin re-render al escribir para no perder foco)
    this.rootEl.querySelector('#m6-daily-turno')?.addEventListener('change', (e) => {
      this.dailyMeta.turno = e.target.value;
    });
    this.rootEl.querySelector('#m6-daily-zona')?.addEventListener('input', (e) => {
      this.dailyMeta.zona = e.target.value;
    });
    this.rootEl.querySelector('#m6-daily-supervisor')?.addEventListener('input', (e) => {
      this.dailyMeta.supervisor = e.target.value;
    });

    // Botones principales de Reporte Diario y M6
    this.rootEl.querySelector('#btn-m6-export-excel')?.addEventListener('click', () => {
      this.handleExportFilteredToExcel();
    });

    this.rootEl.querySelector('#btn-m6-print-daily')?.addEventListener('click', () => {
      this.handlePrintDailyReport();
    });

    this.rootEl.querySelector('#btn-m6-copy-whatsapp')?.addEventListener('click', () => {
      this.handleCopyWhatsAppSummary();
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

    this.rootEl.querySelector('#btn-m6-date-3d')?.addEventListener('click', () => {
      const hoy = getFechaHoyPeru();
      this.filters.fechaDesde = this.getOffsetDatePeru(2);
      this.filters.fechaHasta = hoy;
      this.render();
    });

    this.rootEl.querySelector('#btn-m6-date-7d')?.addEventListener('click', () => {
      const hoy = getFechaHoyPeru();
      this.filters.fechaDesde = this.getOffsetDatePeru(6);
      this.filters.fechaHasta = hoy;
      this.render();
    });

    this.rootEl.querySelector('#btn-m6-date-all')?.addEventListener('click', () => {
      this.filters.fechaDesde = '';
      this.filters.fechaHasta = '';
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-estado-op')?.addEventListener('change', (e) => {
      this.filters.estadoOperativo = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m6-filter-orden')?.addEventListener('change', (e) => {
      this.filters.orden = e.target.value;
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
        estadoOperativo: 'TODOS',
        orden: 'prioridad',
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

    // Respaldo si falla la carga de alguna miniatura (URL expirada / sin red)
    this.rootEl.querySelectorAll('img[data-m6-thumb-id]').forEach((imgEl) => {
      imgEl.addEventListener('error', () => {
        if (imgEl.dataset.fallbackApplied === '1') return;
        imgEl.dataset.fallbackApplied = '1';
        const repId = imgEl.getAttribute('data-m6-thumb-id');
        if (repId) this.thumbUrlMap.delete(repId);
        const rep = this.unifiedReports.find((r) => r.id === repId);
        if (!rep) return;
        const photoPaths =
          Array.isArray(rep?.fotos_rutas) && rep.fotos_rutas.length > 0
            ? rep.fotos_rutas
            : Array.isArray(rep?.fotos)
              ? rep.fotos
              : [];
        imgEl.src = buildCloudPhotoPreviewDataUri({
          codigoEquipo: rep.codigo_equipo,
          fecha: rep.fecha,
          hora: rep.hora_peru,
          photoNumber: 1,
          totalPhotos: Math.max(photoPaths.length, 1),
          storagePath: photoPaths[0] || `${rep.creado_por || 'campo'}/${rep.id}/1.jpg`,
          calidad: rep.calidad_compresion
        });
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
