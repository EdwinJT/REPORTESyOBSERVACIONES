/**
 * App Principal — Layout Operativo, Barra de Estado (Red / Sesión M4 / Cola M5 / Historial M6 / Pendientes / Cuota / Zoom / Tema Claridad-Noche)
 * y Navegación entre los 6 Módulos de la PWA (Entrega 1 + Entrega 2 completas):
 * - Módulo 1 (M1 — Captura "Nuevo reporte" y Tabla Operativa Unificada)
 * - Módulo 2 (M2 — Guardado Local, Compresión Previa y Pantalla "Mis reportes")
 * - Módulo 3 (M3 — PWA Instalable, Service Worker Prompt, Precaché App Shell y Modo Sin Conexión P5)
 * - Módulo 4 (M4 — Inicio de Sesión Resiliente con Supabase Auth, Desacoplamiento Offline P9 y Cierre Seguro)
 * - Módulo 5 (M5 — Motor y Cola de Sincronización Secuencial: Storage -> Postgres, Mutex, Ping 8s y Backoff)
 * - Módulo 6 (M6 — Historial Unificado Local+Nube, Catálogo Compartido, Lazy Load createSignedUrl y Exportación Excel .xlsx P10)
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
import { authService } from './services/authService.js';
import { syncQueue } from './services/syncQueue.js';
import { CapturaReporteView } from './components/CapturaReporte/CapturaReporte.js';
import { MisReportesView } from './components/MisReportes/MisReportes.js';
import { PwaGlobalBanner, PwaModuleView } from './components/PwaBanner/PwaBanner.js';
import { AuthModuleView } from './components/Auth/Auth.js';
import { SyncModuleView } from './components/SyncStatus/SyncStatus.js';
import { HistorialModuleView } from './components/Historial/Historial.js';

export class AppController {
  constructor(mountEl) {
    this.mountEl = mountEl;
    this.isNightTheme = false; // Por defecto inicia en Modo Claridad Industrial
    this.zoomLevel = 0.82; // Vista panorámica por defecto (82%)
    this.activeModule = 'm6'; // Inicia en el Módulo 6 (Historial Unificado, Catálogo Compartido y Exportación a Excel)
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
    await this.refreshGlobalStats();

    const pwaState = pwaManager.getState();
    const authState = authService.getState();
    const syncState = syncQueue.getState();

    this.mountEl.innerHTML = `
      <header class="topbar">
        <div class="brand-block">
          <div class="brand-icon">⛏️</div>
          <div>
            <h1 class="brand-title">REPORTES Y OBSERVACIONES DE EQUIPOS MINEROS</h1>
            <p class="brand-subtitle" id="topbar-module-subtitle">
              Módulo 6 (M6): Historial Unificado (Local + Supabase), Catálogo Compartido, Lazy Load (createSignedUrl) y Exportación Excel (.xlsx)
            </p>
          </div>
        </div>

        <div class="topbar-controls">
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
            title="Estado de red en tiempo real (Clic para abrir panel PWA M3)"
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
            class="status-pill ${authState.isAuthenticatedValid ? 'online' : authState.isExpired ? 'offline' : ''}"
            id="pill-auth"
            style="cursor:pointer;"
            title="Estado de sesión Supabase Auth (Clic para abrir Módulo 4)"
          >
            <span id="stat-auth-pill">${authState.badgeText}</span>
          </div>

          <div
            class="status-pill ${this.stats.pendientes === 0 ? 'online' : ''}"
            id="pill-pending"
            style="cursor:pointer;"
            title="Abrir Cola de Sincronización (Módulo 5)"
          >
            <span id="stat-sync-icon">${syncState.isSyncing ? '🔄' : '⏳'}</span>
            Pendientes: <strong id="stat-pendientes" style="color:#fbbf24;">${this.stats.pendientes}</strong>
          </div>

          <div class="status-pill" id="pill-storage" style="cursor:pointer;" title="Almacenamiento local IndexedDB y cuota del dispositivo (M2)">
            💾 Local: <strong id="stat-storage" style="color:#38bdf8;">${formatBytes(this.stats.indexedDbBytes)}</strong>
          </div>

          <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-toggle-theme">
            🌙 Cambiar a Modo Noche
          </button>
        </div>
      </header>

      <!-- Barra Global M3: Estado de Red, Botón Instalar App, Guía iOS y Aviso de Nueva Versión -->
      <div id="pwa-global-banner-mount"></div>

      <!-- Barra de Navegación de los 6 Módulos (M1 a M6) con botones >= 48px para uso con guantes -->
      <nav class="module-navbar" aria-label="Navegación de Módulos">
        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm1' ? 'active' : ''}"
          id="tab-btn-m1"
        >
          <span>📝 M1 — Nuevo Reporte y Tabla</span>
          <span class="module-tab-badge">Captura + Seguimientos (↳)</span>
        </button>

        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm2' ? 'active' : ''}"
          id="tab-btn-m2"
        >
          <span>💾 M2 — "Mis reportes" Local</span>
          <span class="module-tab-badge" id="tab-badge-m2">${this.stats.totalReportes} guardados (${formatBytes(this.stats.indexedDbBytes)})</span>
        </button>

        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm3' ? 'active' : ''}"
          id="tab-btn-m3"
        >
          <span>📲 M3 — PWA y Modo Avión</span>
          <span class="module-tab-badge" id="tab-badge-m3">${
            pwaState.isOnline ? 'App Shell Offline Ready' : '✈️ Modo Avión Activo'
          }</span>
        </button>

        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm4' ? 'active' : ''}"
          id="tab-btn-m4"
        >
          <span>🔐 M4 — Supabase Auth</span>
          <span class="module-tab-badge" id="tab-badge-m4">${authState.badgeText}</span>
        </button>

        <button
          type="button"
          class="module-tab-btn ${this.activeModule === 'm5' ? 'active' : ''}"
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
          <span>📊 M6 — Historial Unificado y Excel</span>
          <span class="module-tab-badge" id="tab-badge-m6">${this.stats.unificadosTotal} unificados • Exportar .xlsx</span>
        </button>
      </nav>

      <main id="module-view-container"></main>
    `;

    const bannerMount = this.mountEl.querySelector('#pwa-global-banner-mount');
    this.pwaBanner = new PwaGlobalBanner(bannerMount, {
      onOpenPwaModule: () => this.switchModule('m3')
    });
    this.pwaBanner.init();

    this.bindGlobalEvents();
    await this.switchModule(this.activeModule);
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
      if (moduleId === 'm1') {
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
    const pendEl = this.mountEl.querySelector('#stat-pendientes');
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

    if (pendEl) pendEl.textContent = String(this.stats.pendientes);
    if (pendPill) {
      pendPill.className = `status-pill ${this.stats.pendientes === 0 ? 'online' : ''}`;
    }
    if (syncIcon) {
      syncIcon.textContent = syncState.isSyncing ? '🔄' : '⏳';
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
      tabBadgeM6.textContent = `${this.stats.unificadosTotal} unificados • Exportar .xlsx`;
    }
    if (authPill && authPillText) {
      authPill.className = `status-pill ${
        authState.isAuthenticatedValid ? 'online' : authState.isExpired ? 'offline' : ''
      }`;
      authPillText.textContent = authState.badgeText;
    }
  }

  bindGlobalEvents() {
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
      this.switchModule('m3');
    });

    this.mountEl.querySelector('#pill-auth')?.addEventListener('click', () => {
      this.switchModule('m4');
    });

    this.mountEl.querySelector('#pill-pending')?.addEventListener('click', () => {
      this.switchModule('m5');
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
        ? '☀️ Volver a Modo Claridad (Día)'
        : '🌙 Cambiar a Modo Noche';
    });

    pwaManager.subscribe((pwaState) => {
      this.updateNetworkPill(pwaState);
      this.updateTopbarStats();
    });

    authService.subscribe(() => {
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
