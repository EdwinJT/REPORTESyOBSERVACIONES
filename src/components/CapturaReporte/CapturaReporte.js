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
import { getFechaHoyPeru, getHoraActualPeru, esFechaValida } from '../../utils/datePeru.js';
import { normalizeEquipmentCode } from '../../utils/codeNormalizer.js';
import {
  getAllEquipments,
  createOrTouchEquipment,
  syncEquipmentsFromCloudReports
} from '../../services/equipmentService.js';
import {
  compressPhotoFile,
  validateVideoFile,
  COMPRESSION_PROFILES
} from '../../services/imageCompressor.js';
import { authService } from '../../services/authService.js';
import { pwaManager } from '../../services/pwaManager.js';
import { syncQueue } from '../../services/syncQueue.js';

export class CapturaReporteView {
  constructor(rootEl, { onStatsChange } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});

    // Estado de datos persistidos
    this.equipos = [];
    this.reportes = [];
    this.objectUrls = [];

    // Filtro activo en Cuadro de Equipos ("TODOS" o código específico)
    this.filtroEquipo = 'TODOS';

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
    this.followupModal = null; // { reporteId, codigo_equipo, fecha, estado_seguimiento, comentario, fotos_locales, video_local, validationError }
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

  async hydrateRemoteSeguimientos(remSegs, localSegs = []) {
    if (!Array.isArray(remSegs)) return [];
    const localList = Array.isArray(localSegs) ? localSegs : [];
    const hydrated = [];

    for (let sIdx = 0; sIdx < remSegs.length; sIdx++) {
      const seg = remSegs[sIdx];
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
        for (let si = 0; si < segPaths.length; si++) {
          const signedSeg = await supabase.storage.from('fotos').createSignedUrl(segPaths[si], 3600);
          segFotosLocales.push({
            indice: si + 1,
            blob: null,
            signedUrl: signedSeg?.data?.signedUrl || '',
            ruta_remota: segPaths[si],
            peso_bytes: 0,
            ancho: 1600,
            alto: 1200
          });
        }
      }

      hydrated.push({
        ...matchedLocal,
        ...seg,
        fotos_locales: segFotosLocales,
        video_local: matchedLocal?.video_local || null
      });
    }

    return hydrated;
  }

  async reloadData() {
    const rawLocal = await localDb.reportes.toArray();
    const authState = authService.getState();
    let mergedReports = [...rawLocal];

    // Si hay sesión real en Supabase Cloud, descargar reportes de todos los dispositivos y fusionarlos en la tabla principal
    if (authState.isRealCloudSession && pwaManager.getState().isOnline) {
      try {
        const res = await supabase.from('reportes').select();
        if (Array.isArray(res.data) && res.data.length > 0) {
          await syncEquipmentsFromCloudReports(res.data, rawLocal);
          const mergedMap = new Map();
          for (const loc of rawLocal) {
            mergedMap.set(loc.id, loc);
          }

          for (const rem of res.data) {
            const existingLoc = mergedMap.get(rem.id);
            if (existingLoc) {
              // Preservar reportes locales con cambios/seguimientos pendientes por subir
              if (existingLoc.estado === 'pendiente' || existingLoc.estado === 'sincronizando') {
                mergedMap.set(rem.id, existingLoc);
                continue;
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
                fotos_rutas: Array.isArray(rem.fotos) ? rem.fotos : existingLoc.fotos_rutas || [],
                seguimientos: mergedSegs.length > 0 ? mergedSegs : existingLoc.seguimientos || [],
                estado: 'sincronizado',
                sincronizado_en_nube_real: true
              });
            } else {
              // Reporte creado en otro celular o PC: firmar URLs para vista previa real en tabla principal
              const cloudPhotos = [];
              const remotePaths = Array.isArray(rem.fotos) ? rem.fotos : [];
              for (let i = 0; i < remotePaths.length; i++) {
                const signed = await supabase.storage.from('fotos').createSignedUrl(remotePaths[i], 3600);
                cloudPhotos.push({
                  indice: i + 1,
                  blob: null,
                  signedUrl: signed?.data?.signedUrl || '',
                  ruta_remota: remotePaths[i],
                  peso_bytes: 0,
                  ancho: rem.calidad_compresion === 'alta' ? 2048 : 1600,
                  alto: rem.calidad_compresion === 'alta' ? 1536 : 1200
                });
              }

              const cloudSegs = await this.hydrateRemoteSeguimientos(rem.seguimientos, []);

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
          }
          mergedReports = Array.from(mergedMap.values());
        }
      } catch {
        // Si falla la red momentáneamente, continuar con IndexedDB local
      }
    }

    this.equipos = await getAllEquipments();
    this.reportes = mergedReports.sort((a, b) => (b.creado_en || '').localeCompare(a.creado_en || ''));
    const storageEst = await getStorageUsageEstimate();
    const pendientes = rawLocal.filter((r) => r.estado === 'pendiente' || r.estado === 'error').length;
    this.onStatsChange({
      totalReportes: this.reportes.length,
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
      await this.reloadData();

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

    await this.reloadData();
    this.setBanner(
      'success',
      `Reporte del equipo ${codigo} guardado en el dispositivo (IndexedDB) en estado "pendiente".`
    );

    // Si hay conexión real y sesión válida en Supabase, iniciar subida automática en segundo plano
    if (pwaManager.getState().isOnline && authService.getState().isAuthenticatedValid) {
      syncQueue.processQueue({ triggerSource: 'Nuevo reporte guardado en M1' }).catch(() => {});
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

  // Guardar un nuevo seguimiento (↳) desde el modal rápido de la tabla
  async handleSaveFollowupModal() {
    if (!this.followupModal) return;
    if (this.followupModal.isSaving || this.followupModal.isUploadingPhotos) return;

    const { reporteId, fecha, estado_seguimiento, comentario, fotos_locales, video_local, mode } =
      this.followupModal;
    const isResolveMode = mode === 'levantada';

    if (!comentario.trim()) {
      this.followupModal.validationError = isResolveMode
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
      let reporte = await localDb.reportes.get(reporteId);
      if (!reporte) {
        const fromView = this.reportes.find((r) => r.id === reporteId);
        if (!fromView) return;
        reporte = {
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

      if (!Array.isArray(reporte.seguimientos)) {
        reporte.seguimientos = [];
      }

      reporte.seguimientos.push({
        id: crypto.randomUUID(),
        fecha: fecha || getFechaHoyPeru(),
        estado_seguimiento: estado_seguimiento || 'Sigue observación',
        comentario: comentario.trim(),
        fotos_locales: fotos_locales || [],
        video_local: video_local || null
      });

      reporte.estado = 'pendiente';
      reporte.sincronizado_en_nube_real = false;
      reporte.ultimo_error = null;
      reporte.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(reporte);

      if (pwaManager.getState().isOnline) {
        try {
          await syncQueue.processQueue({
            triggerSource: isResolveMode ? 'Observación levantada' : 'Nuevo seguimiento agregado',
            forceManual: true,
            targetReportId: reporte.id,
            perFileDelayMs: 25
          });
        } catch {
          // Si falla la red momentáneamente, el seguimiento permanece seguro en IndexedDB
        }
      }

      this.followupModal = null;
      await this.reloadData();
      this.setBanner(
        'success',
        isResolveMode
          ? `Observación levantada registrada en el equipo ${reporte.codigo_equipo}.`
          : `Seguimiento (↳) agregado al reporte de ${reporte.codigo_equipo}.`
      );
    } finally {
      if (this.followupModal) {
        this.followupModal.isSaving = false;
        this.render();
      }
    }
  }

  render() {
    this.revokeAllUrls();

    const reportesFiltrados =
      this.filtroEquipo === 'TODOS'
        ? this.reportes
        : this.reportes.filter((r) => r.codigo_equipo === this.filtroEquipo);

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

        <!-- 1. CUADRO DE CÓDIGOS DE EQUIPOS CREADOS (SELECTOR + FILTRO RÁPIDO) -->
        <section class="section-panel" aria-label="Cuadro de Códigos de Equipos Creados">
          <div class="section-header">
            <div>
              <h2 class="section-title">🚜 1. Cuadro de Códigos de Equipos Creados (Selector + Filtro Rápido)</h2>
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
              <button
                type="button"
                class="equipment-chip ${this.filtroEquipo === eq.codigo ? 'active' : ''}"
                data-filter-code="${this.escapeHtml(eq.codigo)}"
                title="${this.escapeHtml(eq.categoria || 'Equipo minero')}"
              >
                <span>🔧 ${this.escapeHtml(eq.codigo)}</span>
                <span class="chip-count">${conteoPorEquipo[eq.codigo] || 0}</span>
              </button>
            `
              )
              .join('')}
          </div>
        </section>

        <!-- 2. PANEL DE CREACIÓN DE REPORTE ("NUEVO REPORTE") -->
        <section class="section-panel" aria-label="Panel de Creación de Reporte">
          <div class="section-header">
            <div>
              <h2 class="section-title">📝 2. Panel de Creación de Reporte ("Nuevo Reporte" — M1)</h2>
              <p class="brand-subtitle">
                Diseñado para operación con guantes (botones ≥ 48 px). Captura de 1 a 5 fotos comprimidas + 1 video corto opcional, código normalizado y múltiples observaciones.
              </p>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-test-night-p1" title="Simula las 23:30 h en Lima (04:30 UTC del día siguiente) para verificar Escenario P1">
                🌙 Probar Guardia Nocturna 23:30 h (P1)
              </button>
            </div>
          </div>

          <div class="form-grid">
            <!-- Selector desplegable + Creación manual de Código de Equipo -->
            <div class="field-group">
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

            <!-- Fecha en America/Lima + Tipo + Prioridad -->
            <div class="field-group">
              <label class="field-label" for="input-fecha-peru">
                <span>Fecha Local Perú (America/Lima) *</span>
                <span style="font-size:0.78rem; color:var(--accent-blue);">Hora Lima: ${getHoraActualPeru()}</span>
              </label>
              <input
                type="date"
                id="input-fecha-peru"
                class="input-mine"
                value="${this.escapeHtml(this.form.fecha)}"
              />

              <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 0.65rem; margin-top: 0.45rem;">
                <div>
                  <label class="field-label" for="select-tipo">Tipo *</label>
                  <select id="select-tipo" class="select-mine">
                    <option value="Observación" ${this.form.tipo === 'Observación' ? 'selected' : ''}>🔍 Observación</option>
                    <option value="Reporte" ${this.form.tipo === 'Reporte' ? 'selected' : ''}>📄 Reporte</option>
                  </select>
                </div>
                <div>
                  <label class="field-label" for="select-prioridad">Prioridad *</label>
                  <select id="select-prioridad" class="select-mine">
                    <option value="Alta" ${this.form.prioridad === 'Alta' ? 'selected' : ''}>🔴 Alta</option>
                    <option value="Media" ${this.form.prioridad === 'Media' ? 'selected' : ''}>🟡 Media</option>
                    <option value="Baja" ${this.form.prioridad === 'Baja' ? 'selected' : ''}>🔵 Baja</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- Calidad de Compresión de Foto -->
            <div class="field-group">
              <label class="field-label" for="select-calidad">
                <span>Calidad de Compresión de Foto (P3) *</span>
              </label>
              <select id="select-calidad" class="select-mine">
                <option value="estandar" ${this.form.calidad_compresion === 'estandar' ? 'selected' : ''}>
                  ⚡ Estándar (&lt; 400 KB / máx. 1600 px) — Recomendado
                </option>
                <option value="alta" ${this.form.calidad_compresion === 'alta' ? 'selected' : ''}>
                  🔎 Alta Nitidez (&lt; 800 KB / máx. 2048 px) — Placas / Series / Fisuras
                </option>
              </select>
              <div class="norm-preview">
                Toda foto se comprime en el dispositivo <strong>antes</strong> de guardarse en IndexedDB.
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
                        <label class="field-label">Fecha de este punto (America/Lima)</label>
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
        </section>

        <!-- 3. TABLA PRINCIPAL CON ORDEN DE LECTURA OPERATIVO -->
        <section class="section-panel" aria-label="Tabla Principal con Orden de Lectura Operativo">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                📊 3. Tabla Principal con Orden de Lectura Operativo (${
                  this.filtroEquipo === 'TODOS'
                    ? `Todos los equipos: ${reportesFiltrados.length}`
                    : `Filtrado por equipo ${this.escapeHtml(this.filtroEquipo)}: ${reportesFiltrados.length}`
                })
              </h2>
              <p class="brand-subtitle">
                Orden operativo: <strong>1. Equipo → 2. Fecha (Inicial / Seg.) → 3. Vista Previa (Inicial / Seg.) → 4. Observación Principal y Comentarios Posteriores → 5. Tipo / Prioridad → 6. Estado</strong>.
              </p>
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

          <div class="table-responsive">
            <table class="operational-table report-main-table">
              <thead>
                <tr>
                  <th style="width: 13%;">1. Equipo</th>
                  <th style="width: 14%;">2. Fecha (Inicial / Seg.)</th>
                  <th style="width: 19%;">3. Vista Previa (Inicial / Seg.)</th>
                  <th style="width: 29%;">4. Observación Principal y Comentarios Posteriores</th>
                  <th style="width: 13%;">5. Tipo / Prioridad</th>
                  <th style="width: 12%;">6. Estado</th>
                </tr>
              </thead>
              <tbody>
                ${
                  reportesFiltrados.length === 0
                    ? `
                  <tr>
                    <td colspan="6" style="text-align:center; padding: 2rem; color: var(--text-muted);">
                      No hay reportes registrados para el filtro seleccionado. Usa el panel superior para registrar uno nuevo.
                    </td>
                  </tr>
                `
                    : reportesFiltrados.map((rep, repIdx) => this.renderTableRow(rep, repIdx)).join('')
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>

      ${this.renderViewerModal()}
      ${this.renderFollowupModal()}
    `;

    this.attachEvents();
  }

  renderTableRow(rep, repIdx = 0) {
    const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
    const isSegLevantada = (s) => String(s?.estado_seguimiento || '').toLowerCase().includes('levantada');
    const isReportLevantada = seguimientos.some((s) => isSegLevantada(s));
    const totalRows = 1 + seguimientos.length;
    const groupStripeClass = repIdx % 2 === 1 ? 'report-group-even' : 'report-group-odd';
    const initialRowClasses = `report-row-initial ${groupStripeClass}${seguimientos.length === 0 ? ' report-row-last' : ''}`;
    const prioClass =
      rep.prioridad === 'Alta'
        ? 'badge-alta'
        : rep.prioridad === 'Media'
        ? 'badge-media'
        : 'badge-baja';

    const initialRowHtml = `
      <tr class="${initialRowClasses}" data-report-id="${this.escapeHtml(rep.id)}">
        <!-- COL 1: EQUIPO -->
        <td rowspan="${totalRows}" class="report-span-cell">
          <div style="display:flex; flex-direction:column; gap:0.45rem;">
            <button
              type="button"
              class="btn-mine btn-sm-mine btn-primary"
              data-filter-code="${this.escapeHtml(rep.codigo_equipo)}"
              title="Filtrar por este equipo"
            >
              🚜 ${this.escapeHtml(rep.codigo_equipo)}
            </button>
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

        <!-- COL 2: FECHA (INICIAL) -->
        <td class="report-slot-cell">
          <div class="slot-initial">
            <div>
              <div style="font-size:0.76rem; color:var(--text-muted); font-weight:700;">📌 Fecha Inicial</div>
              <div style="font-size:1rem; font-weight:800; margin-top:0.2rem; white-space:nowrap;">${this.escapeHtml(rep.fecha)}</div>
            </div>
            <div style="font-size:0.74rem; color:var(--accent-blue);">Zona: America/Lima</div>
          </div>
        </td>

        <!-- COL 3: VISTA PREVIA (INICIAL) -->
        <td class="report-slot-cell">
          <div class="slot-initial">
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

        <!-- COL 4: OBSERVACIÓN PRINCIPAL -->
        <td class="report-slot-cell">
          <div class="slot-initial">
            <div>
              <div style="font-size:0.76rem; font-weight:800; color:var(--accent-blue); margin-bottom:0.2rem;">
                📌 Observación Principal
              </div>
              <div style="font-size:0.92rem;">${this.escapeHtml(rep.observacion)}</div>
            </div>
            <div style="margin-top:0.45rem; display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center;">
              <button
                type="button"
                class="btn-mine btn-sm-mine"
                data-open-followup-modal="${this.escapeHtml(rep.id)}"
              >
                + Agregar Seguimiento (↳)
              </button>
              ${
                !isReportLevantada
                  ? `
                <button
                  type="button"
                  class="btn-mine btn-sm-mine btn-success"
                  data-open-resolve-modal="${this.escapeHtml(rep.id)}"
                >
                  ✅ Observación Levantada
                </button>
              `
                  : `<span class="badge badge-resolved">✅ Observación Levantada</span>`
              }
            </div>
          </div>
        </td>

        <!-- COL 5: TIPO / PRIORIDAD -->
        <td rowspan="${totalRows}" class="report-span-cell">
          <div style="display:flex; flex-direction:column; gap:0.45rem;">
            <span class="badge ${prioClass}">
              ${rep.prioridad === 'Alta' ? '🔴' : rep.prioridad === 'Media' ? '🟡' : '🔵'} Prioridad ${this.escapeHtml(rep.prioridad)}
            </span>
            <span class="badge" style="border:1px solid var(--border-strong);">
              ${rep.tipo === 'Observación' ? '🔍' : '📄'} ${this.escapeHtml(rep.tipo)}
            </span>
            <span style="font-size:0.75rem; color:var(--text-muted);">
              Calidad: ${rep.calidad_compresion === 'alta' ? 'Alta Nitidez (2048px)' : 'Estándar (1600px)'}
            </span>
          </div>
        </td>

        <!-- COL 6: ESTADO -->
        <td rowspan="${totalRows}" class="report-span-cell">
          <div style="display:flex; flex-direction:column; gap:0.5rem;">
            <span class="badge ${rep.sincronizado_en_nube_real ? 'badge-baja' : 'badge-pending'}">
              ${rep.sincronizado_en_nube_real ? '☁️ EN NUBE' : `⏳ ${this.escapeHtml(rep.estado.toUpperCase())}`}
            </span>
            <span style="font-size:0.75rem; color:var(--text-muted);">
              ${
                rep.desde_otro_dispositivo
                  ? 'Descargado de Supabase Cloud'
                  : rep.sincronizado_en_nube_real
                    ? 'Confirmado en Supabase Cloud'
                    : 'Guardado solo en este dispositivo'
              }
            </span>
          </div>
        </td>
      </tr>
    `;

    const followupRowsHtml = seguimientos
      .map((seg, sIdx) => {
        const isLastSeg = sIdx === seguimientos.length - 1;
        const isResolvedSeg = isSegLevantada(seg);
        const slotClass = isResolvedSeg ? 'slot-followup slot-resolved' : 'slot-followup';
        const labelColor = isResolvedSeg ? '#15803d' : 'var(--accent-amber)';
        const segRowClasses = `report-row-followup ${groupStripeClass}${isLastSeg ? ' report-row-last' : ''}`;
        const segFotos = seg.fotos_locales || [];

        return `
      <tr class="${segRowClasses}" data-report-id="${this.escapeHtml(rep.id)}" data-seg-row="${sIdx}">
        <!-- COL 2: FECHA SEGUIMIENTO #${sIdx + 1} -->
        <td class="report-slot-cell">
          <div class="${slotClass}">
            <div>
              <div style="font-size:0.76rem; color:${labelColor}; font-weight:800;">${
                isResolvedSeg ? `↳ ✅ Levantada (#${sIdx + 1})` : `↳ Seguimiento #${sIdx + 1}`
              }</div>
              <div style="font-size:0.98rem; font-weight:800; margin-top:0.2rem; white-space:nowrap;">${this.escapeHtml(seg.fecha)}</div>
            </div>
            <div style="font-size:0.74rem; color:var(--text-muted);">${isResolvedSeg ? 'Fecha Cierre' : 'Fecha Seg.'}</div>
          </div>
        </td>

        <!-- COL 3: VISTA PREVIA SEGUIMIENTO #${sIdx + 1} -->
        <td class="report-slot-cell">
          <div class="${slotClass}">
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

        <!-- COL 4: COMENTARIO POSTERIOR SEGUIMIENTO #${sIdx + 1} -->
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
            <div style="font-size:0.73rem; color:var(--text-muted);">
              ${isResolvedSeg ? `Cierre / Levantamiento (#${sIdx + 1})` : `Comentario posterior #${sIdx + 1}`}
            </div>
          </div>
        </td>
      </tr>
    `;
      })
      .join('');

    return `${initialRowHtml}${followupRowsHtml}`;
  }

  renderViewerModal() {
    if (!this.viewerModal) return '';
    const { title, blob, signedUrl, isVideo, meta } = this.viewerModal;
    const url = blob ? this.createObjectUrl(blob) : (signedUrl || '');
    return `
      <div class="modal-backdrop" id="modal-viewer-backdrop">
        <div class="modal-card">
          <div class="section-header">
            <h3 class="section-title">🔍 ${this.escapeHtml(title)}</h3>
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-download-viewer" ${!url ? 'disabled' : ''}>
                ⬇️ Descargar
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-viewer">
                ✕ Cerrar
              </button>
            </div>
          </div>
          <div style="background:#0f172a; border-radius:10px; padding:0.5rem; overflow:hidden; text-align:center; max-height:72vh; display:flex; align-items:center; justify-content:center;">
            ${
              isVideo
                ? `<video src="${url}" controls autoplay style="max-width:100%; max-height:68vh; border-radius:6px;"></video>`
                : `<img src="${url}" alt="Inspección de placa" style="max-width:100%; max-height:68vh; object-fit:contain; border-radius:6px;" />`
            }
          </div>
          <div style="margin-top:0.75rem; font-size:0.88rem; color:var(--text-muted); display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem; font-weight:700;">
            <span>${this.escapeHtml(meta || '')}</span>
            <span>Verificación de legibilidad de placa / serie (Escenario P3)</span>
          </div>
        </div>
      </div>
    `;
  }

  renderFollowupModal() {
    if (!this.followupModal) return '';
    const m = this.followupModal;
    const isUploading = Boolean(m.isUploadingPhotos);
    const isSaving = Boolean(m.isSaving);
    const isBusy = isUploading || isSaving;
    const photoCount = m.fotos_locales.length;

    let statusPillHtml = `<span class="followup-status-pill empty">Sin foto adjunta</span>`;
    if (isUploading) {
      statusPillHtml = `<span class="followup-status-pill uploading">⏳ Procesando foto(s)...</span>`;
    } else if (photoCount > 0) {
      statusPillHtml = `<span class="followup-status-pill ready">✅ ${photoCount} foto(s) lista(s) para subir</span>`;
    }

    const thumbsHtml = m.fotos_locales
      .map((f, fIdx) => {
        const url = f.blob ? this.createObjectUrl(f.blob) : f.signedUrl || '';
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
              <span>${formatBytes(f.peso_bytes || 0)}</span>
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

    return `
      <div class="modal-backdrop" id="modal-followup-backdrop">
        <div class="modal-card">
          <div class="section-header${isResolveMode ? ' modal-header-resolved' : ''}">
            <h3 class="section-title">${
              isResolveMode
                ? `✅ Levantar Observación — Equipo ${this.escapeHtml(m.codigo_equipo)}`
                : `↳ Nuevo Seguimiento para Equipo ${this.escapeHtml(m.codigo_equipo)}`
            }</h3>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-followup">
              ✕ Cancelar
            </button>
          </div>

          <div class="form-grid">
            <div class="field-group">
              <label class="field-label">${
                isResolveMode ? 'Fecha de Levantamiento (America/Lima)' : 'Fecha del Seguimiento (America/Lima)'
              }</label>
              <input type="date" id="modal-seg-fecha" class="input-mine" value="${this.escapeHtml(m.fecha)}" />
            </div>

            <div class="field-group">
              <label class="field-label">Estado de la Observación</label>
              ${
                isResolveMode
                  ? `<div class="resolved-state-readonly">✅ Observación Levantada</div>`
                  : `
                <select id="modal-seg-estado" class="select-mine">
                  <option value="Sigue observación" ${m.estado_seguimiento === 'Sigue observación' ? 'selected' : ''}>
                    ⚠️ Sigue observación
                  </option>
                  <option value="En monitoreo" ${m.estado_seguimiento === 'En monitoreo' ? 'selected' : ''}>
                    🛠️ En monitoreo
                  </option>
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
                  ? isResolveMode
                    ? '⏳ Guardando cierre...'
                    : '⏳ Guardando seguimiento...'
                  : isUploading
                    ? '⏳ Procesando fotos...'
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

  attachEvents() {
    // Cerrar banner
    const btnCloseBanner = this.rootEl.querySelector('#btn-close-banner');
    if (btnCloseBanner) {
      btnCloseBanner.addEventListener('click', () => {
        this.banner = null;
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

    // Botón para probar Escenario P1 (Guardia nocturna 23:30 h en Lima = 04:30 UTC del día siguiente)
    const btnTestNightP1 = this.rootEl.querySelector('#btn-test-night-p1');
    if (btnTestNightP1) {
      btnTestNightP1.addEventListener('click', () => {
        // 2026-11-18T04:30:00Z equivale exactamente a 2026-11-17 23:30:00 en Lima (UTC-5)
        const simulatedNightDate = new Date('2026-11-18T04:30:00.000Z');
        const wrongUtcDate = simulatedNightDate.toISOString().slice(0, 10);
        const correctPeruDate = getFechaHoyPeru(simulatedNightDate);
        this.form.fecha = correctPeruDate;
        this.setBanner(
          'success',
          `Prueba P1 (Guardia Nocturna 23:30 h Lima): En UTC ya sería "${wrongUtcDate}", pero datePeru.js mantuvo la fecha real de Perú "${correctPeruDate}".`
        );
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
          title: `Vista Previa Foto #${idx + 1} — ${this.form.codigo_equipo}`,
          blob: foto.blob,
          signedUrl: foto.signedUrl || '',
          filename: `${this.form.codigo_equipo || 'equipo'}_preview_${idx + 1}.jpg`,
          isVideo: false,
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
          title: `Equipo ${rep.codigo_equipo} — ${
            segAttr === 'null' ? 'Evidencia Inicial' : `Seguimiento #${Number(segAttr) + 1}`
          }`,
          blob: foto.blob || null,
          signedUrl: foto.signedUrl || '',
          filename: `${rep.codigo_equipo}_${target.fecha || rep.fecha}_${
            segAttr === 'null' ? 'inicial' : `seg_${Number(segAttr) + 1}`
          }_foto_${fIdx + 1}.jpg`,
          isVideo: false,
          meta: `Fecha: ${target.fecha || rep.fecha} | Dimensiones: ${foto.ancho}×${foto.alto} px | ${foto.peso_bytes ? 'Peso: ' + formatBytes(foto.peso_bytes) : 'Imagen en Supabase Cloud'}`
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

    // Eventos de modales
    this.rootEl.querySelector('#btn-download-viewer')?.addEventListener('click', () => {
      if (!this.viewerModal) return;
      this.handleDownloadMedia(
        this.viewerModal.blob,
        this.viewerModal.filename,
        this.viewerModal.signedUrl
      );
    });

    this.rootEl.querySelector('#btn-close-viewer')?.addEventListener('click', () => {
      this.viewerModal = null;
      this.render();
    });

    this.rootEl.querySelector('#modal-viewer-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-viewer-backdrop') {
        this.viewerModal = null;
        this.render();
      }
    });

    this.rootEl.querySelector('#btn-close-followup')?.addEventListener('click', () => {
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
            indice: this.followupModal.fotos_locales.length + 1,
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
            indice: this.followupModal.fotos_locales.length + 1,
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
        this.followupModal.fotos_locales.forEach((item, i) => {
          item.indice = i + 1;
        });
        this.render();
      });
    });

    this.rootEl.querySelector('#btn-save-followup')?.addEventListener('click', () => {
      this.handleSaveFollowupModal();
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
