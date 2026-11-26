/**
 * App Principal — Layout Operativo con 2 Modos de Visualización:
 *
 * 1. MODO SUPERVISOR OPERATIVO (Por defecto para operación real en mina):
 *    - Interfaz limpia, directa y ergonómica sin distracciones técnicas.
 *    - Solo 2 pestañas principales:
 *      [ 📝 1. Registrar Reporte y Seguimiento ]   [ 📊 2. Historial de Mina y Exportar Excel ]
 *    - La memoria local (M2), el modo sin conexión (M3), la sesión (M4) y la cola de subida (M5)
 *      trabajan de forma 100 % automática y silenciosa en segundo plano.
 *
 * 2. MODO USUARIO ESPECIAL / ARQUITECTURA COMPLETA (admin.arquitectura@operacion.pe):
 *    - Despliega las 6 pestañas completas (M1, M2, M3, M4, M5 y M6) y todos los laboratorios
 *      interactivos (Escenarios P1 a P10) para auditar y ver paso a paso cómo construimos el proyecto.
 */

import { ensureInitialEquipmentCatalog } from './services/equipmentService.js';
import { ensureDemoReportsIfEmpty } from './components/CapturaReporte/demoSeed.js';
import {
  requestPersistentStorage,
  getStorageUsageEstimate,
  formatBytes,
  calculateAllReportsStorageMetrics
} from './db/storageManager.js';
import { localDb } from './db/localDb.js';
import { supabase } from './config/supabaseClient.js';
import { getFechaHoyPeru, formatFechaDDMMYYYY } from './utils/datePeru.js';
import { pwaManager, APP_SHELL_FILES } from './services/pwaManager.js';
import { authService, DEMO_MINE_ACCOUNTS } from './services/authService.js';
import { syncQueue } from './services/syncQueue.js';
import { CapturaReporteView } from './components/CapturaReporte/CapturaReporte.js';
import { MisReportesView } from './components/MisReportes/MisReportes.js';
import { PwaGlobalBanner, PwaModuleView } from './components/PwaBanner/PwaBanner.js';
import { AuthModuleView } from './components/Auth/Auth.js';
import { SyncModuleView } from './components/SyncStatus/SyncStatus.js';
import { HistorialModuleView } from './components/Historial/Historial.js';

const VIEW_MODE_STORAGE_KEY = 'mineria_pwa_ui_view_mode_v1';
const DESIGN_VERSION_STORAGE_KEY = 'mineria_pwa_ui_design_version_v1';
const SPECIAL_USER_CODES = ['2026', 'STRACON2026', 'Mina2026!Admin'];

export class AppController {
  constructor(mountEl) {
    this.mountEl = mountEl;
    this.isNightTheme = false; // Por defecto inicia en Modo Claridad Industrial
    this.userAdjustedZoom = false;
    this.zoomLevel = this.getRecommendedZoom(); // 62% en celular, 68% tablet, 82% PC
    this.viewMode = 'operativo'; // 'operativo' (pestañas limpias) | 'ingenieria' (módulos M1..M6 + Levantadas)
    this.designVersion = '1.1'; // '1.1' (Diseño STRACON Ejecutivo Limpio) | '1.0' (Diseño Original)
    this.activeModule = 'm1'; // En modo operativo inicia directo en M1 (Registrar Reporte)
    this.m1TableTab = 'activas'; // 'activas' | 'levantadas'
    this.showQuickProfileModal = false;
    this.showSpecialUserCodeModal = false;
    this.specialUserCodeError = '';
    this.pendingSpecialTargetModule = null;
    this.isTopbarCollapsed = typeof window !== 'undefined' ? window.innerWidth <= 980 : false;
    this.userToggledTopbar = false;
    this.isManualSyncing = false;
    this._resizeHandler = null;
    this.pwaBanner = null;
    this.currentView = null;
    this.stats = {
      totalReportes: 0,
      levantadasCount: 0,
      pendientes: 0,
      sincronizados: 0,
      unificadosTotal: 0,
      indexedDbBytes: 0,
      storageEst: { isPersisted: false, usageMB: '0.00', quotaMB: '0' },
      precachedCount: APP_SHELL_FILES.length
    };
  }

  async start() {
    document.documentElement.style.setProperty('--ui-zoom', String(this.zoomLevel));
    await requestPersistentStorage();
    await ensureInitialEquipmentCatalog();
    await ensureDemoReportsIfEmpty();
    supabase.ensureTeamCloudSamplesForM6(getFechaHoyPeru());
    await authService.init();
    await syncQueue.init();
    try {
      await Promise.race([
        pwaManager.init(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    } catch {
      // Continuar incluso si el navegador restringe Service Workers o CacheStorage
    }

    const authState = authService.getState();
    const savedMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (authState.isArchitectureAdmin || savedMode === 'ingenieria') {
      this.viewMode = 'ingenieria';
    } else {
      this.viewMode = 'operativo';
    }
    const savedDesign = localStorage.getItem(DESIGN_VERSION_STORAGE_KEY);
    this.designVersion = savedDesign === '1.0' ? '1.0' : '1.1';
    this.applyBodyViewModeClass();
    this.applyBodyDesignVersionClass();

    await this.refreshGlobalStats();
    this.renderShell();

    const bannerMount = this.mountEl.querySelector('#pwa-global-banner-mount');
    this.pwaBanner = new PwaGlobalBanner(bannerMount, {
      onOpenPwaModule: () => {
        this.requestSpecialUserAccess({ targetModule: 'm3' });
      }
    });
    this.pwaBanner.init();

    this.bindGlobalEvents();
    await this.switchModule(this.activeModule);
  }

  applyBodyViewModeClass() {
    document.body.classList.toggle('view-mode-operativo', this.viewMode === 'operativo');
    document.body.classList.toggle('view-mode-ingenieria', this.viewMode === 'ingenieria');
  }

  applyBodyDesignVersionClass() {
    document.body.classList.toggle('design-v1-1', this.designVersion === '1.1');
  }

  setDesignVersion(version) {
    this.designVersion = version === '1.0' ? '1.0' : '1.1';
    try {
      localStorage.setItem(DESIGN_VERSION_STORAGE_KEY, this.designVersion);
    } catch {
      // Ignorar si almacenamiento restringido
    }
    this.applyBodyDesignVersionClass();
    const btn10 = this.mountEl?.querySelector('#btn-design-v1-0');
    const btn11 = this.mountEl?.querySelector('#btn-design-v1-1');
    if (btn10) {
      const is10 = this.designVersion === '1.0';
      btn10.classList.toggle('active', is10);
      btn10.setAttribute('aria-pressed', String(is10));
    }
    if (btn11) {
      const is11 = this.designVersion === '1.1';
      btn11.classList.toggle('active', is11);
      btn11.setAttribute('aria-pressed', String(is11));
    }
  }

  async setViewMode(mode, { switchUserEmail = null, switchUserPass = null, targetModule = null } = {}) {
    this.viewMode = mode === 'ingenieria' ? 'ingenieria' : 'operativo';
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, this.viewMode);
    this.applyBodyViewModeClass();

    if (switchUserEmail && switchUserPass) {
      await authService.signIn(switchUserEmail, switchUserPass);
    }

    // Si pasa a modo operativo y estaba en una pestaña técnica (M2, M3, M4, M5), llevarlo a M1
    if (this.viewMode === 'operativo' && !['m1', 'm6'].includes(targetModule || this.activeModule)) {
      this.activeModule = 'm1';
    } else if (targetModule) {
      this.activeModule = targetModule;
    }

    this.updateViewModeUI();
    await this.switchModule(this.activeModule);
  }

  getTopbarSyncButtonState() {
    const pwaState = pwaManager.getState();
    const authState = authService.getState();
    const syncState = syncQueue.getState();
    const pendientes = Number(this.stats?.pendientes || 0);

    if (this.isManualSyncing || syncState.isSyncing) {
      return {
        stateClass: 'is-syncing',
        label: '🔄 Sincronizando...',
        title: 'Sincronizando con Supabase Cloud...',
        disabled: true
      };
    }

    if (!pwaState.isOnline) {
      if (pendientes > 0) {
        return {
          stateClass: 'is-pending',
          label: `⏳ Faltan subir (${pendientes})`,
          title: `Sin conexión: faltan subir ${pendientes} cambio(s) cuando regrese la señal`,
          disabled: false
        };
      }
      return {
        stateClass: 'is-offline',
        label: '🔴 Sin red (al día)',
        title: 'Sin conexión a internet. No hay cambios pendientes por subir.',
        disabled: false
      };
    }

    if (!authState.isRealCloudSession) {
      return {
        stateClass: 'is-pending',
        label: pendientes > 0 ? `⚠️ Conectar (${pendientes})` : '⚠️ Conectar nube',
        title: 'Toca para conectar con Supabase Cloud y sincronizar',
        disabled: false
      };
    }

    if (pendientes > 0) {
      return {
        stateClass: 'is-pending',
        label: `⬆️ Subir (${pendientes})`,
        title: `Faltan subir ${pendientes} cambio(s) a la nube — toca para sincronizar ahora`,
        disabled: false
      };
    }

    return {
      stateClass: 'is-synced',
      label: '🔄 Actualizar • Al día',
      title: 'Todo sincronizado en la nube — toca para actualizar y comprobar novedades',
      disabled: false
    };
  }

  async handleManualSyncAndRefresh() {
    if (this.isManualSyncing || syncQueue.getState().isSyncing) return;

    if (!authService.getState().isRealCloudSession) {
      this.showQuickProfileModal = true;
      this.renderQuickProfileModal();
      return;
    }

    const pendientesAntes = Number(this.stats?.pendientes || 0);
    if (!pwaManager.getState().isOnline) {
      if (this.currentView && typeof this.currentView.setBanner === 'function') {
        this.currentView.setBanner(
          pendientesAntes > 0 ? 'error' : 'success',
          pendientesAntes > 0
            ? `Sin conexión a internet: aún faltan subir ${pendientesAntes} registro(s) cuando regrese la señal.`
            : 'Sin conexión a internet. Todo lo anterior ya estaba subido en la nube.'
        );
      }
      return;
    }

    this.isManualSyncing = true;
    this.updateTopbarStats();

    try {
      await syncQueue.processQueue({
        triggerSource: 'Botón Actualizar / Sincronizar',
        forceManual: true
      });
      if (this.currentView && typeof this.currentView.reloadData === 'function') {
        await this.currentView.reloadData();
        this.currentView.render();
      }
      await this.refreshGlobalStats();
      if (this.currentView && typeof this.currentView.setBanner === 'function') {
        if (Number(this.stats?.pendientes || 0) === 0) {
          this.currentView.setBanner(
            'success',
            'Sincronización completada: todo está actualizado y al día en la nube.'
          );
        } else {
          this.currentView.setBanner(
            'error',
            `Actualización realizada, pero aún faltan subir ${this.stats.pendientes} registro(s) a la nube.`
          );
        }
      }
    } catch (err) {
      if (this.currentView && typeof this.currentView.setBanner === 'function') {
        this.currentView.setBanner(
          'error',
          err?.message || 'No se pudo completar la sincronización con la nube.'
        );
      }
    } finally {
      this.isManualSyncing = false;
      this.updateTopbarStats();
    }
  }

  renderShell() {
    const pwaState = pwaManager.getState();
    const authState = authService.getState();
    const syncState = syncQueue.getState();
    const isOperativo = this.viewMode === 'operativo';
    const fechaHoyFormatted = formatFechaDDMMYYYY(getFechaHoyPeru());
    const syncBtnState = this.getTopbarSyncButtonState();

    this.mountEl.innerHTML = `
      <header class="topbar ${this.isTopbarCollapsed ? 'is-collapsed' : ''}" id="main-topbar">
        <div class="topbar-main-row">
          <div class="brand-block">
            <div class="brand-icon">⛏️</div>
            <div>
              <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                <h1 class="brand-title">REPORTES Y OBSERVACIONES DE EQUIPOS MINEROS</h1>
                <span
                  id="badge-active-view-mode"
                  style="font-size:0.73rem; font-weight:800; padding:0.18rem 0.55rem; border-radius:999px; ${
                    isOperativo
                      ? 'background:#22c55e; color:#052e16;'
                      : 'background:#f59e0b; color:#0f172a;'
                  }"
                >
                  ${
                    isOperativo
                      ? '👷 VISTA SUPERVISOR OPERATIVO'
                      : '🛠️ USUARIO ESPECIAL: ARQUITECTURA M1–M6'
                  }
                </span>
              </div>
            </div>
          </div>

          <div class="topbar-main-actions">
            <div
              class="design-version-switcher"
              role="group"
              aria-label="Versión de diseño visual"
              title="Cambiar entre Diseño 1.0 (Original) y Diseño 1.1 (STRACON Ejecutivo Limpio)"
            >
              <button
                type="button"
                class="design-ver-btn ${this.designVersion === '1.0' ? 'active' : ''}"
                id="btn-design-v1-0"
                aria-pressed="${this.designVersion === '1.0'}"
              >
                Diseño 1.0
              </button>
              <button
                type="button"
                class="design-ver-btn ${this.designVersion === '1.1' ? 'active' : ''}"
                id="btn-design-v1-1"
                aria-pressed="${this.designVersion === '1.1'}"
              >
                Diseño 1.1
              </button>
            </div>
            <button
              type="button"
              class="btn-mine btn-sm-mine btn-topbar-sync ${syncBtnState.stateClass}"
              id="btn-topbar-sync"
              title="${syncBtnState.title}"
              ${syncBtnState.disabled ? 'disabled' : ''}
            >
              ${syncBtnState.label}
            </button>
            <div class="topbar-quick-status" title="Resumen rápido de fecha y red">
              <span>📅 ${fechaHoyFormatted}</span>
              <span id="topbar-quick-net-dot">${pwaState.isOnline ? '🟢' : '🔴'}</span>
            </div>
            <button
              type="button"
              class="btn-mine btn-sm-mine btn-topbar-toggle"
              id="btn-toggle-topbar"
              aria-expanded="${!this.isTopbarCollapsed}"
              title="Desplegar o replegar barra superior"
            >
              ${this.isTopbarCollapsed ? '⚙️ Opciones ▾' : '🔼 Replegar'}
            </button>
          </div>
        </div>

        <div class="topbar-collapsible-area">
          <p class="brand-subtitle" id="topbar-module-subtitle">
            Operación en Campo: Captura rápida con guantes, funcionamiento sin señal y sincronización automática
          </p>

          <div class="topbar-controls">
            <!-- Botón directo para alternar entre Vista Limpia Supervisor y Usuario Especial (solicita código) -->
            <button
              type="button"
              class="btn-mine btn-sm-mine ${isOperativo ? 'btn-secondary' : 'btn-amber'}"
              id="btn-toggle-view-mode"
              title="Alternar entre Vista Supervisor y Usuario Especial (requiere código)"
              style="min-height:36px; font-weight:800;"
            >
              ${
                isOperativo
                  ? '🛠️ Usuario Especial: Ver M1–M6'
                  : '👷 Volver a Vista Supervisor'
              }
            </button>

            <!-- Control de Zoom rápido en barra superior -->
            <div class="status-pill" title="Ajustar zoom de la pantalla para ver más contenido">
              <span>🔍 Zoom:</span>
              <button type="button" class="btn-mine btn-sm-mine" id="btn-zoom-out" style="min-height:28px; padding:0.15rem 0.5rem;">−</button>
              <strong id="label-zoom" style="color:#fbbf24;">${Math.round(this.zoomLevel * 100)}%</strong>
              <button type="button" class="btn-mine btn-sm-mine" id="btn-zoom-in" style="min-height:28px; padding:0.15rem 0.5rem;">+</button>
            </div>

            <div class="status-pill" id="pill-peru-date" title="Fecha operativa actual">
              📅 <strong style="color:#fbbf24;">${fechaHoyFormatted}</strong>
            </div>

            <div
              class="status-pill ${pwaState.isOnline ? 'online' : 'offline'}"
              id="pill-network"
              style="cursor:pointer;"
              title="Estado de red en tiempo real"
            >
              <span>${
                pwaState.simulatedAirplaneMode
                  ? '✈️ Modo Avión (P5)'
                  : pwaState.isOnline
                    ? '🟢 En línea'
                    : '🔴 Sin conexión'
              }</span>
            </div>

            <div
              class="status-pill ${authState.isRealCloudSession && this.stats.pendientes === 0 ? 'online' : ''}"
              id="pill-pending"
              style="cursor:pointer;"
              title="${
                !authState.isRealCloudSession
                  ? 'Modo Local: Toca para iniciar sesión en Supabase Cloud y sincronizar entre dispositivos'
                  : isOperativo
                    ? 'Toca para sincronizar ahora con Supabase Cloud'
                    : 'Abrir Cola de Sincronización (Módulo 5)'
              }"
            >
              <span id="stat-sync-icon">${
                syncState.isSyncing
                  ? '🔄'
                  : !authState.isRealCloudSession
                    ? '⚠️'
                    : this.stats.pendientes === 0
                      ? '☁️'
                      : '⏳'
              }</span>
              <span id="stat-pending-label">${
                syncState.isSyncing
                  ? 'Subiendo...'
                  : !authState.isRealCloudSession
                    ? 'Solo Local (Conectar)'
                    : this.stats.pendientes === 0
                      ? 'Al día en nube'
                      : 'Por subir:'
              }</span>
              <strong id="stat-pendientes" style="color:#fbbf24; ${
                !authState.isRealCloudSession || (this.stats.pendientes === 0 && !syncState.isSyncing)
                  ? 'display:none;'
                  : ''
              }">${this.stats.pendientes}</strong>
            </div>

            <div
              class="status-pill ${authState.isRealCloudSession ? 'online' : 'offline'}"
              id="pill-auth"
              style="cursor:pointer;"
              title="Iniciar sesión real en Supabase Cloud o cambiar de perfil"
            >
              <span id="stat-auth-pill">${authState.badgeText}</span>
            </div>

            <div
              class="status-pill tech-only-inline"
              id="pill-storage"
              style="cursor:pointer;"
              title="Almacenamiento local IndexedDB y cuota del dispositivo (M2)"
            >
              💾 Local: <strong id="stat-storage" style="color:#38bdf8;">${formatBytes(this.stats.indexedDbBytes)}</strong>
            </div>

            <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-toggle-theme">
              ${this.isNightTheme ? '☀️ Modo Día' : '🌙 Modo Noche'}
            </button>
          </div>
        </div>
      </header>

      <!-- Barra Global M3: Visible en Modo Ingeniería o cuando hay actualización de versión -->
      <div id="pwa-global-banner-mount" class="tech-only-block"></div>

      <!-- Barra de Navegación Adaptable:
           - En Modo Supervisor Operativo: Muestra SOLO 2 pestañas grandes y claras (M1 y M6)
           - En Modo Usuario Especial (Ingeniería): Muestra los 6 módulos completos (M1 a M6) -->
      <nav class="module-navbar" aria-label="Navegación de Módulos">
        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm1' && this.m1TableTab !== 'levantadas' ? 'active' : ''}"
          id="tab-btn-m1"
        >
          <span id="tab-title-m1">${
            isOperativo
              ? '📝 1. Registrar Reporte y Seguimiento'
              : '📝 M1 — Nuevo Reporte y Tabla'
          }</span>
          <span class="module-tab-badge" id="tab-badge-m1">${
            isOperativo
              ? 'Equipos • Tabla (↳)'
              : 'Captura + Seguimientos (↳)'
          }</span>
        </button>

        <button
          type="button"
          class="module-tab-btn module-tab-levantadas ${this.activeModule === 'm1' && this.m1TableTab === 'levantadas' ? 'active' : ''}"
          id="tab-btn-levantadas"
        >
          <span id="tab-title-levantadas">${
            isOperativo
              ? '✅ Observaciones Levantadas'
              : '✅ M1-B — Observaciones Levantadas'
          }</span>
          <span class="module-tab-badge" id="tab-badge-levantadas">${
            this.stats.levantadasCount || 0
          } cerradas</span>
        </button>

        <button
          type="button"
          class="module-tab-btn tech-only-tab ${this.activeModule === 'm2' ? 'active' : ''}"
          id="tab-btn-m2"
        >
          <span>💾 M2 — "Mis reportes" Local</span>
          <span class="module-tab-badge" id="tab-badge-m2">${this.stats.totalReportes} guardados (${formatBytes(this.stats.indexedDbBytes)})</span>
        </button>

        <button
          type="button"
          class="module-tab-btn tech-only-tab ${this.activeModule === 'm3' ? 'active' : ''}"
          id="tab-btn-m3"
        >
          <span>📲 M3 — PWA y Modo Avión</span>
          <span class="module-tab-badge" id="tab-badge-m3">${
            pwaState.isOnline ? 'App Shell Offline Ready' : '✈️ Modo Avión Activo'
          }</span>
        </button>

        <button
          type="button"
          class="module-tab-btn tech-only-tab ${this.activeModule === 'm4' ? 'active' : ''}"
          id="tab-btn-m4"
        >
          <span>🔐 M4 — Supabase Auth</span>
          <span class="module-tab-badge" id="tab-badge-m4">${authState.badgeText}</span>
        </button>

        <button
          type="button"
          class="module-tab-btn tech-only-tab ${this.activeModule === 'm5' ? 'active' : ''}"
          id="tab-btn-m5"
        >
          <span>🔄 M5 — Motor y Cola Sync</span>
          <span class="module-tab-badge" id="tab-badge-m5">${
            syncState.isSyncing
              ? '🔒 Sincronizando...'
              : `${this.stats.pendientes} pendientes • ${this.stats.sincronizados} en nube`
          }</span>
        </button>

        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm6' ? 'active' : ''}"
          id="tab-btn-m6"
        >
          <span id="tab-title-m6">${
            isOperativo
              ? '📊 2. Historial de Mina y Exportar Excel'
              : '📊 M6 — Historial Unificado y Excel'
          }</span>
          <span class="module-tab-badge" id="tab-badge-m6">${
            isOperativo
              ? `${this.stats.unificadosTotal} reportes • .xlsx`
              : `${this.stats.unificadosTotal} unificados • Exportar .xlsx`
          }</span>
        </button>
      </nav>

      <main id="module-view-container"></main>
      <div id="quick-profile-modal-mount"></div>
      <div id="special-user-code-mount"></div>
    `;
  }

  updateViewModeUI() {
    const isOperativo = this.viewMode === 'operativo';
    const badgeMode = this.mountEl.querySelector('#badge-active-view-mode');
    const btnToggleMode = this.mountEl.querySelector('#btn-toggle-view-mode');
    const tabTitleM1 = this.mountEl.querySelector('#tab-title-m1');
    const tabBadgeM1 = this.mountEl.querySelector('#tab-badge-m1');
    const tabTitleM6 = this.mountEl.querySelector('#tab-title-m6');
    const tabTitleLevantadas = this.mountEl.querySelector('#tab-title-levantadas');

    if (tabTitleLevantadas) {
      tabTitleLevantadas.textContent = isOperativo
        ? '✅ Observaciones Levantadas'
        : '✅ M1-B — Observaciones Levantadas';
    }

    if (badgeMode) {
      badgeMode.style.background = isOperativo ? '#22c55e' : '#f59e0b';
      badgeMode.style.color = isOperativo ? '#052e16' : '#0f172a';
      badgeMode.textContent = isOperativo
        ? '👷 VISTA SUPERVISOR OPERATIVO'
        : '🛠️ USUARIO ESPECIAL: ARQUITECTURA M1–M6';
    }

    if (btnToggleMode) {
      btnToggleMode.className = `btn-mine btn-sm-mine ${isOperativo ? 'btn-secondary' : 'btn-amber'}`;
      btnToggleMode.textContent = isOperativo
        ? '🛠️ Usuario Especial: Ver M1–M6'
        : '👷 Volver a Vista Supervisor';
    }

    if (tabTitleM1) {
      tabTitleM1.textContent = isOperativo
        ? '📝 1. Registrar Reporte y Seguimiento'
        : '📝 M1 — Nuevo Reporte y Tabla';
    }
    if (tabBadgeM1) {
      tabBadgeM1.textContent = isOperativo
        ? 'Equipos • Tabla (↳)'
        : 'Captura + Seguimientos (↳)';
    }
    if (tabTitleM6) {
      tabTitleM6.textContent = isOperativo
        ? '📊 2. Historial de Mina y Exportar Excel'
        : '📊 M6 — Historial Unificado y Excel';
    }
    const tabBadgeLevantadas = this.mountEl.querySelector('#tab-badge-levantadas');
    if (tabBadgeLevantadas) {
      tabBadgeLevantadas.textContent = `${this.stats.levantadasCount || 0} cerradas`;
    }
    const tabBadgeM6 = this.mountEl.querySelector('#tab-badge-m6');
    if (tabBadgeM6) {
      tabBadgeM6.textContent = isOperativo
        ? `${this.stats.unificadosTotal} reportes • .xlsx`
        : `${this.stats.unificadosTotal} unificados • Exportar .xlsx`;
    }
  }

  requestSpecialUserAccess({ targetModule = null } = {}) {
    if (this.viewMode === 'ingenieria') {
      if (targetModule) this.switchModule(targetModule);
      return;
    }
    this.pendingSpecialTargetModule = targetModule;
    this.specialUserCodeError = '';
    this.showSpecialUserCodeModal = true;
    this.renderSpecialUserCodeModal();
  }

  renderSpecialUserCodeModal() {
    const mount = this.mountEl.querySelector('#special-user-code-mount');
    if (!mount) return;
    if (!this.showSpecialUserCodeModal) {
      mount.innerHTML = '';
      return;
    }

    mount.innerHTML = `
      <div class="modal-backdrop" id="special-user-code-backdrop" role="dialog" aria-modal="true" aria-labelledby="special-code-title">
        <div class="modal-card" style="max-width: 480px;">
          <div class="section-header">
            <h3 class="section-title" id="special-code-title">🔐 Acceso a Usuario Especial (M1–M6)</h3>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-special-code">
              ✕ Cancelar
            </button>
          </div>

          <form id="special-user-code-form" style="display:flex; flex-direction:column; gap:0.85rem;">
            <div class="field-group">
              <label class="field-label" for="input-special-user-code">
                Ingresa el código de autorización para habilitar los módulos avanzados:
              </label>
              <input
                type="password"
                id="input-special-user-code"
                class="input-mine ${this.specialUserCodeError ? 'field-error-input' : ''}"
                placeholder="Código de autorización..."
                autocomplete="off"
                required
              />
              ${
                this.specialUserCodeError
                  ? `<div id="special-user-code-error" class="inline-field-error" role="alert">⚠️ ${this.specialUserCodeError}</div>`
                  : ''
              }
            </div>

            <div style="display:flex; justify-content:flex-end; gap:0.65rem;">
              <button type="button" class="btn-mine btn-secondary" id="btn-cancel-special-code">
                Cancelar
              </button>
              <button type="submit" class="btn-mine btn-primary" id="btn-submit-special-code">
                🔓 Validar Código e Ingresar
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    const inputEl = mount.querySelector('#input-special-user-code');
    inputEl?.focus();

    const closeModal = () => {
      this.showSpecialUserCodeModal = false;
      this.specialUserCodeError = '';
      this.pendingSpecialTargetModule = null;
      this.renderSpecialUserCodeModal();
    };

    mount.querySelector('#btn-close-special-code')?.addEventListener('click', closeModal);
    mount.querySelector('#btn-cancel-special-code')?.addEventListener('click', closeModal);
    mount.querySelector('#special-user-code-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'special-user-code-backdrop') closeModal();
    });

    inputEl?.addEventListener('input', () => {
      if (this.specialUserCodeError) {
        this.specialUserCodeError = '';
        inputEl.classList.remove('field-error-input');
        mount.querySelector('#special-user-code-error')?.remove();
      }
    });

    mount.querySelector('#special-user-code-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const entered = (inputEl?.value || '').trim();
      const isValid = SPECIAL_USER_CODES.some((c) => c === entered);
      if (!isValid) {
        this.specialUserCodeError = 'Código incorrecto. No se otorgó acceso a Usuario Especial.';
        this.renderSpecialUserCodeModal();
        return;
      }

      const targetMod = this.pendingSpecialTargetModule;
      this.showSpecialUserCodeModal = false;
      this.specialUserCodeError = '';
      this.pendingSpecialTargetModule = null;
      this.renderSpecialUserCodeModal();

      await this.setViewMode('ingenieria', {
        switchUserEmail: 'admin.arquitectura@operacion.pe',
        switchUserPass: 'Mina2026!Admin',
        targetModule: targetMod
      });
    });
  }

  toggleTopbarCollapsed(forceValue = null, { isManual = true } = {}) {
    if (isManual) {
      this.userToggledTopbar = true;
    }
    this.isTopbarCollapsed =
      typeof forceValue === 'boolean' ? forceValue : !this.isTopbarCollapsed;
    this.updateTopbarCollapsedUI();
  }

  updateTopbarCollapsedUI() {
    const header = this.mountEl.querySelector('#main-topbar');
    const toggleBtn = this.mountEl.querySelector('#btn-toggle-topbar');
    if (header) {
      header.classList.toggle('is-collapsed', this.isTopbarCollapsed);
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(!this.isTopbarCollapsed));
      toggleBtn.textContent = this.isTopbarCollapsed ? '⚙️ Opciones ▾' : '🔼 Replegar';
    }
  }

  renderQuickProfileModal() {
    const mount = this.mountEl.querySelector('#quick-profile-modal-mount');
    if (!mount) return;
    if (!this.showQuickProfileModal) {
      mount.innerHTML = '';
      return;
    }

    const authState = authService.getState();
    const isOperativo = this.viewMode === 'operativo';
    const currentEmail = authState.user?.email || 'Sin sesión activa';

    mount.innerHTML = `
      <div class="modal-backdrop" id="quick-profile-backdrop">
        <div class="modal-card" style="max-width: 680px;">
          <div class="section-header">
            <div>
              <h3 class="section-title">👷 Selector de Perfil: Supervisor Operativo vs. Usuario Especial (M1–M6)</h3>
              <p class="brand-subtitle">
                Sesión actual: <strong>${currentEmail}</strong> • Vista activa: <strong>${
                  isOperativo ? 'Supervisor Operativo (2 Pestañas Limpias)' : 'Arquitectura Completa (6 Módulos M1 a M6)'
                }</strong>
              </p>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-danger" id="btn-close-profile-modal">
              ✕ Cerrar
            </button>
          </div>

          <div style="display:flex; flex-direction:column; gap:0.85rem; margin-top:0.5rem;">
            <!-- Estado real de conexión a Supabase Cloud (Multi-dispositivo) -->
            <div style="padding:0.9rem 1rem; border-radius:10px; border:2px solid ${
              authState.isRealCloudSession ? '#22c55e' : '#f59e0b'
            }; background:${
              authState.isRealCloudSession ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.14)'
            };">
              <strong style="font-size:0.98rem;">
                ${
                  authState.isRealCloudSession
                    ? '☁️ Conectado a Supabase Cloud Real (Sincronización Multi-Dispositivo Activa)'
                    : '⚠️ Estás en Modo Local — Inicia sesión con tu usuario real de Supabase para ver y subir reportes entre celulares y PC'
                }
              </strong>
              <form id="quick-supabase-login-form" style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.65rem; align-items:flex-end;">
                <div style="flex:1; min-width:190px;">
                  <label style="display:block; font-size:0.78rem; font-weight:700; margin-bottom:0.2rem;">Correo en Supabase Auth:</label>
                  <input type="email" id="quick-supa-email" class="form-control" placeholder="tu.correo@empresa.pe" value="${currentEmail.includes('@') ? currentEmail : ''}" required />
                </div>
                <div style="flex:1; min-width:160px;">
                  <label style="display:block; font-size:0.78rem; font-weight:700; margin-bottom:0.2rem;">Contraseña:</label>
                  <input type="password" id="quick-supa-pass" class="form-control" placeholder="••••••••" required />
                </div>
                <button type="submit" class="btn-mine btn-success" id="btn-quick-supa-submit" style="min-height:44px;">
                  ☁️ Conectar a Nube
                </button>
              </form>
              <div id="quick-supa-feedback" style="font-size:0.82rem; font-weight:700; margin-top:0.45rem;"></div>
              ${
                authState.isRealCloudSession
                  ? `
                <div style="margin-top:0.65rem; display:flex; flex-wrap:wrap; gap:0.5rem;">
                  <button type="button" class="btn-mine btn-amber" id="btn-quick-reupload-all" style="min-height:42px;">
                    ⬆️ Subir todos mis reportes locales guardados (${this.stats.totalReportes}) a Supabase Cloud
                  </button>
                </div>
              `
                  : ''
              }
            </div>

            <!-- Opción 1: Vista Limpia Supervisor Operativo -->
            <div style="padding:1rem; border-radius:10px; border:2px solid ${
              isOperativo ? '#22c55e' : '#334155'
            }; background:${isOperativo ? 'rgba(34, 197, 94, 0.1)' : 'rgba(15, 23, 42, 0.5)'};">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                <div>
                  <strong style="font-size:1.05rem;">👷 1. Perfil Supervisor Operativo en Campo (Vista Simplificada)</strong>
                  <div style="font-size:0.84rem; opacity:0.88; margin-top:0.2rem;">
                    Usuario: <code>supervisor.mina@operacion.pe</code> (Clave: <code>Mina2026!Sup</code>)<br/>
                    Muestra <strong>solo 2 pestañas grandes</strong> (<em>1. Registrar Reporte</em> y <em>2. Historial y Excel</em>). La memoria IndexedDB, el modo sin conexión y la sincronización a Supabase trabajan solos en segundo plano.
                  </div>
                </div>
                <button
                  type="button"
                  class="btn-mine btn-success"
                  id="btn-activate-supervisor-mode"
                >
                  ${isOperativo ? '✅ Vista Supervisor Activa' : '👷 Activar Vista Supervisor (2 Pestañas)'}
                </button>
              </div>
            </div>

            <!-- Opción 2: Usuario Especial Admin Arquitectura (6 Módulos M1..M6) -->
            <div style="padding:1rem; border-radius:10px; border:2px solid ${
              !isOperativo ? '#f59e0b' : '#334155'
            }; background:${!isOperativo ? 'rgba(245, 158, 11, 0.12)' : 'rgba(15, 23, 42, 0.5)'};">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                <div>
                  <strong style="font-size:1.05rem;">🛠️ 2. Usuario Especial: Administrador de Arquitectura (M1 a M6)</strong>
                  <div style="font-size:0.84rem; opacity:0.88; margin-top:0.2rem;">
                    Usuario restringido (Requiere código de autorización).<br/>
                    Desbloquea las <strong>6 pestañas completas (M1, M2, M3, M4, M5 y M6)</strong> y todos los laboratorios de validación (Escenarios P1 a P10) para revisar cómo construimos cada módulo.
                  </div>
                </div>
                <button
                  type="button"
                  class="btn-mine btn-amber"
                  id="btn-activate-admin-mode"
                >
                  ${!isOperativo ? '✅ Vista M1–M6 Activa' : '🛠️ Entrar con Usuario Especial (Ver M1–M6)'}
                </button>
              </div>
            </div>

            <!-- Cuentas adicionales de guardia -->
            <div style="padding:0.75rem 1rem; border-radius:8px; background:rgba(15,23,42,0.35); border:1px solid #334155;">
              <div style="font-size:0.82rem; font-weight:700; margin-bottom:0.45rem;">
                👥 Cambiar a otro operador de guardia (Vista Supervisor):
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                ${DEMO_MINE_ACCOUNTS.filter((a) => !a.isArchitectureAdmin)
                  .map(
                    (acc) => `
                  <button
                    type="button"
                    class="btn-mine btn-sm-mine btn-secondary"
                    data-quick-login-email="${acc.email}"
                    data-quick-login-pass="${acc.password}"
                  >
                    👤 ${acc.nombre} (${acc.email})
                  </button>
                `
                  )
                  .join('')}
                <button
                  type="button"
                  class="btn-mine btn-sm-mine"
                  id="btn-open-full-m4-auth"
                >
                  🔐 Abrir Configuración Supabase Auth (M4)
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    mount.querySelector('#btn-close-profile-modal')?.addEventListener('click', () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
    });

    mount.querySelector('#quick-supabase-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = mount.querySelector('#quick-supa-email')?.value?.trim() || '';
      const pass = mount.querySelector('#quick-supa-pass')?.value || '';
      const fb = mount.querySelector('#quick-supa-feedback');
      const btn = mount.querySelector('#btn-quick-supa-submit');
      if (btn) btn.disabled = true;
      if (fb) fb.textContent = '⏳ Autenticando contra Supabase Cloud...';

      const res = await authService.signIn(email, pass);
      const newState = authService.getState();

      if (btn) btn.disabled = false;
      if (!res.ok) {
        if (fb) fb.innerHTML = `<span style="color:#ef4444;">❌ ${res.error}</span>`;
        return;
      }

      if (!newState.isRealCloudSession) {
        if (fb) {
          fb.innerHTML = `<span style="color:#f59e0b;">⚠️ Este correo aún no existe en Supabase (Authentication ➔ Users) o la contraseña no coincide. Créalo en Supabase o ingresa el correo real que registraste allí.</span>`;
        }
        return;
      }

      if (fb) fb.innerHTML = `<span style="color:#22c55e;">✅ ¡Conectado a Supabase Cloud Real! Sincronizando reportes...</span>`;
      await syncQueue.requeueLocalOnlyReportsForRealCloud();
      await this.refreshGlobalStats();
      this.updateTopbarStats();
      await this.switchModule(this.activeModule);
      this.renderQuickProfileModal();
    });

    mount.querySelector('#btn-quick-reupload-all')?.addEventListener('click', async () => {
      const fb = mount.querySelector('#quick-supa-feedback');
      if (fb) fb.textContent = '⏳ Subiendo reportes locales a Supabase Storage y Postgres...';
      const res = await syncQueue.requeueLocalOnlyReportsForRealCloud();
      if (fb) {
        fb.innerHTML = res.ok
          ? `<span style="color:#22c55e;">✅ ${res.reason}</span>`
          : `<span style="color:#ef4444;">❌ ${res.reason}</span>`;
      }
      await this.refreshGlobalStats();
      this.updateTopbarStats();
      await this.switchModule(this.activeModule);
    });

    mount.querySelector('#quick-profile-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'quick-profile-backdrop') {
        this.showQuickProfileModal = false;
        this.renderQuickProfileModal();
      }
    });

    mount.querySelector('#btn-activate-supervisor-mode')?.addEventListener('click', async () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
      await this.setViewMode('operativo', {
        switchUserEmail: 'supervisor.mina@operacion.pe',
        switchUserPass: 'Mina2026!Sup',
        targetModule: 'm1'
      });
    });

    mount.querySelector('#btn-activate-admin-mode')?.addEventListener('click', () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
      this.requestSpecialUserAccess();
    });

    mount.querySelectorAll('[data-quick-login-email]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const email = btn.getAttribute('data-quick-login-email');
        const pass = btn.getAttribute('data-quick-login-pass');
        this.showQuickProfileModal = false;
        this.renderQuickProfileModal();
        await this.setViewMode('operativo', {
          switchUserEmail: email,
          switchUserPass: pass,
          targetModule: 'm1'
        });
      });
    });

    mount.querySelector('#btn-open-full-m4-auth')?.addEventListener('click', () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
      this.requestSpecialUserAccess({ targetModule: 'm4' });
    });
  }

  async refreshGlobalStats(overrideStats = null) {
    const reportes = await localDb.reportes.toArray();
    const storageEst = await getStorageUsageEstimate();
    const metrics = calculateAllReportsStorageMetrics(reportes);
    const pendientes = reportes.filter((r) => r.estado === 'pendiente' || r.estado === 'error').length;
    const sincronizados = reportes.filter((r) => r.estado === 'sincronizado').length;

    const cloudSnap = supabase.getCloudSnapshot();
    const byId = new Map();
    for (const cr of cloudSnap.reportesCloud || []) {
      if (cr?.id) byId.set(cr.id, cr);
    }
    for (const lr of reportes) {
      if (lr?.id) byId.set(lr.id, lr);
    }

    const isLev = (rep) =>
      Array.isArray(rep?.seguimientos) &&
      rep.seguimientos.some((s) =>
        String(s?.estado_seguimiento || '')
          .toLowerCase()
          .includes('levantada')
      );
    const computedLevantadas = Array.from(byId.values()).filter(isLev).length;

    const resolvedLevantadas =
      overrideStats && typeof overrideStats.levantadasCount === 'number'
        ? overrideStats.levantadasCount
        : Math.max(computedLevantadas, this.stats?.levantadasCount || 0);

    this.stats = {
      totalReportes: reportes.length,
      levantadasCount: resolvedLevantadas,
      pendientes,
      sincronizados,
      unificadosTotal: byId.size,
      indexedDbBytes: metrics.totalIndexedDbMediaBytes,
      storageEst
    };
  }

  updateActiveModuleTabClasses() {
    const tabM1 = this.mountEl.querySelector('#tab-btn-m1');
    const tabLevantadas = this.mountEl.querySelector('#tab-btn-levantadas');
    const tabM2 = this.mountEl.querySelector('#tab-btn-m2');
    const tabM3 = this.mountEl.querySelector('#tab-btn-m3');
    const tabM4 = this.mountEl.querySelector('#tab-btn-m4');
    const tabM5 = this.mountEl.querySelector('#tab-btn-m5');
    const tabM6 = this.mountEl.querySelector('#tab-btn-m6');

    tabM1?.classList.toggle('active', this.activeModule === 'm1' && this.m1TableTab !== 'levantadas');
    tabLevantadas?.classList.toggle('active', this.activeModule === 'm1' && this.m1TableTab === 'levantadas');
    tabM2?.classList.toggle('active', this.activeModule === 'm2');
    tabM3?.classList.toggle('active', this.activeModule === 'm3');
    tabM4?.classList.toggle('active', this.activeModule === 'm4');
    tabM5?.classList.toggle('active', this.activeModule === 'm5');
    tabM6?.classList.toggle('active', this.activeModule === 'm6');
  }

  async switchModule(moduleId, { tableTab = null, scrollToTable = false } = {}) {
    if (moduleId === 'm1' && tableTab) {
      this.m1TableTab = tableTab === 'levantadas' ? 'levantadas' : 'activas';
    }

    // Cambio rápido entre Panel Principal Activo y Observaciones Levantadas dentro de M1 sin perder datos escritos
    if (
      moduleId === 'm1' &&
      this.activeModule === 'm1' &&
      this.currentView &&
      typeof this.currentView.setVistaTabla === 'function'
    ) {
      this.currentView.setVistaTabla(this.m1TableTab, { scrollToTable });
      this.updateActiveModuleTabClasses();
      return;
    }

    if (this.currentView && typeof this.currentView.destroy === 'function') {
      this.currentView.destroy();
    }

    this.activeModule = moduleId;
    const viewContainer = this.mountEl.querySelector('#module-view-container');
    if (!viewContainer) return;

    const isOperativo = this.viewMode === 'operativo';
    const subtitle = this.mountEl.querySelector('#topbar-module-subtitle');

    this.updateActiveModuleTabClasses();

    if (subtitle) {
      if (isOperativo) {
        if (moduleId === 'm1') {
          subtitle.textContent =
            'Operación en Campo: Registra reportes con fotos comprimidas y da seguimiento a los equipos con o sin señal';
        } else {
          subtitle.textContent =
            'Supervisión y Guardia: Consulta el historial unificado de toda la mina, filtra por equipo y descarga en Excel (.xlsx)';
        }
      } else if (moduleId === 'm1') {
        subtitle.textContent =
          'Módulo 1 (M1): Captura Offline-First, Compresión en Dispositivo y Tabla Operativa Unificada';
      } else if (moduleId === 'm2') {
        subtitle.textContent =
          'Módulo 2 (M2): Guardado Local en IndexedDB, Imágenes Comprimidas y Pantalla "Mis reportes"';
      } else if (moduleId === 'm3') {
        subtitle.textContent =
          'Módulo 3 (M3): PWA Instalable, Service Worker (Prompt), Precaché del App Shell y Modo Sin Conexión';
      } else if (moduleId === 'm4') {
        subtitle.textContent =
          'Módulo 4 (M4): Inicio de Sesión Resiliente (Supabase Auth), Desacoplamiento Offline (P9) y Cierre Seguro';
      } else if (moduleId === 'm5') {
        subtitle.textContent =
          'Módulo 5 (M5): Motor y Cola de Sincronización Secuencial (Storage ➔ Postgres, Candado Mutex y Exponential Backoff)';
      } else {
        subtitle.textContent =
          'Módulo 6 (M6): Historial Unificado (Local + Supabase), Catálogo Compartido, Lazy Load (createSignedUrl) y Exportación Excel (.xlsx)';
      }
    }

    if (moduleId === 'm1') {
      this.currentView = new CapturaReporteView(viewContainer, {
        initialTableTab: this.m1TableTab,
        onTableTabChange: (tab) => {
          this.m1TableTab = tab === 'levantadas' ? 'levantadas' : 'activas';
          this.updateActiveModuleTabClasses();
        },
        onStatsChange: async (m1Stats) => {
          await this.refreshGlobalStats(m1Stats);
          this.updateTopbarStats();
        }
      });
      await this.currentView.init();
      if (scrollToTable) {
        viewContainer.querySelector('#section-tabla-principal')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    } else if (moduleId === 'm2') {
      this.currentView = new MisReportesView(viewContainer, {
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        },
        onNavigateToCapture: () => {
          this.switchModule('m1');
        },
        onNavigateToSync: () => {
          this.switchModule('m5');
        }
      });
      await this.currentView.init();
    } else if (moduleId === 'm3') {
      this.currentView = new PwaModuleView(viewContainer, {
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        },
        onNavigateModule: (targetMod) => {
          this.switchModule(targetMod);
        }
      });
      await this.currentView.init();
    } else if (moduleId === 'm4') {
      this.currentView = new AuthModuleView(viewContainer, {
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        },
        onNavigateModule: (targetMod) => {
          this.switchModule(targetMod);
        }
      });
      await this.currentView.init();
    } else if (moduleId === 'm5') {
      this.currentView = new SyncModuleView(viewContainer, {
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        },
        onNavigateModule: (targetMod) => {
          this.switchModule(targetMod);
        }
      });
      await this.currentView.init();
    } else {
      this.currentView = new HistorialModuleView(viewContainer, {
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        },
        onNavigateModule: (targetMod) => {
          this.switchModule(targetMod);
        }
      });
      await this.currentView.init();
    }

    await this.refreshGlobalStats();
    this.updateTopbarStats();
  }

  getRecommendedZoom() {
    if (typeof window === 'undefined') return 0.82;
    const w = window.innerWidth;
    if (w <= 480) return 0.62;
    if (w <= 768) return 0.68;
    return 0.82;
  }

  applyZoom(newZoom, { isManual = true } = {}) {
    if (isManual) {
      this.userAdjustedZoom = true;
    }
    this.zoomLevel = Math.min(1.15, Math.max(0.5, Number(newZoom.toFixed(2))));
    document.documentElement.style.setProperty('--ui-zoom', String(this.zoomLevel));
    const label = this.mountEl.querySelector('#label-zoom');
    if (label) {
      label.textContent = `${Math.round(this.zoomLevel * 100)}%`;
    }
  }

  updateTopbarStats() {
    const isOperativo = this.viewMode === 'operativo';
    const pendEl = this.mountEl.querySelector('#stat-pendientes');
    const pendLabel = this.mountEl.querySelector('#stat-pending-label');
    const pendPill = this.mountEl.querySelector('#pill-pending');
    const syncIcon = this.mountEl.querySelector('#stat-sync-icon');
    const storEl = this.mountEl.querySelector('#stat-storage');
    const tabBadgeLevantadas = this.mountEl.querySelector('#tab-badge-levantadas');
    const tabBadgeM2 = this.mountEl.querySelector('#tab-badge-m2');
    const tabBadgeM3 = this.mountEl.querySelector('#tab-badge-m3');
    const tabBadgeM4 = this.mountEl.querySelector('#tab-badge-m4');
    const tabBadgeM5 = this.mountEl.querySelector('#tab-badge-m5');
    const tabBadgeM6 = this.mountEl.querySelector('#tab-badge-m6');
    const authPill = this.mountEl.querySelector('#pill-auth');
    const authPillText = this.mountEl.querySelector('#stat-auth-pill');
    const pwaState = pwaManager.getState();
    const authState = authService.getState();
    const syncState = syncQueue.getState();

    if (pendEl) {
      pendEl.textContent = String(this.stats.pendientes);
      pendEl.style.display =
        !authState.isRealCloudSession || (this.stats.pendientes === 0 && !syncState.isSyncing)
          ? 'none'
          : 'inline';
    }
    if (pendLabel) {
      pendLabel.textContent = syncState.isSyncing
        ? 'Subiendo...'
        : !authState.isRealCloudSession
          ? 'Solo Local (Conectar)'
          : this.stats.pendientes === 0
            ? 'Al día en nube'
            : 'Por subir:';
    }
    if (pendPill) {
      pendPill.className = `status-pill ${
        authState.isRealCloudSession && this.stats.pendientes === 0 ? 'online' : ''
      }`;
    }
    if (syncIcon) {
      syncIcon.textContent = syncState.isSyncing
        ? '🔄'
        : !authState.isRealCloudSession
          ? '⚠️'
          : this.stats.pendientes === 0
            ? '☁️'
            : '⏳';
    }
    if (storEl) {
      storEl.textContent = `${formatBytes(this.stats.indexedDbBytes)} (Cuota: ${this.stats.storageEst.usageMB} MB)`;
    }
    if (tabBadgeLevantadas) {
      tabBadgeLevantadas.textContent = `${this.stats.levantadasCount || 0} cerradas`;
    }
    if (tabBadgeM2) {
      tabBadgeM2.textContent = `${this.stats.totalReportes} guardados (${formatBytes(this.stats.indexedDbBytes)})`;
    }
    if (tabBadgeM3) {
      tabBadgeM3.textContent = pwaState.isOnline
        ? 'App Shell Offline Ready'
        : '✈️ Modo Avión Activo';
    }
    if (tabBadgeM4) {
      tabBadgeM4.textContent = authState.badgeText;
    }
    if (tabBadgeM5) {
      tabBadgeM5.textContent = syncState.isSyncing
        ? '🔒 Sincronizando...'
        : `${this.stats.pendientes} pendientes • ${this.stats.sincronizados} en nube`;
    }
    if (tabBadgeM6) {
      tabBadgeM6.textContent = isOperativo
        ? `${this.stats.unificadosTotal} reportes • .xlsx`
        : `${this.stats.unificadosTotal} unificados • Exportar .xlsx`;
    }
    if (authPill && authPillText) {
      authPill.className = `status-pill ${
        authState.isRealCloudSession ? 'online' : 'offline'
      }`;
      authPillText.textContent = authState.badgeText;
    }
    const topbarSyncBtn = this.mountEl.querySelector('#btn-topbar-sync');
    if (topbarSyncBtn) {
      const syncBtnState = this.getTopbarSyncButtonState();
      topbarSyncBtn.className = `btn-mine btn-sm-mine btn-topbar-sync ${syncBtnState.stateClass}`;
      topbarSyncBtn.textContent = syncBtnState.label;
      topbarSyncBtn.title = syncBtnState.title;
      topbarSyncBtn.disabled = Boolean(syncBtnState.disabled);
    }
  }

  bindGlobalEvents() {
    this.mountEl.querySelector('#btn-design-v1-0')?.addEventListener('click', () => {
      this.setDesignVersion('1.0');
    });

    this.mountEl.querySelector('#btn-design-v1-1')?.addEventListener('click', () => {
      this.setDesignVersion('1.1');
    });

    this.mountEl.querySelector('#btn-topbar-sync')?.addEventListener('click', () => {
      this.handleManualSyncAndRefresh();
    });

    this.mountEl.querySelector('#btn-toggle-topbar')?.addEventListener('click', () => {
      this.toggleTopbarCollapsed(null, { isManual: true });
    });

    if (typeof window !== 'undefined') {
      if (this._resizeHandler) {
        window.removeEventListener('resize', this._resizeHandler);
      }
      this._resizeHandler = () => {
        if (!this.userToggledTopbar) {
          this.isTopbarCollapsed = window.innerWidth <= 980;
          this.updateTopbarCollapsedUI();
        }
        if (!this.userAdjustedZoom) {
          this.applyZoom(this.getRecommendedZoom(), { isManual: false });
        }
      };
      window.addEventListener('resize', this._resizeHandler);
    }

    this.mountEl.querySelector('#btn-toggle-view-mode')?.addEventListener('click', async () => {
      if (this.viewMode === 'operativo') {
        this.requestSpecialUserAccess();
      } else {
        await this.setViewMode('operativo', {
          switchUserEmail: 'supervisor.mina@operacion.pe',
          switchUserPass: 'Mina2026!Sup',
          targetModule: 'm1'
        });
      }
    });

    this.mountEl.querySelector('#tab-btn-m1')?.addEventListener('click', () => {
      this.switchModule('m1', { tableTab: 'activas' });
    });

    this.mountEl.querySelector('#tab-btn-levantadas')?.addEventListener('click', () => {
      this.switchModule('m1', { tableTab: 'levantadas', scrollToTable: true });
    });

    this.mountEl.querySelector('#tab-btn-m2')?.addEventListener('click', () => {
      this.switchModule('m2');
    });

    this.mountEl.querySelector('#tab-btn-m3')?.addEventListener('click', () => {
      this.switchModule('m3');
    });

    this.mountEl.querySelector('#tab-btn-m4')?.addEventListener('click', () => {
      this.switchModule('m4');
    });

    this.mountEl.querySelector('#tab-btn-m5')?.addEventListener('click', () => {
      this.switchModule('m5');
    });

    this.mountEl.querySelector('#tab-btn-m6')?.addEventListener('click', () => {
      this.switchModule('m6');
    });

    this.mountEl.querySelector('#pill-network')?.addEventListener('click', () => {
      if (this.viewMode === 'ingenieria') {
        this.switchModule('m3');
      }
    });

    this.mountEl.querySelector('#pill-auth')?.addEventListener('click', () => {
      this.showQuickProfileModal = true;
      this.renderQuickProfileModal();
    });

    this.mountEl.querySelector('#pill-pending')?.addEventListener('click', async () => {
      if (this.viewMode === 'operativo' || !authService.getState().isRealCloudSession) {
        await this.handleManualSyncAndRefresh();
      } else {
        this.switchModule('m5');
      }
    });

    this.mountEl.querySelector('#pill-storage')?.addEventListener('click', () => {
      this.switchModule('m2');
    });

    this.mountEl.querySelector('#btn-zoom-out')?.addEventListener('click', () => {
      this.applyZoom(this.zoomLevel - 0.06);
    });

    this.mountEl.querySelector('#btn-zoom-in')?.addEventListener('click', () => {
      this.applyZoom(this.zoomLevel + 0.06);
    });

    const btnTheme = this.mountEl.querySelector('#btn-toggle-theme');
    btnTheme?.addEventListener('click', () => {
      this.isNightTheme = !this.isNightTheme;
      document.body.classList.toggle('theme-night', this.isNightTheme);
      btnTheme.textContent = this.isNightTheme
        ? '☀️ Modo Día'
        : '🌙 Modo Noche';
    });

    pwaManager.subscribe((pwaState) => {
      this.updateNetworkPill(pwaState);
      this.updateTopbarStats();
    });

    authService.subscribe((authState) => {
      // Si el usuario inicia sesión manualmente desde M4 como admin.arquitectura@operacion.pe,
      // activar automáticamente la vista completa de 6 módulos
      if (authState.isArchitectureAdmin && this.viewMode !== 'ingenieria') {
        this.viewMode = 'ingenieria';
        localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'ingenieria');
        this.applyBodyViewModeClass();
        this.updateViewModeUI();
      }
      this.updateTopbarStats();
    });

    syncQueue.subscribe(async () => {
      await this.refreshGlobalStats();
      this.updateTopbarStats();
    });
  }

  updateNetworkPill(pwaState = pwaManager.getState()) {
    const pill = this.mountEl.querySelector('#pill-network');
    const quickDot = this.mountEl.querySelector('#topbar-quick-net-dot');
    if (quickDot) {
      quickDot.textContent = pwaState.isOnline ? '🟢' : '🔴';
    }
    if (!pill) return;
    pill.className = `status-pill ${pwaState.isOnline ? 'online' : 'offline'}`;
    pill.innerHTML = `<span>${
      pwaState.simulatedAirplaneMode
        ? '✈️ Modo Avión (P5)'
        : pwaState.isOnline
          ? '🟢 En línea'
          : '🔴 Sin conexión'
    }</span>`;
  }
}
