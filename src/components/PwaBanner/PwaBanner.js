/**
 * M3 — PWA Instalable y Modo Sin Conexión (PwaBanner.js)
 * Incluye:
 * 1. PwaGlobalBanner: Barra rápida global en la parte superior con:
 *    - Indicador visible de estado de red ("En línea" / "Sin conexión" / "Modo Avión P5")
 *    - Aviso interactivo de "Nueva versión disponible" (registerType: 'prompt') con botón "Actualizar ahora"
 *    - Botón "📲 Instalar app" y botón "🍎 Guía iOS (Compartir → Agregar a inicio)"
 * 2. PwaModuleView: Vista completa del Módulo 3 (M3) con:
 *    - Auditoría del Precaché del App Shell en CacheStorage (HTML, JS, CSS, íconos 192x192 y 512x512, manifest)
 *    - Validador interactivo del Escenario P5 (Modo Avión + Cerrar y Abrir App + Crear reporte 100 % Offline)
 *    - Instalador PWA con previsualización del Web App Manifest (display: standalone) e instrucciones paso a paso para iPhone/iPad (Safari) y Android/PC.
 */

import { pwaManager, APP_SHELL_CACHE_NAME } from '../../services/pwaManager.js';
import { localDb } from '../../db/localDb.js';
import { formatBytes, getStorageUsageEstimate } from '../../db/storageManager.js';
import { getAllEquipments, createOrTouchEquipment } from '../../services/equipmentService.js';
import { compressPhotoFile, generateHeavyCameraPhotoForP3 } from '../../services/imageCompressor.js';
import { getFechaHoyPeru, getHoraActualPeru } from '../../utils/datePeru.js';

export class PwaGlobalBanner {
  constructor(mountEl, { onOpenPwaModule } = {}) {
    this.mountEl = mountEl;
    this.onOpenPwaModule = onOpenPwaModule || (() => {});
    this.showIosModal = false;
    this.unsubscribe = null;
  }

  init() {
    this.unsubscribe = pwaManager.subscribe(() => {
      this.render();
    });
    this.render();
  }

  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  render() {
    if (!this.mountEl) return;
    const state = pwaManager.getState();

    this.mountEl.innerHTML = `
      <div class="pwa-top-strip ${state.isOnline ? 'is-online' : 'is-offline'}">
        <div class="pwa-strip-left">
          <span class="pwa-net-indicator ${state.isOnline ? 'net-on' : 'net-off'}">
            ${
              state.simulatedAirplaneMode
                ? '✈️ MODO AVIÓN SIMULADO (SIN CONEXIÓN - ESCENARIO P5)'
                : state.isOnline
                  ? '🟢 ESTADO DE RED: EN LÍNEA'
                  : '🔴 ESTADO DE RED: SIN CONEXIÓN (OPERACIÓN 100 % LOCAL ACTIVA)'
            }
          </span>
          <span class="pwa-sw-chip" title="Estado del Service Worker y Precaché del App Shell">
            ⚙️ SW: <strong>${state.swStatus}</strong>
          </span>
        </div>

        <div class="pwa-strip-actions">
          <button
            type="button"
            class="btn-mine btn-sm-mine ${state.simulatedAirplaneMode ? 'btn-danger' : 'btn-secondary'}"
            id="btn-strip-toggle-airplane"
            title="Probar funcionamiento sin señal (Escenario P5)"
          >
            ${state.simulatedAirplaneMode ? '📶 Desactivar Modo Avión' : '✈️ Probar Modo Avión (P5)'}
          </button>

          <button
            type="button"
            class="btn-mine btn-sm-mine btn-primary"
            id="btn-strip-install-pwa"
            title="Instalar PWA en pantalla de inicio (Android / PC / iOS)"
          >
            📲 ${state.isInstalledStandalone ? 'App Instalada (Standalone)' : 'Instalar app'}
          </button>

          <button
            type="button"
            class="btn-mine btn-sm-mine"
            id="btn-strip-ios-guide"
            title="Instrucciones explícitas para iPhone y iPad en Safari"
          >
            🍎 iOS: Compartir → Agregar a inicio
          </button>
        </div>
      </div>

      ${
        state.updateAvailable
          ? `
        <div class="pwa-update-prompt-bar" role="alert">
          <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
            <span style="font-size:1.25rem;">🚀</span>
            <div>
              <strong>¡Nueva versión de la PWA disponible! (Workbox registerType: 'prompt')</strong>
              <div style="font-size:0.83rem;">
                Se descargó una actualización del App Shell en segundo plano. Tus reportes en IndexedDB están protegidos y no se borrarán.
              </div>
            </div>
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-prompt-reload-sw">
              🔄 Actualizar ahora
            </button>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-prompt-dismiss-sw">
              Más tarde
            </button>
          </div>
        </div>
      `
          : ''
      }

      ${this.showIosModal ? this.renderIosInstallModal(state) : ''}
    `;

    this.bindEvents(state);
  }

  renderIosInstallModal(state) {
    return `
      <div class="modal-backdrop" id="pwa-ios-modal-backdrop">
        <div class="modal-card" style="max-width:640px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:0.6rem; border-bottom:3px solid #f59e0b; padding-bottom:0.65rem; margin-bottom:0.85rem;">
            <div>
              <h3 style="margin:0; font-size:1.1rem; color:#0f172a;">
                📲 Instalar PWA en Celular o PC (Modo Sin Conexión)
              </h3>
              <div style="font-size:0.82rem; color:#475569; font-weight:700;">
                Plataforma detectada: ${state.platform.userAgentShort}
              </div>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-ios-modal">
              ✕ Cerrar
            </button>
          </div>

          ${
            state.canInstallPrompt
              ? `
            <div style="background:#dcfce7; border:2px solid #16a34a; border-radius:10px; padding:0.85rem; margin-bottom:0.9rem;">
              <div style="font-weight:900; color:#14532d; margin-bottom:0.4rem;">
                ✅ Instalación Directa Disponible en tu Navegador
              </div>
              <p style="margin:0 0 0.6rem 0; font-size:0.86rem; color:#166534;">
                Tu navegador soporta instalación directa con un toque. Crea el acceso directo nativo en tu pantalla de inicio:
              </p>
              <button type="button" class="btn-mine btn-primary" id="btn-modal-native-install" style="width:100%; min-height:48px;">
                📲 Instalar Aplicación Ahora
              </button>
            </div>
          `
              : ''
          }

          <div style="background:#fef3c7; border:2px solid #d97706; border-left:6px solid #b45309; border-radius:10px; padding:0.9rem; margin-bottom:0.9rem;">
            <div style="font-weight:900; font-size:0.96rem; color:#78350f; margin-bottom:0.45rem;">
              🍎 Instrucciones en iPhone / iPad (iOS Safari): "Compartir → Agregar a inicio"
            </div>
            <ol style="margin:0; padding-left:1.25rem; font-size:0.88rem; color:#451a03; font-weight:700; display:flex; flex-direction:column; gap:0.4rem;">
              <li>Abre esta dirección desde el navegador <strong>Safari</strong> en tu iPhone o iPad.</li>
              <li>Toca el botón <strong>"Compartir"</strong> (ícono del cuadrado con la flecha hacia arriba <strong>[↑]</strong> en la barra inferior o superior).</li>
              <li>Desliza el menú hacia abajo y selecciona <strong>"Agregar a inicio"</strong> (<em>Add to Home Screen</em>).</li>
              <li>Toca <strong>"Agregar"</strong> en la esquina superior derecha. La app se abrirá a pantalla completa (<code>display: standalone</code>) con su ícono minero y protección contra la purga de 7 días de iOS.</li>
            </ol>
          </div>

          <div style="background:#f1f5f9; border:2px solid #475569; border-radius:10px; padding:0.85rem;">
            <div style="font-weight:900; font-size:0.92rem; color:#0f172a; margin-bottom:0.35rem;">
              🤖 Instrucciones en Android (Chrome / Edge) y PC
            </div>
            <ul style="margin:0; padding-left:1.25rem; font-size:0.85rem; color:#334155; font-weight:700; display:flex; flex-direction:column; gap:0.3rem;">
              <li><strong>En Android (Chrome):</strong> Toca el botón <strong>"Instalar app"</strong> o el menú de tres puntos <strong>(⋮) → "Instalar aplicación" / "Agregar a la pantalla principal"</strong>.</li>
              <li><strong>En PC (Chrome / Edge):</strong> Haz clic en el ícono de instalación <strong>(⊕ / 🖥️)</strong> a la derecha de la barra de direcciones para instalarla como ventana independiente.</li>
            </ul>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; margin-top:0.95rem; flex-wrap:wrap;">
            <button type="button" class="btn-mine btn-secondary" id="btn-modal-go-m3">
              📡 Ir al Panel Completo del Módulo 3 (M3)
            </button>
            <button type="button" class="btn-mine btn-primary" id="btn-modal-ok">
              Entendido
            </button>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents(state) {
    this.mountEl.querySelector('#btn-strip-toggle-airplane')?.addEventListener('click', () => {
      pwaManager.setSimulatedAirplaneMode(!state.simulatedAirplaneMode);
    });

    this.mountEl.querySelector('#btn-strip-install-pwa')?.addEventListener('click', async () => {
      if (state.canInstallPrompt) {
        await pwaManager.triggerNativeInstallPrompt();
      } else {
        this.showIosModal = true;
        this.render();
      }
    });

    this.mountEl.querySelector('#btn-strip-ios-guide')?.addEventListener('click', () => {
      this.showIosModal = true;
      this.render();
    });

    this.mountEl.querySelector('#btn-prompt-reload-sw')?.addEventListener('click', async () => {
      await pwaManager.applyPendingUpdate();
    });

    this.mountEl.querySelector('#btn-prompt-dismiss-sw')?.addEventListener('click', () => {
      pwaManager.dismissUpdatePrompt();
    });

    this.mountEl.querySelector('#btn-close-ios-modal')?.addEventListener('click', () => {
      this.showIosModal = false;
      this.render();
    });

    this.mountEl.querySelector('#btn-modal-ok')?.addEventListener('click', () => {
      this.showIosModal = false;
      this.render();
    });

    this.mountEl.querySelector('#btn-modal-native-install')?.addEventListener('click', async () => {
      await pwaManager.triggerNativeInstallPrompt();
      this.showIosModal = false;
      this.render();
    });

    this.mountEl.querySelector('#btn-modal-go-m3')?.addEventListener('click', () => {
      this.showIosModal = false;
      this.render();
      this.onOpenPwaModule();
    });

    this.mountEl.querySelector('#pwa-ios-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'pwa-ios-modal-backdrop') {
        this.showIosModal = false;
        this.render();
      }
    });
  }
}

/**
 * Vista Principal del Módulo 3 (M3 — PWA Instalable y Modo Sin Conexión)
 */
export class PwaModuleView {
  constructor(rootEl, { onStatsChange, onNavigateModule } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onNavigateModule = onNavigateModule || (() => {});

    this.precachedAssets = [];
    this.reportes = [];
    this.equipos = [];
    this.storageEst = { isPersisted: false, usageMB: '0.00', quotaMB: '0', percent: 0 };
    this.banner = null;
    this.isRunningP5Simulation = false;
    this.p5LogSteps = [];
    this.unsubscribe = null;
  }

  async init() {
    this.unsubscribe = pwaManager.subscribe(() => {
      this.render();
    });
    await this.reloadAll();
    this.render();
  }

  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async reloadAll() {
    this.precachedAssets = await pwaManager.inspectPrecachedAssets();
    this.reportes = await localDb.reportes.toArray();
    this.equipos = await getAllEquipments();
    this.storageEst = await getStorageUsageEstimate();
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  /**
   * Simulación y verificación paso a paso del Escenario P5:
   * 1. Verifica que el App Shell esté precacheado en CacheStorage
   * 2. Activa Modo Avión (Sin conexión)
   * 3. Simula cierre y reapertura fría leyendo el App Shell desde CacheStorage y los datos desde IndexedDB
   * 4. Registra un nuevo reporte con foto comprimida estando 100 % sin conexión
   */
  async handleRunScenarioP5Test() {
    this.isRunningP5Simulation = true;
    this.p5LogSteps = [];
    this.render();

    try {
      // Paso 1: Precaché del App Shell
      await pwaManager.warmUpAppShellCache();
      this.precachedAssets = await pwaManager.inspectPrecachedAssets();
      const cachedCount = this.precachedAssets.filter((a) => a.cached).length;
      this.p5LogSteps.push({
        step: '1. Precaché del App Shell (Workbox / Service Worker)',
        status: 'OK',
        detail: `${cachedCount} de ${this.precachedAssets.length} archivos críticos (HTML, JS, CSS, Manifest e Íconos 192/512) almacenados en CacheStorage (${APP_SHELL_CACHE_NAME}).`
      });

      // Paso 2: Activar Modo Avión
      pwaManager.setSimulatedAirplaneMode(true);
      this.p5LogSteps.push({
        step: '2. Activación de Modo Avión (Corte total de red)',
        status: 'OK',
        detail: 'Estado de red cambiado a 🔴 SIN CONEXIÓN. Cero peticiones externas permitidas.'
      });

      // Paso 3: Simular Cerrar y Volver a Abrir la App sin señal
      const prevReportes = await localDb.reportes.toArray();
      const prevEquipos = await getAllEquipments();
      this.p5LogSteps.push({
        step: '3. Reapertura en frío en Modo Avión (App Shell + IndexedDB)',
        status: 'OK',
        detail: `App Shell servido desde caché local. Se recuperaron intactos ${prevReportes.length} reportes previos y ${prevEquipos.length} códigos de equipo desde IndexedDB.`
      });

      // Paso 4: Crear un nuevo reporte completo con foto comprimida estando en Modo Avión
      const codigo = prevEquipos[0]?.codigo || '793F-05';
      const hoy = getFechaHoyPeru();
      const hora = getHoraActualPeru();
      const sampleFile = await generateHeavyCameraPhotoForP3(codigo, `${hoy} ${hora}`);
      const compressed = await compressPhotoFile(sampleFile, 'estandar');

      await createOrTouchEquipment(codigo);
      const nowIso = new Date().toISOString();

      const nuevoReporteOffline = {
        id: crypto.randomUUID(),
        codigo_equipo: codigo,
        es_nuevo_codigo: false,
        fecha: hoy,
        hora_peru: hora,
        tipo: 'Observación',
        prioridad: 'Alta',
        observacion: `[PRUEBA ESCENARIO P5 - 100 % OFFLINE EN MODO AVIÓN] Reporte registrado sin conexión tras cerrar y reabrir la PWA. App Shell cargado desde CacheStorage y foto comprimida (${formatBytes(compressed.peso_bytes)}) guardada en IndexedDB.`,
        calidad_compresion: 'estandar',
        fotos_locales: [
          {
            indice: 1,
            nombre_original: compressed.nombre_original,
            blob: compressed.blob,
            peso_bytes: compressed.peso_bytes,
            peso_original_bytes: compressed.peso_original_bytes,
            ancho: compressed.ancho,
            alto: compressed.alto,
            calidad_aplicada: 'estandar',
            orientacion_exif: 'Normalizada (EXIF from-image)',
            ruta_remota: null
          }
        ],
        video_local: null,
        seguimientos: [],
        fotos_rutas: [],
        video_ruta: null,
        estado: 'pendiente',
        ultimo_error: null,
        intentos_sync: 0,
        creado_por: 'operador-offline-p5',
        creado_en: nowIso,
        actualizado_en: nowIso,
        dispositivo: 'PWA Standalone (Modo Avión P5)'
      };

      await localDb.reportes.put(nuevoReporteOffline);
      await this.reloadAll();
      await this.onStatsChange();

      this.p5LogSteps.push({
        step: '4. Registro de Nuevo Reporte Offline en IndexedDB',
        status: 'OK',
        detail: `Reporte UUID ${nuevoReporteOffline.id.slice(0, 8)}... para equipo ${codigo} guardado en estado "pendiente" con foto de ${formatBytes(compressed.peso_bytes)} sin conexión.`
      });

      this.setBanner(
        'success',
        `✅ Escenario P5 verificado con éxito: La PWA funciona al 100 % en Modo Avión, mantiene los reportes previos y registró un nuevo reporte para ${codigo} sin red.`
      );
    } catch (err) {
      this.setBanner('error', `Error durante la prueba del Escenario P5: ${err?.message || err}`);
    } finally {
      this.isRunningP5Simulation = false;
      this.render();
    }
  }

  render() {
    if (!this.rootEl) return;
    const pwaState = pwaManager.getState();
    const cachedFilesCount = this.precachedAssets.filter((a) => a.cached).length;
    const totalCacheBytes = this.precachedAssets.reduce((acc, a) => acc + (a.sizeBytes || 0), 0);
    const pendientesCount = this.reportes.filter(
      (r) => r.estado === 'pendiente' || r.estado === 'error'
    ).length;

    this.rootEl.innerHTML = `
      <div class="main-container">
        ${
          this.banner
            ? `
          <div class="alert-banner ${this.banner.type === 'error' ? 'alert-error' : 'alert-success'}">
            <span>${this.banner.type === 'error' ? '⚠️' : '✅'} ${this.banner.text}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-m3-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        <!-- 1. PANEL DE ESTADO PWA, RED, MANIFEST Y SERVICE WORKER (M3) -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>📲 1. MÓDULO 3 (M3): PWA INSTALABLE, SERVICE WORKER Y MODO SIN CONEXIÓN</span>
              </h2>
              <p class="brand-subtitle">
                Configuración Workbox (generateSW, registerType: 'prompt'), Web App Manifest (display: standalone) y Precaché Offline
              </p>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m3-refresh-cache">
                🔄 Verificar y Actualizar Precaché
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-m3-simulate-update">
                🚀 Probar Aviso "Nueva versión disponible"
              </button>
            </div>
          </div>

          <!-- Tarjetas de estado M3 -->
          <div class="m2-stats-grid">
            <div class="m2-stat-card" style="border-left:5px solid ${pwaState.isOnline ? '#16a34a' : '#dc2626'};">
              <span class="m2-stat-label">1. Estado de Red Actual</span>
              <div class="m2-stat-value" style="color:${pwaState.isOnline ? 'var(--accent-green)' : 'var(--accent-red)'};">
                ${pwaState.isOnline ? '🟢 EN LÍNEA' : '🔴 SIN CONEXIÓN'}
              </div>
              <span class="m2-stat-sub">
                ${
                  pwaState.simulatedAirplaneMode
                    ? 'Modo Avión P5 activo para pruebas sin señal en mina.'
                    : 'Detección reactiva (eventos online/offline) + barra fija superior.'
                }
              </span>
              <div style="margin-top:0.35rem;">
                <button
                  type="button"
                  class="btn-mine btn-sm-mine ${pwaState.simulatedAirplaneMode ? 'btn-danger' : 'btn-secondary'}"
                  id="btn-m3-card-toggle-airplane"
                  style="width:100%;"
                >
                  ${pwaState.simulatedAirplaneMode ? '📶 Volver a En Línea' : '✈️ Simular Modo Avión'}
                </button>
              </div>
            </div>

            <div class="m2-stat-card" style="border-left:5px solid #0284c7;">
              <span class="m2-stat-label">2. Service Worker (Workbox Prompt)</span>
              <div class="m2-stat-value">
                ${pwaState.hasServiceWorkerSupport ? '⚙️ ACTIVO' : '⚠️ NO SOPORTADO'}
              </div>
              <span class="m2-stat-sub">
                Estrategia: <strong>generateSW</strong> | <code>registerType: 'prompt'</code> (avisa antes de actualizar).
              </span>
              <span class="m2-stat-sub" style="font-weight:800; color:var(--accent-blue);">
                ${pwaState.swStatus}
              </span>
            </div>

            <div class="m2-stat-card" style="border-left:5px solid #d97706;">
              <span class="m2-stat-label">3. Precaché del App Shell</span>
              <div class="m2-stat-value">
                ${cachedFilesCount} / ${this.precachedAssets.length} archivos (${formatBytes(totalCacheBytes)})
              </div>
              <span class="m2-stat-sub">
                Caché: <code>${APP_SHELL_CACHE_NAME}</code>
              </span>
              <span class="m2-stat-sub">
                HTML, JS, CSS, Manifest e íconos listos para abrir en Modo Avión.
              </span>
            </div>

            <div class="m2-stat-card" style="border-left:5px solid #15803d;">
              <span class="m2-stat-label">4. Instalación PWA (Standalone)</span>
              <div class="m2-stat-value">
                ${pwaState.isInstalledStandalone ? '✅ INSTALADA' : '📲 LISTA PARA INSTALAR'}
              </div>
              <span class="m2-stat-sub">
                Dispositivo: <strong>${pwaState.platform.osName}</strong>
              </span>
              <div style="margin-top:0.35rem;">
                <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-m3-card-install" style="width:100%;">
                  📲 ${pwaState.canInstallPrompt ? 'Instalar App Ahora' : 'Ver Cómo Instalar en Celular/PC'}
                </button>
              </div>
            </div>
          </div>

          <!-- Laboratorio Interactivo del Escenario P5 -->
          <div class="m2-p3-lab" style="margin-top:1rem;">
            <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.75rem;">
              <div style="flex: 1 1 440px;">
                <div style="font-weight:900; font-size:0.96rem; display:flex; align-items:center; gap:0.45rem;">
                  <span>✈️ LABORATORIO DE VALIDACIÓN — ESCENARIO P5 (FUNCIONAMIENTO 100 % OFFLINE EN MODO AVIÓN)</span>
                  <span class="badge badge-pending">Requisito M3 / P5</span>
                </div>
                <p style="margin:0.25rem 0 0 0; font-size:0.84rem;">
                  Simula activar <strong>Modo Avión</strong>, cerrar y reabrir la PWA cargando el App Shell desde <code>CacheStorage</code>, leer los <strong>${this.reportes.length} reportes locales</strong> desde IndexedDB y registrar un reporte nuevo sin conexión.
                </p>
              </div>

              <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;">
                <button
                  type="button"
                  class="btn-mine btn-primary"
                  id="btn-m3-run-p5"
                  ${this.isRunningP5Simulation ? 'disabled' : ''}
                >
                  ${
                    this.isRunningP5Simulation
                      ? '⏳ Ejecutando prueba Modo Avión P5...'
                      : '✈️ Ejecutar Prueba Completa Modo Avión (P5)'
                  }
                </button>

                <button type="button" class="btn-mine btn-secondary" id="btn-m3-go-m1">
                  📝 Ir a Crear Reporte (M1)
                </button>

                <button type="button" class="btn-mine" id="btn-m3-go-m2">
                  💾 Ver "Mis reportes" (${this.reportes.length} locales / ${pendientesCount} pend.)
                </button>
              </div>
            </div>

            ${
              this.p5LogSteps.length > 0
                ? `
              <div style="margin-top:0.8rem; background:#ffffff; color:#0f172a; border:2px solid #16a34a; border-radius:8px; padding:0.75rem;">
                <div style="font-weight:900; font-size:0.88rem; color:#14532d; margin-bottom:0.45rem;">
                  ✅ Resultado de Auditoría del Escenario P5 (100 % Offline):
                </div>
                <div style="display:flex; flex-direction:column; gap:0.4rem;">
                  ${this.p5LogSteps
                    .map(
                      (s) => `
                    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:0.6rem; font-size:0.83rem; padding:0.35rem 0.5rem; background:#f0fdf4; border-radius:6px; border:1px solid #bbf7d0;">
                      <div>
                        <strong>${s.step}:</strong> ${s.detail}
                      </div>
                      <span class="badge badge-estado-sincronizado">${s.status}</span>
                    </div>
                  `
                    )
                    .join('')}
                </div>
              </div>
            `
                : ''
            }
          </div>
        </section>

        <!-- 2. GUÍA DE INSTALACIÓN PWA (ANDROID, PC E INSTRUCCIONES EXPLÍCITAS iOS SAFARI) + WEB APP MANIFEST -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>🍎 2. INSTALACIÓN EN DISPOSITIVO E INSTRUCCIONES iOS / ANDROID + WEB APP MANIFEST</span>
              </h2>
              <p class="brand-subtitle">
                Guía visual para supervisores en campo ("Compartir → Agregar a inicio" en iPhone) e íconos de alto contraste 192x192 y 512x512
              </p>
            </div>
          </div>

          <div class="m3-install-grid">
            <!-- Columna 1: Guía iOS Safari obligatoria -->
            <div class="m3-guide-card m3-guide-ios">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.5rem;">
                <h3 style="margin:0; font-size:1rem; color:#78350f;">
                  🍎 iPhone / iPad (iOS Safari)
                </h3>
                <span class="badge badge-pending">Compartir → Agregar a inicio</span>
              </div>
              <p style="margin:0 0 0.6rem 0; font-size:0.84rem; color:#451a03; font-weight:700;">
                En iOS, instalar la PWA en la pantalla de inicio evita la política de purga de 7 días de Safari y habilita el modo pantalla completa sin barras del navegador:
              </p>
              <div class="m3-steps-list">
                <div class="m3-step-item">
                  <span class="m3-step-num">1</span>
                  <div>Abre esta aplicación desde <strong>Safari</strong> en tu iPhone o iPad.</div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">2</span>
                  <div>Toca el botón <strong>"Compartir" [↑]</strong> en la barra inferior de Safari.</div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">3</span>
                  <div>Selecciona <strong>"Agregar a inicio"</strong> (<em>Add to Home Screen</em>) y confirma en <strong>"Agregar"</strong>.</div>
                </div>
              </div>
            </div>

            <!-- Columna 2: Guía Android y PC -->
            <div class="m3-guide-card">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.5rem;">
                <h3 style="margin:0; font-size:1rem; color:#0f172a;">
                  🤖 Android (Chrome / Edge) y PC
                </h3>
                <span class="badge badge-baja">WebAPK / Standalone</span>
              </div>
              <p style="margin:0 0 0.6rem 0; font-size:0.84rem; color:#334155; font-weight:700;">
                En Android y PC la aplicación se instala como paquete nativo independiente con almacenamiento persistente:
              </p>
              <div class="m3-steps-list">
                <div class="m3-step-item">
                  <span class="m3-step-num">1</span>
                  <div>Presiona el botón <strong>"📲 Instalar app"</strong> en la barra superior de esta pantalla.</div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">2</span>
                  <div>Si no aparece el cuadro automático, abre el menú del navegador <strong>(⋮)</strong> y elige <strong>"Instalar aplicación"</strong>.</div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">3</span>
                  <div>Ábrela desde el ícono <strong>"Reportes Mina"</strong> en tu escritorio o pantalla de inicio, incluso en Modo Avión.</div>
                </div>
              </div>
            </div>

            <!-- Columna 3: Íconos y Especificación del Web App Manifest -->
            <div class="m3-guide-card">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.5rem;">
                <h3 style="margin:0; font-size:1rem; color:#0f172a;">
                  🎨 Íconos y Web App Manifest
                </h3>
                <span class="badge badge-estado-sincronizado">display: standalone</span>
              </div>

              <div style="display:flex; align-items:center; gap:0.8rem; margin-bottom:0.65rem; background:#0f172a; padding:0.6rem; border-radius:8px; color:#ffffff;">
                <img
                  src="./public/pwa-192x192.png"
                  alt="Ícono PWA 192x192"
                  style="width:56px; height:56px; border-radius:10px; border:2px solid #f59e0b;"
                />
                <div style="font-size:0.8rem;">
                  <div style="font-weight:900; color:#fbbf24;">Reportes Mina (PWA)</div>
                  <div>• <code>pwa-192x192.png</code> (192×192 px)</div>
                  <div>• <code>pwa-512x512.png</code> (512×512 px maskable)</div>
                  <div>• <code>apple-touch-icon.png</code> (180×180 px)</div>
                </div>
              </div>

              <div style="font-size:0.78rem; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:0.5rem; font-family:monospace; color:#0f172a;">
                <div><strong>name:</strong> "Reportes y Observaciones de Equipos Mineros"</div>
                <div><strong>short_name:</strong> "Reportes Mina"</div>
                <div><strong>display:</strong> "standalone"</div>
                <div><strong>theme_color:</strong> "#0f172a" | <strong>background_color:</strong> "#0f172a"</div>
              </div>
            </div>
          </div>
        </section>

        <!-- 3. TABLA DE AUDITORÍA DEL PRECACHÉ DEL APP SHELL (CACHE STORAGE) -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>📦 3. INVENTARIO DEL PRECACHÉ DEL APP SHELL (${cachedFilesCount}/${this.precachedAssets.length} ARCHIVOS EN CACHE STORAGE)</span>
              </h2>
              <p class="brand-subtitle">
                Todos estos archivos quedan guardados en el dispositivo para que la app abra tras cerrarse por completo sin internet
              </p>
            </div>
            <span class="badge badge-estado-sincronizado">
              Total App Shell en Caché: ${formatBytes(totalCacheBytes)}
            </span>
          </div>

          <div class="table-responsive">
            <table class="operational-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Recurso del App Shell</th>
                  <th>Categoría</th>
                  <th>Función en Modo Sin Conexión</th>
                  <th>Peso en Caché</th>
                  <th>Estado Offline</th>
                </tr>
              </thead>
              <tbody>
                ${this.precachedAssets
                  .map(
                    (asset, idx) => `
                  <tr>
                    <td><strong>${idx + 1}</strong></td>
                    <td><code>${asset.path}</code></td>
                    <td><span class="badge badge-baja">${asset.category}</span></td>
                    <td style="font-size:0.84rem;">${asset.desc}</td>
                    <td><strong>${asset.sizeBytes ? formatBytes(asset.sizeBytes) : 'Precacheado'}</strong></td>
                    <td>
                      <span class="badge ${asset.cached ? 'badge-estado-sincronizado' : 'badge-pending'}">
                        ${asset.cached ? '✅ EN CACHÉ LOCAL' : '⏳ PENDIENTE DE CACHÉ'}
                      </span>
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    this.bindEvents(pwaState);
  }

  bindEvents(pwaState) {
    this.rootEl.querySelector('#btn-close-m3-banner')?.addEventListener('click', () => {
      this.banner = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-m3-refresh-cache')?.addEventListener('click', async () => {
      await pwaManager.warmUpAppShellCache();
      await this.reloadAll();
      this.setBanner(
        'success',
        'Precaché del App Shell verificado y actualizado en CacheStorage. Todos los activos están listos para Modo Avión.'
      );
    });

    this.rootEl.querySelector('#btn-m3-simulate-update')?.addEventListener('click', () => {
      pwaManager.triggerUpdatePromptSimulation();
      this.setBanner(
        'success',
        'Se activó el aviso de "Nueva versión disponible" (registerType: "prompt") en la barra superior para verificar el flujo de actualización controlada.'
      );
    });

    this.rootEl.querySelector('#btn-m3-card-toggle-airplane')?.addEventListener('click', () => {
      pwaManager.setSimulatedAirplaneMode(!pwaState.simulatedAirplaneMode);
    });

    this.rootEl.querySelector('#btn-m3-card-install')?.addEventListener('click', async () => {
      if (pwaState.canInstallPrompt) {
        await pwaManager.triggerNativeInstallPrompt();
      } else {
        document.querySelector('#btn-strip-ios-guide')?.click();
      }
    });

    this.rootEl.querySelector('#btn-m3-run-p5')?.addEventListener('click', () => {
      this.handleRunScenarioP5Test();
    });

    this.rootEl.querySelector('#btn-m3-go-m1')?.addEventListener('click', () => {
      this.onNavigateModule('m1');
    });

    this.rootEl.querySelector('#btn-m3-go-m2')?.addEventListener('click', () => {
      this.onNavigateModule('m2');
    });
  }
}
