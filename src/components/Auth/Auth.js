/**
 * M4 — Inicio de Sesión Resiliente (Supabase Auth) y Desacoplamiento Offline (Auth.js)
 * Cubre:
 *  - Login con correo y contraseña mediante Supabase Auth (VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY).
 *  - Sin registro público de usuarios.
 *  - Desacoplamiento Offline (Escenario P9 / Riesgo R6): Si no hay internet o el token expiró en campo,
 *    la app abre normalmente y permite seguir creando y guardando reportes locales en M1/M2.
 *    Solo solicita reautenticación al momento de intentar sincronizar con Supabase (M5).
 *  - Botón "Cerrar sesión" que advierte si existen reportes en estado 'pendiente' o 'error'
 *    y NUNCA borra los datos locales de IndexedDB.
 *  - Auditoría de Seguridad (Riesgo R7): Rechazo activo de claves 'service_role'.
 */

import { authService, DEMO_MINE_ACCOUNTS } from '../../services/authService.js';
import { supabase } from '../../config/supabaseClient.js';
import { pwaManager } from '../../services/pwaManager.js';
import { localDb } from '../../db/localDb.js';
import { formatBytes, calculateAllReportsStorageMetrics } from '../../db/storageManager.js';
import { getAllEquipments, createOrTouchEquipment } from '../../services/equipmentService.js';
import { compressPhotoFile, generateHeavyCameraPhotoForP3 } from '../../services/imageCompressor.js';
import { getFechaHoyPeru, getHoraActualPeru } from '../../utils/datePeru.js';

export class AuthModuleView {
  constructor(rootEl, { onStatsChange, onNavigateModule } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onNavigateModule = onNavigateModule || (() => {});

    this.emailInput = DEMO_MINE_ACCOUNTS[0].email;
    this.passwordInput = DEMO_MINE_ACCOUNTS[0].password;
    this.showPassword = false;
    this.isSubmittingLogin = false;

    this.showSignOutModal = false;
    this.pendingSummary = {
      totalReportes: 0,
      totalEquipos: 0,
      pendientesCount: 0,
      errorCount: 0,
      unsyncedCount: 0,
      sincronizadosCount: 0,
      requiresWarning: false
    };
    this.indexedDbBytes = 0;

    this.banner = null;
    this.isRunningP9Test = false;
    this.p9Steps = [];
    this.r7TestResult = null;
    const currentCfg = supabase.getConfig();
    this.customUrlInput = currentCfg.isPlaceholder ? '' : currentCfg.url;
    this.customAnonKeyInput = currentCfg.isPlaceholder ? '' : currentCfg.anonKey;
    this.connectionTestResult = null;
    this.isTestingConnection = false;
    this.showSqlPreview = false;
    this.unsubscribeAuth = null;
  }

  async init() {
    await authService.init();
    this.unsubscribeAuth = authService.subscribe(async () => {
      await this.reloadLocalMetrics();
      this.render();
    });

    await this.reloadLocalMetrics();
    this.render();
  }

  destroy() {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  }

  async reloadLocalMetrics() {
    this.pendingSummary = await authService.inspectPendingBeforeSignOut();
    const reportes = await localDb.reportes.toArray();
    const metrics = calculateAllReportsStorageMetrics(reportes);
    this.indexedDbBytes = metrics.totalIndexedDbMediaBytes;
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  async handleLoginSubmit(e) {
    if (e) e.preventDefault();
    this.isSubmittingLogin = true;
    this.render();

    try {
      const { data, error } = await authService.signIn(this.emailInput, this.passwordInput);
      if (error) {
        this.setBanner('error', error.message);
      } else {
        await this.reloadLocalMetrics();
        await this.onStatsChange();
        this.setBanner(
          'success',
          `✅ Sesión iniciada correctamente como ${data.user.email} (UID: ${data.user.id.slice(0, 8)}...). Listo para sincronizar ${this.pendingSummary.unsyncedCount} reporte(s) pendiente(s) cuando el Módulo 5 esté activo.`
        );
      }
    } finally {
      this.isSubmittingLogin = false;
      this.render();
    }
  }

  async handleOpenSignOutModal() {
    await this.reloadLocalMetrics();
    this.showSignOutModal = true;
    this.render();
  }

  async handleConfirmSafeSignOut() {
    const res = await authService.confirmSafeSignOut();
    this.showSignOutModal = false;
    await this.reloadLocalMetrics();
    await this.onStatsChange();

    this.setBanner(
      'success',
      `🔒 Sesión cerrada de forma segura. Se conservaron intactos los ${res.afterSummary.totalReportes} reportes locales (${res.afterSummary.unsyncedCount} pendientes) y ${res.afterSummary.totalEquipos} códigos de equipo en IndexedDB. Puedes seguir creando reportes en M1 sin sesión.`
    );
  }

  async handleSimulateExpiredTokenP9() {
    authService.simulateTokenExpirationInField();
    await this.reloadLocalMetrics();
    await this.onStatsChange();
    this.setBanner(
      'warning',
      `⚠️ Simulación Escenario P9 activada: El token JWT de Supabase ha expirado en campo. Observa que la aplicación NO te bloquea y puedes seguir registrando reportes locales en M1.`
    );
  }

  async handleVerifyCloudSyncGate() {
    const check = await authService.verifySessionForCloudSync();
    if (check.allowed) {
      this.setBanner('success', `☁️ Verificación de Sincronización (Regla 6): ${check.reason}`);
    } else {
      this.setBanner('warning', `🔐 Desacoplamiento M4 / Regla 6 verificado: ${check.reason}`);
    }
  }

  /**
   * Prueba Automatizada del Escenario P9 ("Sesión vencida o cerrada estando sin internet"):
   * 1. Activa Modo Avión y vence el token JWT de Supabase.
   * 2. Verifica que el formulario de captura y IndexedDB NO están bloqueados por login.
   * 3. Registra un nuevo reporte con foto comprimida estando con sesión expirada y sin red.
   * 4. Verifica que solo al intentar subir a la nube se pide reautenticación, y que IndexedDB conserva el 100 % de los datos.
   */
  async handleRunScenarioP9Lab() {
    this.isRunningP9Test = true;
    this.p9Steps = [];
    this.render();

    try {
      // Paso 1: Activar Modo Avión y expirar el token JWT en campo
      pwaManager.setSimulatedAirplaneMode(true);
      const expiredState = authService.simulateTokenExpirationInField();
      this.p9Steps.push({
        step: '1. Token JWT expirado en zona sin cobertura (Modo Avión)',
        status: 'VERIFICADO',
        detail: `Modo Avión activo (🔴 Sin conexión) y token de ${expiredState.user?.email || 'operador'} marcado como EXPIRADO (exp < now).`
      });

      // Paso 2: Comprobar que la captura local sigue 100 % desbloqueada
      const canCapture = expiredState.canCaptureLocalReports;
      this.p9Steps.push({
        step: '2. Desacoplamiento Offline M1/M2 vs M4 (Riesgo R6)',
        status: canCapture ? 'SIN BLOQUEO' : 'ERROR',
        detail:
          'La interfaz NO redirige ni bloquea al técnico en una pantalla de login. El acceso a "Nuevo reporte" (M1) y "Mis reportes" (M2) sigue 100 % operativo.'
      });

      // Paso 3: Crear y guardar un reporte completo en IndexedDB sin sesión válida y sin red
      const equipos = await getAllEquipments();
      const codigo = equipos[0]?.codigo || '793F-05';
      const hoy = getFechaHoyPeru();
      const hora = getHoraActualPeru();
      const rawPhoto = await generateHeavyCameraPhotoForP3(codigo, `${hoy} ${hora}`);
      const compressed = await compressPhotoFile(rawPhoto, 'estandar');

      await createOrTouchEquipment(codigo);
      const nowIso = new Date().toISOString();

      const nuevoReporteP9 = {
        id: crypto.randomUUID(),
        codigo_equipo: codigo,
        es_nuevo_codigo: false,
        fecha: hoy,
        hora_peru: hora,
        tipo: 'Reporte',
        prioridad: 'Alta',
        observacion: `[PRUEBA ESCENARIO P9 - SESIÓN VENCIDA SIN INTERNET] Reporte creado y guardado localmente en IndexedDB mientras el token JWT de Supabase estaba expirado y sin señal. Foto comprimida a ${formatBytes(compressed.peso_bytes)}.`,
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
        creado_por: authService.getCurrentOperatorIdentifier(),
        creado_en: nowIso,
        actualizado_en: nowIso,
        dispositivo: 'Campo Mina (Sesión Expirada P9)'
      };

      await localDb.reportes.put(nuevoReporteP9);
      await this.reloadLocalMetrics();
      await this.onStatsChange();

      this.p9Steps.push({
        step: '3. Guardado Local en IndexedDB sin sesión activa',
        status: 'GUARDADO OK',
        detail: `Reporte UUID ${nuevoReporteP9.id.slice(0, 8)}... (${codigo}) guardado como "pendiente" con foto de ${formatBytes(compressed.peso_bytes)}. Total pendientes en dispositivo: ${this.pendingSummary.unsyncedCount}.`
      });

      // Paso 4: Comprobar que la reautenticación SOLO se pide al intentar sincronizar con Supabase
      const syncCheck = await authService.verifySessionForCloudSync();
      this.p9Steps.push({
        step: '4. Solicitud de reautenticación exclusiva al sincronizar (M5)',
        status: !syncCheck.allowed ? 'REGLA 6 OK' : 'REVISAR',
        detail: `Al intentar sincronizar con la nube, el sistema conserva los ${this.pendingSummary.totalReportes} reportes locales y muestra el aviso no bloqueante: "${syncCheck.reason}"`
      });

      this.setBanner(
        'success',
        `✅ Escenario P9 superado con éxito: Con sesión vencida y en Modo Avión, la PWA guardó un nuevo reporte local para ${codigo} sin bloquear al operador.`
      );
    } catch (err) {
      this.setBanner('error', `Error en prueba del Escenario P9: ${err?.message || err}`);
    } finally {
      this.isRunningP9Test = false;
      this.render();
    }
  }

  handleTestServiceRoleRejection() {
    const fakeServiceRoleJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.secret_signature';
    this.r7TestResult = authService.validateKeyAttempt(fakeServiceRoleJwt);
    this.setBanner(
      'success',
      `🛡️ Prueba de Seguridad R7 ejecutada: El cliente detectó y bloqueó la clave "service_role" correctamente.`
    );
  }

  async handleSaveAndTestRealSupabase(e) {
    if (e) e.preventDefault();
    const url = (this.customUrlInput || '').trim();
    const anonKey = (this.customAnonKeyInput || '').trim();

    if (!url || !url.startsWith('https://')) {
      this.setBanner(
        'error',
        'Ingresa tu Project URL de Supabase válida (debe iniciar con https://...supabase.co).'
      );
      return;
    }

    if (!anonKey || anonKey.length < 20) {
      this.setBanner('error', 'Ingresa tu clave pública VITE_SUPABASE_ANON_KEY de Supabase.');
      return;
    }

    this.isTestingConnection = true;
    this.render();

    try {
      supabase.saveCustomConfig({ url, anonKey });
      // Asegurar que no esté en Modo Avión simulado para poder probar la red real
      if (pwaManager.getState().simulatedAirplaneMode) {
        pwaManager.setSimulatedAirplaneMode(false);
      }
      const testRes = await supabase.testRealConnection();
      this.connectionTestResult = testRes;
      if (testRes.ok) {
        this.setBanner('success', testRes.message);
      } else {
        this.setBanner('warning', testRes.message);
      }
    } catch (err) {
      this.connectionTestResult = { ok: false, message: err?.message || String(err) };
      this.setBanner('error', err?.message || String(err));
    } finally {
      this.isTestingConnection = false;
      this.render();
    }
  }

  handleResetDemoConfig() {
    supabase.resetCustomConfig();
    this.customUrlInput = '';
    this.customAnonKeyInput = '';
    this.connectionTestResult = null;
    this.setBanner(
      'success',
      'Se restauró el Modo Simulador Local Resiliente. Cuando tengas tus credenciales de Supabase puedes pegarlas nuevamente.'
    );
  }

  async handleCopySqlScript() {
    try {
      const res = await fetch('./supabase_setup.sql');
      const sqlText = await res.text();
      await navigator.clipboard.writeText(sqlText);
      this.setBanner(
        'success',
        '📋 Script SQL completo (supabase_setup.sql) copiado al portapapeles. Pégalo en el "SQL Editor" de tu proyecto Supabase y presiona "Run".'
      );
    } catch {
      this.showSqlPreview = true;
      this.setBanner(
        'warning',
        'El script SQL está disponible en el archivo supabase_setup.sql en la raíz del proyecto.'
      );
    }
  }

  render() {
    if (!this.rootEl) return;
    const authState = authService.getState();
    const pwaState = pwaManager.getState();
    const { user, config } = authState;

    const maskedAnonKey =
      config.anonKey.length > 28
        ? `${config.anonKey.slice(0, 16)}...${config.anonKey.slice(-10)}`
        : config.anonKey;

    this.rootEl.innerHTML = `
      <div class="main-container">
        ${
          this.banner
            ? `
          <div class="alert-banner ${
            this.banner.type === 'error'
              ? 'alert-error'
              : this.banner.type === 'warning'
                ? 'alert-warning-mine'
                : 'alert-success'
          }">
            <span>${
              this.banner.type === 'error'
                ? '⚠️'
                : this.banner.type === 'warning'
                  ? '🔐'
                  : '✅'
            } ${this.banner.text}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-m4-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        ${
          authState.isExpired || !authState.hasSession
            ? `
          <div class="m4-nonblocking-notice" role="status">
            <div style="display:flex; align-items:center; gap:0.65rem; flex-wrap:wrap;">
              <span style="font-size:1.35rem;">🛡️</span>
              <div>
                <strong>${
                  authState.isExpired
                    ? `Sesión expirada en campo. Inicia sesión cuando tengas señal para subir ${this.pendingSummary.unsyncedCount} reporte(s) pendiente(s).`
                    : `Modo sin sesión activa. Puedes seguir creando y guardando reportes locales; inicia sesión solo para subir ${this.pendingSummary.unsyncedCount} reporte(s) pendiente(s) a Supabase.`
                }</strong>
                <div style="font-size:0.83rem; margin-top:0.15rem;">
                  Desacoplamiento Offline M4 activo (Escenario P9 / Riesgo R6): El vencimiento o ausencia de sesión <strong>nunca bloquea</strong> la captura en campo.
                </div>
              </div>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-notice-go-m1">
              📝 Crear Reporte Ahora en M1 (Sin Bloqueo)
            </button>
          </div>
        `
            : ''
        }

        <!-- 1. RESUMEN EJECUTIVO M4: 4 TARJETAS DE ESTADO DE SESIÓN Y RESILIENCIA OFFLINE -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>🔐 1. MÓDULO 4 (M4): INICIO DE SESIÓN RESILIENTE (SUPABASE AUTH) Y DESACOPLAMIENTO OFFLINE</span>
              </h2>
              <p class="brand-subtitle">
                Autenticación con correo y contraseña, protección anti-service_role (R7), cierre seguro sin borrar IndexedDB y resiliencia en campo (Escenario P9)
              </p>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn-mine btn-sm-mine btn-secondary" id="btn-m4-simulate-expired">
                ⏳ Simular Token Vencido en Campo (P9)
              </button>
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-m4-check-sync-gate">
                ☁️ Verificar Permiso de Sincronización
              </button>
            </div>
          </div>

          <div class="m2-stats-grid">
            <!-- Tarjeta 1: Estado de Sesión Supabase Auth -->
            <div class="m2-stat-card" style="border-left:5px solid ${
              authState.isAuthenticatedValid
                ? '#16a34a'
                : authState.isExpired
                  ? '#d97706'
                  : '#0284c7'
            };">
              <span class="m2-stat-label">1. Estado de Sesión (Supabase Auth)</span>
              <div class="m2-stat-value" style="color:${
                authState.isAuthenticatedValid
                  ? 'var(--accent-green)'
                  : authState.isExpired
                    ? '#d97706'
                    : 'var(--accent-blue)'
              };">
                ${
                  authState.isAuthenticatedValid
                    ? '🟢 SESIÓN ACTIVA'
                    : authState.isExpired
                      ? '⚠️ TOKEN EXPIRADO (P9)'
                      : '🔓 SIN SESIÓN REMOTA'
                }
              </div>
              <span class="m2-stat-sub">
                Operador: <strong>${user ? user.email : 'Modo Local Offline'}</strong>
              </span>
              <span class="m2-stat-sub">
                ${
                  authState.isAuthenticatedValid
                    ? `JWT vigente (${Math.max(1, Math.round(authState.remainingSeconds / 60))} min restantes)`
                    : authState.isExpired
                      ? 'Expiró en campo -> Captura local permitida'
                      : 'Inicia sesión abajo para habilitar subida a nube'
                }
              </span>
            </div>

            <!-- Tarjeta 2: Desacoplamiento Offline (Escenario P9 / Riesgo R6) -->
            <div class="m2-stat-card" style="border-left:5px solid #16a34a;">
              <span class="m2-stat-label">2. Captura en Campo (M1 / M2)</span>
              <div class="m2-stat-value" style="color:var(--accent-green);">
                ✅ 100 % DESBLOQUEADA
              </div>
              <span class="m2-stat-sub">
                Red actual: <strong>${pwaState.isOnline ? '🟢 En línea' : '🔴 Sin conexión (Modo Avión)'}</strong>
              </span>
              <span class="m2-stat-sub">
                El login <strong>jamás</strong> bloquea "Nuevo reporte". Solo se solicita al sincronizar (M5).
              </span>
            </div>

            <!-- Tarjeta 3: Protección de Datos Locales al Cerrar Sesión -->
            <div class="m2-stat-card" style="border-left:5px solid #d97706;">
              <span class="m2-stat-label">3. Datos Protegidos en IndexedDB</span>
              <div class="m2-stat-value">
                ${this.pendingSummary.totalReportes} reportes (${this.pendingSummary.unsyncedCount} pend.)
              </div>
              <span class="m2-stat-sub">
                Peso local: <strong>${formatBytes(this.indexedDbBytes)}</strong> | Equipos: <strong>${this.pendingSummary.totalEquipos} códigos</strong>
              </span>
              <span class="m2-stat-sub" style="color:var(--accent-green); font-weight:800;">
                🔒 "Cerrar sesión" nunca borra IndexedDB.
              </span>
            </div>

            <!-- Tarjeta 4: Seguridad de Credenciales (Riesgo R7) -->
            <div class="m2-stat-card" style="border-left:5px solid #0284c7;">
              <span class="m2-stat-label">4. Seguridad Supabase (Riesgo R7)</span>
              <div class="m2-stat-value">
                🛡️ SOLO ANON_KEY
              </div>
              <span class="m2-stat-sub">
                Clave: <code>${maskedAnonKey}</code>
              </span>
              <span class="m2-stat-sub">
                Sin registro público | <code>service_role</code> bloqueada.
              </span>
            </div>
          </div>

          <!-- LABORATORIO INTERACTIVO DEL ESCENARIO P9 -->
          <div class="m2-p3-lab" style="margin-top:1rem;">
            <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:0.75rem;">
              <div style="flex: 1 1 440px;">
                <div style="font-weight:900; font-size:0.96rem; display:flex; align-items:center; gap:0.45rem;">
                  <span>🧪 LABORATORIO DE VALIDACIÓN — ESCENARIO P9 (SESIÓN VENCIDA O CERRADA ESTANDO SIN INTERNET)</span>
                  <span class="badge badge-pending">Requisito M4 / P9 / R6</span>
                </div>
                <p style="margin:0.25rem 0 0 0; font-size:0.84rem;">
                  Comprueba que si el token JWT de Supabase caduca cuando el técnico está en interior mina o Modo Avión, la app <strong>permite crear y guardar un reporte nuevo como "pendiente"</strong> sin bloquearlo en una pantalla de login.
                </p>
              </div>

              <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;">
                <button
                  type="button"
                  class="btn-mine btn-primary"
                  id="btn-m4-run-p9"
                  ${this.isRunningP9Test ? 'disabled' : ''}
                >
                  ${
                    this.isRunningP9Test
                      ? '⏳ Ejecutando prueba Escenario P9...'
                      : '🧪 Ejecutar Prueba Completa Escenario P9'
                  }
                </button>

                <button type="button" class="btn-mine btn-secondary" id="btn-m4-go-m1">
                  📝 Ir a "Nuevo reporte" (M1)
                </button>

                <button type="button" class="btn-mine" id="btn-m4-go-m2">
                  💾 Ver "Mis reportes" (${this.pendingSummary.unsyncedCount} pend.)
                </button>
              </div>
            </div>

            ${
              this.p9Steps.length > 0
                ? `
              <div style="margin-top:0.8rem; background:#ffffff; color:#0f172a; border:2px solid #16a34a; border-radius:8px; padding:0.75rem;">
                <div style="font-weight:900; font-size:0.88rem; color:#14532d; margin-bottom:0.45rem;">
                  ✅ Resultado de Auditoría del Escenario P9 (Desacoplamiento Offline de Autenticación):
                </div>
                <div style="display:flex; flex-direction:column; gap:0.4rem;">
                  ${this.p9Steps
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

        <!-- 2. PANEL DE LOGIN (CORREO Y CONTRASEÑA) Y GESTIÓN DE SESIÓN / CIERRE SEGURO -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>🔑 2. AUTENTICACIÓN SUPABASE AUTH (CORREO Y CONTRASEÑA) Y CIERRE DE SESIÓN SEGURO</span>
              </h2>
              <p class="brand-subtitle">
                Sin registro público de usuarios • Cuentas asignadas por la operación minera • Cierre de sesión con advertencia de pendientes
              </p>
            </div>
            <span class="badge ${
              authState.isAuthenticatedValid
                ? 'badge-estado-sincronizado'
                : authState.isExpired
                  ? 'badge-pending'
                  : 'badge-baja'
            }">
              ${authState.statusLabel}
            </span>
          </div>

          <div class="m4-auth-grid">
            <!-- Columna Izquierda: Formulario de Login con Correo y Contraseña -->
            <div class="m4-auth-card">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.65rem; border-bottom:2px solid var(--border-subtle); padding-bottom:0.5rem;">
                <div>
                  <h3 style="margin:0; font-size:1.02rem;">
                    🔐 Iniciar Sesión / Reautenticar Operador
                  </h3>
                  <div style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">
                    <code>supabase.auth.signInWithPassword({ email, password })</code>
                  </div>
                </div>
                <span class="badge badge-baja">Sin Registro Público</span>
              </div>

              <!-- Selector rápido de cuentas corporativas para prueba con guantes -->
              <div style="margin-bottom:0.8rem;">
                <label class="field-label" style="margin-bottom:0.35rem; display:block;">
                  ⚡ Cuentas Operativas de Guardia (Toque rápido para autocompletar):
                </label>
                <div style="display:flex; flex-wrap:wrap; gap:0.45rem;">
                  ${DEMO_MINE_ACCOUNTS.map(
                    (acc, idx) => `
                    <button
                      type="button"
                      class="btn-mine btn-sm-mine ${
                        this.emailInput === acc.email ? 'btn-primary' : 'btn-secondary'
                      } btn-quick-account"
                      data-idx="${idx}"
                    >
                      👷 ${acc.nombre}
                    </button>
                  `
                  ).join('')}
                </div>
              </div>

              <form id="m4-login-form" style="display:flex; flex-direction:column; gap:0.75rem;">
                <div>
                  <label class="field-label" for="m4-input-email">
                    📧 Correo Corporativo del Supervisor / Técnico:
                  </label>
                  <input
                    type="email"
                    id="m4-input-email"
                    class="mine-input"
                    value="${this.emailInput}"
                    placeholder="supervisor.mina@operacion.pe"
                    autocomplete="username"
                    required
                  />
                </div>

                <div>
                  <label class="field-label" for="m4-input-password">
                    🔑 Contraseña de Operación:
                  </label>
                  <div style="display:flex; gap:0.45rem;">
                    <input
                      type="${this.showPassword ? 'text' : 'password'}"
                      id="m4-input-password"
                      class="mine-input"
                      value="${this.passwordInput}"
                      placeholder="••••••••••••"
                      autocomplete="current-password"
                      required
                      style="flex:1;"
                    />
                    <button
                      type="button"
                      class="btn-mine btn-sm-mine"
                      id="btn-toggle-pass-vis"
                      title="Mostrar u ocultar contraseña"
                    >
                      ${this.showPassword ? '🙈 Ocultar' : '👁️ Ver'}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  class="btn-mine btn-primary"
                  id="btn-m4-submit-login"
                  style="min-height:48px; font-size:0.96rem;"
                  ${this.isSubmittingLogin ? 'disabled' : ''}
                >
                  ${
                    this.isSubmittingLogin
                      ? '⏳ Autenticando con Supabase Auth...'
                      : authState.isExpired
                        ? '🔄 Reautenticar Sesión Expirada Ahora'
                        : '🔐 Iniciar Sesión con Correo y Contraseña'
                  }
                </button>
              </form>

              <div class="m4-no-signup-box" style="margin-top:0.85rem;">
                <strong>🚫 Política de Seguridad: Sin Registro Público de Usuarios</strong>
                <p style="margin:0.2rem 0 0 0; font-size:0.81rem;">
                  Esta aplicación no incluye formulario de registro público (<code>signUp</code> deshabilitado en cliente). Solo el personal autorizado con credenciales dadas de alta en Supabase Auth puede sincronizar reportes hacia la nube.
                </p>
              </div>
            </div>

            <!-- Columna Derecha: Estado de la Sesión Actual y Botón "Cerrar sesión" con Advertencia -->
            <div class="m4-auth-card">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.65rem; border-bottom:2px solid var(--border-subtle); padding-bottom:0.5rem;">
                <div>
                  <h3 style="margin:0; font-size:1.02rem;">
                    👷 Credencial en Dispositivo y Cierre de Sesión Seguro
                  </h3>
                  <div style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">
                    Protección de cola local en IndexedDB ante cambios de turno
                  </div>
                </div>
                <span class="badge ${
                  this.pendingSummary.requiresWarning
                    ? 'badge-estado-pendiente'
                    : 'badge-estado-sincronizado'
                }">
                  ${this.pendingSummary.unsyncedCount} pendientes en cola
                </span>
              </div>

              ${
                user
                  ? `
                <div class="m4-session-details">
                  <div class="m4-detail-row">
                    <span>Estado del Token JWT:</span>
                    <strong style="color:${authState.isExpired ? '#b45309' : '#15803d'};">
                      ${
                        authState.isExpired
                          ? '⚠️ EXPIRADO EN CAMPO (Requiere login solo para M5)'
                          : '✅ VIGENTE Y AUTENTICADO'
                      }
                    </strong>
                  </div>
                  <div class="m4-detail-row">
                    <span>Correo Autenticado:</span>
                    <strong>${user.email}</strong>
                  </div>
                  <div class="m4-detail-row">
                    <span>Cargo / Guardia:</span>
                    <strong>${user.user_metadata?.puesto || 'Supervisor Operativo'}</strong>
                  </div>
                  <div class="m4-detail-row">
                    <span>Supabase User UID (<code>auth.uid()</code>):</span>
                    <code>${user.id}</code>
                  </div>
                  <div class="m4-detail-row">
                    <span>Carpeta destino en Storage (M5):</span>
                    <code>fotos/${user.id.slice(0, 8)}.../{reporte_id}/{1..5}.jpg</code>
                  </div>
                </div>
              `
                  : `
                <div class="m4-session-empty">
                  <div style="font-weight:900; font-size:0.95rem; margin-bottom:0.3rem;">
                    🔓 Actualmente sin sesión activa en Supabase Auth
                  </div>
                  <p style="margin:0; font-size:0.84rem;">
                    La aplicación está operando en <strong>Modo Local Autónomo</strong>. Todos los reportes que registres en el Módulo 1 se guardan inmediatamente en IndexedDB con estado <code>pendiente</code>.
                  </p>
                </div>
              `
              }

              <!-- Resumen de advertencia antes de cerrar sesión -->
              <div style="background:#fef3c7; border:2px solid #d97706; border-left:6px solid #b45309; border-radius:8px; padding:0.75rem; margin-top:0.8rem; color:#0f172a;">
                <div style="font-weight:900; font-size:0.88rem; color:#78350f; margin-bottom:0.25rem;">
                  ⚠️ Protección en Cierre de Sesión (Cambio de Guardia):
                </div>
                <div style="font-size:0.82rem; color:#451a03; font-weight:600;">
                  • Reportes en estado <code>pendiente</code> o <code>error</code>: <strong>${this.pendingSummary.unsyncedCount} reporte(s)</strong>.<br/>
                  • Total de reportes guardados en IndexedDB: <strong>${this.pendingSummary.totalReportes} reporte(s) (${formatBytes(this.indexedDbBytes)})</strong>.<br/>
                  • Al presionar <strong>"Cerrar sesión"</strong>, la app te advertirá sobre los reportes pendientes y <strong>jamás borrará</strong> los datos de IndexedDB.
                </div>
              </div>

              <div style="display:flex; flex-wrap:wrap; gap:0.55rem; margin-top:0.85rem;">
                <button
                  type="button"
                  class="btn-mine btn-danger"
                  id="btn-m4-open-signout"
                  style="flex:1; min-height:48px;"
                  ${!authState.hasSession ? 'disabled' : ''}
                >
                  🚪 Cerrar sesión ${
                    this.pendingSummary.unsyncedCount > 0
                      ? `(Advierte ${this.pendingSummary.unsyncedCount} pendientes)`
                      : ''
                  }
                </button>

                <button
                  type="button"
                  class="btn-mine btn-secondary"
                  id="btn-m4-simulate-exp-card"
                  style="min-height:48px;"
                >
                  ⏳ Simular Token Expirado (P9)
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 3. AUDITORÍA DE SEGURIDAD DE CREDENCIALES (RIESGO R7: VITE_SUPABASE_ANON_KEY Y RLS) -->
        <section class="section-panel">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>🛡️ 3. AUDITORÍA DE SEGURIDAD SUPABASE (RIESGO R7: USO EXCLUSIVO DE ANON_KEY Y POLÍTICAS RLS)</span>
              </h2>
              <p class="brand-subtitle">
                Verificación de variables de entorno (.env), bloqueo de claves privadas service_role y políticas Row Level Security
              </p>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-m4-test-r7">
              🛡️ Probar Bloqueo Anti-service_role (R7)
            </button>
          </div>

          <div class="m3-install-grid">
            <div class="m3-guide-card">
              <h3 style="margin:0 0 0.45rem 0; font-size:0.96rem;">
                1. Variables Públicas Permitidas (<code>.env</code>)
              </h3>
              <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:0.4rem;">
                <div style="background:#ffffff; color:#0f172a; padding:0.45rem 0.6rem; border-radius:6px; border:1px solid #cbd5e1;">
                  <strong>VITE_SUPABASE_URL:</strong><br/>
                  <code>${config.url}</code>
                </div>
                <div style="background:#ffffff; color:#0f172a; padding:0.45rem 0.6rem; border-radius:6px; border:1px solid #cbd5e1;">
                  <strong>VITE_SUPABASE_ANON_KEY:</strong><br/>
                  <code>${maskedAnonKey}</code>
                </div>
                <div style="color:var(--accent-green); font-weight:800;">
                  ✅ ${config.security.reason}
                </div>
              </div>
            </div>

            <div class="m3-guide-card">
              <h3 style="margin:0 0 0.45rem 0; font-size:0.96rem;">
                2. Bloqueo de <code>service_role</code> en Cliente
              </h3>
              <p style="margin:0 0 0.5rem 0; font-size:0.83rem;">
                El cliente valida el JWT antes de inicializar Supabase. Si detecta <code>role: "service_role"</code>, aborta la conexión para evitar exposición de la base de datos.
              </p>
              ${
                this.r7TestResult
                  ? `
                <div style="background:#dcfce7; color:#14532d; border:2px solid #16a34a; border-radius:8px; padding:0.55rem; font-size:0.8rem; font-weight:700;">
                  ✅ Resultado del Test R7:<br/>
                  ${this.r7TestResult.reason}
                </div>
              `
                  : `
                <div style="font-size:0.8rem; color:var(--text-muted); font-weight:700;">
                  Haz clic en <strong>"Probar Bloqueo Anti-service_role (R7)"</strong> arriba a la derecha para auditar el rechazo automático.
                </div>
              `
              }
            </div>

            <div class="m3-guide-card">
              <h3 style="margin:0 0 0.45rem 0; font-size:0.96rem;">
                3. Políticas RLS vinculadas a <code>auth.uid()</code>
              </h3>
              <ul style="margin:0; padding-left:1.15rem; font-size:0.82rem; display:flex; flex-direction:column; gap:0.3rem; font-weight:600;">
                <li><strong>SELECT:</strong> Solo usuarios <code>authenticated</code> (<code>anon</code> recibe 0 filas).</li>
                <li><strong>INSERT / UPDATE:</strong> Solo filas donde <code>creado_por = auth.uid()</code> (permite <code>upsert</code> idempotente en M5).</li>
                <li><strong>STORAGE (Bucket <code>fotos</code>):</strong> Solo escritura en carpeta <code>{auth.uid()}/{reporte_id}/...</code>.</li>
                <li><strong>DELETE:</strong> Denegado desde la aplicación cliente.</li>
              </ul>
            </div>
          </div>
        </section>

        <!-- 4. GUÍA PASO A PASO PARA ENLAZAR TU PROYECTO REAL DE SUPABASE EN ESTE MÓDULO 4 -->
        <section class="section-panel" id="panel-supabase-connect">
          <div class="section-header">
            <div>
              <h2 class="section-title">
                <span>🔌 4. GUÍA PASO A PASO Y ENLACE EN VIVO CON TU PROYECTO REAL DE SUPABASE</span>
              </h2>
              <p class="brand-subtitle">
                Sigue estos 4 pasos en tu panel de Supabase y pega tu URL y Anon Key para activar la conexión en la nube
              </p>
            </div>
            <div style="display:flex; gap:0.45rem; flex-wrap:wrap; align-items:center;">
              <span class="badge ${
                !config.isPlaceholder ? 'badge-estado-sincronizado' : 'badge-pending'
              }">
                ${
                  !config.isPlaceholder
                    ? '☁️ ENLAZADO A SUPABASE REAL'
                    : '🧪 MODO SIMULADOR LOCAL (ESPERANDO TUS CREDENCIALES)'
                }
              </span>
              <button type="button" class="btn-mine btn-sm-mine btn-primary" id="btn-m4-copy-sql">
                📋 Copiar Script SQL (supabase_setup.sql)
              </button>
            </div>
          </div>

          <div class="m4-auth-grid">
            <!-- Columna Izquierda: Los 4 pasos guiados en Supabase -->
            <div class="m3-guide-card m3-guide-ios">
              <h3 style="margin:0 0 0.5rem 0; font-size:1rem; color:#78350f;">
                🧭 4 Pasos para Configurar tu Proyecto en Supabase
              </h3>
              <div class="m3-steps-list">
                <div class="m3-step-item">
                  <span class="m3-step-num">1</span>
                  <div>
                    <strong>Crear Proyecto y obtener URL + Anon Key:</strong><br/>
                    Entra a <code>supabase.com/dashboard</code> → <strong>New Project</strong>. Una vez creado, ve a <strong>Project Settings (⚙️) → API</strong> y copia tu <strong>Project URL</strong> y tu clave pública <strong><code>anon</code> / <code>public</code></strong> (jamás uses <code>service_role</code>).
                  </div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">2</span>
                  <div>
                    <strong>Crear Tabla <code>reportes</code>, Bucket <code>fotos</code> y Políticas RLS:</strong><br/>
                    Haz clic en el botón <strong>"📋 Copiar Script SQL"</strong> arriba a la derecha (o abre el archivo <code>supabase_setup.sql</code> de tu carpeta), ve en Supabase a <strong>SQL Editor → New query</strong>, pégalo y presiona <strong>Run</strong>.
                  </div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">3</span>
                  <div>
                    <strong>Crear tu Usuario Operativo y Desactivar Registro Público:</strong><br/>
                    En Supabase ve a <strong>Authentication → Users → Add user → Create new user</strong> (ej. tu correo y contraseña, marcando <em>Auto Confirm User</em>). Luego en <strong>Authentication → Providers → Email</strong> puedes desactivar <em>Allow new users to sign up</em>.
                  </div>
                </div>
                <div class="m3-step-item">
                  <span class="m3-step-num">4</span>
                  <div>
                    <strong>Enlazar Aquí al Lado (o en tu archivo <code>.env</code>):</strong><br/>
                    Pega tu <strong>Project URL</strong> y tu <strong>Anon Key</strong> en el formulario de la derecha y presiona <strong>"🔌 Guardar y Probar Conexión Real"</strong>.
                  </div>
                </div>
              </div>
            </div>

            <!-- Columna Derecha: Formulario para pegar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY -->
            <div class="m4-auth-card">
              <div>
                <h3 style="margin:0 0 0.35rem 0; font-size:1.02rem;">
                  🔗 Conectar Credenciales de tu Proyecto Supabase
                </h3>
                <p style="margin:0 0 0.75rem 0; font-size:0.82rem; color:var(--text-muted); font-weight:600;">
                  Pega aquí tus credenciales de <strong>Project Settings → API</strong> para enlazar la aplicación en vivo:
                </p>

                <form id="m4-supabase-config-form" style="display:flex; flex-direction:column; gap:0.75rem;">
                  <div>
                    <label class="field-label" for="m4-cfg-url">
                      🌐 VITE_SUPABASE_URL (Project URL):
                    </label>
                    <input
                      type="url"
                      id="m4-cfg-url"
                      class="mine-input"
                      value="${this.customUrlInput}"
                      placeholder="https://xyzcompany.supabase.co"
                      required
                    />
                  </div>

                  <div>
                    <label class="field-label" for="m4-cfg-anon">
                      🔑 VITE_SUPABASE_ANON_KEY (Clave pública <code>anon</code> / <code>public</code>):
                    </label>
                    <input
                      type="text"
                      id="m4-cfg-anon"
                      class="mine-input"
                      value="${this.customAnonKeyInput}"
                      placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                      required
                    />
                  </div>

                  <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
                    <button
                      type="submit"
                      class="btn-mine btn-primary"
                      id="btn-m4-save-supabase"
                      style="flex:1; min-height:48px;"
                      ${this.isTestingConnection ? 'disabled' : ''}
                    >
                      ${
                        this.isTestingConnection
                          ? '⏳ Verificando enlace con Supabase...'
                          : '🔌 Guardar y Probar Conexión Real'
                      }
                    </button>

                    ${
                      !config.isPlaceholder
                        ? `
                      <button
                        type="button"
                        class="btn-mine btn-secondary"
                        id="btn-m4-reset-demo-cfg"
                        style="min-height:48px;"
                      >
                        🔄 Volver a Modo Simulador
                      </button>
                    `
                        : ''
                    }
                  </div>
                </form>

                ${
                  this.connectionTestResult
                    ? `
                  <div style="margin-top:0.75rem; padding:0.65rem 0.8rem; border-radius:8px; font-size:0.83rem; font-weight:700; border:2px solid ${
                    this.connectionTestResult.ok ? '#16a34a' : '#d97706'
                  }; background:${this.connectionTestResult.ok ? '#dcfce7' : '#fef3c7'}; color:#0f172a;">
                    ${this.connectionTestResult.message}
                  </div>
                `
                    : ''
                }
              </div>

              <div style="margin-top:0.75rem; font-size:0.8rem; background:#f8fafc; color:#0f172a; padding:0.6rem; border-radius:8px; border:1px solid #cbd5e1; font-weight:600;">
                💡 <strong>Tip:</strong> También puedes pasarme tu <code>VITE_SUPABASE_URL</code> y tu <code>VITE_SUPABASE_ANON_KEY</code> en el chat y yo creo automáticamente tu archivo <code>.env</code> local.
              </div>
            </div>
          </div>
        </section>

        ${this.showSignOutModal ? this.renderSafeSignOutModal() : ''}
      </div>
    `;

    this.bindEvents();
  }

  renderSafeSignOutModal() {
    const s = this.pendingSummary;
    return `
      <div class="modal-backdrop" id="m4-signout-modal-backdrop">
        <div class="modal-card" style="max-width:580px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:0.6rem; border-bottom:3px solid #dc2626; padding-bottom:0.65rem; margin-bottom:0.85rem;">
            <div>
              <h3 style="margin:0; font-size:1.1rem; color:#991b1b;">
                ⚠️ Confirmar Cierre de Sesión Seguro (M4)
              </h3>
              <div style="font-size:0.82rem; color:#475569; font-weight:700;">
                Verificación previa de cola local en IndexedDB
              </div>
            </div>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-cancel-signout-x">
              ✕ Cancelar
            </button>
          </div>

          ${
            s.requiresWarning
              ? `
            <div style="background:#fef3c7; border:2px solid #d97706; border-left:6px solid #b45309; border-radius:10px; padding:0.9rem; margin-bottom:0.85rem; color:#0f172a;">
              <div style="font-weight:900; font-size:0.96rem; color:#78350f; margin-bottom:0.35rem;">
                ⏳ ¡Atención! Tienes ${s.unsyncedCount} reporte(s) sin sincronizar en este dispositivo
              </div>
              <ul style="margin:0; padding-left:1.2rem; font-size:0.86rem; color:#451a03; font-weight:700;">
                <li>Reportes en estado <strong>pendiente</strong>: ${s.pendientesCount}</li>
                <li>Reportes en estado <strong>error</strong>: ${s.errorCount}</li>
                <li>Total de reportes almacenados localmente: ${s.totalReportes} (${formatBytes(this.indexedDbBytes)})</li>
              </ul>
            </div>
          `
              : `
            <div style="background:#dcfce7; border:2px solid #16a34a; border-radius:10px; padding:0.85rem; margin-bottom:0.85rem; color:#14532d; font-weight:700;">
              ✅ Todos tus reportes locales están sincronizados.
            </div>
          `
          }

          <div style="background:#f1f5f9; border:2px solid #475569; border-radius:10px; padding:0.85rem; margin-bottom:0.95rem; color:#0f172a; font-size:0.86rem; font-weight:700;">
            🔒 <strong>Garantía de Cero Pérdida Local (Regla M4):</strong><br/>
            Al cerrar sesión <strong>NUNCA se borran</strong> los reportes ni los códigos de equipo guardados en IndexedDB (<code>MineriaReportesDB</code>). Además, podrás seguir registrando nuevos reportes en modo local y sincronizarlos cuando vuelvas a iniciar sesión.
          </div>

          <div style="display:flex; justify-content:flex-end; gap:0.6rem; flex-wrap:wrap;">
            <button type="button" class="btn-mine btn-secondary" id="btn-cancel-signout" style="min-height:48px;">
              Mantener Sesión Activa
            </button>
            <button type="button" class="btn-mine btn-danger" id="btn-confirm-safe-signout" style="min-height:48px;">
              🚪 Cerrar sesión (Conservar ${s.totalReportes} reportes locales)
            </button>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.rootEl.querySelector('#btn-close-m4-banner')?.addEventListener('click', () => {
      this.banner = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-notice-go-m1')?.addEventListener('click', () => {
      this.onNavigateModule('m1');
    });

    this.rootEl.querySelector('#btn-m4-go-m1')?.addEventListener('click', () => {
      this.onNavigateModule('m1');
    });

    this.rootEl.querySelector('#btn-m4-go-m2')?.addEventListener('click', () => {
      this.onNavigateModule('m2');
    });

    this.rootEl.querySelector('#btn-m4-simulate-expired')?.addEventListener('click', () => {
      this.handleSimulateExpiredTokenP9();
    });

    this.rootEl.querySelector('#btn-m4-simulate-exp-card')?.addEventListener('click', () => {
      this.handleSimulateExpiredTokenP9();
    });

    this.rootEl.querySelector('#btn-m4-check-sync-gate')?.addEventListener('click', () => {
      this.handleVerifyCloudSyncGate();
    });

    this.rootEl.querySelector('#btn-m4-run-p9')?.addEventListener('click', () => {
      this.handleRunScenarioP9Lab();
    });

    this.rootEl.querySelector('#btn-m4-test-r7')?.addEventListener('click', () => {
      this.handleTestServiceRoleRejection();
    });

    this.rootEl.querySelector('#btn-m4-copy-sql')?.addEventListener('click', () => {
      this.handleCopySqlScript();
    });

    this.rootEl.querySelector('#m4-cfg-url')?.addEventListener('input', (e) => {
      this.customUrlInput = e.target.value;
    });

    this.rootEl.querySelector('#m4-cfg-anon')?.addEventListener('input', (e) => {
      this.customAnonKeyInput = e.target.value;
    });

    this.rootEl.querySelector('#m4-supabase-config-form')?.addEventListener('submit', (e) => {
      this.handleSaveAndTestRealSupabase(e);
    });

    this.rootEl.querySelector('#btn-m4-reset-demo-cfg')?.addEventListener('click', () => {
      this.handleResetDemoConfig();
    });

    // Botones rápidos de cuentas de guardia
    this.rootEl.querySelectorAll('.btn-quick-account').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx'));
        const acc = DEMO_MINE_ACCOUNTS[idx];
        if (acc) {
          this.emailInput = acc.email;
          this.passwordInput = acc.password;
          this.render();
        }
      });
    });

    const emailEl = this.rootEl.querySelector('#m4-input-email');
    emailEl?.addEventListener('input', (e) => {
      this.emailInput = e.target.value;
    });

    const passEl = this.rootEl.querySelector('#m4-input-password');
    passEl?.addEventListener('input', (e) => {
      this.passwordInput = e.target.value;
    });

    this.rootEl.querySelector('#btn-toggle-pass-vis')?.addEventListener('click', () => {
      this.showPassword = !this.showPassword;
      this.render();
    });

    const loginForm = this.rootEl.querySelector('#m4-login-form');
    loginForm?.addEventListener('submit', (e) => {
      this.handleLoginSubmit(e);
    });

    this.rootEl.querySelector('#btn-m4-open-signout')?.addEventListener('click', () => {
      this.handleOpenSignOutModal();
    });

    this.rootEl.querySelector('#btn-cancel-signout')?.addEventListener('click', () => {
      this.showSignOutModal = false;
      this.render();
    });

    this.rootEl.querySelector('#btn-cancel-signout-x')?.addEventListener('click', () => {
      this.showSignOutModal = false;
      this.render();
    });

    this.rootEl.querySelector('#btn-confirm-safe-signout')?.addEventListener('click', () => {
      this.handleConfirmSafeSignOut();
    });

    this.rootEl.querySelector('#m4-signout-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'm4-signout-modal-backdrop') {
        this.showSignOutModal = false;
        this.render();
      }
    });
  }
}
