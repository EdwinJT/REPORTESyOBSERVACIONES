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
import { getFechaHoyPeru } from './utils/datePeru.js';
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

export class AppController {
  constructor(mountEl) {
    this.mountEl = mountEl;
    this.isNightTheme = false; // Por defecto inicia en Modo Claridad Industrial
    this.zoomLevel = 0.82; // Vista panorámica por defecto (82%)
    this.viewMode = 'operativo'; // 'operativo' (2 pestañas limpias) | 'ingenieria' (6 módulos M1..M6)
    this.activeModule = 'm1'; // En modo operativo inicia directo en M1 (Registrar Reporte)
    this.showQuickProfileModal = false;
    this.pwaBanner = null;
    this.currentView = null;
    this.stats = {
      totalReportes: 0,
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
    this.applyBodyViewModeClass();

    await this.refreshGlobalStats();
    this.renderShell();

    const bannerMount = this.mountEl.querySelector('#pwa-global-banner-mount');
    this.pwaBanner = new PwaGlobalBanner(bannerMount, {
      onOpenPwaModule: () => {
        this.setViewMode('ingenieria');
        this.switchModule('m3');
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

  renderShell() {
    const pwaState = pwaManager.getState();
    const authState = authService.getState();
    const syncState = syncQueue.getState();
    const isOperativo = this.viewMode === 'operativo';

    this.mountEl.innerHTML = `
      <header class="topbar">
        <div class="brand-block">
          <div class="brand-icon">⛏️</div>
          <div>
            <div style="display:flex; align-items:center; gap:0.55rem; flex-wrap:wrap;">
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
                    ? '👷 VISTA SUPERVISOR OPERATIVO (2 PESTAÑAS)'
                    : '🛠️ USUARIO ESPECIAL: ARQUITECTURA M1–M6'
                }
              </span>
            </div>
            <p class="brand-subtitle" id="topbar-module-subtitle">
              Operación en Campo: Captura rápida con guantes, funcionamiento sin señal y sincronización automática
            </p>
          </div>
        </div>

        <div class="topbar-controls">
          <!-- Botón directo para alternar entre Vista Limpia Supervisor (2 pestañas) y Usuario Especial (6 módulos M1..M6) -->
          <button
            type="button"
            class="btn-mine btn-sm-mine ${isOperativo ? 'btn-secondary' : 'btn-amber'}"
            id="btn-toggle-view-mode"
            title="Alternar entre la vista simplificada del Supervisor (2 pestañas) y el Usuario Especial de Arquitectura (6 módulos M1 a M6)"
            style="min-height:34px; font-weight:800;"
          >
            ${
              isOperativo
                ? '🛠️ Usuario Especial: Ver M1–M6'
                : '👷 Volver a Vista Supervisor (2 Pestañas)'
            }
          </button>

          <!-- Control de Zoom rápido en barra superior -->
          <div class="status-pill" title="Ajustar zoom de la pantalla para ver más contenido">
            <span>🔍 Zoom:</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-zoom-out" style="min-height:28px; padding:0.15rem 0.5rem;">−</button>
            <strong id="label-zoom" style="color:#fbbf24;">${Math.round(this.zoomLevel * 100)}%</strong>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-zoom-in" style="min-height:28px; padding:0.15rem 0.5rem;">+</button>
          </div>

          <div class="status-pill" id="pill-peru-date" title="Fecha calculada en zona horaria America/Lima (UTC-5)">
            📅 Lima: <strong style="color:#fbbf24;">${getFechaHoyPeru()}</strong>
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
            class="status-pill ${this.stats.pendientes === 0 ? 'online' : ''}"
            id="pill-pending"
            style="cursor:pointer;"
            title="${
              isOperativo
                ? 'Toca para sincronizar ahora con la nube'
                : 'Abrir Cola de Sincronización (Módulo 5)'
            }"
          >
            <span id="stat-sync-icon">${syncState.isSyncing ? '🔄' : this.stats.pendientes === 0 ? '☁️' : '⏳'}</span>
            <span id="stat-pending-label">${
              syncState.isSyncing
                ? 'Subiendo...'
                : this.stats.pendientes === 0
                  ? 'Al día en nube'
                  : 'Por subir:'
            }</span>
            <strong id="stat-pendientes" style="color:#fbbf24; ${
              this.stats.pendientes === 0 && !syncState.isSyncing ? 'display:none;' : ''
            }">${this.stats.pendientes}</strong>
          </div>

          <div
            class="status-pill ${authState.isAuthenticatedValid ? 'online' : authState.isExpired ? 'offline' : ''}"
            id="pill-auth"
            style="cursor:pointer;"
            title="Cambiar de usuario (Supervisor Operativo o Usuario Especial Admin M1-M6)"
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
            🌙 Modo Noche
          </button>
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
          class="module-tab-btn ${this.activeModule === 'm1' ? 'active' : ''}"
          id="tab-btn-m1"
        >
          <span id="tab-title-m1">${
            isOperativo
              ? '📝 1. Registrar Reporte y Seguimiento'
              : '📝 M1 — Nuevo Reporte y Tabla'
          }</span>
          <span class="module-tab-badge" id="tab-badge-m1">${
            isOperativo
              ? 'Cámara • Equipos • Tabla Operativa (↳)'
              : 'Captura + Seguimientos (↳)'
          }</span>
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
              ? `${this.stats.unificadosTotal} reportes • Descargar .xlsx`
              : `${this.stats.unificadosTotal} unificados • Exportar .xlsx`
          }</span>
        </button>
      </nav>

      <main id="module-view-container"></main>
      <div id="quick-profile-modal-mount"></div>
    `;
  }

  updateViewModeUI() {
    const isOperativo = this.viewMode === 'operativo';
    const badgeMode = this.mountEl.querySelector('#badge-active-view-mode');
    const btnToggleMode = this.mountEl.querySelector('#btn-toggle-view-mode');
    const tabTitleM1 = this.mountEl.querySelector('#tab-title-m1');
    const tabBadgeM1 = this.mountEl.querySelector('#tab-badge-m1');
    const tabTitleM6 = this.mountEl.querySelector('#tab-title-m6');

    if (badgeMode) {
      badgeMode.style.background = isOperativo ? '#22c55e' : '#f59e0b';
      badgeMode.style.color = isOperativo ? '#052e16' : '#0f172a';
      badgeMode.textContent = isOperativo
        ? '👷 VISTA SUPERVISOR OPERATIVO (2 PESTAÑAS)'
        : '🛠️ USUARIO ESPECIAL: ARQUITECTURA M1–M6';
    }

    if (btnToggleMode) {
      btnToggleMode.className = `btn-mine btn-sm-mine ${isOperativo ? 'btn-secondary' : 'btn-amber'}`;
      btnToggleMode.textContent = isOperativo
        ? '🛠️ Usuario Especial: Ver M1–M6'
        : '👷 Volver a Vista Supervisor (2 Pestañas)';
    }

    if (tabTitleM1) {
      tabTitleM1.textContent = isOperativo
        ? '📝 1. Registrar Reporte y Seguimiento'
        : '📝 M1 — Nuevo Reporte y Tabla';
    }
    if (tabBadgeM1) {
      tabBadgeM1.textContent = isOperativo
        ? 'Cámara • Equipos • Tabla Operativa (↳)'
        : 'Captura + Seguimientos (↳)';
    }
    if (tabTitleM6) {
      tabTitleM6.textContent = isOperativo
        ? '📊 2. Historial de Mina y Exportar Excel'
        : '📊 M6 — Historial Unificado y Excel';
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
                    Usuario: <code>admin.arquitectura@operacion.pe</code> (Clave: <code>Mina2026!Admin</code>)<br/>
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

    mount.querySelector('#btn-activate-admin-mode')?.addEventListener('click', async () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
      await this.setViewMode('ingenieria', {
        switchUserEmail: 'admin.arquitectura@operacion.pe',
        switchUserPass: 'Mina2026!Admin'
      });
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

    mount.querySelector('#btn-open-full-m4-auth')?.addEventListener('click', async () => {
      this.showQuickProfileModal = false;
      this.renderQuickProfileModal();
      await this.setViewMode('ingenieria', { targetModule: 'm4' });
    });
  }

  async refreshGlobalStats() {
    const reportes = await localDb.reportes.toArray();
    const storageEst = await getStorageUsageEstimate();
    const metrics = calculateAllReportsStorageMetrics(reportes);
    const pendientes = reportes.filter((r) => r.estado === 'pendiente' || r.estado === 'error').length;
    const sincronizados = reportes.filter((r) => r.estado === 'sincronizado').length;

    const cloudSnap = supabase.getCloudSnapshot();
    const unifiedIds = new Set([
      ...reportes.map((r) => r.id),
      ...(cloudSnap.reportesCloud || []).map((r) => r.id)
    ]);

    this.stats = {
      totalReportes: reportes.length,
      pendientes,
      sincronizados,
      unificadosTotal: unifiedIds.size,
      indexedDbBytes: metrics.totalIndexedDbMediaBytes,
      storageEst
    };
  }

  async switchModule(moduleId) {
    if (this.currentView && typeof this.currentView.destroy === 'function') {
      this.currentView.destroy();
    }

    this.activeModule = moduleId;
    const viewContainer = this.mountEl.querySelector('#module-view-container');
    if (!viewContainer) return;

    const isOperativo = this.viewMode === 'operativo';

    // Actualizar pestañas activas y subtítulo
    const tabM1 = this.mountEl.querySelector('#tab-btn-m1');
    const tabM2 = this.mountEl.querySelector('#tab-btn-m2');
    const tabM3 = this.mountEl.querySelector('#tab-btn-m3');
    const tabM4 = this.mountEl.querySelector('#tab-btn-m4');
    const tabM5 = this.mountEl.querySelector('#tab-btn-m5');
    const tabM6 = this.mountEl.querySelector('#tab-btn-m6');
    const subtitle = this.mountEl.querySelector('#topbar-module-subtitle');

    tabM1?.classList.toggle('active', moduleId === 'm1');
    tabM2?.classList.toggle('active', moduleId === 'm2');
    tabM3?.classList.toggle('active', moduleId === 'm3');
    tabM4?.classList.toggle('active', moduleId === 'm4');
    tabM5?.classList.toggle('active', moduleId === 'm5');
    tabM6?.classList.toggle('active', moduleId === 'm6');

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
        onStatsChange: async () => {
          await this.refreshGlobalStats();
          this.updateTopbarStats();
        }
      });
      await this.currentView.init();
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

  applyZoom(newZoom) {
    this.zoomLevel = Math.min(1.15, Math.max(0.65, Number(newZoom.toFixed(2))));
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
        this.stats.pendientes === 0 && !syncState.isSyncing ? 'none' : 'inline';
    }
    if (pendLabel) {
      pendLabel.textContent = syncState.isSyncing
        ? 'Subiendo...'
        : this.stats.pendientes === 0
          ? 'Al día en nube'
          : 'Por subir:';
    }
    if (pendPill) {
      pendPill.className = `status-pill ${this.stats.pendientes === 0 ? 'online' : ''}`;
    }
    if (syncIcon) {
      syncIcon.textContent = syncState.isSyncing
        ? '🔄'
        : this.stats.pendientes === 0
          ? '☁️'
          : '⏳';
    }
    if (storEl) {
      storEl.textContent = `${formatBytes(this.stats.indexedDbBytes)} (Cuota: ${this.stats.storageEst.usageMB} MB)`;
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
        ? `${this.stats.unificadosTotal} reportes • Descargar .xlsx`
        : `${this.stats.unificadosTotal} unificados • Exportar .xlsx`;
    }
    if (authPill && authPillText) {
      authPill.className = `status-pill ${
        authState.isAuthenticatedValid ? 'online' : authState.isExpired ? 'offline' : ''
      }`;
      authPillText.textContent = authState.badgeText;
    }
  }

  bindGlobalEvents() {
    this.mountEl.querySelector('#btn-toggle-view-mode')?.addEventListener('click', async () => {
      if (this.viewMode === 'operativo') {
        await this.setViewMode('ingenieria', {
          switchUserEmail: 'admin.arquitectura@operacion.pe',
          switchUserPass: 'Mina2026!Admin'
        });
      } else {
        await this.setViewMode('operativo', {
          switchUserEmail: 'supervisor.mina@operacion.pe',
          switchUserPass: 'Mina2026!Sup',
          targetModule: 'm1'
        });
      }
    });

    this.mountEl.querySelector('#tab-btn-m1')?.addEventListener('click', () => {
      this.switchModule('m1');
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
      if (this.viewMode === 'operativo') {
        // En modo supervisor, sincroniza directamente en segundo plano con 1 toque sin cambiar de pantalla
        await syncQueue.processQueue({
          triggerSource: 'Sincronización rápida Supervisor',
          forceManual: true
        });
        await this.refreshGlobalStats();
        this.updateTopbarStats();
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
