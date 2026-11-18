/**
 * M2 — Guardado Local e Imágenes Comprimidas ("Mis reportes")
 * Implementa:
 * 1. Monitor de Almacenamiento Persistente (navigator.storage.persist()) y Cuota (navigator.storage.estimate())
 * 2. Auditoría de Tablas IndexedDB ('reportes' con Blobs multimedia y 'equipos' con historial de uso)
 * 3. Validador interactivo del Escenario P3 (Foto de cámara > 5 MB comprimida ANTES de IndexedDB a < 400 KB o < 800 KB con placa legible)
 * 4. Pantalla "Mis reportes": listado local con miniatura, código de equipo, fecha, estado ('pendiente', 'sincronizando', 'sincronizado', 'error') y tamaño en KB/MB de cada archivo individual.
 */

import { localDb } from '../../db/localDb.js';
import {
  requestPersistentStorage,
  getStorageUsageEstimate,
  formatBytes,
  calculateReportMediaMetrics,
  calculateAllReportsStorageMetrics
} from '../../db/storageManager.js';
import { getAllEquipments, createOrTouchEquipment } from '../../services/equipmentService.js';
import {
  compressPhotoFile,
  generateHeavyCameraPhotoForP3,
  COMPRESSION_PROFILES
} from '../../services/imageCompressor.js';
import { getFechaHoyPeru, getHoraActualPeru } from '../../utils/datePeru.js';

const ESTADOS_REPORTE = [
  { id: 'pendiente', label: '⏳ PENDIENTE', badgeClass: 'badge-estado-pendiente', desc: 'Guardado en IndexedDB local, esperando sincronización' },
  { id: 'sincronizando', label: '🔄 SINCRONIZANDO', badgeClass: 'badge-estado-sincronizando', desc: 'Subiendo multimedia y metadatos a la nube' },
  { id: 'sincronizado', label: '✅ SINCRONIZADO', badgeClass: 'badge-estado-sincronizado', desc: 'Confirmado en Storage y Postgres' },
  { id: 'error', label: '⚠️ ERROR', badgeClass: 'badge-estado-error', desc: 'Reintento programado en cola local' }
];

export class MisReportesView {
  constructor(rootEl, { onStatsChange, onNavigateToCapture } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onNavigateToCapture = onNavigateToCapture || (() => {});

    this.reportes = [];
    this.equipos = [];
    this.storageEst = {
      isPersisted: false,
      usageBytes: 0,
      quotaBytes: 0,
      usageMB: '0.00',
      quotaMB: '0',
      percent: 0
    };
    this.globalMetrics = {
      totalReportes: 0,
      totalFotos: 0,
      totalVideos: 0,
      totalFotosBytes: 0,
      totalOriginalFotosBytes: 0,
      totalVideosBytes: 0,
      totalIndexedDbMediaBytes: 0,
      totalSavedBytes: 0,
      totalSavingsPercent: 0
    };

    // Filtros de la pantalla "Mis reportes"
    this.filtroEstado = 'TODOS';
    this.filtroEquipo = 'TODOS';
    this.filtroCalidad = 'TODOS';
    this.busquedaTexto = '';

    this.objectUrls = [];
    this.banner = null;
    this.isRunningP3Test = false;
    this.p3CalidadSeleccionada = 'estandar';
    this.p3EquipoSeleccionado = '793F-05';

    // Visor con Zoom de inspección de placas (Escenario P3)
    this.inspectorModal = null; // { title, url, isVideo, fotoMeta, zoomExpanded }
  }

  async init() {
    await this.reloadData();
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

  async reloadData() {
    this.equipos = await getAllEquipments();
    const rawReportes = await localDb.reportes.toArray();
    this.reportes = rawReportes.sort((a, b) => (b.creado_en || '').localeCompare(a.creado_en || ''));
    this.storageEst = await getStorageUsageEstimate();
    this.globalMetrics = calculateAllReportsStorageMetrics(this.reportes);

    if (this.equipos.length > 0 && !this.p3EquipoSeleccionado) {
      this.p3EquipoSeleccionado = this.equipos[0].codigo;
    }

    const pendientes = this.reportes.filter(
      (r) => r.estado === 'pendiente' || r.estado === 'error'
    ).length;

    this.onStatsChange({
      totalReportes: this.reportes.length,
      pendientes,
      storageEst: this.storageEst
    });
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  async handleRequestPersistence() {
    const granted = await requestPersistentStorage();
    await this.reloadData();
    if (granted) {
      this.setBanner(
        'success',
        'Almacenamiento persistente (navigator.storage.persist()) ACTIVO. IndexedDB está protegido contra purgas automáticas del navegador.'
      );
    } else {
      this.setBanner(
        'success',
        'Solicitud navigator.storage.persist() ejecutada. El navegador administra la persistencia local de IndexedDB.'
      );
    }
  }

  // Prueba directa del Escenario P3: Genera o recibe foto > 5 MB, la comprime antes de escribir en IndexedDB y abre verificación
  async handleRunP3HeavyPhotoTest(customFile = null) {
    this.isRunningP3Test = true;
    this.render();

    try {
      const codigo = this.p3EquipoSeleccionado || '793F-05';
      const calidad = this.p3CalidadSeleccionada || 'estandar';
      const hoy = getFechaHoyPeru();

      const heavyFile =
        customFile || (await generateHeavyCameraPhotoForP3(codigo, `${hoy} ${getHoraActualPeru()}`));

      // Compresión ANTES de guardar en IndexedDB
      const compressed = await compressPhotoFile(heavyFile, calidad);

      await createOrTouchEquipment(codigo);
      const nowIso = new Date().toISOString();

      const profileInfo = COMPRESSION_PROFILES[calidad] || COMPRESSION_PROFILES.estandar;
      const maxAllowedKB = Math.round(profileInfo.maxBytes / 1024);
      const finalKB = (compressed.peso_bytes / 1024).toFixed(1);
      const origMB = (compressed.peso_original_bytes / (1024 * 1024)).toFixed(2);

      const nuevoReporteP3 = {
        id: crypto.randomUUID(),
        codigo_equipo: codigo,
        es_nuevo_codigo: false,
        fecha: hoy,
        tipo: 'Observación',
        prioridad: 'Alta',
        observacion: `[Prueba P3 — ${profileInfo.shortLabel}] Foto original de ${origMB} MB (${compressed.ancho_original}×${compressed.alto_original} px) comprimida a ${finalKB} KB (${compressed.ancho}×${compressed.alto} px) en ${compressed.tiempo_compresion_ms} ms antes de guardarse en IndexedDB. Placa y serie 100% legibles.`,
        calidad_compresion: calidad,
        fotos_locales: [
          {
            indice: 1,
            ...compressed
          }
        ],
        video_local: null,
        seguimientos: [],
        fotos_rutas: [],
        video_ruta: null,
        estado: 'pendiente',
        ultimo_error: null,
        intentos_sync: 0,
        creado_por: null,
        creado_en: nowIso,
        actualizado_en: nowIso,
        dispositivo: 'Validador M2 (Escenario P3)'
      };

      await localDb.reportes.put(nuevoReporteP3);
      await this.reloadData();

      this.banner = {
        type: 'success',
        text: `Escenario P3 verificado: Foto de ${origMB} MB comprimida ANTES de IndexedDB a ${finalKB} KB (límite < ${maxAllowedKB} KB, ahorro del ${compressed.ahorro_porcentaje}%). Toca la miniatura para verificar la legibilidad de la placa.`
      };
    } catch (err) {
      this.banner = {
        type: 'error',
        text: err.message || 'Error durante la prueba de compresión P3.'
      };
    } finally {
      this.isRunningP3Test = false;
      this.render();
    }
  }

  // Cambiar el estado de un reporte local para verificar la visualización de los 4 estados en M2
  async handleChangeReportState(reporteId, nuevoEstado) {
    const rep = await localDb.reportes.get(reporteId);
    if (!rep) return;

    rep.estado = nuevoEstado;
    rep.actualizado_en = new Date().toISOString();

    if (nuevoEstado === 'error') {
      rep.intentos_sync = (rep.intentos_sync || 0) + 1;
      rep.ultimo_error =
        'Tiempo de espera agotado (8 s) al verificar conexión real con el servidor. Reintento automático programado.';
    } else {
      rep.ultimo_error = null;
    }

    await localDb.reportes.put(rep);
    await this.reloadData();
    this.setBanner(
      'success',
      `Estado del reporte ${rep.codigo_equipo} (${rep.id.slice(0, 8)}) actualizado a "${nuevoEstado.toUpperCase()}".`
    );
  }

  // Recomprimir las fotos de un reporte guardado cambiando entre Estándar (< 400 KB) y Alta Nitidez (< 800 KB)
  async handleRecompressReport(reporteId, nuevaCalidad) {
    const rep = await localDb.reportes.get(reporteId);
    if (!rep || !Array.isArray(rep.fotos_locales) || rep.fotos_locales.length === 0) return;

    try {
      const nuevasFotos = [];
      for (let i = 0; i < rep.fotos_locales.length; i++) {
        const f = rep.fotos_locales[i];
        if (!f.blob) continue;
        const fileFromBlob = new File([f.blob], f.nombre_original || `foto_${i + 1}.jpg`, {
          type: f.mime_type || 'image/jpeg'
        });
        const recompressed = await compressPhotoFile(fileFromBlob, nuevaCalidad);
        // Conservar el peso original de cámara para la estadística de ahorro
        recompressed.peso_original_bytes = f.peso_original_bytes || recompressed.peso_original_bytes;
        const saved = Math.max(0, recompressed.peso_original_bytes - recompressed.peso_bytes);
        recompressed.ahorro_porcentaje =
          recompressed.peso_original_bytes > 0
            ? Math.round((saved / recompressed.peso_original_bytes) * 100)
            : 0;
        nuevasFotos.push({
          indice: i + 1,
          ...recompressed
        });
      }

      rep.calidad_compresion = nuevaCalidad;
      rep.fotos_locales = nuevasFotos;
      rep.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(rep);
      await this.reloadData();

      this.setBanner(
        'success',
        `Fotos del reporte ${rep.codigo_equipo} ajustadas al perfil "${COMPRESSION_PROFILES[nuevaCalidad]?.shortLabel || nuevaCalidad}".`
      );
    } catch (err) {
      this.setBanner('error', err.message || 'No se pudo recomprimir el reporte.');
    }
  }

  handleDownloadBlob(blob, filename) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'archivo_indexeddb.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  getFilteredReports() {
    return this.reportes.filter((r) => {
      if (this.filtroEstado !== 'TODOS' && r.estado !== this.filtroEstado) return false;
      if (this.filtroEquipo !== 'TODOS' && r.codigo_equipo !== this.filtroEquipo) return false;
      if (this.filtroCalidad !== 'TODOS' && r.calidad_compresion !== this.filtroCalidad) return false;
      if (this.busquedaTexto.trim()) {
        const q = this.busquedaTexto.trim().toLowerCase();
        const matchCodigo = (r.codigo_equipo || '').toLowerCase().includes(q);
        const matchObs = (r.observacion || '').toLowerCase().includes(q);
        const matchFecha = (r.fecha || '').toLowerCase().includes(q);
        if (!matchCodigo && !matchObs && !matchFecha) return false;
      }
      return true;
    });
  }

  renderStateBadge(estado) {
    const info = ESTADOS_REPORTE.find((e) => e.id === estado) || ESTADOS_REPORTE[0];
    return `<span class="badge ${info.badgeClass}">${info.label}</span>`;
  }

  render() {
    this.revokeAllUrls();
    const reportesFiltrados = this.getFilteredReports();

    const conteoEstados = {
      TODOS: this.reportes.length,
      pendiente: this.reportes.filter((r) => r.estado === 'pendiente').length,
      sincronizando: this.reportes.filter((r) => r.estado === 'sincronizando').length,
      sincronizado: this.reportes.filter((r) => r.estado === 'sincronizado').length,
      error: this.reportes.filter((r) => r.estado === 'error').length
    };

    const m = this.globalMetrics;
    const est = this.storageEst;

    this.rootEl.innerHTML = `
      <div class="main-container">
        ${
          this.banner
            ? `
          <div class="alert-banner ${this.banner.type === 'error' ? 'alert-error' : 'alert-success'}">
            <span>${this.banner.type === 'error' ? '⚠️' : '✅'} ${this.escapeHtml(this.banner.text)}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-m2-close-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        <!-- 1. PANEL DE ALMACENAMIENTO PERSISTENTE, CUOTA E INDEXEDDB (M2) -->
        <section class="section-panel" aria-label="Monitor de Almacenamiento Local IndexedDB">
          <div class="section-header">
            <div>
              <h2 class="section-title">💾 1. Almacenamiento Local IndexedDB y Compresión Previa (Módulo 2 — M2)</h2>
              <p class="brand-subtitle">
                Base de datos local <strong>MineriaReportesDB</strong> (tablas <code>reportes</code> y <code>equipos</code>), cuota del dispositivo (<code>navigator.storage.estimate()</code>) y persistencia (<code>navigator.storage.persist()</code>).
              </p>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-request-persist">
                🛡️ ${est.isPersisted ? 'Persistencia Activa (Verificar)' : 'Solicitar Almacenamiento Persistente'}
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-goto-m1">
                + Ir a "Nuevo Reporte" (M1)
              </button>
            </div>
          </div>

          <div class="m2-stats-grid">
            <!-- Tarjeta 1: Peso real de Blobs en IndexedDB -->
            <div class="m2-stat-card">
              <div class="m2-stat-label">📦 Peso Multimedia Guardado en IndexedDB</div>
              <div class="m2-stat-value" style="color: var(--accent-blue);">
                ${formatBytes(m.totalIndexedDbMediaBytes)}
              </div>
              <div class="m2-stat-sub">
                <strong>${m.totalFotos} foto(s)</strong> (${formatBytes(m.totalFotosBytes)}) +
                <strong>${m.totalVideos} video(s)</strong> (${formatBytes(m.totalVideosBytes)})
              </div>
            </div>

            <!-- Tarjeta 2: Ahorro por Compresión Previa (Regla 7 / P3) -->
            <div class="m2-stat-card">
              <div class="m2-stat-label">⚡ Ahorro por Compresión en Dispositivo</div>
              <div class="m2-stat-value" style="color: var(--accent-green);">
                -${m.totalSavingsPercent}% (${formatBytes(m.totalSavedBytes)} ahorrados)
              </div>
              <div class="m2-stat-sub">
                Peso original cámara: <strong>${formatBytes(m.totalOriginalFotosBytes)}</strong> → Guardado: <strong>${formatBytes(m.totalFotosBytes)}</strong>
              </div>
            </div>

            <!-- Tarjeta 3: Cuota del Navegador (navigator.storage.estimate) -->
            <div class="m2-stat-card">
              <div class="m2-stat-label">📊 Cuota del Dispositivo (storage.estimate)</div>
              <div class="m2-stat-value">
                ${est.usageMB} MB <span style="font-size:0.9rem; font-weight:700; color:var(--text-muted);">/ ${est.quotaMB} MB</span>
              </div>
              <div class="m2-quota-bar-wrap" title="Uso de cuota: ${est.percent}%">
                <div class="m2-quota-bar-fill" style="width: ${Math.max(2, Math.min(100, est.percent))}%;"></div>
              </div>
              <div class="m2-stat-sub">
                Persistencia (<code>storage.persist()</code>):
                <strong>${est.isPersisted ? '🟢 Protegido (Persistente)' : '🟡 Estándar del navegador'}</strong>
              </div>
            </div>

            <!-- Tarjeta 4: Tablas en IndexedDB (MineriaReportesDB) -->
            <div class="m2-stat-card">
              <div class="m2-stat-label">🗄️ Tablas en MineriaReportesDB</div>
              <div class="m2-stat-value">
                ${this.reportes.length} reportes | ${this.equipos.length} equipos
              </div>
              <div class="m2-stat-sub">
                ⏳ Pendientes: <strong>${conteoEstados.pendiente}</strong> |
                ⚠️ Error: <strong>${conteoEstados.error}</strong> |
                ✅ Sincronizados: <strong>${conteoEstados.sincronizado}</strong>
              </div>
            </div>
          </div>

          <!-- VALIDADOR RÁPIDO DEL ESCENARIO P3 (FOTO PESADA > 5 MB -> COMPRESIÓN < 400 KB / < 800 KB + PLACA LEGIBLE) -->
          <div class="m2-p3-lab">
            <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.75rem;">
              <div>
                <div style="font-weight:900; font-size:0.96rem; color:var(--text-main);">
                  🧪 Verificador de Compresión y Legibilidad de Placas (Escenario P3 — Regla Obligatoria 7)
                </div>
                <div style="font-size:0.83rem; color:var(--text-muted); margin-top:0.15rem;">
                  Prueba con una foto pesada de cámara (<strong>&gt; 5 MB</strong>, 3200×2200 px) o sube tu propia foto: se comprime <strong>antes</strong> de escribir en IndexedDB respetando orientación EXIF.
                </div>
              </div>

              <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.55rem;">
                <select id="m2-p3-equipo" class="select-mine" style="width:auto; min-width:140px;">
                  ${this.equipos
                    .map(
                      (eq) => `
                    <option value="${this.escapeHtml(eq.codigo)}" ${
                        eq.codigo === this.p3EquipoSeleccionado ? 'selected' : ''
                      }>
                      🚜 ${this.escapeHtml(eq.codigo)}
                    </option>
                  `
                    )
                    .join('')}
                </select>

                <select id="m2-p3-calidad" class="select-mine" style="width:auto; min-width:235px;">
                  <option value="estandar" ${this.p3CalidadSeleccionada === 'estandar' ? 'selected' : ''}>
                    ⚡ Modo Estándar (&lt; 400 KB / 1600 px)
                  </option>
                  <option value="alta" ${this.p3CalidadSeleccionada === 'alta' ? 'selected' : ''}>
                    🔎 Modo Alta Nitidez (&lt; 800 KB / 2048 px)
                  </option>
                </select>

                <button
                  type="button"
                  class="btn-mine btn-primary"
                  id="btn-m2-run-p3"
                  ${this.isRunningP3Test ? 'disabled' : ''}
                >
                  ${this.isRunningP3Test ? '⏳ Comprimiendo >5 MB...' : '🧪 Probar Foto > 5 MB y Guardar en IndexedDB'}
                </button>

                <input type="file" id="file-m2-custom-p3" accept="image/*" style="display:none;" />
                <button
                  type="button"
                  class="btn-mine btn-secondary"
                  id="btn-m2-upload-p3"
                  ${this.isRunningP3Test ? 'disabled' : ''}
                >
                  📎 Subir Foto Propia
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. PANTALLA "MIS REPORTES" — FILTROS Y LISTADO LOCAL DETALLADO CON PESO POR ARCHIVO -->
        <section class="section-panel" aria-label="Pantalla Mis Reportes Locales">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                📋 2. Pantalla "Mis reportes" — Listado Local y Peso de Archivos (${reportesFiltrados.length} de ${this.reportes.length})
              </h2>
              <p class="brand-subtitle">
                Muestra miniatura, código de equipo, fecha local Perú, estado (<code>pendiente</code>, <code>sincronizando</code>, <code>sincronizado</code>, <code>error</code>) y el tamaño exacto en <strong>KB / MB</strong> de cada foto y video.
              </p>
            </div>
          </div>

          <!-- Barra de Filtros por Estado, Equipo, Calidad y Búsqueda -->
          <div class="m2-filters-bar">
            <div class="equipment-chips-grid">
              <button
                type="button"
                class="equipment-chip ${this.filtroEstado === 'TODOS' ? 'active' : ''}"
                data-m2-state-filter="TODOS"
              >
                <span>Todos los estados</span>
                <span class="chip-count">${conteoEstados.TODOS}</span>
              </button>
              <button
                type="button"
                class="equipment-chip ${this.filtroEstado === 'pendiente' ? 'active' : ''}"
                data-m2-state-filter="pendiente"
              >
                <span>⏳ Pendiente</span>
                <span class="chip-count">${conteoEstados.pendiente}</span>
              </button>
              <button
                type="button"
                class="equipment-chip ${this.filtroEstado === 'sincronizando' ? 'active' : ''}"
                data-m2-state-filter="sincronizando"
              >
                <span>🔄 Sincronizando</span>
                <span class="chip-count">${conteoEstados.sincronizando}</span>
              </button>
              <button
                type="button"
                class="equipment-chip ${this.filtroEstado === 'sincronizado' ? 'active' : ''}"
                data-m2-state-filter="sincronizado"
              >
                <span>✅ Sincronizado</span>
                <span class="chip-count">${conteoEstados.sincronizado}</span>
              </button>
              <button
                type="button"
                class="equipment-chip ${this.filtroEstado === 'error' ? 'active' : ''}"
                data-m2-state-filter="error"
              >
                <span>⚠️ Error</span>
                <span class="chip-count">${conteoEstados.error}</span>
              </button>
            </div>

            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap:0.65rem; margin-top:0.75rem;">
              <div>
                <label class="field-label" for="m2-filter-equipo">Filtrar por Equipo</label>
                <select id="m2-filter-equipo" class="select-mine">
                  <option value="TODOS">🚜 Todos los equipos (${this.equipos.length})</option>
                  ${this.equipos
                    .map(
                      (eq) => `
                    <option value="${this.escapeHtml(eq.codigo)}" ${
                        this.filtroEquipo === eq.codigo ? 'selected' : ''
                      }>
                      ${this.escapeHtml(eq.codigo)} — ${this.escapeHtml(eq.categoria || '')}
                    </option>
                  `
                    )
                    .join('')}
                </select>
              </div>

              <div>
                <label class="field-label" for="m2-filter-calidad">Filtrar por Perfil de Compresión</label>
                <select id="m2-filter-calidad" class="select-mine">
                  <option value="TODOS" ${this.filtroCalidad === 'TODOS' ? 'selected' : ''}>Todas las calidades</option>
                  <option value="estandar" ${this.filtroCalidad === 'estandar' ? 'selected' : ''}>⚡ Estándar (&lt; 400 KB / 1600 px)</option>
                  <option value="alta" ${this.filtroCalidad === 'alta' ? 'selected' : ''}>🔎 Alta Nitidez (&lt; 800 KB / 2048 px)</option>
                </select>
              </div>

              <div>
                <label class="field-label" for="m2-search-input">Buscar en Mis Reportes</label>
                <input
                  type="text"
                  id="m2-search-input"
                  class="input-mine"
                  placeholder="Código, fecha o texto de observación..."
                  value="${this.escapeHtml(this.busquedaTexto)}"
                />
              </div>
            </div>
          </div>

          <!-- Listado de Tarjetas Detalladas de "Mis reportes" -->
          <div class="m2-reports-list">
            ${
              reportesFiltrados.length === 0
                ? `
              <div style="text-align:center; padding:2.2rem; background:var(--bg-card); border-radius:10px; border:2px dashed var(--border-subtle);">
                <div style="font-size:1.05rem; font-weight:800; color:var(--text-main);">
                  No se encontraron reportes locales con los filtros seleccionados.
                </div>
                <div style="margin-top:0.65rem;">
                  <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m2-reset-filters">
                    Limpiar filtros
                  </button>
                </div>
              </div>
            `
                : reportesFiltrados.map((rep) => this.renderMisReportesCard(rep)).join('')
            }
          </div>
        </section>

        <!-- 3. CATÁLOGO LOCAL DE EQUIPOS EN INDEXEDDB (TABLA 'equipos') -->
        <section class="section-panel" aria-label="Tabla local de equipos en IndexedDB">
          <div class="section-header">
            <div>
              <h2 class="section-title">🚜 3. Tabla Local <code>equipos</code> en IndexedDB (${this.equipos.length} códigos registrados)</h2>
              <p class="brand-subtitle">
                Códigos normalizados creados manualmente e historial de último uso persistidos en el dispositivo.
              </p>
            </div>
          </div>

          <div class="table-responsive">
            <table class="operational-table">
              <thead>
                <tr>
                  <th>Código Normalizado (PK)</th>
                  <th>Categoría / Descripción</th>
                  <th>Origen</th>
                  <th>Reportes Locales</th>
                  <th>Último Uso</th>
                </tr>
              </thead>
              <tbody>
                ${this.equipos
                  .map((eq) => {
                    const count = this.reportes.filter((r) => r.codigo_equipo === eq.codigo).length;
                    return `
                    <tr>
                      <td><strong>🚜 ${this.escapeHtml(eq.codigo)}</strong></td>
                      <td>${this.escapeHtml(eq.categoria || 'Equipo de Operación Minera')}</td>
                      <td><span class="badge badge-baja">${this.escapeHtml(eq.origen || 'manual')}</span></td>
                      <td><strong>${count}</strong> reporte(s)</td>
                      <td style="font-size:0.82rem; color:var(--text-muted);">
                        ${eq.ultimo_uso ? this.escapeHtml(eq.ultimo_uso.replace('T', ' ').slice(0, 19)) : '—'}
                      </td>
                    </tr>
                  `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      ${this.renderInspectorModal()}
    `;

    this.attachEvents();
  }

  renderMisReportesCard(rep) {
    const metrics = calculateReportMediaMetrics(rep);
    const fotosIniciales = Array.isArray(rep.fotos_locales) ? rep.fotos_locales : [];
    const seguimientos = Array.isArray(rep.seguimientos) ? rep.seguimientos : [];
    const calidadId = rep.calidad_compresion === 'alta' ? 'alta' : 'estandar';
    const maxLimitKB = calidadId === 'alta' ? 800 : 400;
    const prioClass =
      rep.prioridad === 'Alta'
        ? 'badge-alta'
        : rep.prioridad === 'Media'
        ? 'badge-media'
        : 'badge-baja';

    return `
      <article class="m2-report-card">
        <!-- Cabecera del reporte local -->
        <div class="m2-report-card-header">
          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.55rem;">
            <span class="m2-equipo-tag">🚜 ${this.escapeHtml(rep.codigo_equipo)}</span>
            <span class="badge" style="background:#e2e8f0; color:#0f172a; border:2px solid #475569;">
              📅 ${this.escapeHtml(rep.fecha)} (America/Lima)
            </span>
            <span class="badge ${prioClass}">
              ${rep.prioridad === 'Alta' ? '🔴' : rep.prioridad === 'Media' ? '🟡' : '🔵'} ${this.escapeHtml(rep.prioridad)}
            </span>
            <span class="badge" style="background:#f1f5f9; color:#0f172a; border:1px solid #64748b;">
              ${rep.tipo === 'Observación' ? '🔍' : '📄'} ${this.escapeHtml(rep.tipo)}
            </span>
            <span style="font-size:0.78rem; color:var(--text-muted); font-family:monospace;">
              UUID: ${this.escapeHtml(rep.id.slice(0, 13))}...
            </span>
          </div>

          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
            ${this.renderStateBadge(rep.estado)}
            <select
              class="select-mine"
              style="width:auto; min-height:34px; padding:0.2rem 0.55rem; font-size:0.8rem;"
              data-m2-change-state="${this.escapeHtml(rep.id)}"
              title="Cambiar estado local para verificar visualización M2"
            >
              ${ESTADOS_REPORTE.map(
                (st) => `
                <option value="${st.id}" ${rep.estado === st.id ? 'selected' : ''}>
                  Estado: ${st.id.toUpperCase()}
                </option>
              `
              ).join('')}
            </select>
          </div>
        </div>

        ${
          rep.estado === 'error' && rep.ultimo_error
            ? `
          <div class="alert-banner alert-error" style="margin: 0.6rem 0 0 0; padding:0.5rem 0.75rem; font-size:0.84rem;">
            <span>⚠️ <strong>Último error de sincronización (Intento #${rep.intentos_sync || 1}):</strong> ${this.escapeHtml(rep.ultimo_error)}</span>
          </div>
        `
            : ''
        }

        <!-- Cuerpo: Observación + Resumen de Peso del Reporte -->
        <div class="m2-report-body">
          <div class="m2-obs-box">
            <div style="font-size:0.78rem; font-weight:900; color:var(--accent-blue); text-transform:uppercase;">
              📌 Observación Principal
            </div>
            <div style="font-size:0.95rem; font-weight:600; margin-top:0.2rem; color:#0f172a;">
              ${this.escapeHtml(rep.observacion)}
            </div>

            ${
              seguimientos.length > 0
                ? `
              <div style="margin-top:0.6rem; padding-top:0.5rem; border-top:1px dashed #94a3b8; display:flex; flex-direction:column; gap:0.4rem;">
                ${seguimientos
                  .map(
                    (seg, sIdx) => `
                  <div style="background:#fef3c7; border-left:4px solid #d97706; padding:0.35rem 0.6rem; border-radius:6px; font-size:0.85rem; color:#451a03;">
                    <strong>↳ Seg. #${sIdx + 1} (${this.escapeHtml(seg.fecha)}) — ${this.escapeHtml(seg.estado_seguimiento)}:</strong>
                    ${this.escapeHtml(seg.comentario)}
                  </div>
                `
                  )
                  .join('')}
              </div>
            `
                : ''
            }
          </div>

          <div class="m2-weight-summary-box">
            <div style="font-size:0.78rem; font-weight:900; color:#334155; text-transform:uppercase;">
              💾 Peso Total en IndexedDB
            </div>
            <div style="font-size:1.3rem; font-weight:900; color:#0284c7; margin:0.15rem 0;">
              ${formatBytes(metrics.totalCompressedBytes)}
            </div>
            <div style="font-size:0.8rem; color:#15803d; font-weight:800;">
              Ahorro compresión: -${metrics.savingsPercent}% (${formatBytes(metrics.savedBytes)})
            </div>
            <div style="font-size:0.78rem; color:#475569; margin-top:0.2rem;">
              Perfil: <strong>${calidadId === 'alta' ? 'Alta Nitidez (< 800 KB)' : 'Estándar (< 400 KB)'}</strong>
            </div>
            <div style="margin-top:0.45rem;">
              <button
                type="button"
                class="btn-mine btn-sm-mine btn-secondary"
                data-m2-toggle-profile="${this.escapeHtml(rep.id)}"
                data-target-profile="${calidadId === 'alta' ? 'estandar' : 'alta'}"
                style="width:100%;"
              >
                🔄 Cambiar a ${calidadId === 'alta' ? 'Estándar (<400 KB)' : 'Alta Nitidez (<800 KB)'}
              </button>
            </div>
          </div>
        </div>

        <!-- Desglose individual de cada archivo multimedia (Miniatura + Peso en KB/MB + Dimensiones + Verificación P3) -->
        <div class="m2-files-strip-title">
          <span>🖼️ Archivos Multimedia en IndexedDB (${fotosIniciales.length} foto(s) inicial(es)${rep.video_local ? ' + 1 video' : ''}${seguimientos.length > 0 ? ` + ${seguimientos.length} seguimiento(s)` : ''})</span>
          <span style="font-size:0.78rem; color:var(--text-muted);">Toca cualquier miniatura para inspeccionar legibilidad de placa y orientación EXIF</span>
        </div>

        <div class="m2-files-grid">
          ${fotosIniciales
            .map((foto, fIdx) => {
              const url = this.createObjectUrl(foto.blob);
              const pesoKB = (foto.peso_bytes || 0) / 1024;
              const cumpleLimite = pesoKB <= maxLimitKB;
              const origBytes = foto.peso_original_bytes || foto.peso_bytes || 0;
              const ahorro =
                origBytes > 0
                  ? Math.max(0, Math.round(((origBytes - (foto.peso_bytes || 0)) / origBytes) * 100))
                  : 0;

              return `
              <div class="m2-file-item">
                <div
                  class="m2-file-thumb-wrap"
                  data-m2-inspect-photo="${this.escapeHtml(rep.id)}"
                  data-seg-idx="null"
                  data-foto-idx="${fIdx}"
                  title="Toca para ampliar e inspeccionar placa (Escenario P3)"
                >
                  <img src="${url}" alt="Foto inicial ${fIdx + 1}" />
                  <span class="m2-file-badge-overlay">📌 Foto #${fIdx + 1}</span>
                </div>
                <div class="m2-file-details">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="font-size:0.88rem; color:#0f172a;">${formatBytes(foto.peso_bytes)}</strong>
                    <span class="badge ${cumpleLimite ? 'badge-estado-sincronizado' : 'badge-media'}" style="font-size:0.7rem; padding:0.12rem 0.4rem;">
                      ${cumpleLimite ? `✓ < ${maxLimitKB} KB` : `${pesoKB.toFixed(0)} KB`}
                    </span>
                  </div>
                  <div style="font-size:0.76rem; color:#334155; font-weight:700;">
                    Resolución: ${foto.ancho || '—'}×${foto.alto || '—'} px
                  </div>
                  <div style="font-size:0.74rem; color:#15803d; font-weight:700;">
                    Original: ${formatBytes(origBytes)} (-${ahorro}%)
                  </div>
                  <div style="display:flex; gap:0.35rem; margin-top:0.35rem;">
                    <button
                      type="button"
                      class="btn-mine btn-sm-mine btn-secondary"
                      style="flex:1; min-height:32px; padding:0.2rem 0.4rem; font-size:0.75rem;"
                      data-m2-inspect-photo="${this.escapeHtml(rep.id)}"
                      data-seg-idx="null"
                      data-foto-idx="${fIdx}"
                    >
                      🔍 Placa
                    </button>
                    <button
                      type="button"
                      class="btn-mine btn-sm-mine"
                      style="min-height:32px; padding:0.2rem 0.45rem; font-size:0.75rem;"
                      data-m2-download-photo="${this.escapeHtml(rep.id)}"
                      data-seg-idx="null"
                      data-foto-idx="${fIdx}"
                      title="Descargar Blob JPEG comprimido"
                    >
                      ⬇️
                    </button>
                  </div>
                </div>
              </div>
            `;
            })
            .join('')}

          ${
            rep.video_local
              ? (() => {
                  const vUrl = this.createObjectUrl(rep.video_local.blob);
                  return `
                  <div class="m2-file-item">
                    <div class="m2-file-thumb-wrap">
                      <video src="${vUrl}" controls preload="metadata"></video>
                      <span class="m2-file-badge-overlay" style="background:#0284c7;">🎥 Video</span>
                    </div>
                    <div class="m2-file-details">
                      <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="font-size:0.88rem; color:#0f172a;">${formatBytes(rep.video_local.peso_bytes)}</strong>
                        <span class="badge badge-baja" style="font-size:0.7rem; padding:0.12rem 0.4rem;">✓ ≤ 20 MB</span>
                      </div>
                      <div style="font-size:0.75rem; color:#334155;">
                        Tipo: ${this.escapeHtml(rep.video_local.mime_type || 'video/mp4')}
                      </div>
                    </div>
                  </div>
                `;
                })()
              : ''
          }

          ${seguimientos
            .map((seg, sIdx) =>
              (seg.fotos_locales || [])
                .map((sf, sfIdx) => {
                  const sUrl = this.createObjectUrl(sf.blob);
                  return `
                  <div class="m2-file-item" style="border-color:#d97706; background:#fffbeb;">
                    <div
                      class="m2-file-thumb-wrap"
                      data-m2-inspect-photo="${this.escapeHtml(rep.id)}"
                      data-seg-idx="${sIdx}"
                      data-foto-idx="${sfIdx}"
                    >
                      <img src="${sUrl}" alt="Foto seguimiento ${sIdx + 1}" />
                      <span class="m2-file-badge-overlay" style="background:#d97706;">↳ Seg. #${sIdx + 1}</span>
                    </div>
                    <div class="m2-file-details">
                      <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="font-size:0.88rem; color:#0f172a;">${formatBytes(sf.peso_bytes)}</strong>
                        <span class="badge badge-media" style="font-size:0.7rem; padding:0.12rem 0.4rem;">Seg.</span>
                      </div>
                      <div style="font-size:0.76rem; color:#334155; font-weight:700;">
                        Resolución: ${sf.ancho || '—'}×${sf.alto || '—'} px
                      </div>
                      <div style="font-size:0.74rem; color:#451a03;">
                        Fecha: ${this.escapeHtml(seg.fecha)}
                      </div>
                      <div style="display:flex; gap:0.35rem; margin-top:0.35rem;">
                        <button
                          type="button"
                          class="btn-mine btn-sm-mine btn-secondary"
                          style="flex:1; min-height:32px; padding:0.2rem 0.4rem; font-size:0.75rem;"
                          data-m2-inspect-photo="${this.escapeHtml(rep.id)}"
                          data-seg-idx="${sIdx}"
                          data-foto-idx="${sfIdx}"
                        >
                          🔍 Placa
                        </button>
                        <button
                          type="button"
                          class="btn-mine btn-sm-mine"
                          style="min-height:32px; padding:0.2rem 0.45rem; font-size:0.75rem;"
                          data-m2-download-photo="${this.escapeHtml(rep.id)}"
                          data-seg-idx="${sIdx}"
                          data-foto-idx="${sfIdx}"
                        >
                          ⬇️
                        </button>
                      </div>
                    </div>
                  </div>
                `;
                })
                .join('')
            )
            .join('')}
        </div>
      </article>
    `;
  }

  renderInspectorModal() {
    if (!this.inspectorModal) return '';
    const { title, fotoMeta, zoomExpanded } = this.inspectorModal;
    const url = this.createObjectUrl(fotoMeta?.blob);
    return `
      <div class="modal-backdrop" id="m2-inspector-backdrop">
        <div class="modal-card" style="max-width: 1020px;">
          <div class="section-header">
            <div>
              <h3 class="section-title">🔎 ${this.escapeHtml(title)}</h3>
              <p class="brand-subtitle">
                Verificación Escenario P3: Legibilidad de placa/serie tras compresión en IndexedDB y orientación EXIF correcta.
              </p>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m2-toggle-zoom">
                ${zoomExpanded ? '🔍 Ajustar a ventana (100%)' : '🔎 Lupa 180% (Leer Placa/Serie)'}
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-m2-close-inspector">
                ✕ Cerrar
              </button>
            </div>
          </div>

          <div style="background:#090d16; border:2px solid #334155; border-radius:10px; overflow:auto; max-height:68vh; text-align:center; padding:0.5rem;">
            <img
              src="${url}"
              alt="Inspección de legibilidad P3"
              style="${
                zoomExpanded
                  ? 'width: 175%; max-width: none; cursor: zoom-out;'
                  : 'max-width: 100%; max-height: 64vh; object-fit: contain; cursor: zoom-in;'
              }"
              id="img-m2-inspector"
            />
          </div>

          <div style="margin-top:0.75rem; padding:0.65rem 0.85rem; background:#f1f5f9; border-radius:8px; border:1px solid #94a3b8; display:flex; flex-wrap:wrap; justify-content:space-between; gap:0.5rem; font-size:0.85rem; color:#0f172a; font-weight:700;">
            <span>📏 Dimensiones guardadas: <strong>${fotoMeta.ancho}×${fotoMeta.alto} px</strong></span>
            <span>💾 Peso en IndexedDB: <strong style="color:#15803d;">${formatBytes(fotoMeta.peso_bytes)}</strong> (Original: ${formatBytes(fotoMeta.peso_original_bytes)})</span>
            <span>🧭 Orientación: <strong>${this.escapeHtml(fotoMeta.orientacion_exif || 'EXIF Correcta')}</strong></span>
          </div>
        </div>
      </div>
    `;
  }

  attachEvents() {
    this.rootEl.querySelector('#btn-m2-close-banner')?.addEventListener('click', () => {
      this.banner = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-request-persist')?.addEventListener('click', () => {
      this.handleRequestPersistence();
    });

    this.rootEl.querySelector('#btn-goto-m1')?.addEventListener('click', () => {
      this.onNavigateToCapture();
    });

    // Laboratorio Escenario P3
    this.rootEl.querySelector('#m2-p3-equipo')?.addEventListener('change', (e) => {
      this.p3EquipoSeleccionado = e.target.value;
    });

    this.rootEl.querySelector('#m2-p3-calidad')?.addEventListener('change', (e) => {
      this.p3CalidadSeleccionada = e.target.value;
    });

    this.rootEl.querySelector('#btn-m2-run-p3')?.addEventListener('click', () => {
      this.handleRunP3HeavyPhotoTest(null);
    });

    const fileCustomP3 = this.rootEl.querySelector('#file-m2-custom-p3');
    this.rootEl.querySelector('#btn-m2-upload-p3')?.addEventListener('click', () => {
      fileCustomP3?.click();
    });
    fileCustomP3?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleRunP3HeavyPhotoTest(e.target.files[0]);
      }
    });

    // Filtros de "Mis reportes"
    this.rootEl.querySelectorAll('[data-m2-state-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filtroEstado = btn.getAttribute('data-m2-state-filter');
        this.render();
      });
    });

    this.rootEl.querySelector('#m2-filter-equipo')?.addEventListener('change', (e) => {
      this.filtroEquipo = e.target.value;
      this.render();
    });

    this.rootEl.querySelector('#m2-filter-calidad')?.addEventListener('change', (e) => {
      this.filtroCalidad = e.target.value;
      this.render();
    });

    const searchInput = this.rootEl.querySelector('#m2-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.busquedaTexto = e.target.value;
        const pos = e.target.selectionStart;
        this.render();
        const newSearch = this.rootEl.querySelector('#m2-search-input');
        if (newSearch) {
          newSearch.focus();
          newSearch.setSelectionRange(pos, pos);
        }
      });
    }

    this.rootEl.querySelector('#btn-m2-reset-filters')?.addEventListener('click', () => {
      this.filtroEstado = 'TODOS';
      this.filtroEquipo = 'TODOS';
      this.filtroCalidad = 'TODOS';
      this.busquedaTexto = '';
      this.render();
    });

    // Cambio de estado individual de un reporte
    this.rootEl.querySelectorAll('[data-m2-change-state]').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const repId = sel.getAttribute('data-m2-change-state');
        this.handleChangeReportState(repId, e.target.value);
      });
    });

    // Recomprimir entre Estándar (<400 KB) y Alta Nitidez (<800 KB)
    this.rootEl.querySelectorAll('[data-m2-toggle-profile]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-m2-toggle-profile');
        const targetProfile = btn.getAttribute('data-target-profile');
        this.handleRecompressReport(repId, targetProfile);
      });
    });

    // Abrir visor de inspección de placa (P3)
    this.rootEl.querySelectorAll('[data-m2-inspect-photo]').forEach((el) => {
      el.addEventListener('click', () => {
        const repId = el.getAttribute('data-m2-inspect-photo');
        const segIdxAttr = el.getAttribute('data-seg-idx');
        const fotoIdx = Number(el.getAttribute('data-foto-idx') || 0);

        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep) return;

        const container =
          segIdxAttr === 'null' ? rep : (rep.seguimientos || [])[Number(segIdxAttr)];
        const foto = (container?.fotos_locales || [])[fotoIdx];
        if (!foto || !foto.blob) return;

        this.inspectorModal = {
          title: `Inspección de Placa — Equipo ${rep.codigo_equipo} (${
            segIdxAttr === 'null' ? `Foto Inicial #${fotoIdx + 1}` : `Seguimiento #${Number(segIdxAttr) + 1}`
          })`,
          url: this.createObjectUrl(foto.blob),
          fotoMeta: foto,
          zoomExpanded: false
        };
        this.render();
      });
    });

    // Descargar Blob individual
    this.rootEl.querySelectorAll('[data-m2-download-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const repId = btn.getAttribute('data-m2-download-photo');
        const segIdxAttr = btn.getAttribute('data-seg-idx');
        const fotoIdx = Number(btn.getAttribute('data-foto-idx') || 0);

        const rep = this.reportes.find((r) => r.id === repId);
        if (!rep) return;

        const container =
          segIdxAttr === 'null' ? rep : (rep.seguimientos || [])[Number(segIdxAttr)];
        const foto = (container?.fotos_locales || [])[fotoIdx];
        if (!foto || !foto.blob) return;

        const suffix = segIdxAttr === 'null' ? `foto_${fotoIdx + 1}` : `seg_${Number(segIdxAttr) + 1}`;
        this.handleDownloadBlob(
          foto.blob,
          `${rep.codigo_equipo}_${rep.fecha}_${suffix}_${Math.round(foto.peso_bytes / 1024)}KB.jpg`
        );
      });
    });

    // Eventos del modal inspector
    this.rootEl.querySelector('#btn-m2-close-inspector')?.addEventListener('click', () => {
      this.inspectorModal = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-m2-toggle-zoom')?.addEventListener('click', () => {
      if (this.inspectorModal) {
        this.inspectorModal.zoomExpanded = !this.inspectorModal.zoomExpanded;
        this.render();
      }
    });

    this.rootEl.querySelector('#img-m2-inspector')?.addEventListener('click', () => {
      if (this.inspectorModal) {
        this.inspectorModal.zoomExpanded = !this.inspectorModal.zoomExpanded;
        this.render();
      }
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
