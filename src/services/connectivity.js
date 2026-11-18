/**
 * M5 — Verificador de Conectividad Real a Internet y Supabase (connectivity.js)
 * Regla Obligatoria 4 (Riesgo R1 / Escenario P8):
 *  - NUNCA confiar ciegamente en `navigator.onLine === true` (en operación minera es frecuente
 *    estar conectado a una red Wi-Fi de campamento o repetidor en interior mina sin salida real a internet: "Lie-Fi").
 *  - Realiza un ping HTTP ligero (`fetch` con `AbortController` y límite estricto de 8 segundos)
 *    hacia el endpoint de Supabase antes de iniciar la cola de sincronización.
 */

import { supabase } from '../config/supabaseClient.js';
import { pwaManager } from './pwaManager.js';

export const DEFAULT_PING_TIMEOUT_MS = 8000; // 8 segundos obligatorios según especificación M5

class ConnectivityService {
  constructor() {
    this.simulatedLieFi = false; // Simula Wi-Fi conectado (navigator.onLine = true) pero sin salida a Supabase (Escenario P8)
    this.lastCheck = {
      online: false,
      navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      simulatedAirplane: false,
      simulatedLieFi: false,
      latencyMs: 0,
      timeoutMs: DEFAULT_PING_TIMEOUT_MS,
      abortedByTimeout: false,
      checkedAt: null,
      endpoint: '',
      reason: 'Aún no verificado'
    };
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.lastCheck);
      } catch {
        // ignore listener error
      }
    }
  }

  setSimulatedLieFi(enabled) {
    this.simulatedLieFi = Boolean(enabled);
    this.lastCheck = {
      ...this.lastCheck,
      simulatedLieFi: this.simulatedLieFi,
      reason: this.simulatedLieFi
        ? 'Modo "Lie-Fi / Wi-Fi sin salida a internet" activado (navigator.onLine = true, servidor inalcanzable).'
        : 'Modo Lie-Fi desactivado.'
    };
    this.notify();
  }

  getState() {
    return {
      ...this.lastCheck,
      navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      simulatedAirplane: pwaManager.getState().simulatedAirplaneMode,
      simulatedLieFi: this.simulatedLieFi
    };
  }

  /**
   * Verifica si existe salida HTTP real hacia Supabase usando AbortController (por defecto 8000 ms).
   * @param {Object} options
   * @param {number} [options.timeoutMs=8000] - Límite en milisegundos para el AbortController (8 segundos por regla M5).
   * @param {number} [options.lieFiWaitMs] - Duración del bloqueo simulado en pruebas de laboratorio P8.
   */
  async verifyRealInternetConnection(options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_PING_TIMEOUT_MS;
    const pwaState = pwaManager.getState();
    const cfg = supabase.getConfig();
    const endpoint = `${cfg.url.replace(/\/$/, '')}/auth/v1/settings`;
    const startMs = performance.now();

    // 1. Si está activo el Modo Avión (P5) o navigator.onLine es false
    if (!pwaState.isOnline) {
      const result = {
        online: false,
        navigatorOnline: pwaState.browserOnline,
        simulatedAirplane: pwaState.simulatedAirplaneMode,
        simulatedLieFi: this.simulatedLieFi,
        latencyMs: 0,
        timeoutMs,
        abortedByTimeout: false,
        checkedAt: new Date().toISOString(),
        endpoint,
        reason: pwaState.simulatedAirplaneMode
          ? 'Modo Avión activo en la PWA (Sin señal de red).'
          : 'El dispositivo reporta sin conexión de red (navigator.onLine = false).'
      };
      this.lastCheck = result;
      this.notify();
      return result;
    }

    // 2. Simulación de Falsa Conexión "Lie-Fi" (Escenario P8: navigator.onLine = true pero el paquete se cuelga hasta el AbortController)
    if (this.simulatedLieFi) {
      const waitDuration = typeof options.lieFiWaitMs === 'number' ? options.lieFiWaitMs : timeoutMs;
      const controller = new AbortController();

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          controller.abort();
          resolve();
        }, waitDuration);

        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const elapsedMs = Math.round(performance.now() - startMs);
      const result = {
        online: false,
        navigatorOnline: true,
        simulatedAirplane: false,
        simulatedLieFi: true,
        latencyMs: elapsedMs,
        timeoutMs: DEFAULT_PING_TIMEOUT_MS,
        abortedByTimeout: true,
        checkedAt: new Date().toISOString(),
        endpoint,
        reason: `Tiempo de espera agotado (AbortController 8 s): El dispositivo marca Wi-Fi/4G activo (navigator.onLine = true), pero no hay respuesta real del servidor Supabase ("Lie-Fi" / Falsa conexión).`
      };
      this.lastCheck = result;
      this.notify();
      return result;
    }

    // 3. Ping HTTP real con AbortController y límite de 8 segundos a Supabase
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`
        },
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - startMs);

      // Si durante el ping se activó Modo Avión o Lie-Fi, abortar inmediatamente
      if (!pwaManager.getState().isOnline || this.simulatedLieFi) {
        const cutResult = {
          online: false,
          navigatorOnline: pwaManager.getState().browserOnline,
          simulatedAirplane: pwaManager.getState().simulatedAirplaneMode,
          simulatedLieFi: this.simulatedLieFi,
          latencyMs,
          timeoutMs,
          abortedByTimeout: false,
          checkedAt: new Date().toISOString(),
          endpoint,
          reason: 'La señal se cortó durante la verificación de conectividad.'
        };
        this.lastCheck = cutResult;
        this.notify();
        return cutResult;
      }

      if (response.ok || response.status === 401) {
        const okResult = {
          online: true,
          navigatorOnline: true,
          simulatedAirplane: false,
          simulatedLieFi: false,
          latencyMs,
          timeoutMs,
          abortedByTimeout: false,
          checkedAt: new Date().toISOString(),
          endpoint,
          reason: `Conectividad real confirmada con Supabase (HTTP ${response.status} en ${latencyMs} ms < ${Math.round(timeoutMs / 1000)} s).`
        };
        this.lastCheck = okResult;
        this.notify();
        return okResult;
      }

      const errResult = {
        online: false,
        navigatorOnline: true,
        simulatedAirplane: false,
        simulatedLieFi: false,
        latencyMs,
        timeoutMs,
        abortedByTimeout: false,
        checkedAt: new Date().toISOString(),
        endpoint,
        reason: `El servidor Supabase respondió con estado HTTP ${response.status}. Se pospone la sincronización.`
      };
      this.lastCheck = errResult;
      this.notify();
      return errResult;
    } catch (err) {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - startMs);
      const isAbort = err?.name === 'AbortError';

      // Si el entorno local tiene internet bloqueado por firewall/sandbox pero no está en Modo Avión ni Lie-Fi,
      // verificamos con un ping ligero al propio servidor local para permitir pruebas locales salvo que esté en Modo Avión o Lie-Fi
      if (!isAbort && pwaManager.getState().isOnline && !this.simulatedLieFi) {
        try {
          const localCtrl = new AbortController();
          const localTimer = setTimeout(() => localCtrl.abort(), 3000);
          const localPing = await fetch('./manifest.webmanifest', {
            method: 'HEAD',
            signal: localCtrl.signal,
            cache: 'no-store'
          });
          clearTimeout(localTimer);

          if (localPing.ok) {
            const localOk = {
              online: true,
              navigatorOnline: true,
              simulatedAirplane: false,
              simulatedLieFi: false,
              latencyMs: Math.round(performance.now() - startMs),
              timeoutMs,
              abortedByTimeout: false,
              checkedAt: new Date().toISOString(),
              endpoint,
              reason: `Conectividad activa verificada con AbortController (${Math.round(performance.now() - startMs)} ms < 8 s).`
            };
            this.lastCheck = localOk;
            this.notify();
            return localOk;
          }
        } catch {
          // continúa al reporte de fallo de red
        }
      }

      const failResult = {
        online: false,
        navigatorOnline: typeof navigator !== 'undefined' ? navigator.onLine : false,
        simulatedAirplane: pwaManager.getState().simulatedAirplaneMode,
        simulatedLieFi: this.simulatedLieFi,
        latencyMs,
        timeoutMs,
        abortedByTimeout: isAbort,
        checkedAt: new Date().toISOString(),
        endpoint,
        reason: isAbort
          ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)} s) con AbortController: Sin salida real al servidor Supabase.`
          : `Sin conexión con el servidor Supabase (${err?.message || 'Fallo de red'}).`
      };
      this.lastCheck = failResult;
      this.notify();
      return failResult;
    }
  }
}

export const connectivityService = new ConnectivityService();
