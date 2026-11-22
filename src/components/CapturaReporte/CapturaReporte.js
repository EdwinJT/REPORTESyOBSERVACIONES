/**
 * M1 — Captura ("Nuevo reporte" e interfaz principal unificada tipo tabla/panel)
 * Implementa:
 * 1. Cuadro de Códigos de Equipos Creados (Selector + Filtro Rápido)
 * 2. Panel de Creación de Reporte (Cámara, Adjuntar, 1-5 fotos + 1 video opcional, Calidad compresión, + Agregar otra observación)
 * 3. Tabla Principal con Orden de Lectura Operativo (6 columnas con subsección de seguimiento ↳ alineada en Fecha, Vista Previa y Observación)
 */

import { localDb } from '../../db/localDb.js';
import { supabase } from '../../config/supabaseClient.js';
import { formatBytes, getStorageUsageEstimate } from '../../db/storageManager.js';
import {
  getFechaHoyPeru,
  getHoraActualPeru,
  esFechaValida,
  formatFechaDDMMYYYY,
  formatDiasTranscurridos
} from '../../utils/datePeru.js';
import { normalizeEquipmentCode } from '../../utils/codeNormalizer.js';
import {
  getAllEquipments,
  createOrTouchEquipment,
  syncEquipmentsFromCloudReports,
  renameOrUpdateEquipment,
  deleteEquipmentFromCatalog
} from '../../services/equipmentService.js';
import {
  compressPhotoFile,
  validateVideoFile,
  COMPRESSION_PROFILES
} from '../../services/imageCompressor.js';
import { authService } from '../../services/authService.js';
import { pwaManager } from '../../services/pwaManager.js';
import { syncQueue } from '../../services/syncQueue.js';

const CREATE_PANEL_COLLAPSED_KEY = 'mineria_create_panel_collapsed_v1';

export class CapturaReporteView {
  constructor(rootEl, { onStatsChange, initialTableTab = 'activas', onTableTabChange } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onTableTabChange = onTableTabChange || (() => {});

    // Estado de datos persistidos
    this.equipos = [];
    this.reportes = [];
    this.objectUrls = [];

    // Filtro activo en Cuadro de Equipos ("TODOS" o código específico)
    this.filtroEquipo = 'TODOS';
    this.vistaTabla = initialTableTab === 'levantadas' ? 'levantadas' : 'activas';

    // Estado minimizado/expandido del Panel 2 ("Nuevo Reporte")
    this.isCreatePanelCollapsed = false;
    try {
      this.isCreatePanelCollapsed = localStorage.getItem(CREATE_PANEL_COLLAPSED_KEY) === '1';
    } catch {
      this.isCreatePanelCollapsed = false;
    }

    // Estado del formulario "Nuevo Reporte"
    this.form = {
      codigo_equipo: '793F-05',
      nuevo_codigo_input: '',
      nueva_categoria_input: '',
      fecha: getFechaHoyPeru(),
      tipo: 'Observación',
      prioridad: 'Alta',
      calidad_compresion: 'estandar',
      observacion: '',
      fotos_locales: [], // 1 a 5 fotos
      video_local: null, // 0 o 1 video
      observaciones_adicionales: [] // "+ Agregar otra observación"
    };

    this.banner = null; // { type: 'error' | 'success', text: string }
    this.obsValidationError = null;
    this.isCompressing = false;
    this.viewerModal = null; // { title, url, isVideo, meta }
    this._viewerDrawState = null;
    this.followupModal = null; // { reporteId, codigo_equipo, fecha, estado_seguimiento, comentario, fotos_locales, video_local, validationError }
    this.deleteConfirmModal = null; // { reporteId, codigo_equipo, fecha, observacion, seguimientosCount, isDeleting }
    this.editReportModal = null; // { reporteId, codigo_equipo, fecha, tipo, prioridad, observacion, fotos_locales, isUploadingPhotos, uploadingCount, isSaving, validationError }
    this.editEquipmentModal = null; // { oldCodigo, nuevoCodigo, categoria, reportCount, isSaving, validationError }
    this.deleteEquipmentModal = null; // { codigo, categoria, reportCount, deleteReportsToo, isDeleting }
  }

  async init() {
    await this.reloadData();
    if (this.equipos.length > 0 && !this.form.codigo_equipo) {
      this.form.codigo_equipo = this.equipos[0].codigo;
    }
    this.render();
  }

  revokeAllUrls() {
    for (const url of this.objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.objectUrls = [];
  }

  createObjectUrl(blob) {
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    return url;
  }

  isSegLevantada(seg) {
    return String(seg?.estado_seguimiento || '')
      .toLowerCase()
      .includes('levantada');
  }

  isReportLevantada(rep) {
    return (
      Array.isArray(rep?.seguimientos) &&
      rep.seguimientos.some((s) => this.isSegLevantada(s))
    );
  }

  setVistaTabla(tab, { scrollToTable = false } = {}) {
    const nextTab = tab === 'levantadas' ? 'levantadas' : 'activas';
    this.vistaTabla = nextTab;
    this.render();
    if (scrollToTable) {
      const tableSec = this.rootEl.querySelector('#section-tabla-principal');
      if (tableSec) {
        tableSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  async _getWritableReport(reporteId) {
    const localRep = await localDb.reportes.get(reporteId);
    if (localRep) return localRep;
    const fromView = this.reportes.find((r) => r.id === reporteId);
    if (!fromView) return null;
    return {
      ...fromView,
      seguimientos: Array.isArray(fromView.seguimientos) ? [...fromView.seguimientos] : [],
      fotos_locales: Array.isArray(fromView.fotos_locales) ? [...fromView.fotos_locales] : [],
      fotos_rutas: Array.isArray(fromView.fotos_rutas)
        ? [...fromView.fotos_rutas]
        : Array.isArray(fromView.fotos)
          ? [...fromView.fotos]
          : []
    };
  }

  _hasActiveOverlayModal() {
    return Boolean(
      this.viewerModal ||
        this.followupModal ||
        this.deleteConfirmModal ||
        this.editReportModal ||
        this.editEquipmentModal ||
        this.deleteEquipmentModal
    );
  }

  _triggerBackgroundReportSync(reporteId, triggerSource) {
    if (!pwaManager.getState().isOnline) return;
    syncQueue
      .processQueue({
        triggerSource,
        forceManual: true,
        targetReportId: reporteId,
        perFileDelayMs: 25
      })
      .then(async () => {
        await this.reloadData({ skipCloudFetch: true });
        if (!this._hasActiveOverlayModal()) {
          this.render();
        }
      })
      .catch(() => {
        // Permanece seguro en IndexedDB si falla la red momentáneamente
      });
  }

  async hydrateRemoteSeguimientos(remSegs, localSegs = []) {
    if (!Array.isArray(remSegs)) return [];
    const localList = Array.isArray(localSegs) ? localSegs : [];

    return Promise.all(
      remSegs.map(async (seg, sIdx) => {
        const matchedLocal =
          localList.find((ls) => ls.id && seg.id && ls.id === seg.id) || localList[sIdx] || null;
        const localFotos = Array.isArray(matchedLocal?.fotos_locales)
          ? matchedLocal.fotos_locales
          : [];
        const hasLocalBlobs = localFotos.some((lf) => Boolean(lf?.blob));

        let segFotosLocales = [];
        if (hasLocalBlobs) {
          segFotosLocales = localFotos;
        } else {
          const segPaths = Array.isArray(seg.fotos) ? seg.fotos : [];
          segFotosLocales = await Promise.all(
            segPaths.map(async (segPath, si) => {
              const signedSeg = await supabase.storage
                .from('fotos')
                .createSignedUrl(segPath, 3600);
              return {
                indice: si + 1,
                blob: null,
                signedUrl: signedSeg?.data?.signedUrl || '',
                ruta_remota: segPath,
                peso_bytes: 0,
                ancho: 1600,
                alto: 1200
              };
            })
          );
        }

        return {
          ...matchedLocal,
          ...seg,
          fotos_locales: segFotosLocales,
          video_local: matchedLocal?.video_local || null
        };
      })
    );
  }

  async reloadData({ skipCloudFetch = false } = {}) {
    const rawLocal = await localDb.reportes.toArray();
    const authState = authService.getState();
    let mergedReports = [...rawLocal];

    // Si hay sesión real en Supabase Cloud, fusionar reportes remotos (desde red o desde caché local instantánea)
    if (authState.isRealCloudSession && (skipCloudFetch || pwaManager.getState().isOnline)) {
      try {
        let remoteRows = [];
        if (skipCloudFetch && typeof supabase.getCachedCloudReports === 'function') {
          remoteRows = supabase.getCachedCloudReports();
        } else if (pwaManager.getState().isOnline) {
          const res = await supabase.from('reportes').select();
          remoteRows = Array.isArray(res?.data) ? res.data : [];
        }

        if (Array.isArray(remoteRows) && remoteRows.length > 0) {
          await syncEquipmentsFromCloudReports(remoteRows, rawLocal);
          const mergedMap = new Map();
          for (const loc of rawLocal) {
            mergedMap.set(loc.id, loc);
          }

          await Promise.all(
            remoteRows.map(async (rem) => {
              const existingLoc = mergedMap.get(rem.id);
              if (existingLoc) {
                // Preservar reportes locales con cambios/seguimientos pendientes por subir
                if (existingLoc.estado === 'pendiente' || existingLoc.estado === 'sincronizando') {
                  mergedMap.set(rem.id, existingLoc);
                  return;
                }
                const mergedSegs = await this.hydrateRemoteSeguimientos(
                  rem.seguimientos,
                  existingLoc.seguimientos
                );
                mergedMap.set(rem.id, {
                  ...existingLoc,
                  ...rem,
                  fotos_locales: existingLoc.fotos_locales || [],
                  video_local: existingLoc.video_local || null,
                  fotos_rutas: Array.isArray(rem.fotos)
                    ? rem.fotos
                    : existingLoc.fotos_rutas || [],
                  seguimientos:
                    mergedSegs.length > 0 ? mergedSegs : existingLoc.seguimientos || [],
                  estado: 'sincronizado',
                  sincronizado_en_nube_real: true
                });
              } else {
                // Reporte creado en otro celular o PC: firmar URLs en paralelo (con caché en memoria)
                const remotePaths = Array.isArray(rem.fotos) ? rem.fotos : [];
                const [cloudPhotos, cloudSegs] = await Promise.all([
                  Promise.all(
                    remotePaths.map(async (remotePath, i) => {
                      const signed = await supabase.storage
                        .from('fotos')
                        .createSignedUrl(remotePath, 3600);
                      return {
                        indice: i + 1,
                        blob: null,
                        signedUrl: signed?.data?.signedUrl || '',
                        ruta_remota: remotePath,
                        peso_bytes: 0,
                        ancho: rem.calidad_compresion === 'alta' ? 2048 : 1600,
                        alto: rem.calidad_compresion === 'alta' ? 1536 : 1200
                      };
                    })
                  ),
                  this.hydrateRemoteSeguimientos(rem.seguimientos, [])
                ]);

                mergedMap.set(rem.id, {
                  ...rem,
                  es_nuevo_codigo: Boolean(rem.fuera_catalogo),
                  fotos_locales: cloudPhotos,
                  fotos_rutas: remotePaths,
                  video_local: null,
                  seguimientos: cloudSegs,
                  estado: 'sincronizado',
                  sincronizado_en_nube_real: true,
                  desde_otro_dispositivo: true
                });
              }
            })
          );
          mergedReports = Array.from(mergedMap.values());
        }
      } catch {
        // Si falla la red momentáneamente, continuar con IndexedDB local
      }
    }

    const cleanedReports = [];
    for (const r of mergedReports) {
      const isDeleted =
        (typeof supabase.isReportDeleted === 'function' && supabase.isReportDeleted(r.id)) ||
        r.observacion === '__REPORTE_ELIMINADO__';
      if (isDeleted) {
        await localDb.reportes.delete(r.id);
        continue;
      }
      cleanedReports.push(r);
    }

    this.equipos = await getAllEquipments();
    this.reportes = cleanedReports.sort((a, b) => {
      const codeCmp = String(a.codigo_equipo || '').localeCompare(
        String(b.codigo_equipo || ''),
        'es',
        { numeric: true, sensitivity: 'base' }
      );
      if (codeCmp !== 0) return codeCmp;
      const dateCmp = String(a.fecha || '').localeCompare(String(b.fecha || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(a.creado_en || '').localeCompare(String(b.creado_en || ''));
    });
    const storageEst = await getStorageUsageEstimate();
    const pendientes = rawLocal.filter((r) => r.estado === 'pendiente' || r.estado === 'error').length;
    const levantadasCount = this.reportes.filter((r) => this.isReportLevantada(r)).length;
    const activasCount = this.reportes.length - levantadasCount;
    this.onStatsChange({
      totalReportes: this.reportes.length,
      activasCount,
      levantadasCount,
      pendientes,
      storageEst
    });
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  // Generador rápido de foto de prueba (para probar en PC sin cámara o validar P3)
  async generateSamplePhotoFile(codigo, calidad) {
    const canvas = document.createElement('canvas');
    canvas.width = 2200;
    canvas.height = 1400;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 18;
    ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);

    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(40, 40, canvas.width - 80, 140);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 58px sans-serif';
    ctx.fillText(`INSPECCIÓN DE CAMPO — EQUIPO ${codigo || 'SIN-CODIGO'}`, 85, 130);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText(`PLACA DE IDENTIFICACIÓN Y LECTURA DE CAMPO`, 90, 340);

    ctx.fillStyle = '#090d16';
    ctx.fillRect(90, 430, canvas.width - 180, 420);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 6;
    ctx.strokeRect(90, 430, canvas.width - 180, 420);

    ctx.fillStyle = '#fde047';
    ctx.font = 'bold 54px monospace';
    ctx.fillText(`CÓDIGO ACTIVO : ${codigo || '793F-05'}`, 140, 545);
    ctx.fillText(`N° SERIE      : CAT0793FPE0098412`, 140, 645);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`FECHA LIMA    : ${this.form.fecha} (${getHoraActualPeru()})`, 140, 745);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '44px sans-serif';
    ctx.fillText(
      `Perfil solicitado: ${COMPRESSION_PROFILES[calidad]?.label || calidad} — Resolución original: 2200x1400 px`,
      90,
      1020
    );

    const rawBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.96));
    return new File([rawBlob], `captura_${(codigo || 'equipo').toLowerCase()}_${Date.now()}.jpg`, {
      type: 'image/jpeg'
    });
  }

  async handleAddPhotos(fileList, targetExtraObsIndex = null) {
    if (!fileList || fileList.length === 0) return;

    const currentPhotos =
      targetExtraObsIndex === null
        ? this.form.fotos_locales
        : this.form.observaciones_adicionales[targetExtraObsIndex].fotos_locales;

    if (currentPhotos.length + fileList.length > 5) {
      this.setBanner(
        'error',
        `Límite multimedia (Escenario P4): Puedes adjuntar entre 1 y máximo 5 fotos por sección (actualmente tienes ${currentPhotos.length}).`
      );
      return;
    }

    this.isCompressing = true;
    this.render();

    try {
      for (const file of Array.from(fileList)) {
        const compressed = await compressPhotoFile(file, this.form.calidad_compresion);
        currentPhotos.push({
          indice: currentPhotos.length + 1,
          ...compressed
        });
      }
      // Reindexar 1..N
      currentPhotos.forEach((f, idx) => {
        f.indice = idx + 1;
      });
      this.banner = {
        type: 'success',
        text: `Foto(s) comprimida(s) correctamente con perfil "${
          COMPRESSION_PROFILES[this.form.calidad_compresion].label
        }".`
      };
    } catch (err) {
      this.banner = {
        type: 'error',
        text: err.message || 'Error al comprimir la imagen.'
      };
    } finally {
      this.isCompressing = false;
      this.render();
    }
  }

  handleAttachVideo(file, targetExtraObsIndex = null) {
    if (!file) return;
    const validation = validateVideoFile(file);
    if (!validation.valid) {
      this.setBanner('error', validation.error);
      return;
    }

    if (targetExtraObsIndex === null) {
      this.form.video_local = validation.videoLocal;
    } else {
      this.form.observaciones_adicionales[targetExtraObsIndex].video_local = validation.videoLocal;
    }

    this.setBanner(
      'success',
      `Video corto adjuntado (${formatBytes(validation.videoLocal.peso_bytes)}).`
    );
  }

  async handleCreateEquipmentCode() {
    const raw = this.form.nuevo_codigo_input;
    const normalized = normalizeEquipmentCode(raw);
    if (!normalized) {
      this.setBanner('error', 'Escribe un código de equipo válido para crear (ej. "793f 05").');
      return;
    }

    try {
      const { record, es_nuevo_codigo } = await createOrTouchEquipment(
        normalized,
        this.form.nueva_categoria_input
      );
      this.form.codigo_equipo = record.codigo;
      this.form.nuevo_codigo_input = '';
      this.form.nueva_categoria_input = '';
      await this.reloadData({ skipCloudFetch: true });

      this.setBanner(
        'success',
        es_nuevo_codigo
          ? `Código "${record.codigo}" normalizado y creado. Ya está disponible en la lista desplegable y en el cuadro superior.`
          : `Código "${record.codigo}" seleccionado y actualizado.`
      );
    } catch (err) {
      this.setBanner('error', err.message);
    }
  }

  addExtraObservationSlot() {
    this.form.observaciones_adicionales.push({
      id: crypto.randomUUID(),
      modo: 'seguimiento', // 'seguimiento' (se agrega como ↳ en el mismo reporte) | 'independiente' (crea fila aparte)
      fecha: getFechaHoyPeru(),
      estado_seguimiento: 'Sigue observación',
      comentario: '',
      fotos_locales: [],
      video_local: null
    });
    this.render();
  }

  removeExtraObservationSlot(idx) {
    this.form.observaciones_adicionales.splice(idx, 1);
    this.render();
  }

  async handleSaveReport() {
    // Validaciones obligatorias (Escenario P4)
    const codigo = normalizeEquipmentCode(this.form.codigo_equipo);
    if (!codigo) {
      this.setBanner('error', 'Validación P4: Debes seleccionar o crear un Código de Equipo antes de guardar.');
      return;
    }

    if (!esFechaValida(this.form.fecha)) {
      this.setBanner('error', 'Validación P4: La fecha debe tener formato válido AAAA-MM-DD.');
      return;
    }

    if (this.form.fotos_locales.length < 1 || this.form.fotos_locales.length > 5) {
      this.setBanner(
        'error',
        'Validación P4: Todo reporte requiere mínimo 1 foto y máximo 5 fotos antes de guardarse.'
      );
      return;
    }

    if (!this.form.observacion.trim()) {
      this.obsValidationError =
        'Debes colocar un comentario u observación obligatoria. Caso contrario, el reporte no se guardará.';
      this.setBanner('error', this.obsValidationError);
      const ta = this.rootEl.querySelector('#textarea-observacion');
      if (ta) {
        ta.focus();
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    this.obsValidationError = null;

    const { es_nuevo_codigo } = await createOrTouchEquipment(codigo);
    const nowIso = new Date().toISOString();

    // Separar las observaciones adicionales que van como subsección de seguimiento (↳)
    // de las que el usuario marcó como otra observación independiente del mismo equipo
    const seguimientosIntegrados = [];
    const observacionesIndependientes = [];

    for (const extra of this.form.observaciones_adicionales) {
      if (!extra.comentario.trim() && (extra.fotos_locales.length > 0 || extra.video_local)) {
        this.setBanner(
          'error',
          'Cada observación/seguimiento adicional con fotos requiere un comentario obligatorio; caso contrario no se guardará.'
        );
        return;
      }
      if (!extra.comentario.trim() && extra.fotos_locales.length === 0 && !extra.video_local) {
        continue;
      }
      if (extra.modo === 'independiente') {
        observacionesIndependientes.push(extra);
      } else {
        seguimientosIntegrados.push({
          id: extra.id || crypto.randomUUID(),
          fecha: extra.fecha || this.form.fecha,
          estado_seguimiento: extra.estado_seguimiento || 'Sigue observación',
          comentario: extra.comentario.trim() || 'Seguimiento registrado en campo.',
          fotos_locales: extra.fotos_locales,
          video_local: extra.video_local
        });
      }
    }

    const nuevoReporte = {
      id: crypto.randomUUID(),
      codigo_equipo: codigo,
      es_nuevo_codigo,
      fecha: this.form.fecha,
      tipo: this.form.tipo,
      prioridad: this.form.prioridad,
      observacion: this.form.observacion.trim(),
      calidad_compresion: this.form.calidad_compresion,
      fotos_locales: this.form.fotos_locales,
      video_local: this.form.video_local,
      seguimientos: seguimientosIntegrados,
      fotos_rutas: [],
      video_ruta: null,
      estado: 'pendiente',
      ultimo_error: null,
      intentos_sync: 0,
      creado_por: authService.getCurrentOperatorIdentifier(),
      creado_en: nowIso,
      actualizado_en: nowIso,
      dispositivo: navigator.userAgent.includes('Mobile') ? 'Móvil Campo' : 'PC / Terminal Mina'
    };

    await localDb.reportes.put(nuevoReporte);

    // Si hay observaciones marcadas como fila independiente para el mismo equipo, guardarlas también
    for (const ind of observacionesIndependientes) {
      const fotosInd = ind.fotos_locales.length > 0 ? ind.fotos_locales : this.form.fotos_locales;
      const repAdicional = {
        id: crypto.randomUUID(),
        codigo_equipo: codigo,
        es_nuevo_codigo: false,
        fecha: ind.fecha || this.form.fecha,
        tipo: this.form.tipo,
        prioridad: this.form.prioridad,
        observacion: ind.comentario.trim(),
        calidad_compresion: this.form.calidad_compresion,
        fotos_locales: fotosInd,
        video_local: ind.video_local,
        seguimientos: [],
        fotos_rutas: [],
        video_ruta: null,
        estado: 'pendiente',
        ultimo_error: null,
        intentos_sync: 0,
        creado_por: authService.getCurrentOperatorIdentifier(),
        creado_en: new Date(Date.now() + 10).toISOString(),
        actualizado_en: new Date(Date.now() + 10).toISOString(),
        dispositivo: navigator.userAgent.includes('Mobile') ? 'Móvil Campo' : 'PC / Terminal Mina'
      };
      await localDb.reportes.put(repAdicional);
    }

    // Limpiar formulario manteniendo el equipo activo y la fecha de Perú
    this.form.observacion = '';
    this.obsValidationError = null;
    this.form.fotos_locales = [];
    this.form.video_local = null;
    this.form.observaciones_adicionales = [];
    this.form.fecha = getFechaHoyPeru();

    await this.reloadData({ skipCloudFetch: true });
    this.setBanner(
      'success',
      `Reporte del equipo ${codigo} guardado en el dispositivo (IndexedDB) en estado "pendiente".`
    );

    // Si hay conexión real y sesión válida en Supabase, iniciar subida automática en segundo plano
    if (pwaManager.getState().isOnline && authService.getState().isAuthenticatedValid) {
      syncQueue
        .processQueue({ triggerSource: 'Nuevo reporte guardado en M1' })
        .then(async () => {
          await this.reloadData({ skipCloudFetch: true });
          if (!this._hasActiveOverlayModal()) {
            this.render();
          }
        })
        .catch(() => {});
    }
  }

  // Descargar (⬇️ Descargar) foto o video desde el Visor Multimedia (blob local o URL firmada de Supabase Cloud)
  async handleDownloadMedia(blob, filename, fallbackUrl = '') {
    const safeName = filename || 'evidencia_equipo.jpg';
    const triggerBlobDownload = (fileBlob) => {
      const url = URL.createObjectURL(fileBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    };

    if (blob) {
      triggerBlobDownload(blob);
      return;
    }

    if (fallbackUrl) {
      try {
        const res = await fetch(fallbackUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fetchedBlob = await res.blob();
        triggerBlobDownload(fetchedBlob);
      } catch (err) {
        console.warn('[CapturaReporte] Descarga directa vía fetch falló, abriendo URL:', err);
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      }
    }
  }

  // Guardar o editar un seguimiento (↳) desde el modal rápido de la tabla
  async handleSaveFollowupModal() {
    if (!this.followupModal) return;
    if (this.followupModal.isSaving || this.followupModal.isUploadingPhotos) return;

    const {
      reporteId,
      editSegIndex = null,
      fecha,
      estado_seguimiento,
      comentario,
      fotos_locales,
      video_local,
      mode
    } = this.followupModal;
    const isEditMode = editSegIndex !== null && editSegIndex !== undefined;
    const isResolveMode = mode === 'levantada';

    if (!comentario.trim()) {
      this.followupModal.validationError = isResolveMode && !isEditMode
        ? 'Debes colocar un comentario obligatorio para levantar la observación. Caso contrario, no se guardará.'
        : 'Debes colocar un comentario obligatorio. Caso contrario, el seguimiento no se guardará.';
      this.render();
      const ta = this.rootEl.querySelector('#modal-seg-comentario');
      if (ta) {
        ta.focus();
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    this.followupModal.validationError = null;

    this.followupModal.isSaving = true;
    this.render();

    try {
      const reporte = await this._getWritableReport(reporteId);
      if (!reporte) return;

      if (!Array.isArray(reporte.seguimientos)) {
        reporte.seguimientos = [];
      }

      const nextFotosLocales = [...(fotos_locales || [])];

      if (isEditMode) {
        const prevSeg = reporte.seguimientos[editSegIndex];
        if (!prevSeg) {
          this.followupModal = null;
          await this.reloadData({ skipCloudFetch: true });
          this.setBanner('error', 'No se encontró el seguimiento que intentabas editar.');
          return;
        }

        const updatedFotosRutas = nextFotosLocales
          .map((f) => f?.ruta_remota)
          .filter(Boolean);

        reporte.seguimientos[editSegIndex] = {
          ...prevSeg,
          id: prevSeg.id || crypto.randomUUID(),
          fecha: fecha || prevSeg.fecha || getFechaHoyPeru(),
          estado_seguimiento:
            estado_seguimiento || prevSeg.estado_seguimiento || 'Sigue observación',
          comentario: comentario.trim(),
          fotos_locales: nextFotosLocales,
          fotos: updatedFotosRutas,
          video_local: video_local !== undefined ? video_local : prevSeg.video_local || null
        };
      } else {
        reporte.seguimientos.push({
          id: crypto.randomUUID(),
          fecha: fecha || getFechaHoyPeru(),
          estado_seguimiento: estado_seguimiento || 'Sigue observación',
          comentario: comentario.trim(),
          fotos_locales: nextFotosLocales,
          video_local: video_local || null
        });
      }

      reporte.estado = 'pendiente';
      reporte.sincronizado_en_nube_real = false;
      reporte.ultimo_error = null;
      reporte.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(reporte);

      this.followupModal = null;
      await this.reloadData({ skipCloudFetch: true });
      this.setBanner(
        'success',
        isEditMode
          ? `Cambios guardados en el seguimiento #${editSegIndex + 1} del equipo ${reporte.codigo_equipo}.`
          : isResolveMode
            ? `Observación levantada registrada en el equipo ${reporte.codigo_equipo}.`
            : `Seguimiento (↳) agregado al reporte de ${reporte.codigo_equipo}.`
      );

      this._triggerBackgroundReportSync(
        reporte.id,
        isEditMode
          ? `Edición de seguimiento #${editSegIndex + 1}`
          : isResolveMode
            ? 'Observación levantada'
            : 'Nuevo seguimiento agregado'
      );
    } catch (err) {
      if (this.followupModal) {
        this.followupModal.isSaving = false;
      }
      this.setBanner('error', err?.message || 'No se pudo guardar el seguimiento.');
    } finally {
      if (this.followupModal && this.followupModal.isSaving) {
        this.followupModal.isSaving = false;
        this.render();
      }
    }
  }

  // Cambiar estado de una observación ya levantada y devolverla al Panel Principal
  async handleReopenResolvedReport(reporteId, nuevoEstado = 'Sigue observación') {
    const reporte = await this._getWritableReport(reporteId);
    if (!reporte) return;

    const estadoDestino = nuevoEstado === 'En monitoreo' ? 'En monitoreo' : 'Sigue observación';
    if (!Array.isArray(reporte.seguimientos)) {
      reporte.seguimientos = [];
    }

    reporte.seguimientos = reporte.seguimientos.map((seg) =>
      this.isSegLevantada(seg)
        ? { ...seg, estado_seguimiento: estadoDestino }
        : seg
    );

    reporte.estado = 'pendiente';
    reporte.sincronizado_en_nube_real = false;
    reporte.ultimo_error = null;
    reporte.actualizado_en = new Date().toISOString();
    await localDb.reportes.put(reporte);

    await this.reloadData({ skipCloudFetch: true });
    this.setBanner(
      'success',
      `Estado cambiado a "${estadoDestino}". La observación de ${reporte.codigo_equipo} volvió al Panel Principal.`
    );

    this._triggerBackgroundReportSync(reporte.id, 'Reapertura de observación levantada');
  }

  // Eliminar un seguimiento individual o toda la fila de observación
  async handleConfirmDeleteReport() {
    if (!this.deleteConfirmModal || this.deleteConfirmModal.isDeleting) return;
    const { isFollowup, reporteId, segIndex, segNumber, codigo_equipo, fecha, segFecha } =
      this.deleteConfirmModal;
    this.deleteConfirmModal.isDeleting = true;
    this.render();

    try {
      if (isFollowup) {
        const reporte = await this._getWritableReport(reporteId);
        if (
          !reporte ||
          !Array.isArray(reporte.seguimientos) ||
          segIndex < 0 ||
          segIndex >= reporte.seguimientos.length
        ) {
          this.deleteConfirmModal = null;
          await this.reloadData({ skipCloudFetch: true });
          this.setBanner('error', 'No se encontró el seguimiento que intentabas borrar.');
          return;
        }

        reporte.seguimientos.splice(segIndex, 1);
        reporte.estado = 'pendiente';
        reporte.sincronizado_en_nube_real = false;
        reporte.ultimo_error = null;
        reporte.actualizado_en = new Date().toISOString();
        await localDb.reportes.put(reporte);

        this.deleteConfirmModal = null;
        await this.reloadData({ skipCloudFetch: true });
        this.setBanner(
          'success',
          `Se borró el Seguimiento #${segNumber} (${formatFechaDDMMYYYY(segFecha)}) del equipo ${codigo_equipo}. La observación principal se mantiene.`
        );

        this._triggerBackgroundReportSync(reporte.id, `Borrado de seguimiento #${segNumber}`);
        return;
      }

      await localDb.reportes.delete(reporteId);
      if (typeof supabase.markReportDeletedLocal === 'function') {
        supabase.markReportDeletedLocal(reporteId);
      }
      this.deleteConfirmModal = null;
      await this.reloadData({ skipCloudFetch: true });
      this.setBanner(
        'success',
        `Se borró completamente la observación del equipo ${codigo_equipo} (${formatFechaDDMMYYYY(fecha)}) y todos sus seguimientos.`
      );

      supabase
        .from('reportes')
        .delete(reporteId)
        .catch(() => {});
    } catch (err) {
      if (this.deleteConfirmModal) {
        this.deleteConfirmModal.isDeleting = false;
        this.render();
      }
      this.setBanner(
        'error',
        err?.message ||
          (isFollowup ? 'No se pudo borrar el seguimiento.' : 'No se pudo borrar la observación.')
      );
    }
  }

  // Guardar edición de una fila existente de observación
  async handleSaveEditReport() {
    if (!this.editReportModal) return;
    if (this.editReportModal.isSaving || this.editReportModal.isUploadingPhotos) return;

    const { reporteId, codigo_equipo, fecha, tipo, prioridad, observacion, fotos_locales } =
      this.editReportModal;

    if (!observacion.trim()) {
      this.editReportModal.validationError =
        'La observación principal no puede quedar vacía. Caso contrario, no se guardarán los cambios.';
      this.render();
      const ta = this.rootEl.querySelector('#edit-observacion');
      if (ta) {
        ta.focus();
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    if (!esFechaValida(fecha)) {
      this.editReportModal.validationError = 'Ingresa una fecha válida.';
      this.render();
      return;
    }

    this.editReportModal.validationError = null;
    this.editReportModal.isSaving = true;
    this.render();

    try {
      const reporte = await this._getWritableReport(reporteId);
      if (!reporte) return;

      reporte.codigo_equipo = normalizeEquipmentCode(codigo_equipo) || reporte.codigo_equipo;
      reporte.fecha = fecha;
      reporte.tipo = tipo || 'Observación';
      reporte.prioridad = prioridad || 'Media';
      reporte.observacion = observacion.trim();
      reporte.fotos_locales = [...(fotos_locales || [])];
      reporte.fotos_rutas = reporte.fotos_locales
        .map((f) => f?.ruta_remota)
        .filter(Boolean);
      if (Array.isArray(reporte.fotos)) {
        reporte.fotos = [...reporte.fotos_rutas];
      }

      reporte.estado = 'pendiente';
      reporte.sincronizado_en_nube_real = false;
      reporte.ultimo_error = null;
      reporte.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(reporte);
      await createOrTouchEquipment(reporte.codigo_equipo);

      this.editReportModal = null;
      await this.reloadData({ skipCloudFetch: true });
      this.setBanner(
        'success',
        `Cambios guardados en la observación del equipo ${reporte.codigo_equipo} (${formatFechaDDMMYYYY(reporte.fecha)}).`
      );

      this._triggerBackgroundReportSync(reporte.id, 'Edición de observación');
    } catch (err) {
      if (this.editReportModal) {
        this.editReportModal.isSaving = false;
      }
      this.setBanner('error', err?.message || 'No se pudieron guardar los cambios.');
    } finally {
      if (this.editReportModal && this.editReportModal.isSaving) {
        this.editReportModal.isSaving = false;
        this.render();
      }
    }
  }

  // Guardar edición o renombrado de un código de equipo en catálogo (y actualizar sus observaciones)
  async handleSaveEditEquipment() {
    if (!this.editEquipmentModal || this.editEquipmentModal.isSaving) return;

    const { oldCodigo, nuevoCodigo, categoria } = this.editEquipmentModal;
    const normalizedNew = normalizeEquipmentCode(nuevoCodigo);

    if (!normalizedNew) {
      this.editEquipmentModal.validationError =
        'Ingresa un código de equipo válido (ej. "793F-05"). Caso contrario, no se guardarán los cambios.';
      this.render();
      const inp = this.rootEl.querySelector('#modal-edit-eq-codigo');
      if (inp) {
        inp.focus();
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    this.editEquipmentModal.validationError = null;
    this.editEquipmentModal.isSaving = true;
    this.render();

    try {
      const res = await renameOrUpdateEquipment(oldCodigo, normalizedNew, categoria);
      let updatedReportsCount = 0;

      if (res.renamed) {
        const affectedReports = this.reportes.filter((r) => r.codigo_equipo === oldCodigo);
        for (const r of affectedReports) {
          const rep = await this._getWritableReport(r.id);
          if (!rep) continue;

          rep.codigo_equipo = res.nuevoCodigo;
          rep.estado = 'pendiente';
          rep.sincronizado_en_nube_real = false;
          rep.ultimo_error = null;
          rep.actualizado_en = new Date().toISOString();
          await localDb.reportes.put(rep);
          updatedReportsCount++;

          this._triggerBackgroundReportSync(rep.id, 'Renombrado de código de equipo');
        }

        if (this.form.codigo_equipo === oldCodigo) {
          this.form.codigo_equipo = res.nuevoCodigo;
        }
        if (this.filtroEquipo === oldCodigo) {
          this.filtroEquipo = res.nuevoCodigo;
        }
      }

      this.editEquipmentModal = null;
      await this.reloadData({ skipCloudFetch: true });
      this.setBanner(
        'success',
        res.renamed
          ? `Código ${oldCodigo} cambiado a ${res.nuevoCodigo}${
              updatedReportsCount > 0 ? ` (${updatedReportsCount} observación(es) actualizadas)` : ''
            }.`
          : `Código ${res.nuevoCodigo} actualizado.`
      );
    } catch (err) {
      if (this.editEquipmentModal) {
        this.editEquipmentModal.isSaving = false;
      }
      this.setBanner('error', err?.message || 'No se pudo actualizar el código de equipo.');
    } finally {
      if (this.editEquipmentModal && this.editEquipmentModal.isSaving) {
        this.editEquipmentModal.isSaving = false;
        this.render();
      }
    }
  }

  // Confirmar borrado de un código de equipo del catálogo (con borrado opcional de sus observaciones)
  async handleConfirmDeleteEquipment() {
    if (!this.deleteEquipmentModal || this.deleteEquipmentModal.isDeleting) return;

    const { codigo, deleteReportsToo } = this.deleteEquipmentModal;
    this.deleteEquipmentModal.isDeleting = true;
    this.render();

    try {
      await deleteEquipmentFromCatalog(codigo);
      let deletedReportsCount = 0;

      if (deleteReportsToo) {
        const affectedReports = this.reportes.filter((r) => r.codigo_equipo === codigo);
        for (const r of affectedReports) {
          await localDb.reportes.delete(r.id);
          if (typeof supabase.markReportDeletedLocal === 'function') {
            supabase.markReportDeletedLocal(r.id);
          }
          supabase
            .from('reportes')
            .delete(r.id)
            .catch(() => {});
          deletedReportsCount++;
        }
      }

      if (this.filtroEquipo === codigo) {
        this.filtroEquipo = 'TODOS';
      }

      this.deleteEquipmentModal = null;
      await this.reloadData({ skipCloudFetch: true });

      if (this.form.codigo_equipo === codigo) {
        this.form.codigo_equipo = this.equipos[0]?.codigo || '';
      }

      this.setBanner(
        'success',
        `Se borró el código ${codigo} del cuadro de equipos${
          deleteReportsToo ? ` junto con ${deletedReportsCount} observación(es)` : ''
        }.`
      );
    } catch (err) {
      if (this.deleteEquipmentModal) {
        this.deleteEquipmentModal.isDeleting = false;
        this.render();
      }
      this.setBanner('error', err?.message || 'No se pudo borrar el código de equipo.');
    }
  }

  render() {
    this.revokeAllUrls();

    const reportesPorEquipo =
      this.filtroEquipo === 'TODOS'
        ? this.reportes
        : this.reportes.filter((r) => r.codigo_equipo === this.filtroEquipo);

    const reportesActivos = reportesPorEquipo.filter((r) => !this.isReportLevantada(r));
    const reportesLevantados = reportesPorEquipo.filter((r) => this.isReportLevantada(r));
    const reportesVisibles =
      this.vistaTabla === 'levantadas' ? reportesLevantados : reportesActivos;

    const conteoPorEquipo = {};
    for (const r of this.reportes) {
      conteoPorEquipo[r.codigo_equipo] = (conteoPorEquipo[r.codigo_equipo] || 0) + 1;
    }

    const normPreview = normalizeEquipmentCode(this.form.nuevo_codigo_input);

    this.rootEl.innerHTML = `
      <div class="main-container">
        ${
          this.banner
            ? `
          <div class="alert-banner ${this.banner.type === 'error' ? 'alert-error' : 'alert-success'}">
            <span>${this.banner.type === 'error' ? '⚠️' : '✅'} ${this.escapeHtml(this.banner.text)}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        <!-- 1. CUADRO DE CÓDIGOS DE EQUIPOS CREADOS -->
        <section class="section-panel section-panel-equipos" aria-label="Cuadro de Códigos de Equipos Creados">
          <div class="section-header">
            <div>
              <h2 class="section-title">🚜 1. Cuadro de Códigos de Equipos Creados</h2>
              <p class="brand-subtitle">
                Toca cualquier código para <strong>filtrar la tabla inferior</strong> por ese equipo y <strong>preseleccionarlo</strong> automáticamente en "Nuevo Reporte".
              </p>
            </div>
            <span class="badge badge-pending">Total códigos: ${this.equipos.length}</span>
          </div>

          <div class="equipment-chips-grid">
            <button
              type="button"
              class="equipment-chip ${this.filtroEquipo === 'TODOS' ? 'active' : ''}"
              data-filter-code="TODOS"
            >
              <span>📋 Todos</span>
              <span class="chip-count">${this.reportes.length}</span>
            </button>

            ${this.equipos
              .map(
                (eq) => `
              <div class="equipment-chip-group ${this.filtroEquipo === eq.codigo ? 'active' : ''}">
                <button
                  type="button"
                  class="equipment-chip-select"
                  data-filter-code="${this.escapeHtml(eq.codigo)}"
                  title="Filtrar por ${this.escapeHtml(eq.codigo)} — ${this.escapeHtml(eq.categoria || 'Equipo minero')}"
                >
                  <span>🔧 ${this.escapeHtml(eq.codigo)}</span>
                  <span class="chip-count">${conteoPorEquipo[eq.codigo] || 0}</span>
                </button>
                <div class="equipment-chip-actions">
                  <button
                    type="button"
                    class="equipment-chip-action-btn edit"
                    data-edit-equipment="${this.escapeHtml(eq.codigo)}"
                    title="Editar código ${this.escapeHtml(eq.codigo)}"
                    aria-label="Editar código ${this.escapeHtml(eq.codigo)}"
                  >✏️</button>
                  <button
                    type="button"
                    class="equipment-chip-action-btn delete"
                    data-delete-equipment="${this.escapeHtml(eq.codigo)}"
                    title="Borrar código ${this.escapeHtml(eq.codigo)}"
                    aria-label="Borrar código ${this.escapeHtml(eq.codigo)}"
                  >🗑️</button>
                </div>
              </div>
            `
              )
              .join('')}
          </div>
        </section>

        <!-- 2. PANEL DE CREACIÓN DE REPORTE ("NUEVO REPORTE") -->
        <section
          class="section-panel section-panel-creacion ${this.isCreatePanelCollapsed ? 'is-panel-collapsed' : ''}"
          id="section-panel-creacion"
          aria-label="Panel de Creación de Reporte"
        >
          <div class="section-header">
            <div>
              <h2 class="section-title">📝 2. Panel de Creación de Reporte ("Nuevo Reporte")</h2>
            </div>
            <button
              type="button"
              class="btn-mine btn-sm-mine btn-panel-toggle ${this.isCreatePanelCollapsed ? 'is-collapsed' : ''}"
              id="btn-toggle-create-panel"
              aria-expanded="${!this.isCreatePanelCollapsed}"
              aria-controls="create-panel-body"
              title="${this.isCreatePanelCollapsed ? 'Mostrar el formulario para registrar un nuevo reporte' : 'Ocultar el formulario para ver los códigos y la tabla principal más cerca'}"
            >
              ${this.isCreatePanelCollapsed ? '🔽 Mostrar formulario' : '🔼 Ocultar formulario'}
            </button>
          </div>

          <div class="create-panel-body" id="create-panel-body">
          <div class="form-grid">
            <!-- Tarjeta 1: Código de Equipo + Crear Nuevo -->
            <div class="field-group">
              <div>
                <label class="field-label" for="select-codigo-equipo">
                  <span>Código de Equipo (Lista Desplegable) *</span>
                  <span style="color:var(--accent-amber)">Activo: ${this.escapeHtml(this.form.codigo_equipo)}</span>
                </label>
                <select id="select-codigo-equipo" class="select-mine">
                  ${this.equipos
                    .map(
                      (eq) => `
                    <option value="${this.escapeHtml(eq.codigo)}" ${
                        eq.codigo === this.form.codigo_equipo ? 'selected' : ''
                      }>
                      ${this.escapeHtml(eq.codigo)} — ${this.escapeHtml(eq.categoria || 'Equipo')}
                    </option>
                  `
                    )
                    .join('')}
                </select>
              </div>

              <div>
                <div class="new-code-inline">
                  <input
                    type="text"
                    id="input-nuevo-codigo"
                    class="input-mine"
                    placeholder="¿Equipo nuevo? Ej: 793f 05"
                    value="${this.escapeHtml(this.form.nuevo_codigo_input)}"
                  />
                  <button type="button" class="btn-mine btn-primary" id="btn-crear-codigo">
                    + Crear
                  </button>
                </div>
                <div class="norm-preview">
                  ${
                    normPreview
                      ? `Se normalizará como: <strong>${this.escapeHtml(normPreview)}</strong>`
                      : 'Escribe minúsculas o espacios (ej. "793f 05" → "793F-05") y toca "+ Crear".'
                  }
                </div>
              </div>
            </div>

            <!-- Tarjeta 2: Fecha + Tipo -->
            <div class="field-group">
              <div>
                <label class="field-label" for="input-fecha-peru">
                  <span>Fecha *</span>
                  <span id="form-fecha-display" style="font-size:0.86rem; color:var(--accent-blue);">${this.escapeHtml(formatFechaDDMMYYYY(this.form.fecha))}</span>
                </label>
                <input
                  type="date"
                  id="input-fecha-peru"
                  class="input-mine"
                  value="${this.escapeHtml(this.form.fecha)}"
                />
              </div>

              <div>
                <label class="field-label" for="select-tipo">Tipo *</label>
                <select id="select-tipo" class="select-mine">
                  <option value="Observación" ${this.form.tipo === 'Observación' ? 'selected' : ''}>🔍 Observación</option>
                  <option value="Reporte" ${this.form.tipo === 'Reporte' ? 'selected' : ''}>📄 Reporte</option>
                </select>
              </div>
            </div>

            <!-- Tarjeta 3: Prioridad + Calidad de Compresión de Foto -->
            <div class="field-group">
              <div>
                <label class="field-label" for="select-prioridad">Prioridad *</label>
                <select id="select-prioridad" class="select-mine">
                  <option value="Alta" ${this.form.prioridad === 'Alta' ? 'selected' : ''}>🔴 Alta</option>
                  <option value="Media" ${this.form.prioridad === 'Media' ? 'selected' : ''}>🟡 Media</option>
                  <option value="Baja" ${this.form.prioridad === 'Baja' ? 'selected' : ''}>🔵 Baja</option>
                </select>
              </div>

              <div>
                <label class="field-label" for="select-calidad">
                  <span>Calidad de Compresión de Foto (P3) *</span>
                </label>
                <select id="select-calidad" class="select-mine">
                  <option value="estandar" ${this.form.calidad_compresion === 'estandar' ? 'selected' : ''}>
                    ⚡ Estándar (1600 px / &lt; 400 KB) — Recomendado
                  </option>
                  <option value="alta" ${this.form.calidad_compresion === 'alta' ? 'selected' : ''}>
                    🔎 Alta Nitidez (2048 px / &lt; 800 KB) — Placas / Fisuras
                  </option>
                </select>
                <div class="norm-preview">
                  Toda foto se comprime en el dispositivo <strong>antes</strong> de guardarse en IndexedDB.
                </div>
              </div>
            </div>
          </div>

          <!-- Captura Multimedia Inicial (1 a 5 fotos + 1 video corto opcional) -->
          <div class="media-capture-box">
            <div class="field-label" style="margin-bottom: 0.65rem;">
              <span>📸 Multimedia Inicial del Reporte: Fotos (${this.form.fotos_locales.length} / 5 obligatorias) y Video Opcional (${this.form.video_local ? '1 / 1' : '0 / 1'})</span>
              ${this.isCompressing ? `<span style="color:var(--accent-amber)">⏳ Comprimiendo imagen...</span>` : ''}
            </div>

            <!-- Inputs ocultos para Cámara, Galería y Video -->
            <input type="file" id="file-camera-main" accept="image/*" capture="environment" style="display:none" />
            <input type="file" id="file-attach-main" accept="image/*" multiple style="display:none" />
            <input type="file" id="file-video-main" accept="video/mp4,video/webm,video/quicktime" style="display:none" />

            <div class="media-buttons-row">
              <button
                type="button"
                class="btn-mine btn-primary"
                id="btn-camera-main"
                ${this.form.fotos_locales.length >= 5 ? 'disabled' : ''}
              >
                📷 Cámara (${this.form.fotos_locales.length}/5)
              </button>

              <button
                type="button"
                class="btn-mine btn-secondary"
                id="btn-attach-main"
                ${this.form.fotos_locales.length >= 5 ? 'disabled' : ''}
              >
                📎 Adjuntar Fotos
              </button>

              <button
                type="button"
                class="btn-mine"
                id="btn-video-main"
              >
                🎥 ${this.form.video_local ? 'Cambiar Video Opcional' : 'Adjuntar Video (Máx 20 MB)'}
              </button>

              <button
                type="button"
                class="btn-mine btn-sm-mine"
                id="btn-sim-photo-main"
                ${this.form.fotos_locales.length >= 5 ? 'disabled' : ''}
                title="Genera una foto de alta resolución de placa minera y la pasa por el compresor real"
              >
                🧪 Generar Foto Placa de Prueba
              </button>
            </div>

            <!-- Vista previa de las 1 a 5 fotos y video opcional -->
            ${
              this.form.fotos_locales.length > 0 || this.form.video_local
                ? `
              <div class="thumbs-list">
                ${this.form.fotos_locales
                  .map((foto, idx) => {
                    const url = this.createObjectUrl(foto.blob);
                    return `
                    <div class="thumb-card">
                      <div class="thumb-img-wrap" data-preview-main-photo="${idx}" title="Toca para ampliar">
                        <img src="${url}" alt="Foto ${idx + 1}" />
                      </div>
                      <div class="thumb-meta">
                        <strong>Foto #${idx + 1} (${foto.ancho}×${foto.alto} px)</strong>
                        <span style="color:var(--accent-green); font-weight:700;">
                          Peso final: ${formatBytes(foto.peso_bytes)}
                        </span>
                        <span>Original: ${formatBytes(foto.peso_original_bytes)}</span>
                      </div>
                      <button type="button" class="btn-mine btn-sm-mine btn-danger" data-remove-main-photo="${idx}">
                        ✕ Quitar
                      </button>
                    </div>
                  `;
                  })
                  .join('')}

                ${
                  this.form.video_local
                    ? (() => {
                        const vUrl = this.createObjectUrl(this.form.video_local.blob);
                        return `
                        <div class="thumb-card">
                          <div class="thumb-img-wrap">
                            <video src="${vUrl}" controls preload="metadata"></video>
                          </div>
                          <div class="thumb-meta">
                            <strong>🎥 Video Opcional</strong>
                            <span style="color:var(--accent-blue); font-weight:700;">
                              Peso: ${formatBytes(this.form.video_local.peso_bytes)}
                            </span>
                            <span>${this.escapeHtml(this.form.video_local.mime_type)}</span>
                          </div>
                          <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-remove-main-video">
                            ✕ Quitar Video
                          </button>
                        </div>
                      `;
                      })()
                    : ''
                }
              </div>
            `
                : ''
            }
          </div>

          <!-- Observación Principal y botón "+ Agregar otra observación" -->
          <div class="field-group" style="margin-top: 1rem;">
            <label class="field-label" for="textarea-observacion">
              <span>📌 Observación Principal / Hallazgo en Campo * <span class="required-comment-hint">(Obligatorio — sin comentario no se guardará)</span></span>
            </label>
            <textarea
              id="textarea-observacion"
              required
              aria-invalid="${this.obsValidationError ? 'true' : 'false'}"
              class="textarea-mine${this.obsValidationError ? ' field-error-input' : ''}"
              placeholder="Describe el hallazgo, componente, código en placa o condición operativa..."
            >${this.escapeHtml(this.form.observacion)}</textarea>
            ${
              this.obsValidationError
                ? `<div id="main-obs-error" class="inline-field-error" role="alert">⚠️ ${this.escapeHtml(this.obsValidationError)}</div>`
                : ''
            }
          </div>

          <!-- Lista dinámica de "+ Agregar otra observación" -->
          ${
            this.form.observaciones_adicionales.length > 0
              ? `
            <div class="extra-obs-list">
              ${this.form.observaciones_adicionales
                .map((extra, idx) => {
                  return `
                  <div class="extra-obs-card">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.65rem;">
                      <strong>↳ Observación / Seguimiento Adicional #${idx + 1}</strong>
                      <button type="button" class="btn-mine btn-sm-mine btn-danger" data-remove-extra="${idx}">
                        ✕ Quitar esta observación
                      </button>
                    </div>

                    <div class="form-grid" style="margin-bottom:0.65rem;">
                      <div class="field-group">
                        <label class="field-label">Modo de registro</label>
                        <select class="select-mine" data-extra-modo="${idx}">
                          <option value="seguimiento" ${extra.modo === 'seguimiento' ? 'selected' : ''}>
                            ↳ Subsección de Seguimiento alineada en este reporte
                          </option>
                          <option value="independiente" ${extra.modo === 'independiente' ? 'selected' : ''}>
                            📌 Fila de observación adicional para ${this.escapeHtml(this.form.codigo_equipo)}
                          </option>
                        </select>
                      </div>

                      <div class="field-group">
                        <label class="field-label">Fecha de este punto</label>
                        <input type="date" class="input-mine" data-extra-fecha="${idx}" value="${this.escapeHtml(extra.fecha)}" />
                      </div>

                      <div class="field-group">
                        <label class="field-label">Estado de la observación</label>
                        <select class="select-mine" data-extra-estado="${idx}">
                          <option value="Sigue observación" ${extra.estado_seguimiento === 'Sigue observación' ? 'selected' : ''}>
                            ⚠️ Sigue observación
                          </option>
                          <option value="Observación controlada" ${extra.estado_seguimiento === 'Observación controlada' ? 'selected' : ''}>
                            🛠️ En monitoreo / controlada
                          </option>
                        </select>
                      </div>
                    </div>

                    <div class="field-group" style="margin-bottom:0.65rem;">
                      <label class="field-label">Comentario / Detalle de esta observación adicional</label>
                      <textarea class="textarea-mine" data-extra-comentario="${idx}" placeholder="Escribe el comentario de seguimiento o la observación adicional...">${this.escapeHtml(extra.comentario)}</textarea>
                    </div>

                    <div class="media-buttons-row">
                      <input type="file" id="file-extra-cam-${idx}" accept="image/*" capture="environment" style="display:none" />
                      <input type="file" id="file-extra-att-${idx}" accept="image/*" multiple style="display:none" />
                      <button type="button" class="btn-mine btn-sm-mine btn-primary" data-extra-cam-btn="${idx}">
                        📷 Cámara Seg. (${extra.fotos_locales.length}/5)
                      </button>
                      <button type="button" class="btn-mine btn-sm-mine btn-secondary" data-extra-att-btn="${idx}">
                        📎 Adjuntar Foto Seg.
                      </button>
                      <button type="button" class="btn-mine btn-sm-mine" data-extra-sim-btn="${idx}">
                        🧪 Foto Placa Seg.
                      </button>
                    </div>

                    ${
                      extra.fotos_locales.length > 0
                        ? `
                      <div class="thumbs-list">
                        ${extra.fotos_locales
                          .map((f, fIdx) => {
                            const fUrl = this.createObjectUrl(f.blob);
                            return `
                            <div class="thumb-card">
                              <div class="thumb-img-wrap">
                                <img src="${fUrl}" alt="Seg foto ${fIdx + 1}" />
                              </div>
                              <div class="thumb-meta">
                                <strong>Foto Seg. #${fIdx + 1}</strong>
                                <span>${formatBytes(f.peso_bytes)}</span>
                              </div>
                            </div>
                          `;
                          })
                          .join('')}
                      </div>
                    `
                        : ''
                    }
                  </div>
                `;
                })
                .join('')}
            </div>
          `
              : ''
          }

          <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:0.85rem; margin-top: 1.15rem; padding-top: 1rem; border-top: 2px solid var(--border-strong);">
            <button type="button" class="btn-mine btn-secondary" id="btn-add-extra-obs">
              + Agregar otra observación
            </button>

            <button type="button" class="btn-mine btn-primary" id="btn-guardar-reporte" style="min-width: 260px; font-size: 1.05rem;">
              💾 Guardar Reporte en Dispositivo
            </button>
          </div>
          </div>
        </section>

        <!-- 3. TABLA PRINCIPAL CON ORDEN DE LECTURA OPERATIVO -->
        <section class="section-panel section-panel-tabla" id="section-tabla-principal" aria-label="Tabla Principal con Orden de Lectura Operativo">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                ${
                  this.vistaTabla === 'levantadas'
                    ? `✅ 3. Observaciones Levantadas (${
                        this.filtroEquipo === 'TODOS'
                          ? `Todos los equipos: ${reportesLevantados.length}`
                          : `Equipo ${this.escapeHtml(this.filtroEquipo)}: ${reportesLevantados.length}`
                      })`
                    : `📊 3. Tabla Principal (${
                        this.filtroEquipo === 'TODOS'
                          ? `Todos los equipos: ${reportesActivos.length}`
                          : `Filtrado por equipo ${this.escapeHtml(this.filtroEquipo)}: ${reportesActivos.length}`
                      })`
                }
              </h2>
              ${
                this.vistaTabla === 'levantadas'
                  ? `<p class="brand-subtitle">Historial de observaciones cerradas/levantadas. Puedes cambiar su estado para devolverlas al Panel Principal.</p>`
                  : ''
              }
            </div>
            ${
              this.filtroEquipo !== 'TODOS'
                ? `
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-clear-filter">
                Mostrar Todos los Equipos
              </button>
            `
                : ''
            }
          </div>

          <div class="table-status-tabs" role="tablist" aria-label="Vista de observaciones activas vs levantadas">
            <button
              type="button"
              role="tab"
              aria-selected="${this.vistaTabla === 'activas'}"
              class="table-status-tab-btn ${this.vistaTabla === 'activas' ? 'active' : ''}"
              data-switch-table-tab="activas"
            >
              <span>📋 Panel Principal — Observaciones Activas</span>
              <span class="chip-count">${reportesActivos.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="${this.vistaTabla === 'levantadas'}"
              class="table-status-tab-btn tab-levantadas ${this.vistaTabla === 'levantadas' ? 'active' : ''}"
              data-switch-table-tab="levantadas"
            >
              <span>✅ Observaciones Levantadas</span>
              <span class="chip-count">${reportesLevantados.length}</span>
            </button>
          </div>

          <div class="table-responsive">
            <table class="operational-table report-main-table">
              <thead>
                <tr>
                  <th style="width: 16%;">1. Equipo / Fecha</th>
                  <th style="width: 19%;">2. Vista Previa (Inicial / Seg.)</th>
                  <th style="width: 39%;">3. Observación Principal y Comentarios Posteriores</th>
                  <th style="width: 14%;">4. Tipo / Prioridad</th>
                  <th style="width: 12%;">5. Estado</th>
                </tr>
              </thead>
              <tbody>
                ${
                  reportesVisibles.length === 0
                    ? `
                  <tr>
                    <td colspan="5" style="text-align:center; padding: 2rem; color: var(--text-muted);">
                      ${
                        this.vistaTabla === 'levantadas'
                          ? 'No hay observaciones levantadas para el filtro seleccionado.'
                          : 'No hay observaciones activas pendientes para el filtro seleccionado. Usa el panel superior para registrar una nueva o revisa la pestaña "✅ Observaciones Levantadas".'
                      }
                    </td>
                  </tr>
                `
                    : reportesVisibles.map((rep, repIdx) => this.renderTableRow(rep, repIdx)).join('')
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>

      ${this.renderViewerModal()}
      ${this.renderFollowupModal()}
      ${this.renderDeleteConfirmModal()}
      ${this.renderEditReportModal()}
      ${this.renderEditEquipmentModal()}
      ${this.renderDeleteEquipmentModal()}
    `;

    this.attachEvents();
  }

  renderTableRow(rep, repIdx = 0) {
    const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
    const isReportLevantada = this.isReportLevantada(rep);
    const totalRows = 1 + seguimientos.length;
    const groupStripeClass = repIdx % 2 === 1 ? 'report-group-even' : 'report-group-odd';
    const initialRowClasses = `report-row-initial ${groupStripeClass}${seguimientos.length === 0 ? ' report-row-last' : ''}`;
    const prioClass =
      rep.prioridad === 'Alta'
        ? 'badge-alta'
        : rep.prioridad === 'Media'
        ? 'badge-media'
        : 'badge-baja';

    const spacerRowHtml =
      repIdx > 0
        ? `<tr class="report-block-spacer" aria-hidden="true"><td colspan="5"></td></tr>`
        : '';

    const initialRowHtml = `
      ${spacerRowHtml}
      <tr class="${initialRowClasses}" data-report-id="${this.escapeHtml(rep.id)}">
        <!-- COL 1: EQUIPO / FECHA -->
        <td class="report-slot-cell report-equip-cell">
          <div style="display:flex; flex-direction:column; gap:0.45rem;">
            <button
              type="button"
              class="btn-mine btn-sm-mine btn-primary"
              data-filter-code="${this.escapeHtml(rep.codigo_equipo)}"
              title="Filtrar por este equipo"
            >
              🚜 ${this.escapeHtml(rep.codigo_equipo)}
            </button>
            <div class="equip-date-box">
              <div style="font-size:0.74rem; color:var(--text-muted); font-weight:700;">📌 Fecha Inicial</div>
              <div style="font-size:0.96rem; font-weight:900; margin-top:0.12rem; white-space:nowrap;">📅 ${this.escapeHtml(formatFechaDDMMYYYY(rep.fecha))}</div>
            </div>
            <span style="font-size:0.75rem; color:var(--text-muted);">
              ID: ${this.escapeHtml(rep.id.slice(0, 8))}
            </span>
            ${
              rep.es_nuevo_codigo
                ? `<span class="badge badge-baja">Código nuevo</span>`
                : ''
            }
          </div>
        </td>

        <!-- COL 2: VISTA PREVIA (INICIAL) -->
        <td class="report-slot-cell">
          <div class="slot-initial slot-preview-top">
            <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700; margin-bottom:0.25rem;">
              📌 Inicial (${(rep.fotos_locales || []).length} foto(s)${rep.video_local ? ' + 1 video' : ''})
            </div>
            <div class="preview-strip">
              ${(rep.fotos_locales || [])
                .map((f, fIdx) => {
                  const url = f.blob ? this.createObjectUrl(f.blob) : (f.signedUrl || '');
                  return `
                  <img
                    src="${url}"
                    alt="Miniatura inicial ${fIdx + 1}"
                    class="table-thumb"
                    data-open-viewer="${this.escapeHtml(rep.id)}"
                    data-viewer-seg="null"
                    data-viewer-idx="${fIdx}"
                    title="Toca para inspeccionar placa / detalle (${f.ancho}x${f.alto}px)"
                  />
                `;
                })
                .join('')}
              ${
                rep.video_local
                  ? `
                <button
                  type="button"
                  class="btn-mine btn-sm-mine"
                  data-open-video="${this.escapeHtml(rep.id)}"
                  data-viewer-seg="null"
                >
                  🎥 Ver Video
                </button>
              `
                  : ''
              }
            </div>
          </div>
        </td>

        <!-- COL 3: OBSERVACIÓN PRINCIPAL -->
        <td class="report-slot-cell">
          <div class="slot-initial">
            <div>
              <div style="font-size:0.76rem; font-weight:800; color:var(--accent-blue); margin-bottom:0.2rem;">
                📌 Observación Principal
              </div>
              <div style="font-size:0.92rem;">${this.escapeHtml(rep.observacion)}</div>
            </div>
            <div class="obs-actions-row">
              <div class="obs-actions-left">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-obs-action"
                  data-open-followup-modal="${this.escapeHtml(rep.id)}"
                  title="Agregar seguimiento posterior (↳)"
                >
                  + Seg. (↳)
                </button>
                ${
                  !isReportLevantada
                    ? `
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine btn-success btn-obs-action"
                    data-open-resolve-modal="${this.escapeHtml(rep.id)}"
                    title="Marcar observación como levantada / cerrada"
                  >
                    ✅ Levantar
                  </button>
                `
                    : `<span class="badge badge-resolved">✅ Observación Levantada</span>`
                }
              </div>
              <div class="obs-actions-right">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-secondary btn-icon-square"
                  data-open-edit-modal="${this.escapeHtml(rep.id)}"
                  aria-label="Editar observación"
                  title="Editar equipo, fecha, tipo, prioridad, observación o fotos de esta fila"
                >
                  ✏️
                </button>
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-danger btn-icon-square"
                  data-request-delete-report="${this.escapeHtml(rep.id)}"
                  aria-label="Borrar observación"
                  title="Borrar toda esta fila de observación y sus seguimientos"
                >
                  🗑️
                </button>
              </div>
            </div>
            ${
              isReportLevantada
                ? `
              <div class="reopen-observation-box">
                <label class="reopen-label" for="reopen-state-${this.escapeHtml(rep.id)}">
                  ¿Reabrir o devolver al Panel Principal? Elige el nuevo estado:
                </label>
                <div class="reopen-controls-row">
                  <select
                    id="reopen-state-${this.escapeHtml(rep.id)}"
                    class="select-mine select-sm-reopen"
                    data-reopen-state-select="${this.escapeHtml(rep.id)}"
                  >
                    <option value="Sigue observación">⚠️ Sigue observación</option>
                    <option value="En monitoreo">🛠️ En monitoreo</option>
                  </select>
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine btn-primary"
                    data-reopen-report-btn="${this.escapeHtml(rep.id)}"
                  >
                    ↩️ Cambiar Estado y Volver al Panel Principal
                  </button>
                </div>
              </div>
            `
                : ''
            }
          </div>
        </td>

        <!-- COL 4: TIPO / PRIORIDAD -->
        <td rowspan="${totalRows}" class="report-span-cell">
          <div style="display:flex; flex-direction:column; gap:0.4rem;">
            <span class="badge badge-prio-pill ${prioClass}">
              <span class="prio-dot" aria-hidden="true">●</span> ${this.escapeHtml((rep.prioridad || 'Media').toUpperCase())}
            </span>
            <span class="tipo-text-subtle">
              ${rep.tipo === 'Observación' ? '🔍' : '📄'} ${this.escapeHtml(rep.tipo)}
            </span>
          </div>
        </td>

        <!-- COL 5: ESTADO -->
        <td rowspan="${totalRows}" class="report-span-cell">
          <div style="display:flex; flex-direction:column; gap:0.4rem;">
            ${
              rep.sincronizado_en_nube_real
                ? `<span class="status-synced-subtle">☁️ En nube</span>`
                : `<span class="badge badge-pending">⏳ Pendiente</span>`
            }
          </div>
        </td>
      </tr>
    `;

    const followupRowsHtml = seguimientos
      .map((seg, sIdx) => {
        const isLastSeg = sIdx === seguimientos.length - 1;
        const isResolvedSeg = this.isSegLevantada(seg);
        const slotClass = isResolvedSeg ? 'slot-followup slot-resolved' : 'slot-followup';
        const labelColor = isResolvedSeg ? '#15803d' : 'var(--accent-amber)';
        const segRowClasses = `report-row-followup ${groupStripeClass}${isLastSeg ? ' report-row-last' : ''}`;
        const segFotos = seg.fotos_locales || [];

        return `
      <tr class="${segRowClasses}" data-report-id="${this.escapeHtml(rep.id)}" data-seg-row="${sIdx}">
        <!-- COL 1: FECHA SEGUIMIENTO #${sIdx + 1} + DÍAS DESDE FECHA INICIAL -->
        <td class="report-slot-cell report-elapsed-cell">
          <div class="elapsed-followup-slot ${isResolvedSeg ? 'is-resolved' : ''}">
            <div style="font-size:0.76rem; color:${labelColor}; font-weight:800; text-align:center;">
              ${isResolvedSeg ? `↳ ✅ Levantada (#${sIdx + 1})` : `↳ Seguimiento #${sIdx + 1}`}
            </div>
            <div style="font-size:0.96rem; font-weight:900; white-space:nowrap;">
              📅 ${this.escapeHtml(formatFechaDDMMYYYY(seg.fecha))}
            </div>
            <span
              class="elapsed-days-badge ${isResolvedSeg ? 'is-resolved' : ''}"
              title="Días transcurridos desde ${this.escapeHtml(formatFechaDDMMYYYY(rep.fecha))} hasta ${this.escapeHtml(formatFechaDDMMYYYY(seg.fecha))}"
            >
              ⏱️ ${this.escapeHtml(formatDiasTranscurridos(rep.fecha, seg.fecha))}
            </span>
            <span class="elapsed-days-caption">desde inicio de reporte</span>
          </div>
        </td>

        <!-- COL 2: VISTA PREVIA SEGUIMIENTO #${sIdx + 1} -->
        <td class="report-slot-cell">
          <div class="${slotClass} slot-preview-top">
            <div style="font-size:0.75rem; color:${labelColor}; font-weight:700; margin-bottom:0.25rem;">
              ${
                isResolvedSeg ? `↳ Vista Cierre #${sIdx + 1}` : `↳ Vista Seg. #${sIdx + 1}`
              } (${segFotos.length} foto(s)${seg.video_local ? ' + 1 video' : ''})
            </div>
            <div class="preview-strip">
              ${
                segFotos.length === 0 && !seg.video_local
                  ? `<span style="font-size:0.78rem; color:var(--text-muted);">Sin foto adjunta</span>`
                  : segFotos
                      .map((f, fIdx) => {
                        const url = f.blob ? this.createObjectUrl(f.blob) : (f.signedUrl || '');
                        return `
                        <img
                          src="${url}"
                          alt="Miniatura seg ${fIdx + 1}"
                          class="table-thumb"
                          data-open-viewer="${this.escapeHtml(rep.id)}"
                          data-viewer-seg="${sIdx}"
                          data-viewer-idx="${fIdx}"
                        />
                      `;
                      })
                      .join('')
              }
            </div>
          </div>
        </td>

        <!-- COL 3: COMENTARIO POSTERIOR SEGUIMIENTO #${sIdx + 1} -->
        <td class="report-slot-cell">
          <div class="${slotClass}">
            <div>
              ${
                isResolvedSeg
                  ? `<span class="badge badge-resolved" style="margin-bottom:0.3rem;">↳ ✅ Observación Levantada</span>`
                  : `<span class="badge badge-media" style="margin-bottom:0.3rem;">↳ ⚠️ ${this.escapeHtml(seg.estado_seguimiento || 'Sigue observación')}</span>`
              }
              <div style="font-size:0.9rem; margin-top:0.2rem;">
                ${this.escapeHtml(seg.comentario)}
              </div>
            </div>
            <div class="obs-actions-row">
              <span style="font-size:0.73rem; color:var(--text-muted);">
                ${isResolvedSeg ? `Cierre / Levantamiento (#${sIdx + 1})` : `Comentario posterior #${sIdx + 1}`}
              </span>
              <div class="obs-actions-right">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-secondary btn-icon-square"
                  data-edit-followup="${this.escapeHtml(rep.id)}"
                  data-seg-idx="${sIdx}"
                  aria-label="Editar seguimiento"
                  title="Editar fecha, estado, comentario o fotos de este seguimiento"
                >
                  ✏️
                </button>
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-danger btn-icon-square"
                  data-delete-followup="${this.escapeHtml(rep.id)}"
                  data-seg-idx="${sIdx}"
                  aria-label="Borrar seguimiento"
                  title="Borrar solo este seguimiento (mantiene la observación principal)"
                >
                  🗑️
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
      })
      .join('');

    return `${initialRowHtml}${followupRowsHtml}`;
  }

  initViewerDrawCanvas() {
    if (!this.viewerModal?.isEditing || this.viewerModal?.isVideo) {
      this._viewerDrawState = null;
      return;
    }

    const img = this.rootEl.querySelector('#viewer-base-img');
    const canvas = this.rootEl.querySelector('#viewer-draw-canvas');
    if (!img || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const state = {
      canvas,
      ctx,
      isDrawing: false,
      activePointerId: null,
      undoStack: []
    };
    this._viewerDrawState = state;

    const setup = () => {
      const w = img.naturalWidth || canvas.clientWidth || 1200;
      const h = img.naturalHeight || canvas.clientHeight || 800;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    };

    if (img.complete && img.naturalWidth > 0) {
      setup();
    } else {
      img.addEventListener('load', setup, { once: true });
    }

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? canvas.width / rect.width : 1;
      const scaleY = rect.height ? canvas.height / rect.height : 1;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.viewerModal?.isEditing || this.viewerModal?.isSavingEdit) return;
      e.preventDefault();
      if (canvas.width === 0 || canvas.height === 0 || (canvas.width === 300 && canvas.height === 150 && img.naturalWidth > 0)) {
        setup();
      }
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch {
        // Algunos eventos sintéticos no admiten pointer capture
      }

      if (canvas.width > 0 && canvas.height > 0) {
        if (state.undoStack.length >= 20) state.undoStack.shift();
        state.undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      }

      const scaleFactor = Math.max(1, canvas.width / 800);
      const size = Number(this.viewerModal.drawSize) || 5;
      if (this.viewerModal.drawTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = size * 3 * scaleFactor;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = this.viewerModal.drawColor || '#EF4444';
        ctx.lineWidth = size * scaleFactor;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const { x, y } = getPos(e);
      state.isDrawing = true;
      state.activePointerId = e.pointerId;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.01, y + 0.01);
      ctx.stroke();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!state.isDrawing || state.activePointerId !== e.pointerId) return;
      e.preventDefault();
      const { x, y } = getPos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    });

    const stopDrawing = (e) => {
      if (!state.isDrawing || state.activePointerId !== e.pointerId) return;
      state.isDrawing = false;
      state.activePointerId = null;
      ctx.closePath();
      try {
        canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    };

    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
  }

  async handleSaveEditedViewerPhoto() {
    if (!this.viewerModal || this.viewerModal.isSavingEdit || this.viewerModal.isVideo) return;

    const m = this.viewerModal;
    const drawCanvas = this._viewerDrawState?.canvas || this.rootEl.querySelector('#viewer-draw-canvas');
    const saveBtn = this.rootEl.querySelector('#btn-save-viewer-edit');
    const cancelEditBtn = this.rootEl.querySelector('#btn-cancel-viewer-edit');

    m.isSavingEdit = true;
    m.editError = null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Guardando...';
    }
    if (cancelEditBtn) cancelEditBtn.disabled = true;

    let tempObjUrl = '';
    try {
      let baseBlob = m.blob || null;
      if (!baseBlob && m.signedUrl) {
        const res = await fetch(m.signedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} al descargar imagen base.`);
        baseBlob = await res.blob();
      }
      if (!baseBlob) {
        throw new Error('No se encontró la imagen original para guardar.');
      }

      tempObjUrl = URL.createObjectURL(baseBlob);
      const baseImg = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('No se pudo cargar la imagen base para exportar.'));
        im.src = tempObjUrl;
      });

      const w = baseImg.naturalWidth || drawCanvas?.width || 1200;
      const h = baseImg.naturalHeight || drawCanvas?.height || 800;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = w;
      exportCanvas.height = h;
      const exportCtx = exportCanvas.getContext('2d');
      exportCtx.drawImage(baseImg, 0, 0, w, h);

      if (drawCanvas && drawCanvas.width > 0 && drawCanvas.height > 0) {
        exportCtx.drawImage(drawCanvas, 0, 0, w, h);
      }

      const rawEditedBlob = await new Promise((resolve, reject) => {
        exportCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen editada.'))),
          'image/jpeg',
          0.9
        );
      });

      const editedFile = new File([rawEditedBlob], m.filename || 'foto_editada.jpg', {
        type: 'image/jpeg'
      });
      const compressed = await compressPhotoFile(editedFile, m.calidad || 'estandar');

      if (m.source === 'form') {
        const prev = this.form.fotos_locales[m.fotoIndex];
        if (prev) {
          this.form.fotos_locales[m.fotoIndex] = {
            ...prev,
            ...compressed
          };
        }
        this.viewerModal = {
          ...m,
          blob: compressed.blob,
          signedUrl: '',
          isEditing: false,
          isSavingEdit: false,
          editError: null,
          meta: `Resolución: ${compressed.ancho}×${compressed.alto} px | Peso comprimido: ${formatBytes(compressed.peso_bytes)} (Editada)`
        };
        this._viewerDrawState = null;
        this.render();
        return;
      }

      const reporte = await this._getWritableReport(m.reporteId);
      if (!reporte) throw new Error('No se encontró el reporte de esta foto.');

      const targetList =
        m.segIndex === null || m.segIndex === undefined
          ? reporte.fotos_locales
          : reporte.seguimientos?.[m.segIndex]?.fotos_locales;

      if (!Array.isArray(targetList) || !targetList[m.fotoIndex]) {
        throw new Error('No se encontró la foto objetivo dentro del reporte.');
      }

      const prevPhoto = targetList[m.fotoIndex];
      targetList[m.fotoIndex] = {
        ...prevPhoto,
        ...compressed,
        indice: prevPhoto.indice || m.fotoIndex + 1,
        ruta_remota: prevPhoto.ruta_remota || undefined,
        signedUrl: ''
      };

      reporte.estado = 'pendiente';
      reporte.sincronizado_en_nube_real = false;
      reporte.ultimo_error = null;
      reporte.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(reporte);

      await this.reloadData({ skipCloudFetch: true });
      this.viewerModal = {
        ...m,
        blob: compressed.blob,
        signedUrl: '',
        isEditing: false,
        isSavingEdit: false,
        editError: null,
        meta: `Editada: ${compressed.ancho}×${compressed.alto} px | Peso: ${formatBytes(compressed.peso_bytes)}`
      };
      this._viewerDrawState = null;
      this.setBanner('success', 'Foto editada guardada correctamente.');

      this._triggerBackgroundReportSync(reporte.id, 'Foto anotada en visor');
    } catch (err) {
      m.isSavingEdit = false;
      m.editError = err?.message || 'No se pudo guardar la foto editada.';
      this.render();
    } finally {
      if (tempObjUrl) URL.revokeObjectURL(tempObjUrl);
    }
  }

  renderViewerModal() {
    if (!this.viewerModal) return '';
    const {
      title,
      blob,
      signedUrl,
      isVideo,
      meta,
      isEditing,
      drawTool = 'pencil',
      drawColor = '#EF4444',
      drawSize = 5,
      isSavingEdit = false,
      editError = null
    } = this.viewerModal;
    const url = blob ? this.createObjectUrl(blob) : (signedUrl || '');
    const colors = ['#EF4444', '#FACC15', '#F26522', '#38BDF8', '#FFFFFF'];

    return `
      <div class="modal-backdrop" id="modal-viewer-backdrop">
        <div class="modal-card">
          <div class="section-header">
            <h3 class="section-title">🔍 ${this.escapeHtml(title)}</h3>
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
              ${
                !isVideo && url
                  ? isEditing
                    ? `
                      <button type="button" class="btn-mine btn-sm-mine btn-success" id="btn-save-viewer-edit" ${isSavingEdit ? 'disabled' : ''}>
                        ${isSavingEdit ? '⏳ Guardando...' : '💾 Guardar Foto'}
                      </button>
                      <button type="button" class="btn-mine btn-sm-mine" id="btn-cancel-viewer-edit" ${isSavingEdit ? 'disabled' : ''}>
                        ✕ Salir edición
                      </button>
                    `
                    : `
                      <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-toggle-viewer-edit">
                        ✏️ Editar Foto
                      </button>
                    `
                  : ''
              }
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-download-viewer" ${!url || isSavingEdit ? 'disabled' : ''}>
                ⬇️ Descargar
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-viewer" ${isSavingEdit ? 'disabled' : ''}>
                ✕ Cerrar
              </button>
            </div>
          </div>

          ${
            !isVideo && url && isEditing
              ? `
            <div class="photo-editor-toolbar">
              <div class="photo-editor-group">
                <button type="button" class="btn-mine btn-sm-mine ${drawTool === 'pencil' ? 'tool-active' : ''}" id="btn-tool-pencil">
                  ✏️ Lápiz
                </button>
                <button type="button" class="btn-mine btn-sm-mine ${drawTool === 'eraser' ? 'tool-active' : ''}" id="btn-tool-eraser">
                  🧽 Borrador
                </button>
              </div>

              <div class="photo-editor-group" aria-label="Color de trazo">
                ${colors
                  .map(
                    (c) => `
                  <button
                    type="button"
                    class="draw-color-swatch ${drawColor === c ? 'active' : ''}"
                    data-draw-color="${c}"
                    style="background:${c};"
                    title="Color ${c}"
                    aria-label="Color ${c}"
                  ></button>
                `
                  )
                  .join('')}
              </div>

              <label class="draw-size-control" for="range-draw-size">
                <span>Grosor:</span>
                <input type="range" id="range-draw-size" min="2" max="16" value="${Number(drawSize) || 5}" />
                <span id="label-draw-size">${Number(drawSize) || 5}px</span>
              </label>

              <div class="photo-editor-group">
                <button type="button" class="btn-mine btn-sm-mine" id="btn-draw-undo" title="Deshacer último trazo">
                  ↩️ Deshacer
                </button>
                <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-draw-clear" title="Limpiar todos los trazos">
                  🧹 Limpiar
                </button>
              </div>
            </div>
          `
              : ''
          }

          ${
            editError
              ? `<div id="viewer-edit-error" class="alert-banner alert-error" style="margin-bottom:0.65rem;">⚠️ ${this.escapeHtml(editError)}</div>`
              : ''
          }

          <div class="photo-editor-viewer-box">
            ${
              isVideo
                ? `<video src="${url}" controls autoplay style="max-width:100%; max-height:66vh; border-radius:6px;"></video>`
                : `
                  <div class="photo-editor-stage" id="photo-editor-stage">
                    <img id="viewer-base-img" src="${url}" alt="Inspección de placa" />
                    ${
                      isEditing
                        ? `<canvas id="viewer-draw-canvas" class="photo-editor-canvas"></canvas>`
                        : ''
                    }
                  </div>
                `
            }
          </div>
          <div style="margin-top:0.75rem; font-size:0.88rem; color:var(--text-muted); display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; font-weight:700;">
            <span>${this.escapeHtml(meta || '')}</span>
            <span>${
              isEditing
                ? 'Dibuja directamente sobre la foto con el dedo o el mouse (Lápiz y Borrador solo afectan tus trazos).'
                : 'Verificación de legibilidad de placa / serie (Escenario P3)'
            }</span>
          </div>
        </div>
      </div>
    `;
  }

  renderFollowupModal() {
    if (!this.followupModal) return '';
    const m = this.followupModal;
    const isEditMode = m.editSegIndex !== undefined && m.editSegIndex !== null;
    const segNumber = isEditMode ? m.editSegIndex + 1 : null;
    const isUploading = Boolean(m.isUploadingPhotos);
    const isSaving = Boolean(m.isSaving);
    const isBusy = isUploading || isSaving;
    const photoCount = m.fotos_locales.length;

    let statusPillHtml = `<span class="followup-status-pill empty">Sin foto adjunta</span>`;
    if (isUploading) {
      statusPillHtml = `<span class="followup-status-pill uploading">⏳ Procesando foto(s)...</span>`;
    } else if (photoCount > 0) {
      statusPillHtml = `<span class="followup-status-pill ready">✅ ${photoCount} foto(s) ${isEditMode ? 'en el seguimiento' : 'lista(s) para subir'}</span>`;
    }

    const thumbsHtml = m.fotos_locales
      .map((f, fIdx) => {
        const url = f.blob ? this.createObjectUrl(f.blob) : f.signedUrl || '';
        const sizeLabel = f.peso_bytes ? formatBytes(f.peso_bytes) : 'Nube';
        return `
          <div class="followup-thumb-chip">
            <button
              type="button"
              class="followup-thumb-remove"
              data-remove-modal-seg-photo="${fIdx}"
              title="Quitar foto #${fIdx + 1}"
              aria-label="Quitar foto ${fIdx + 1}"
              ${isBusy ? 'disabled' : ''}
            >✕</button>
            <img src="${url}" alt="Miniatura seguimiento ${fIdx + 1}" class="followup-thumb-img" />
            <div class="followup-thumb-caption">
              <span class="followup-thumb-ok">✓ #${fIdx + 1}</span>
              <span>${sizeLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const uploadingCardHtml = isUploading
      ? `
        <div class="followup-thumb-uploading">
          <span class="followup-spinner" aria-hidden="true"></span>
          <span>Subiendo (${m.uploadingCount || 1})...</span>
        </div>
      `
      : '';

    const isResolveMode = m.mode === 'levantada';
    const isResolvedState = this.isSegLevantada({ estado_seguimiento: m.estado_seguimiento });
    const modalTitle = isEditMode
      ? isResolveMode
        ? `✏️ Editar Cierre / Levantamiento #${segNumber} — Equipo ${this.escapeHtml(m.codigo_equipo)}`
        : `✏️ Editar Seguimiento #${segNumber} — Equipo ${this.escapeHtml(m.codigo_equipo)}`
      : isResolveMode
        ? `✅ Levantar Observación — Equipo ${this.escapeHtml(m.codigo_equipo)}`
        : `↳ Nuevo Seguimiento para Equipo ${this.escapeHtml(m.codigo_equipo)}`;

    return `
      <div class="modal-backdrop" id="modal-followup-backdrop">
        <div class="modal-card">
          <div class="section-header${isResolveMode ? ' modal-header-resolved' : ''}">
            <h3 class="section-title">${modalTitle}</h3>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-followup" ${isBusy ? 'disabled' : ''}>
              ✕ Cancelar
            </button>
          </div>

          <div class="form-grid">
            <div class="field-group">
              <label class="field-label">${
                isResolveMode ? 'Fecha de Levantamiento' : 'Fecha del Seguimiento'
              }</label>
              <input type="date" id="modal-seg-fecha" class="input-mine" value="${this.escapeHtml(m.fecha)}" />
            </div>

            <div class="field-group">
              <label class="field-label">Estado de la Observación</label>
              ${
                !isEditMode && isResolveMode
                  ? `<div class="resolved-state-readonly">✅ Observación Levantada</div>`
                  : `
                <select id="modal-seg-estado" class="select-mine">
                  <option value="Sigue observación" ${m.estado_seguimiento === 'Sigue observación' ? 'selected' : ''}>
                    ⚠️ Sigue observación
                  </option>
                  <option value="En monitoreo" ${m.estado_seguimiento === 'En monitoreo' ? 'selected' : ''}>
                    🛠️ En monitoreo
                  </option>
                  ${
                    isEditMode
                      ? `<option value="Observación Levantada" ${isResolvedState ? 'selected' : ''}>✅ Observación Levantada</option>`
                      : ''
                  }
                </select>
              `
              }
            </div>
          </div>

          <div class="field-group" style="margin-top:0.85rem;">
            <label class="field-label" for="modal-seg-comentario">
              <span>${isResolveMode ? 'Comentario de Levantamiento / Cierre *' : 'Comentario Posterior *'} <span class="required-comment-hint">(Obligatorio — sin comentario no se guardará)</span></span>
            </label>
            <textarea
              id="modal-seg-comentario"
              required
              aria-invalid="${m.validationError ? 'true' : 'false'}"
              class="textarea-mine${m.validationError ? ' field-error-input' : ''}"
              placeholder="${
                isResolveMode
                  ? 'Describe la corrección o trabajo realizado para levantar la observación...'
                  : 'Describe la evolución de la observación o el trabajo realizado...'
              }"
            >${this.escapeHtml(m.comentario)}</textarea>
            ${
              m.validationError
                ? `<div id="modal-seg-error" class="inline-field-error" role="alert">⚠️ ${this.escapeHtml(m.validationError)}</div>`
                : ''
            }
          </div>

          <div class="media-capture-box">
            <div class="field-label" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.45rem; margin-bottom:0.55rem;">
              <span>${isResolveMode ? 'Evidencia del Levantamiento' : 'Evidencia del Seguimiento'} (${photoCount}/5 fotos)</span>
              ${statusPillHtml}
            </div>
            <input type="file" id="modal-seg-file" accept="image/*" multiple style="display:none" />
            <div class="followup-media-row">
              <div class="media-buttons-row">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-primary"
                  id="btn-modal-seg-photo"
                  ${photoCount >= 5 || isBusy ? 'disabled' : ''}
                >
                  ${isUploading ? '⏳ Procesando...' : '📷 / 📎 Adjuntar Foto de Seguimiento'}
                </button>
                <button
                  type="button"
                  class="btn-mine btn-sm-mine"
                  id="btn-modal-seg-sim"
                  ${photoCount >= 5 || isBusy ? 'disabled' : ''}
                >
                  🧪 Generar Foto Placa de Seguimiento
                </button>
              </div>
              <div class="followup-thumbs-inline" aria-live="polite">
                ${thumbsHtml}${uploadingCardHtml}
              </div>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:0.75rem; margin-top:1rem;">
            <button
              type="button"
              class="btn-mine ${isResolveMode ? 'btn-success' : 'btn-primary'}"
              id="btn-save-followup"
              ${isBusy ? 'disabled' : ''}
            >
              ${
                isSaving
                  ? isEditMode
                    ? '⏳ Guardando cambios...'
                    : isResolveMode
                      ? '⏳ Guardando cierre...'
                      : '⏳ Guardando seguimiento...'
                  : isUploading
                    ? '⏳ Procesando fotos...'
                    : isEditMode
                      ? '💾 Guardar Cambios del Seguimiento'
                      : isResolveMode
                        ? '✅ Confirmar Observación Levantada'
                        : '💾 Guardar Seguimiento (↳)'
              }
            </button>
          </div>
        </div>
      </div>
    `;
  }

  renderDeleteConfirmModal() {
    if (!this.deleteConfirmModal) return '';
    const m = this.deleteConfirmModal;
    const isFollowup = Boolean(m.isFollowup);
    const segNum = m.segNumber || 1;
    return `
      <div class="modal-backdrop" id="modal-delete-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
        <div class="modal-card" style="max-width: 560px; border-color: #DC2626;">
          <div class="section-header" style="background: #7F1D1D; border-bottom-color: #F87171;">
            <h3 class="section-title" id="delete-modal-title">${
              isFollowup
                ? `🗑️ Confirmar Borrado de Seguimiento #${segNum}`
                : '🗑️ Confirmar Borrado de Fila Completa'
            }</h3>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-delete-modal" ${m.isDeleting ? 'disabled' : ''}>
              ✕ Cerrar
            </button>
          </div>

          <div style="display:flex; flex-direction:column; gap:0.85rem;">
            <div class="alert-banner alert-error" style="margin:0;">
              <span>${
                isFollowup
                  ? `⚠️ Esta acción eliminará únicamente el <strong>Seguimiento #${segNum}</strong> y su(s) <strong>${m.segFotosCount || 0}</strong> foto(s) asociada(s). La observación principal del equipo y los demás seguimientos se conservarán intactos.`
                  : `⚠️ Esta acción eliminará toda la observación, sus fotos y sus <strong>${m.seguimientosCount}</strong> seguimiento(s) asociados en este dispositivo y en la nube.`
              }</span>
            </div>

            <div class="field-group">
              ${
                isFollowup
                  ? `
                <div style="font-size:0.95rem;"><strong>Equipo:</strong> 🚜 ${this.escapeHtml(m.codigo_equipo)}</div>
                <div style="font-size:0.95rem;"><strong>Fecha del Seguimiento:</strong> 📅 ${this.escapeHtml(formatFechaDDMMYYYY(m.segFecha))}</div>
                <div style="font-size:0.95rem;"><strong>Estado:</strong> ${this.escapeHtml(m.segEstado || 'Sigue observación')}</div>
                <div style="font-size:0.92rem; margin-top:0.25rem;">
                  <strong>Comentario:</strong> ${this.escapeHtml(m.segComentario || '(Sin comentario)')}
                </div>
              `
                  : `
                <div style="font-size:0.95rem;"><strong>Equipo:</strong> 🚜 ${this.escapeHtml(m.codigo_equipo)}</div>
                <div style="font-size:0.95rem;"><strong>Fecha Inicial:</strong> 📅 ${this.escapeHtml(formatFechaDDMMYYYY(m.fecha))}</div>
                <div style="font-size:0.92rem; margin-top:0.25rem;">
                  <strong>Observación:</strong> ${this.escapeHtml(m.observacion || '(Sin descripción)')}
                </div>
              `
              }
            </div>

            <div style="display:flex; justify-content:flex-end; gap:0.65rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-secondary" id="btn-cancel-delete-report" ${m.isDeleting ? 'disabled' : ''}>
                ✕ Cancelar
              </button>
              <button type="button" class="btn-mine btn-danger" id="btn-confirm-delete-report" ${m.isDeleting ? 'disabled' : ''}>
                ${
                  m.isDeleting
                    ? '⏳ Borrando...'
                    : isFollowup
                      ? `🗑️ Sí, Borrar Seguimiento #${segNum}`
                      : '🗑️ Sí, Borrar Fila Completa'
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderEditReportModal() {
    if (!this.editReportModal) return '';
    const m = this.editReportModal;
    const isUploading = Boolean(m.isUploadingPhotos);
    const isSaving = Boolean(m.isSaving);
    const isBusy = isUploading || isSaving;
    const photoCount = m.fotos_locales.length;
    const hasCustomCode = !this.equipos.some((eq) => eq.codigo === m.codigo_equipo);

    let statusPillHtml = `<span class="followup-status-pill empty">Sin fotos adjuntas</span>`;
    if (isUploading) {
      statusPillHtml = `<span class="followup-status-pill uploading">⏳ Procesando foto(s)...</span>`;
    } else if (photoCount > 0) {
      statusPillHtml = `<span class="followup-status-pill ready">✅ ${photoCount} foto(s) en el reporte</span>`;
    }

    const thumbsHtml = m.fotos_locales
      .map((f, fIdx) => {
        const url = f.blob ? this.createObjectUrl(f.blob) : f.signedUrl || '';
        const sizeLabel = f.peso_bytes ? formatBytes(f.peso_bytes) : 'Nube';
        return `
          <div class="followup-thumb-chip">
            <button
              type="button"
              class="followup-thumb-remove"
              data-remove-edit-photo="${fIdx}"
              title="${photoCount <= 1 ? 'Debe conservar al menos 1 foto' : `Quitar foto #${fIdx + 1}`}"
              aria-label="Quitar foto ${fIdx + 1}"
              ${isBusy || photoCount <= 1 ? 'disabled' : ''}
            >✕</button>
            <img src="${url}" alt="Foto inicial ${fIdx + 1}" class="followup-thumb-img" />
            <div class="followup-thumb-caption">
              <span class="followup-thumb-ok">✓ #${fIdx + 1}</span>
              <span>${sizeLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const uploadingCardHtml = isUploading
      ? `
        <div class="followup-thumb-uploading" role="status">
          <div class="followup-spinner"></div>
          <span>Subiendo${m.uploadingCount > 1 ? ` (${m.uploadingCount})` : ''}...</span>
        </div>
      `
      : '';

    return `
      <div class="modal-backdrop" id="modal-edit-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
        <div class="modal-card">
          <div class="section-header">
            <h3 class="section-title" id="edit-modal-title">✏️ Editar Observación — Equipo ${this.escapeHtml(m.codigo_equipo)}</h3>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-edit-modal" ${isBusy ? 'disabled' : ''}>
              ✕ Cancelar
            </button>
          </div>

          <div class="form-grid">
            <div class="field-group">
              <label class="field-label" for="edit-codigo-equipo">Código de Equipo *</label>
              <select id="edit-codigo-equipo" class="select-mine" ${isBusy ? 'disabled' : ''}>
                ${
                  hasCustomCode
                    ? `<option value="${this.escapeHtml(m.codigo_equipo)}" selected>${this.escapeHtml(m.codigo_equipo)}</option>`
                    : ''
                }
                ${this.equipos
                  .map(
                    (eq) => `
                  <option value="${this.escapeHtml(eq.codigo)}" ${
                      eq.codigo === m.codigo_equipo ? 'selected' : ''
                    }>
                    ${this.escapeHtml(eq.codigo)} — ${this.escapeHtml(eq.categoria || 'Equipo')}
                  </option>
                `
                  )
                  .join('')}
              </select>
            </div>

            <div class="field-group">
              <label class="field-label" for="edit-fecha">
                <span>Fecha Inicial *</span>
                <span id="edit-fecha-display" style="font-size:0.86rem; color:var(--accent-blue);">${this.escapeHtml(formatFechaDDMMYYYY(m.fecha))}</span>
              </label>
              <input type="date" id="edit-fecha" class="input-mine" value="${this.escapeHtml(m.fecha)}" ${isBusy ? 'disabled' : ''} />
            </div>

            <div class="field-group">
              <label class="field-label" for="edit-tipo">Tipo *</label>
              <select id="edit-tipo" class="select-mine" ${isBusy ? 'disabled' : ''}>
                <option value="Observación" ${m.tipo === 'Observación' ? 'selected' : ''}>🔍 Observación</option>
                <option value="Reporte" ${m.tipo === 'Reporte' ? 'selected' : ''}>📄 Reporte</option>
              </select>
            </div>

            <div class="field-group">
              <label class="field-label" for="edit-prioridad">Prioridad *</label>
              <select id="edit-prioridad" class="select-mine" ${isBusy ? 'disabled' : ''}>
                <option value="Alta" ${m.prioridad === 'Alta' ? 'selected' : ''}>🔴 Alta</option>
                <option value="Media" ${m.prioridad === 'Media' ? 'selected' : ''}>🟡 Media</option>
                <option value="Baja" ${m.prioridad === 'Baja' ? 'selected' : ''}>🔵 Baja</option>
              </select>
            </div>
          </div>

          <div class="field-group" style="margin-top:0.85rem;">
            <label class="field-label" for="edit-observacion">
              <span>Observación Principal * <span class="required-comment-hint">(Obligatorio)</span></span>
            </label>
            <textarea
              id="edit-observacion"
              class="textarea-mine ${m.validationError ? 'field-error-input' : ''}"
              aria-invalid="${m.validationError ? 'true' : 'false'}"
              placeholder="Describe el hallazgo u observación principal..."
              ${isBusy ? 'disabled' : ''}
            >${this.escapeHtml(m.observacion)}</textarea>
            ${
              m.validationError
                ? `<div id="modal-edit-error" class="inline-field-error" role="alert">⚠️ ${this.escapeHtml(m.validationError)}</div>`
                : ''
            }
          </div>

          <div class="media-capture-box">
            <div class="field-label" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.45rem; margin-bottom:0.55rem;">
              <span>Fotos Iniciales (${photoCount}/5 fotos)</span>
              ${statusPillHtml}
            </div>
            <input type="file" id="edit-photo-file" accept="image/*" multiple style="display:none" />
            <div class="followup-media-row">
              <div class="media-buttons-row">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-primary"
                  id="btn-edit-add-photo"
                  ${photoCount >= 5 || isBusy ? 'disabled' : ''}
                >
                  ${isUploading ? '⏳ Procesando...' : '📷 / 📎 Agregar Foto'}
                </button>
              </div>
              <div class="followup-thumbs-inline" aria-live="polite">
                ${thumbsHtml}${uploadingCardHtml}
              </div>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:0.75rem; margin-top:1rem; flex-wrap:wrap;">
            <button type="button" class="btn-mine btn-secondary" id="btn-cancel-edit-report" ${isBusy ? 'disabled' : ''}>
              ✕ Cancelar
            </button>
            <button
              type="button"
              class="btn-mine btn-primary"
              id="btn-save-edit-report"
              ${isBusy ? 'disabled' : ''}
            >
              ${
                isSaving
                  ? '⏳ Guardando cambios...'
                  : isUploading
                    ? '⏳ Procesando fotos...'
                    : '💾 Guardar Cambios'
              }
            </button>
          </div>
        </div>
      </div>
    `;
  }

  renderEditEquipmentModal() {
    if (!this.editEquipmentModal) return '';
    const m = this.editEquipmentModal;
    const isSaving = Boolean(m.isSaving);
    const normalizedPreview = normalizeEquipmentCode(m.nuevoCodigo);

    return `
      <div class="modal-backdrop" id="modal-edit-equipment-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-eq-modal-title">
        <div class="modal-card" style="max-width: 560px;">
          <div class="section-header">
            <h3 class="section-title" id="edit-eq-modal-title">✏️ Editar Código de Equipo — ${this.escapeHtml(m.oldCodigo)}</h3>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-edit-equipment" ${isSaving ? 'disabled' : ''}>
              ✕ Cerrar
            </button>
          </div>

          <div style="display:flex; flex-direction:column; gap:0.85rem;">
            <div class="field-group">
              <label class="field-label" for="modal-edit-eq-codigo">
                <span>Código de Equipo *</span>
                <span style="color:var(--accent-amber)">Normalizado: <strong id="modal-edit-eq-preview">${this.escapeHtml(normalizedPreview || '—')}</strong></span>
              </label>
              <input
                type="text"
                id="modal-edit-eq-codigo"
                class="input-mine${m.validationError ? ' field-error-input' : ''}"
                value="${this.escapeHtml(m.nuevoCodigo)}"
                placeholder="Ej. 793F-05"
                ${isSaving ? 'disabled' : ''}
              />
              ${
                m.validationError
                  ? `<div id="modal-edit-eq-error" class="inline-field-error" role="alert">⚠️ ${this.escapeHtml(m.validationError)}</div>`
                  : ''
              }
            </div>

            <div class="field-group">
              <label class="field-label" for="modal-edit-eq-categoria">
                <span>Categoría / Descripción del Equipo</span>
              </label>
              <input
                type="text"
                id="modal-edit-eq-categoria"
                class="input-mine"
                value="${this.escapeHtml(m.categoria)}"
                placeholder="Ej. Camión Minero CAT 793F"
                ${isSaving ? 'disabled' : ''}
              />
            </div>

            ${
              m.reportCount > 0
                ? `
              <div class="alert-banner alert-success" style="margin:0;">
                <span>ℹ️ Si cambias el código, las <strong>${m.reportCount}</strong> observación(es) asociadas a <strong>${this.escapeHtml(m.oldCodigo)}</strong> se actualizarán automáticamente al nuevo código.</span>
              </div>
            `
                : ''
            }

            <div style="display:flex; justify-content:flex-end; gap:0.65rem; flex-wrap:wrap; margin-top:0.25rem;">
              <button type="button" class="btn-mine btn-secondary" id="btn-cancel-edit-equipment" ${isSaving ? 'disabled' : ''}>
                ✕ Cancelar
              </button>
              <button type="button" class="btn-mine btn-primary" id="btn-save-edit-equipment" ${isSaving ? 'disabled' : ''}>
                ${isSaving ? '⏳ Guardando...' : '💾 Guardar Código'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderDeleteEquipmentModal() {
    if (!this.deleteEquipmentModal) return '';
    const m = this.deleteEquipmentModal;
    const isDeleting = Boolean(m.isDeleting);

    return `
      <div class="modal-backdrop" id="modal-delete-equipment-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-eq-modal-title">
        <div class="modal-card" style="max-width: 560px; border-color: #DC2626;">
          <div class="section-header" style="background: #7F1D1D; border-bottom-color: #F87171;">
            <h3 class="section-title" id="delete-eq-modal-title">🗑️ Confirmar Borrado de Código de Equipo</h3>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-delete-equipment" ${isDeleting ? 'disabled' : ''}>
              ✕ Cerrar
            </button>
          </div>

          <div style="display:flex; flex-direction:column; gap:0.85rem;">
            <div class="alert-banner alert-error" style="margin:0;">
              <span>⚠️ Se quitará este código del cuadro de equipos y del selector desplegable.</span>
            </div>

            <div class="field-group">
              <div style="font-size:0.95rem;"><strong>Código:</strong> 🔧 ${this.escapeHtml(m.codigo)}</div>
              <div style="font-size:0.95rem;"><strong>Categoría:</strong> ${this.escapeHtml(m.categoria || 'Equipo minero')}</div>
              <div style="font-size:0.95rem;"><strong>Observaciones asociadas:</strong> ${m.reportCount}</div>
            </div>

            ${
              m.reportCount > 0
                ? `
              <label class="field-group" style="display:flex; align-items:flex-start; gap:0.6rem; cursor:pointer;">
                <input
                  type="checkbox"
                  id="chk-delete-eq-reports"
                  ${m.deleteReportsToo ? 'checked' : ''}
                  ${isDeleting ? 'disabled' : ''}
                  style="width:20px; height:20px; margin-top:0.15rem; accent-color:#DC2626;"
                />
                <span style="font-size:0.92rem; font-weight:700;">
                  Eliminar también las ${m.reportCount} observación(es) asociadas a este equipo (si no marcas esta casilla, los reportes existentes se conservan en la tabla).
                </span>
              </label>
            `
                : ''
            }

            <div style="display:flex; justify-content:flex-end; gap:0.65rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-secondary" id="btn-cancel-delete-equipment" ${isDeleting ? 'disabled' : ''}>
                ✕ Cancelar
              </button>
              <button type="button" class="btn-mine btn-danger" id="btn-confirm-delete-equipment" ${isDeleting ? 'disabled' : ''}>
                ${isDeleting ? '⏳ Borrando...' : '🗑️ Sí, Borrar Código'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  attachEvents() {
    // Cerrar banner
    const btnCloseBanner = this.rootEl.querySelector('#btn-close-banner');
    if (btnCloseBanner) {
      btnCloseBanner.addEventListener('click', () => {
        this.banner = null;
        this.render();
      });
    }

    // Ocultar / mostrar el Panel 2 ("Nuevo Reporte")
    const btnToggleCreatePanel = this.rootEl.querySelector('#btn-toggle-create-panel');
    if (btnToggleCreatePanel) {
      btnToggleCreatePanel.addEventListener('click', () => {
        this.isCreatePanelCollapsed = !this.isCreatePanelCollapsed;
        try {
          localStorage.setItem(
            CREATE_PANEL_COLLAPSED_KEY,
            this.isCreatePanelCollapsed ? '1' : '0'
          );
        } catch {
          // Ignorar restricciones de storage
        }
        this.render();
      });
    }

    // Filtro por código de equipo en el Cuadro Superior o en la Tabla
    this.rootEl.querySelectorAll('[data-filter-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-filter-code');
        this.filtroEquipo = code;
        if (code !== 'TODOS') {
          this.form.codigo_equipo = code;
        }
        this.render();
      });
    });

    const btnClearFilter = this.rootEl.querySelector('#btn-clear-filter');
    if (btnClearFilter) {
      btnClearFilter.addEventListener('click', () => {
        this.filtroEquipo = 'TODOS';
        this.render();
      });
    }

    // Cambios en los campos del formulario principal
    const selectEquipo = this.rootEl.querySelector('#select-codigo-equipo');
    if (selectEquipo) {
      selectEquipo.addEventListener('change', (e) => {
        this.form.codigo_equipo = e.target.value;
        this.render();
      });
    }

    const inputNuevoCodigo = this.rootEl.querySelector('#input-nuevo-codigo');
    if (inputNuevoCodigo) {
      inputNuevoCodigo.addEventListener('input', (e) => {
        this.form.nuevo_codigo_input = e.target.value;
        const previewEl = this.rootEl.querySelector('.norm-preview');
        const norm = normalizeEquipmentCode(this.form.nuevo_codigo_input);
        if (previewEl) {
          previewEl.innerHTML = norm
            ? `Se normalizará como: <strong>${this.escapeHtml(norm)}</strong>`
            : 'Escribe minúsculas o espacios (ej. "793f 05" → "793F-05") y toca "+ Crear".';
        }
      });
      inputNuevoCodigo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleCreateEquipmentCode();
        }
      });
    }

    const btnCrearCodigo = this.rootEl.querySelector('#btn-crear-codigo');
    if (btnCrearCodigo) {
      btnCrearCodigo.addEventListener('click', () => this.handleCreateEquipmentCode());
    }

    const inputFecha = this.rootEl.querySelector('#input-fecha-peru');
    if (inputFecha) {
      inputFecha.addEventListener('change', (e) => {
        this.form.fecha = e.target.value;
        const fechaDisp = this.rootEl.querySelector('#form-fecha-display');
        if (fechaDisp) {
          fechaDisp.textContent = formatFechaDDMMYYYY(e.target.value);
        }
      });
    }

    const selectTipo = this.rootEl.querySelector('#select-tipo');
    if (selectTipo) {
      selectTipo.addEventListener('change', (e) => {
        this.form.tipo = e.target.value;
      });
    }

    const selectPrioridad = this.rootEl.querySelector('#select-prioridad');
    if (selectPrioridad) {
      selectPrioridad.addEventListener('change', (e) => {
        this.form.prioridad = e.target.value;
      });
    }

    const selectCalidad = this.rootEl.querySelector('#select-calidad');
    if (selectCalidad) {
      selectCalidad.addEventListener('change', (e) => {
        this.form.calidad_compresion = e.target.value;
      });
    }

    const textareaObs = this.rootEl.querySelector('#textarea-observacion');
    if (textareaObs) {
      textareaObs.addEventListener('input', (e) => {
        this.form.observacion = e.target.value;
        if (this.obsValidationError && e.target.value.trim()) {
          this.obsValidationError = null;
          e.target.classList.remove('field-error-input');
          e.target.setAttribute('aria-invalid', 'false');
          this.rootEl.querySelector('#main-obs-error')?.remove();
        }
      });
    }

    // Botones Multimedia Principal (Cámara, Adjuntar, Video, Simulador de placa)
    const fileCamMain = this.rootEl.querySelector('#file-camera-main');
    const fileAttMain = this.rootEl.querySelector('#file-attach-main');
    const fileVidMain = this.rootEl.querySelector('#file-video-main');

    this.rootEl.querySelector('#btn-camera-main')?.addEventListener('click', () => fileCamMain?.click());
    this.rootEl.querySelector('#btn-attach-main')?.addEventListener('click', () => fileAttMain?.click());
    this.rootEl.querySelector('#btn-video-main')?.addEventListener('click', () => fileVidMain?.click());

    fileCamMain?.addEventListener('change', (e) => this.handleAddPhotos(e.target.files, null));
    fileAttMain?.addEventListener('change', (e) => this.handleAddPhotos(e.target.files, null));
    fileVidMain?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleAttachVideo(e.target.files[0], null);
      }
    });

    this.rootEl.querySelector('#btn-sim-photo-main')?.addEventListener('click', async () => {
      const sampleFile = await this.generateSamplePhotoFile(
        this.form.codigo_equipo,
        this.form.calidad_compresion
      );
      await this.handleAddPhotos([sampleFile], null);
    });

    // Quitar o ver foto del formulario principal
    this.rootEl.querySelectorAll('[data-remove-main-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-remove-main-photo'));
        this.form.fotos_locales.splice(idx, 1);
        this.form.fotos_locales.forEach((f, i) => {
          f.indice = i + 1;
        });
        this.render();
      });
    });

    this.rootEl.querySelectorAll('[data-preview-main-photo]').forEach((wrap) => {
      wrap.addEventListener('click', () => {
        const idx = Number(wrap.getAttribute('data-preview-main-photo'));
        const foto = this.form.fotos_locales[idx];
        if (!foto) return;
        this.viewerModal = {
          source: 'form',
          fotoIndex: idx,
          calidad: this.form.calidad_compresion || 'estandar',
          title: `Vista Previa Foto #${idx + 1} — ${this.form.codigo_equipo}`,
          blob: foto.blob,
          signedUrl: foto.signedUrl || '',
          filename: `${this.form.codigo_equipo || 'equipo'}_preview_${idx + 1}.jpg`,
          isVideo: false,
          isEditing: false,
          drawTool: 'pencil',
          drawColor: '#EF4444',
          drawSize: 5,
          isSavingEdit: false,
          editError: null,
          meta: `Resolución: ${foto.ancho}×${foto.alto} px | Peso comprimido: ${formatBytes(foto.peso_bytes)} (Original: ${formatBytes(foto.peso_original_bytes)})`
        };
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-remove-main-video')?.addEventListener('click', () => {
      this.form.video_local = null;
      this.render();
    });

    // "+ Agregar otra observación"
    this.rootEl
      .querySelector('#btn-add-extra-obs')
      ?.addEventListener('click', () => this.addExtraObservationSlot());

    this.rootEl.querySelectorAll('[data-remove-extra]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-remove-extra'));
        this.removeExtraObservationSlot(idx);
      });
    });

    this.rootEl.querySelectorAll('[data-extra-modo]').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(sel.getAttribute('data-extra-modo'));
        this.form.observaciones_adicionales[idx].modo = e.target.value;
      });
    });

    this.rootEl.querySelectorAll('[data-extra-fecha]').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const idx = Number(inp.getAttribute('data-extra-fecha'));
        this.form.observaciones_adicionales[idx].fecha = e.target.value;
      });
    });

    this.rootEl.querySelectorAll('[data-extra-estado]').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(sel.getAttribute('data-extra-estado'));
        this.form.observaciones_adicionales[idx].estado_seguimiento = e.target.value;
      });
    });

    this.rootEl.querySelectorAll('[data-extra-comentario]').forEach((txt) => {
      txt.addEventListener('input', (e) => {
        const idx = Number(txt.getAttribute('data-extra-comentario'));
        this.form.observaciones_adicionales[idx].comentario = e.target.value;
      });
    });

    this.rootEl.querySelectorAll('[data-extra-cam-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-extra-cam-btn'));
        const inp = this.rootEl.querySelector(`#file-extra-cam-${idx}`);
        inp?.click();
        inp?.addEventListener(
          'change',
          (e) => this.handleAddPhotos(e.target.files, idx),
          { once: true }
        );
      });
    });

    this.rootEl.querySelectorAll('[data-extra-att-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-extra-att-btn'));
        const inp = this.rootEl.querySelector(`#file-extra-att-${idx}`);
        inp?.click();
        inp?.addEventListener(
          'change',
          (e) => this.handleAddPhotos(e.target.files, idx),
          { once: true }
        );
      });
    });

    this.rootEl.querySelectorAll('[data-extra-sim-btn]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.getAttribute('data-extra-sim-btn'));
        const sampleFile = await this.generateSamplePhotoFile(
          this.form.codigo_equipo,
          this.form.calidad_compresion
        );
        await this.handleAddPhotos([sampleFile], idx);
      });
    });

    // Guardar Reporte
    this.rootEl
      .querySelector('#btn-guardar-reporte')
      ?.addEventListener('click', () => this.handleSaveReport());

    // Eventos en la Tabla Principal: Visor de fotos/videos, Descarga en visor y Seguimiento (↳)
    this.rootEl.querySelectorAll('[data-open-viewer]').forEach((img) => {
      img.addEventListener('click', () => {
        const repId = img.getAttribute('data-open-viewer');
        const segAttr = img.getAttribute('data-viewer-seg');
        const fIdx = Number(img.getAttribute('data-viewer-idx') || 0);
        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep) return;

        const target =
          segAttr === 'null' ? rep : (rep.seguimientos || [])[Number(segAttr)];
        const foto = (target?.fotos_locales || [])[fIdx];
        if (!foto) return;

        this.viewerModal = {
          source: 'table',
          reporteId: rep.id,
          segIndex: segAttr === 'null' ? null : Number(segAttr),
          fotoIndex: fIdx,
          calidad: rep.calidad_compresion || 'estandar',
          title: `Equipo ${rep.codigo_equipo} — ${
            segAttr === 'null' ? 'Evidencia Inicial' : `Seguimiento #${Number(segAttr) + 1}`
          }`,
          blob: foto.blob || null,
          signedUrl: foto.signedUrl || '',
          filename: `${rep.codigo_equipo}_${target.fecha || rep.fecha}_${
            segAttr === 'null' ? 'inicial' : `seg_${Number(segAttr) + 1}`
          }_foto_${fIdx + 1}.jpg`,
          isVideo: false,
          isEditing: false,
          drawTool: 'pencil',
          drawColor: '#EF4444',
          drawSize: 5,
          isSavingEdit: false,
          editError: null,
          meta: `Fecha: ${formatFechaDDMMYYYY(target.fecha || rep.fecha)} | Dimensiones: ${foto.ancho}×${foto.alto} px | ${foto.peso_bytes ? 'Peso: ' + formatBytes(foto.peso_bytes) : 'Imagen en Supabase Cloud'}`
        };
        this.render();
      });
    });

    this.rootEl.querySelectorAll('[data-open-video]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-open-video');
        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep || !rep.video_local) return;
        this.viewerModal = {
          title: `Video Equipo ${rep.codigo_equipo}`,
          blob: rep.video_local.blob || null,
          signedUrl: rep.video_local.signedUrl || '',
          filename: `${rep.codigo_equipo}_${rep.fecha}_video.mp4`,
          isVideo: true,
          meta: `Peso: ${formatBytes(rep.video_local.peso_bytes)}`
        };
        this.render();
      });
    });

    // Abrir modal "+ Agregar Seguimiento (↳)" o "✅ Observación Levantada"
    const openModalForReport = (repId, mode) => {
      const rep = this.reportes.find((r) => r.id === repId);
      if (!rep) return;
      this.followupModal = {
        mode,
        reporteId: rep.id,
        editSegIndex: null,
        codigo_equipo: rep.codigo_equipo,
        fecha: getFechaHoyPeru(),
        estado_seguimiento:
          mode === 'levantada' ? 'Observación Levantada' : 'Sigue observación',
        comentario: '',
        fotos_locales: [],
        video_local: null,
        isUploadingPhotos: false,
        uploadingCount: 0,
        isSaving: false,
        validationError: null
      };
      this.render();
    };

    this.rootEl.querySelectorAll('[data-open-followup-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openModalForReport(btn.getAttribute('data-open-followup-modal'), 'seguimiento');
      });
    });

    this.rootEl.querySelectorAll('[data-open-resolve-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openModalForReport(btn.getAttribute('data-open-resolve-modal'), 'levantada');
      });
    });

    // Editar un seguimiento individual existente
    this.rootEl.querySelectorAll('[data-edit-followup]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-edit-followup');
        const segIdx = Number(btn.getAttribute('data-seg-idx'));
        const rep = this.reportes.find((r) => r.id === repId);
        const seg = rep && Array.isArray(rep.seguimientos) ? rep.seguimientos[segIdx] : null;
        if (!rep || !seg) return;

        this.followupModal = {
          mode: this.isSegLevantada(seg) ? 'levantada' : 'seguimiento',
          reporteId: rep.id,
          editSegIndex: segIdx,
          codigo_equipo: rep.codigo_equipo,
          fecha: seg.fecha || getFechaHoyPeru(),
          estado_seguimiento: seg.estado_seguimiento || 'Sigue observación',
          comentario: seg.comentario || '',
          fotos_locales: Array.isArray(seg.fotos_locales)
            ? seg.fotos_locales.map((f) => ({ ...f }))
            : [],
          video_local: seg.video_local ? { ...seg.video_local } : null,
          isUploadingPhotos: false,
          uploadingCount: 0,
          isSaving: false,
          validationError: null
        };
        this.render();
      });
    });

    // Abrir modal de confirmación para borrar solo un seguimiento individual
    this.rootEl.querySelectorAll('[data-delete-followup]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-delete-followup');
        const segIdx = Number(btn.getAttribute('data-seg-idx'));
        const rep = this.reportes.find((r) => r.id === repId);
        const seg = rep && Array.isArray(rep.seguimientos) ? rep.seguimientos[segIdx] : null;
        if (!rep || !seg) return;

        this.deleteConfirmModal = {
          isFollowup: true,
          reporteId: rep.id,
          segIndex: segIdx,
          segNumber: segIdx + 1,
          codigo_equipo: rep.codigo_equipo,
          segFecha: seg.fecha || rep.fecha,
          segEstado: seg.estado_seguimiento || 'Sigue observación',
          segComentario: seg.comentario || '',
          segFotosCount: Array.isArray(seg.fotos_locales)
            ? seg.fotos_locales.length
            : Array.isArray(seg.fotos)
              ? seg.fotos.length
              : 0,
          isDeleting: false
        };
        this.render();
      });
    });

    // Pestañas Panel Principal (Activas) vs Observaciones Levantadas
    this.rootEl.querySelectorAll('[data-switch-table-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextTab = btn.getAttribute('data-switch-table-tab') === 'levantadas' ? 'levantadas' : 'activas';
        this.vistaTabla = nextTab;
        this.onTableTabChange(nextTab);
        this.render();
      });
    });

    // Cambiar estado de una observación levantada para devolverla al Panel Principal
    this.rootEl.querySelectorAll('[data-reopen-report-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-reopen-report-btn');
        const sel = this.rootEl.querySelector(`[data-reopen-state-select="${repId}"]`);
        const nuevoEstado = sel ? sel.value : 'Sigue observación';
        this.handleReopenResolvedReport(repId, nuevoEstado);
      });
    });

    // Abrir modal de confirmación para borrar toda la fila de observación
    this.rootEl.querySelectorAll('[data-request-delete-report]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-request-delete-report');
        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep) return;
        this.deleteConfirmModal = {
          reporteId: rep.id,
          codigo_equipo: rep.codigo_equipo,
          fecha: rep.fecha,
          observacion: rep.observacion || '',
          seguimientosCount: Array.isArray(rep.seguimientos) ? rep.seguimientos.length : 0,
          isDeleting: false
        };
        this.render();
      });
    });

    const closeDeleteModal = () => {
      if (this.deleteConfirmModal?.isDeleting) return;
      this.deleteConfirmModal = null;
      this.render();
    };
    this.rootEl.querySelector('#btn-close-delete-modal')?.addEventListener('click', closeDeleteModal);
    this.rootEl.querySelector('#btn-cancel-delete-report')?.addEventListener('click', closeDeleteModal);
    this.rootEl.querySelector('#modal-delete-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-delete-backdrop') closeDeleteModal();
    });
    this.rootEl.querySelector('#btn-confirm-delete-report')?.addEventListener('click', () => {
      this.handleConfirmDeleteReport();
    });

    // Abrir modal para editar fila completa de observación
    this.rootEl.querySelectorAll('[data-open-edit-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-open-edit-modal');
        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep) return;
        this.editReportModal = {
          reporteId: rep.id,
          codigo_equipo: rep.codigo_equipo,
          fecha: rep.fecha,
          tipo: rep.tipo || 'Observación',
          prioridad: rep.prioridad || 'Media',
          observacion: rep.observacion || '',
          fotos_locales: Array.isArray(rep.fotos_locales)
            ? rep.fotos_locales.map((f) => ({ ...f }))
            : [],
          isUploadingPhotos: false,
          uploadingCount: 0,
          isSaving: false,
          validationError: null
        };
        this.render();
      });
    });

    const closeEditModal = () => {
      if (this.editReportModal?.isSaving || this.editReportModal?.isUploadingPhotos) return;
      this.editReportModal = null;
      this.render();
    };
    this.rootEl.querySelector('#btn-close-edit-modal')?.addEventListener('click', closeEditModal);
    this.rootEl.querySelector('#btn-cancel-edit-report')?.addEventListener('click', closeEditModal);
    this.rootEl.querySelector('#modal-edit-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-edit-backdrop') closeEditModal();
    });

    this.rootEl.querySelector('#edit-codigo-equipo')?.addEventListener('change', (e) => {
      if (this.editReportModal) {
        this.editReportModal.codigo_equipo = e.target.value;
        const titleEl = this.rootEl.querySelector('#edit-modal-title');
        if (titleEl) {
          titleEl.textContent = `✏️ Editar Observación — Equipo ${e.target.value}`;
        }
      }
    });
    this.rootEl.querySelector('#edit-fecha')?.addEventListener('change', (e) => {
      if (this.editReportModal) {
        this.editReportModal.fecha = e.target.value;
        const disp = this.rootEl.querySelector('#edit-fecha-display');
        if (disp) disp.textContent = formatFechaDDMMYYYY(e.target.value);
      }
    });
    this.rootEl.querySelector('#edit-tipo')?.addEventListener('change', (e) => {
      if (this.editReportModal) this.editReportModal.tipo = e.target.value;
    });
    this.rootEl.querySelector('#edit-prioridad')?.addEventListener('change', (e) => {
      if (this.editReportModal) this.editReportModal.prioridad = e.target.value;
    });
    this.rootEl.querySelector('#edit-observacion')?.addEventListener('input', (e) => {
      if (this.editReportModal) {
        this.editReportModal.observacion = e.target.value;
        if (this.editReportModal.validationError && e.target.value.trim()) {
          this.editReportModal.validationError = null;
          e.target.classList.remove('field-error-input');
          e.target.setAttribute('aria-invalid', 'false');
          this.rootEl.querySelector('#modal-edit-error')?.remove();
        }
      }
    });

    const editPhotoFile = this.rootEl.querySelector('#edit-photo-file');
    this.rootEl.querySelector('#btn-edit-add-photo')?.addEventListener('click', () => {
      editPhotoFile?.click();
    });
    editPhotoFile?.addEventListener('change', async (e) => {
      if (!this.editReportModal || !e.target.files) return;
      const remaining = Math.max(0, 5 - this.editReportModal.fotos_locales.length);
      const selectedFiles = Array.from(e.target.files).slice(0, remaining);
      if (selectedFiles.length === 0) {
        e.target.value = '';
        return;
      }

      this.editReportModal.isUploadingPhotos = true;
      this.editReportModal.uploadingCount = selectedFiles.length;
      this.render();

      try {
        for (const f of selectedFiles) {
          if (!this.editReportModal || this.editReportModal.fotos_locales.length >= 5) break;
          const c = await compressPhotoFile(f, 'estandar');
          if (!this.editReportModal) break;
          const usedIndices = new Set(
            this.editReportModal.fotos_locales.map((item) => Number(item.indice) || 0)
          );
          let nextIdx = 1;
          while (usedIndices.has(nextIdx)) nextIdx++;
          this.editReportModal.fotos_locales.push({
            indice: nextIdx,
            ...c
          });
          this.editReportModal.uploadingCount = Math.max(
            0,
            (this.editReportModal.uploadingCount || 1) - 1
          );
          this.render();
        }
      } finally {
        if (this.editReportModal) {
          this.editReportModal.isUploadingPhotos = false;
          this.editReportModal.uploadingCount = 0;
          this.render();
        }
        e.target.value = '';
      }
    });

    this.rootEl.querySelectorAll('[data-remove-edit-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (
          !this.editReportModal ||
          this.editReportModal.isUploadingPhotos ||
          this.editReportModal.isSaving ||
          this.editReportModal.fotos_locales.length <= 1
        ) {
          return;
        }
        const idx = Number(btn.getAttribute('data-remove-edit-photo'));
        this.editReportModal.fotos_locales.splice(idx, 1);
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-save-edit-report')?.addEventListener('click', () => {
      this.handleSaveEditReport();
    });

    // Eventos de modales
    this.rootEl.querySelector('#btn-download-viewer')?.addEventListener('click', () => {
      if (!this.viewerModal) return;
      this.handleDownloadMedia(
        this.viewerModal.blob,
        this.viewerModal.filename,
        this.viewerModal.signedUrl
      );
    });

    const closeViewerModal = () => {
      if (this.viewerModal?.isSavingEdit) return;
      this.viewerModal = null;
      this._viewerDrawState = null;
      this.render();
    };

    this.rootEl.querySelector('#btn-close-viewer')?.addEventListener('click', closeViewerModal);

    this.rootEl.querySelector('#modal-viewer-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-viewer-backdrop') {
        closeViewerModal();
      }
    });

    this.rootEl.querySelector('#btn-toggle-viewer-edit')?.addEventListener('click', () => {
      if (!this.viewerModal || this.viewerModal.isVideo) return;
      this.viewerModal.isEditing = true;
      this.viewerModal.editError = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-cancel-viewer-edit')?.addEventListener('click', () => {
      if (!this.viewerModal || this.viewerModal.isSavingEdit) return;
      this.viewerModal.isEditing = false;
      this.viewerModal.editError = null;
      this._viewerDrawState = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-save-viewer-edit')?.addEventListener('click', () => {
      this.handleSaveEditedViewerPhoto();
    });

    const btnToolPencil = this.rootEl.querySelector('#btn-tool-pencil');
    const btnToolEraser = this.rootEl.querySelector('#btn-tool-eraser');
    btnToolPencil?.addEventListener('click', () => {
      if (!this.viewerModal) return;
      this.viewerModal.drawTool = 'pencil';
      btnToolPencil.classList.add('tool-active');
      btnToolEraser?.classList.remove('tool-active');
    });

    btnToolEraser?.addEventListener('click', () => {
      if (!this.viewerModal) return;
      this.viewerModal.drawTool = 'eraser';
      btnToolEraser.classList.add('tool-active');
      btnToolPencil?.classList.remove('tool-active');
    });

    this.rootEl.querySelectorAll('[data-draw-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!this.viewerModal) return;
        const color = btn.getAttribute('data-draw-color') || '#EF4444';
        this.viewerModal.drawColor = color;
        this.viewerModal.drawTool = 'pencil';
        btnToolPencil?.classList.add('tool-active');
        btnToolEraser?.classList.remove('tool-active');
        this.rootEl
          .querySelectorAll('[data-draw-color]')
          .forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    this.rootEl.querySelector('#range-draw-size')?.addEventListener('input', (e) => {
      if (!this.viewerModal) return;
      const val = Number(e.target.value) || 5;
      this.viewerModal.drawSize = val;
      const lbl = this.rootEl.querySelector('#label-draw-size');
      if (lbl) lbl.textContent = `${val}px`;
    });

    this.rootEl.querySelector('#btn-draw-undo')?.addEventListener('click', () => {
      const ds = this._viewerDrawState;
      if (!ds || !ds.ctx || !ds.canvas) return;
      const prev = ds.undoStack.pop();
      if (prev) {
        ds.ctx.putImageData(prev, 0, 0);
      }
    });

    this.rootEl.querySelector('#btn-draw-clear')?.addEventListener('click', () => {
      const ds = this._viewerDrawState;
      if (!ds || !ds.ctx || !ds.canvas || ds.canvas.width <= 0 || ds.canvas.height <= 0) return;
      if (ds.undoStack.length >= 20) ds.undoStack.shift();
      ds.undoStack.push(ds.ctx.getImageData(0, 0, ds.canvas.width, ds.canvas.height));
      ds.ctx.clearRect(0, 0, ds.canvas.width, ds.canvas.height);
    });

    if (this.viewerModal?.isEditing && !this.viewerModal?.isVideo) {
      this.initViewerDrawCanvas();
    }

    this.rootEl.querySelector('#btn-close-followup')?.addEventListener('click', () => {
      if (this.followupModal?.isSaving || this.followupModal?.isUploadingPhotos) return;
      this.followupModal = null;
      this.render();
    });

    this.rootEl.querySelector('#modal-seg-fecha')?.addEventListener('change', (e) => {
      if (this.followupModal) this.followupModal.fecha = e.target.value;
    });
    this.rootEl.querySelector('#modal-seg-estado')?.addEventListener('change', (e) => {
      if (this.followupModal) this.followupModal.estado_seguimiento = e.target.value;
    });
    this.rootEl.querySelector('#modal-seg-comentario')?.addEventListener('input', (e) => {
      if (this.followupModal) {
        this.followupModal.comentario = e.target.value;
        if (this.followupModal.validationError && e.target.value.trim()) {
          this.followupModal.validationError = null;
          e.target.classList.remove('field-error-input');
          e.target.setAttribute('aria-invalid', 'false');
          this.rootEl.querySelector('#modal-seg-error')?.remove();
        }
      }
    });

    const getNextFollowupPhotoIndex = () => {
      const usedIndices = new Set(
        (this.followupModal?.fotos_locales || []).map((item) => Number(item.indice) || 0)
      );
      let nextIdx = 1;
      while (usedIndices.has(nextIdx)) nextIdx++;
      return nextIdx;
    };

    const modalSegFile = this.rootEl.querySelector('#modal-seg-file');
    this.rootEl.querySelector('#btn-modal-seg-photo')?.addEventListener('click', () => {
      modalSegFile?.click();
    });
    modalSegFile?.addEventListener('change', async (e) => {
      if (!this.followupModal || !e.target.files) return;
      const remaining = Math.max(0, 5 - this.followupModal.fotos_locales.length);
      const selectedFiles = Array.from(e.target.files).slice(0, remaining);
      if (selectedFiles.length === 0) {
        e.target.value = '';
        return;
      }

      this.followupModal.isUploadingPhotos = true;
      this.followupModal.uploadingCount = selectedFiles.length;
      this.render();

      try {
        for (const f of selectedFiles) {
          if (!this.followupModal || this.followupModal.fotos_locales.length >= 5) break;
          const c = await compressPhotoFile(f, 'estandar');
          if (!this.followupModal) break;
          this.followupModal.fotos_locales.push({
            indice: getNextFollowupPhotoIndex(),
            ...c
          });
          this.followupModal.uploadingCount = Math.max(
            0,
            (this.followupModal.uploadingCount || 1) - 1
          );
          this.render();
        }
      } finally {
        if (this.followupModal) {
          this.followupModal.isUploadingPhotos = false;
          this.followupModal.uploadingCount = 0;
          this.render();
        }
        e.target.value = '';
      }
    });

    this.rootEl.querySelector('#btn-modal-seg-sim')?.addEventListener('click', async () => {
      if (!this.followupModal || this.followupModal.fotos_locales.length >= 5) return;
      this.followupModal.isUploadingPhotos = true;
      this.followupModal.uploadingCount = 1;
      this.render();
      try {
        const sample = await this.generateSamplePhotoFile(this.followupModal.codigo_equipo, 'estandar');
        const c = await compressPhotoFile(sample, 'estandar');
        if (this.followupModal) {
          this.followupModal.fotos_locales.push({
            indice: getNextFollowupPhotoIndex(),
            ...c
          });
        }
      } finally {
        if (this.followupModal) {
          this.followupModal.isUploadingPhotos = false;
          this.followupModal.uploadingCount = 0;
          this.render();
        }
      }
    });

    this.rootEl.querySelectorAll('[data-remove-modal-seg-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!this.followupModal || this.followupModal.isUploadingPhotos || this.followupModal.isSaving) {
          return;
        }
        const idx = Number(btn.getAttribute('data-remove-modal-seg-photo'));
        this.followupModal.fotos_locales.splice(idx, 1);
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-save-followup')?.addEventListener('click', () => {
      this.handleSaveFollowupModal();
    });

    // Gestión de códigos de equipo (Editar / Borrar desde Cuadro 1)
    this.rootEl.querySelectorAll('[data-edit-equipment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const codigo = btn.getAttribute('data-edit-equipment');
        const eq = this.equipos.find((e) => e.codigo === codigo);
        if (!eq) return;
        const reportCount = this.reportes.filter((r) => r.codigo_equipo === eq.codigo).length;
        this.editEquipmentModal = {
          oldCodigo: eq.codigo,
          nuevoCodigo: eq.codigo,
          categoria: eq.categoria || '',
          reportCount,
          isSaving: false,
          validationError: null
        };
        this.render();
      });
    });

    const closeEditEquipmentModal = () => {
      if (this.editEquipmentModal?.isSaving) return;
      this.editEquipmentModal = null;
      this.render();
    };
    this.rootEl
      .querySelector('#btn-close-edit-equipment')
      ?.addEventListener('click', closeEditEquipmentModal);
    this.rootEl
      .querySelector('#btn-cancel-edit-equipment')
      ?.addEventListener('click', closeEditEquipmentModal);
    this.rootEl
      .querySelector('#modal-edit-equipment-backdrop')
      ?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-edit-equipment-backdrop') closeEditEquipmentModal();
      });

    this.rootEl.querySelector('#modal-edit-eq-codigo')?.addEventListener('input', (e) => {
      if (!this.editEquipmentModal) return;
      this.editEquipmentModal.nuevoCodigo = e.target.value;
      const normalized = normalizeEquipmentCode(e.target.value);
      const previewEl = this.rootEl.querySelector('#modal-edit-eq-preview');
      if (previewEl) {
        previewEl.textContent = normalized || '—';
      }
      if (this.editEquipmentModal.validationError && normalized) {
        this.editEquipmentModal.validationError = null;
        e.target.classList.remove('field-error-input');
        this.rootEl.querySelector('#modal-edit-eq-error')?.remove();
      }
    });

    this.rootEl.querySelector('#modal-edit-eq-categoria')?.addEventListener('input', (e) => {
      if (this.editEquipmentModal) {
        this.editEquipmentModal.categoria = e.target.value;
      }
    });

    this.rootEl.querySelector('#btn-save-edit-equipment')?.addEventListener('click', () => {
      this.handleSaveEditEquipment();
    });

    this.rootEl.querySelectorAll('[data-delete-equipment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const codigo = btn.getAttribute('data-delete-equipment');
        const eq = this.equipos.find((e) => e.codigo === codigo);
        if (!eq) return;
        const reportCount = this.reportes.filter((r) => r.codigo_equipo === eq.codigo).length;
        this.deleteEquipmentModal = {
          codigo: eq.codigo,
          categoria: eq.categoria || '',
          reportCount,
          deleteReportsToo: false,
          isDeleting: false
        };
        this.render();
      });
    });

    const closeDeleteEquipmentModal = () => {
      if (this.deleteEquipmentModal?.isDeleting) return;
      this.deleteEquipmentModal = null;
      this.render();
    };
    this.rootEl
      .querySelector('#btn-close-delete-equipment')
      ?.addEventListener('click', closeDeleteEquipmentModal);
    this.rootEl
      .querySelector('#btn-cancel-delete-equipment')
      ?.addEventListener('click', closeDeleteEquipmentModal);
    this.rootEl
      .querySelector('#modal-delete-equipment-backdrop')
      ?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-delete-equipment-backdrop') closeDeleteEquipmentModal();
      });

    this.rootEl.querySelector('#chk-delete-eq-reports')?.addEventListener('change', (e) => {
      if (this.deleteEquipmentModal) {
        this.deleteEquipmentModal.deleteReportsToo = Boolean(e.target.checked);
      }
    });

    this.rootEl
      .querySelector('#btn-confirm-delete-equipment')
      ?.addEventListener('click', () => {
        this.handleConfirmDeleteEquipment();
      });
  }

  escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
