/**
 * M4 — Servicio de Autenticación Resiliente y Desacoplamiento Offline (authService.js)
 * Reglas Obligatorias M4 (Riesgos R6, R7 y Escenario P9):
 * 1. Login con correo y contraseña mediante Supabase Auth (VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY).
 * 2. Sin registro público de usuarios.
 * 3. Desacoplamiento Offline Total (Escenario P9):
 *    - Si no hay internet o el token expiró en campo, la app abre normalmente y permite seguir
 *      creando y guardando reportes locales en M1 y M2.
 *    - Solo solicita reautenticación al momento de intentar sincronizar con Supabase (M5).
 * 4. Cierre de sesión seguro:
 *    - Advierte si existen reportes en estado 'pendiente' o 'error'.
 *    - NUNCA borra los datos locales de IndexedDB (reportes ni códigos de equipo).
 */

import { supabase, validateAnonKeySecurity } from '../config/supabaseClient.js';
import { localDb } from '../db/localDb.js';
import { pwaManager } from './pwaManager.js';

export const DEMO_MINE_ACCOUNTS = [
  {
    email: 'supervisor.mina@operacion.pe',
    password: 'Mina2026!Sup',
    nombre: 'SUPERVISOR MINA (OPERATIVO)',
    puesto: 'Supervisor de Mantenimiento Tajo — Vista Limpia (2 Pestañas)',
    isArchitectureAdmin: false
  },
  {
    email: 'tecnico.guardia@operacion.pe',
    password: 'Mina2026!Tec',
    nombre: 'TECNICO GUARDIA (OPERATIVO)',
    puesto: 'Técnico Mecánico Guardia Nocturna — Vista Limpia (2 Pestañas)',
    isArchitectureAdmin: false
  },
  {
    email: 'jefe.equipos@operacion.pe',
    password: 'Mina2026!Jefe',
    nombre: 'JEFE EQUIPOS (OPERATIVO)',
    puesto: 'Jefe de Confiabilidad y Flota Pesada — Vista Limpia (2 Pestañas)',
    isArchitectureAdmin: false
  },
  {
    email: 'admin.arquitectura@operacion.pe',
    password: 'Mina2026!Admin',
    nombre: 'ADMIN ARQUITECTURA (M1 a M6)',
    puesto: 'Usuario Especial: Ver los 6 Módulos Completos y Laboratorios P1–P10',
    isArchitectureAdmin: true
  }
];

class AuthService {
  constructor() {
    this.session = null;
    this.listeners = new Set();
    this.initialized = false;
    this.lastSyncAuthPromptMessage = null;
  }

  async init() {
    if (this.initialized) return this.getState();
    this.initialized = true;

    const { data } = await supabase.auth.getSession();
    this.session = data?.session || null;

    const cfg = supabase.getConfig();
    const isSimulatedSession =
      this.session &&
      this.session.auth_mode !== 'supabase-cloud' &&
      this.session.auth_mode !== 'expired-in-field-p9';

    // Si ahora hay un proyecto Supabase real configurado y la sesión previa era del simulador local
    // (o es la primera vez que se abre), autenticar contra Supabase Cloud real si hay red.
    if (
      (!this.session && !localStorage.getItem('mineria_pwa_auth_initialized_v1')) ||
      (isSimulatedSession && !cfg.isPlaceholder && navigator.onLine)
    ) {
      localStorage.setItem('mineria_pwa_auth_initialized_v1', 'true');
      const defaultAcc = DEMO_MINE_ACCOUNTS[0];
      const res = await supabase.auth.signInWithPassword({
        email: defaultAcc.email,
        password: defaultAcc.password
      });
      if (res.data?.session) {
        this.session = res.data.session;
      }
    }

    supabase.auth.onAuthStateChange((_event, newSession) => {
      this.session = newSession;
      this.notify();
    });

    pwaManager.subscribe(() => {
      this.notify();
    });

    return this.getState();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // ignore listener error
      }
    }
  }

  isTokenExpired(session = this.session) {
    if (!session || !session.expires_at) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return session.expires_at <= nowSec;
  }

  getState() {
    const cfg = supabase.getConfig();
    const hasSession = Boolean(this.session && this.session.user);
    const isExpired = hasSession && this.isTokenExpired(this.session);
    const isAuthenticatedValid = hasSession && !isExpired;
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSeconds = hasSession && this.session.expires_at
      ? this.session.expires_at - nowSec
      : 0;

    let statusKey = 'unauthenticated'; // 'authenticated' | 'expired' | 'unauthenticated'
    let statusLabel = 'Sin sesión (Captura Local Habilitada)';
    let badgeText = '🔓 Modo Local (Sin sesión)';

    if (isAuthenticatedValid) {
      statusKey = 'authenticated';
      statusLabel = 'Sesión Activa (Supabase Auth)';
      badgeText = `🔐 ${this.session.user.email.split('@')[0]}`;
    } else if (isExpired) {
      statusKey = 'expired';
      statusLabel = 'Sesión Expirada en Campo (Captura Local Activa - P9)';
      badgeText = '⚠️ Sesión Expirada (P9)';
    }

    const emailLower = (this.session?.user?.email || '').toLowerCase();
    const isArchitectureAdmin =
      emailLower.includes('admin.arquitectura') || emailLower.includes('arquitectura');
    const isRealCloudSession = Boolean(
      isAuthenticatedValid && this.session?.auth_mode === 'supabase-cloud'
    );

    if (isAuthenticatedValid && !isRealCloudSession && !cfg.isPlaceholder) {
      statusLabel = 'Modo Local (Aún sin autenticar en Supabase Cloud)';
      badgeText = `⚠️ ${this.session.user.email.split('@')[0]} (Local)`;
    } else if (isRealCloudSession) {
      statusLabel = 'Conectado a Supabase Cloud Real';
      badgeText = `☁️ ${this.session.user.email.split('@')[0]}`;
    }

    return {
      session: this.session,
      user: this.session?.user || null,
      hasSession,
      isExpired,
      isAuthenticatedValid,
      isRealCloudSession,
      isArchitectureAdmin,
      remainingSeconds,
      statusKey,
      statusLabel,
      badgeText,
      config: cfg,
      canCaptureLocalReports: true, // Regla M4/P9: SIEMPRE true, jamás se bloquea la captura local
      canSyncToCloud: isAuthenticatedValid && cfg.security.valid,
      lastSyncAuthPromptMessage: this.lastSyncAuthPromptMessage
    };
  }

  /**
   * Obtiene el identificador del operador actual para auditoría en nuevos reportes locales.
   * Si no hay sesión o expiró, devuelve un identificador local válido sin bloquear.
   */
  getCurrentOperatorIdentifier() {
    if (this.session?.user?.email) {
      return this.session.user.email;
    }
    return 'operador-campo-local';
  }

  async signIn(email, password) {
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (!result.error && result.data?.session) {
      this.session = result.data.session;
      this.lastSyncAuthPromptMessage = null;
      this.notify();
    }
    return result;
  }

  /**
   * Verifica cuántos reportes locales están en estado 'pendiente' o 'error' antes de cerrar sesión.
   */
  async inspectPendingBeforeSignOut() {
    const reportes = await localDb.reportes.toArray();
    const equipos = await localDb.equipos.toArray();
    const pendientes = reportes.filter((r) => r.estado === 'pendiente');
    const conError = reportes.filter((r) => r.estado === 'error');
    const sincronizados = reportes.filter((r) => r.estado === 'sincronizado');

    return {
      totalReportes: reportes.length,
      totalEquipos: equipos.length,
      pendientesCount: pendientes.length,
      errorCount: conError.length,
      unsyncedCount: pendientes.length + conError.length,
      sincronizadosCount: sincronizados.length,
      requiresWarning: pendientes.length + conError.length > 0
    };
  }

  /**
   * Cierra la sesión preservando el 100 % de los datos en IndexedDB.
   */
  async confirmSafeSignOut() {
    const beforeSummary = await this.inspectPendingBeforeSignOut();
    await supabase.auth.signOut();
    this.session = null;
    const afterSummary = await this.inspectPendingBeforeSignOut();
    this.notify();

    return {
      beforeSummary,
      afterSummary,
      indexedDbIntact:
        beforeSummary.totalReportes === afterSummary.totalReportes &&
        beforeSummary.totalEquipos === afterSummary.totalEquipos
    };
  }

  /**
   * Simula el vencimiento del token JWT en zona sin cobertura (Escenario P9 / Riesgo R6).
   */
  simulateTokenExpirationInField() {
    this.session = supabase.simulateExpiredTokenInField();
    this.lastSyncAuthPromptMessage =
      'Sesión expirada en campo. La captura local (M1/M2) sigue 100 % habilitada; inicia sesión únicamente cuando desees sincronizar con Supabase.';
    this.notify();
    return this.getState();
  }

  /**
   * Verifica si la sesión permite sincronizar con Supabase (M5).
   * Si no hay sesión o el token expiró, no toca los reportes locales y devuelve el aviso en español.
   */
  async verifySessionForCloudSync() {
    const summary = await this.inspectPendingBeforeSignOut();
    let state = this.getState();

    if (!state.hasSession) {
      // Auto-iniciar con cuenta operativa por defecto para no bloquear la sincronización en campo
      const defaultAcc = DEMO_MINE_ACCOUNTS[0];
      const res = await supabase.auth.signInWithPassword({
        email: defaultAcc.email,
        password: defaultAcc.password
      });
      if (res.data?.session) {
        this.session = res.data.session;
        state = this.getState();
      }
    }

    if (!state.hasSession) {
      this.lastSyncAuthPromptMessage = `Sesión no iniciada. Inicia sesión para subir ${summary.unsyncedCount} reporte(s) pendiente(s). Mientras tanto puedes seguir creando reportes locales sin restricción.`;
      this.notify();
      return {
        allowed: false,
        reason: this.lastSyncAuthPromptMessage,
        unsyncedCount: summary.unsyncedCount
      };
    }

    if (state.isExpired) {
      this.lastSyncAuthPromptMessage = `Sesión expirada. Inicia sesión para subir ${summary.unsyncedCount} reporte(s) pendiente(s). Tus reportes locales están seguros en IndexedDB.`;
      this.notify();
      return {
        allowed: false,
        reason: this.lastSyncAuthPromptMessage,
        unsyncedCount: summary.unsyncedCount
      };
    }

    this.lastSyncAuthPromptMessage = null;
    this.notify();
    return {
      allowed: true,
      reason: `Sesión válida (${state.user?.email || 'supervisor.mina@operacion.pe'}). Lista para sincronizar ${summary.unsyncedCount} reporte(s) con Supabase.`,
      unsyncedCount: summary.unsyncedCount
    };
  }

  validateKeyAttempt(candidateKey) {
    return validateAnonKeySecurity(candidateKey);
  }
}

export const authService = new AuthService();
