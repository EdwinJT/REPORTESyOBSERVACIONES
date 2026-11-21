/**
 * M3 — Gestor de PWA Instalable, Service Worker (registerType: 'prompt'),
 * Precaché del App Shell y Estado de Red / Modo Avión (Escenario P5).
 */

export const APP_SHELL_MANIFEST_VERSION = 'v1.9.7-tema-stracon';
export const APP_SHELL_CACHE_NAME = `mineria-pwa-appshell-${APP_SHELL_MANIFEST_VERSION}`;

export const APP_SHELL_FILES = [
  { path: './index.html', category: 'HTML Principal', desc: 'Documento raíz con meta tags PWA e íconos Apple Touch' },
  { path: './manifest.webmanifest', category: 'Web App Manifest', desc: 'Configuración display: standalone, íconos 192x192 y 512x512' },
  { path: './supabase_setup.sql', category: 'Script SQL (M4/M5)', desc: 'Tabla public.reportes, bucket privado fotos y políticas RLS auth.uid()' },
  { path: './public/pwa-192x192.png', category: 'Ícono PWA 192px', desc: 'Ícono estándar de alto contraste para pantalla de inicio' },
  { path: './public/pwa-512x512.png', category: 'Ícono PWA 512px', desc: 'Ícono alta resolución y maskable para splash screen' },
  { path: './public/apple-touch-icon.png', category: 'Ícono Apple Touch', desc: 'Ícono 180x180 para iOS Safari ("Agregar a inicio")' },
  { path: './src/main.js', category: 'App Shell JS', desc: 'Punto de entrada y arranque del controlador principal' },
  { path: './src/App.js', category: 'App Shell JS', desc: 'Layout operativo, barra de estado y enrutador M1..M6' },
  { path: './src/index.css', category: 'App Shell CSS', desc: 'Estilos de alto contraste (Modo Claridad Día y Modo Noche) >= 48px' },
  { path: './src/config/supabaseClient.js', category: 'Cliente Supabase (M4/M5/M6)', desc: 'Auth, Storage (upsert + createSignedUrl) y Postgres (upsert + select)' },
  { path: './src/db/localDb.js', category: 'Base de Datos Local', desc: 'Motor IndexedDB (tablas reportes y equipos)' },
  { path: './src/db/storageManager.js', category: 'Persistencia Local', desc: 'Gestión de navigator.storage.persist() y estimate()' },
  { path: './src/services/imageCompressor.js', category: 'Compresor Multimedia', desc: 'Compresión previa a IndexedDB (<400KB / <800KB)' },
  { path: './src/services/equipmentService.js', category: 'Catálogo Compartido (M1/M6)', desc: 'Normalización, persistencia y sincronización de códigos Local + Nube' },
  { path: './src/services/pwaManager.js', category: 'Motor PWA (M3)', desc: 'Registro Service Worker (prompt), instalación y precaché' },
  { path: './src/services/authService.js', category: 'Autenticación (M4)', desc: 'Inicio de sesión resiliente, desacoplamiento P9 y cierre seguro' },
  { path: './src/services/connectivity.js', category: 'Conectividad Real (M5)', desc: 'Ping HTTP con AbortController (8 s) y detección de Lie-Fi (P8)' },
  { path: './src/services/syncQueue.js', category: 'Motor y Cola Sync (M5)', desc: 'Mutex, 2 fases (Storage -> Postgres) y Exponential Backoff (30s/2m/10m)' },
  { path: './src/services/excelExporter.js', category: 'Exportador Excel (M6)', desc: 'Generador OpenXML .xlsx de reportes filtrados sin URLs firmadas (P10)' },
  { path: './src/utils/datePeru.js', category: 'Zona Horaria Lima', desc: 'Cálculo estricto America/Lima (UTC-5) sin desfase UTC' },
  { path: './src/utils/codeNormalizer.js', category: 'Normalizador', desc: 'Estandarización de códigos (ej. 793f 05 -> 793F-05)' },
  { path: './src/components/CapturaReporte/CapturaReporte.js', category: 'Módulo 1 (UI)', desc: 'Captura Nuevo Reporte y Tabla Operativa' },
  { path: './src/components/MisReportes/MisReportes.js', category: 'Módulo 2 (UI)', desc: 'Pantalla Mis reportes y auditoría de pesos IndexedDB' },
  { path: './src/components/PwaBanner/PwaBanner.js', category: 'Módulo 3 (UI)', desc: 'Panel PWA Instalable, Modo Avión P5 y Guía iOS/Android' },
  { path: './src/components/Auth/Auth.js', category: 'Módulo 4 (UI)', desc: 'Panel Supabase Auth, Laboratorio Escenario P9 y Auditoría R7' },
  { path: './src/components/SyncStatus/SyncStatus.js', category: 'Módulo 5 (UI)', desc: 'Panel Motor de Sincronización y Laboratorios P6, P7 y P8' },
  { path: './src/components/Historial/Historial.js', category: 'Módulo 6 (UI)', desc: 'Historial Unificado, Catálogo Compartido, Lazy Load y Exportación Excel P10' }
];

class PwaManagerService {
  constructor() {
    this.deferredInstallPrompt = null;
    this.swRegistration = null;
    this.waitingWorker = null;
    this.updateAvailable = false;
    this.simulatedUpdatePrompt = false;
    this.simulatedAirplaneMode = false;
    this.isInstalledStandalone = this.checkIsStandalone();
    this.swStatus = 'Verificando...';
    this.listeners = new Set();
    this.initialized = false;
  }

  checkIsStandalone() {
    if (typeof window === 'undefined') return false;
    const isDisplayStandalone =
      window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const isIosStandalone = window.navigator && window.navigator.standalone === true;
    return Boolean(isDisplayStandalone || isIosStandalone);
  }

  detectPlatformInfo() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

    let osName = 'PC / Escritorio';
    if (isIOS) osName = 'iPhone / iPad (iOS)';
    else if (isAndroid) osName = 'Android';

    return {
      isIOS,
      isAndroid,
      isSafari,
      osName,
      userAgentShort: `${osName}${isSafari ? ' - Safari' : ' - Chromium/Web'}`
    };
  }

  isEffectiveOnline() {
    if (this.simulatedAirplaneMode) return false;
    return navigator.onLine;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore listener error
      }
    }
  }

  getState() {
    return {
      isOnline: this.isEffectiveOnline(),
      browserOnline: navigator.onLine,
      simulatedAirplaneMode: this.simulatedAirplaneMode,
      canInstallPrompt: Boolean(this.deferredInstallPrompt),
      isInstalledStandalone: this.checkIsStandalone(),
      updateAvailable: Boolean(this.updateAvailable || this.simulatedUpdatePrompt),
      swStatus: this.swStatus,
      hasServiceWorkerSupport: 'serviceWorker' in navigator,
      hasCacheStorageSupport: 'caches' in window,
      platform: this.detectPlatformInfo(),
      cacheVersion: APP_SHELL_MANIFEST_VERSION
    };
  }

  async init() {
    if (this.initialized) return this.getState();
    this.initialized = true;

    // 1. Capturar evento nativo de instalación PWA (beforeinstallprompt en Android/Chrome/Edge)
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredInstallPrompt = event;
      this.notify();
    });

    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt = null;
      this.isInstalledStandalone = true;
      this.notify();
    });

    // 2. Escuchar cambios de red reales
    window.addEventListener('online', () => this.notify());
    window.addEventListener('offline', () => this.notify());

    // 3. Registrar Service Worker con patrón registerType: 'prompt' (en segundo plano sin bloquear la UI)
    this.registerServiceWorker().then(() => {
      // 4. Asegurar precaché del App Shell en CacheStorage en segundo plano
      this.warmUpAppShellCache();
    });

    return this.getState();
  }

  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      this.swStatus = 'No soportado en este navegador';
      this.notify();
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register('./sw.js', {
        scope: './'
      });
      this.swRegistration = registration;
      this.swStatus = registration.active
        ? 'Activo y controlando App Shell (Offline Ready)'
        : 'Instalando precaché del App Shell...';

      if (registration.waiting) {
        this.waitingWorker = registration.waiting;
        this.updateAvailable = true;
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // Hay una nueva versión lista en espera (registerType: 'prompt')
              this.waitingWorker = newWorker;
              this.updateAvailable = true;
              this.swStatus = 'Nueva versión descargada (esperando confirmación)';
            } else {
              this.swStatus = 'App Shell precacheado y listo para Modo Avión';
            }
            this.notify();
          } else if (newWorker.state === 'activated') {
            this.swStatus = 'Activo y controlando App Shell (Offline Ready)';
            this.notify();
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        this.swStatus = 'Service Worker actualizado y activo';
        this.notify();
      });

      // No bloquear el arranque si el Service Worker sigue instalando en segundo plano
      Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(resolve, 1200))
      ]).then(() => {
        this.swStatus = 'Activo y controlando App Shell (Offline Ready)';
        this.notify();
      });

      this.notify();
    } catch (err) {
      this.swStatus = `Modo local activo (${err?.message || 'SW en espera'})`;
      this.notify();
    }
  }

  /**
   * Precachea todos los recursos del App Shell en CacheStorage y devuelve el inventario verificado
   */
  async warmUpAppShellCache() {
    if (!('caches' in window)) return [];

    try {
      const cache = await caches.open(APP_SHELL_CACHE_NAME);
      for (const item of APP_SHELL_FILES) {
        try {
          const matched = await cache.match(item.path);
          if (!matched && this.isEffectiveOnline()) {
            const response = await fetch(item.path, { cache: 'no-cache' });
            if (response && response.ok) {
              await cache.put(item.path, response.clone());
            }
          }
        } catch {
          // Si ya estamos sin conexión, mantiene la versión en caché
        }
      }

      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'PRECACHING_VERIFY' });
      }
    } catch {
      // ignore cache write errors
    }

    return this.inspectPrecachedAssets();
  }

  async inspectPrecachedAssets() {
    const results = [];
    let cache = null;

    if ('caches' in window) {
      try {
        cache = await caches.open(APP_SHELL_CACHE_NAME);
      } catch {
        cache = null;
      }
    }

    for (const item of APP_SHELL_FILES) {
      let cached = false;
      let sizeBytes = 0;

      if (cache) {
        try {
          const match = await cache.match(item.path);
          if (match) {
            cached = true;
            const clone = match.clone();
            const buf = await clone.arrayBuffer();
            sizeBytes = buf.byteLength;
          }
        } catch {
          cached = false;
        }
      }

      results.push({
        ...item,
        cached,
        sizeBytes
      });
    }

    return results;
  }

  async triggerNativeInstallPrompt() {
    if (!this.deferredInstallPrompt) {
      return { outcome: 'unavailable' };
    }

    this.deferredInstallPrompt.prompt();
    const choiceResult = await this.deferredInstallPrompt.userChoice;
    if (choiceResult.outcome === 'accepted') {
      this.deferredInstallPrompt = null;
    }
    this.notify();
    return choiceResult;
  }

  setSimulatedAirplaneMode(enabled) {
    this.simulatedAirplaneMode = Boolean(enabled);
    this.notify();
  }

  triggerUpdatePromptSimulation() {
    this.simulatedUpdatePrompt = true;
    this.notify();
  }

  dismissUpdatePrompt() {
    this.simulatedUpdatePrompt = false;
    this.updateAvailable = false;
    this.notify();
  }

  async applyPendingUpdate() {
    if (this.waitingWorker) {
      this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    }
    this.simulatedUpdatePrompt = false;
    this.updateAvailable = false;
    await this.warmUpAppShellCache();
    this.notify();
    return true;
  }
}

export const pwaManager = new PwaManagerService();
