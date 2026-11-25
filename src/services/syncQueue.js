/**
 * M5 — Motor y Cola de Sincronización Secuencial e Idempotente (syncQueue.js)
 * Implementa las Reglas Obligatorias 1, 2, 3, 4 y 6 (Sección 6 del Plan de Arquitectura):
 *  1. Candado de concurrencia (Mutex `isSyncing`) que impide dos ejecuciones simultáneas (Escenario P8).
 *  2. Recuperación automática al iniciar de registros que quedaron en `'sincronizando'` tras un cierre abrupto.
 *  3. Verificación de internet real (`connectivity.js` con `AbortController` de 8 s) sin confiar en `navigator.onLine`.
 *  4. Validación de sesión de Supabase Auth (`authService.verifySessionForCloudSync()`) sin bloquear la captura local (Regla 6 / P9).
 *  5. Subida estricta en DOS FASES por reporte (del más antiguo al más reciente):
 *     - FASE 1 (Multimedia primero): Fotos (1..5) y video opcional al bucket privado `fotos` en `{user_id}/{id}/{n}.jpg` con `{ upsert: true }`.
 *     - FASE 2 (Registro después): Solo si el 100 % del multimedia subió sin error, `upsert` en `public.reportes` por `id` UUID (`{ onConflict: 'id' }`).
 *     - FASE 3 (Confirmación): Solo si Fase 1 y Fase 2 tuvieron éxito, el estado en IndexedDB pasa a `'sincronizado'`.
 *  6. Reintentos con Exponential Backoff (`30 s`, `2 min`, `10 min`) y mensajes de error claros en español.
 *  7. Cuatro disparadores automáticos: Al abrir/volver a primer plano (`visibilitychange`), al recuperar red (`online`), cada 2 minutos y botón manual `"Sincronizar ahora"`.
 */

import { localDb } from '../db/localDb.js';
import { supabase } from '../config/supabaseClient.js';
import { authService } from './authService.js';
import { pwaManager } from './pwaManager.js';
import { connectivityService, DEFAULT_PING_TIMEOUT_MS } from './connectivity.js';
import {
  packVideoAudioField,
  unpackVideoAudioField,
  getAudioExtensionFromMime
} from '../utils/audioMedia.js';

// Escalera oficial de Exponential Backoff (M5): 30 s -> 2 min -> 10 min
export const BACKOFF_SCHEDULE = [
  { attempt: 1, seconds: 30, ms: 30 * 1000, label: '30 s' },
  { attempt: 2, seconds: 120, ms: 120 * 1000, label: '2 min' },
  { attempt: 3, seconds: 600, ms: 600 * 1000, label: '10 min' }
];

export const PERIODIC_SYNC_INTERVAL_MS = 2 * 60 * 1000; // Cada 2 minutos

export function getBackoffInfoForAttempt(attemptCount) {
  const idx = Math.max(0, Math.min(BACKOFF_SCHEDULE.length - 1, (attemptCount || 1) - 1));
  return BACKOFF_SCHEDULE[idx];
}

/**
 * Traduce cualquier error técnico o de red a un mensaje claro en español para el operador en mina.
 */
export function translateSyncErrorToSpanish(rawError, contextLabel = '') {
  const msg = String(rawError?.message || rawError || '').trim();
  const lower = msg.toLowerCase();

  if (lower.includes('tiempo de espera agotado') || lower.includes('abort') || lower.includes('timeout')) {
    return contextLabel
      ? `Tiempo de espera agotado (8 s) al ${contextLabel}. La red no tiene salida real al servidor Supabase.`
      : 'Tiempo de espera agotado (8 s): Sin respuesta del servidor Supabase (posible "Lie-Fi" o red sin internet).';
  }
  if (lower.includes('corte') || lower.includes('modo avión') || lower.includes('offline') || lower.includes('network') || lower.includes('fetch')) {
    return contextLabel
      ? `Corte abrupto de señal durante ${contextLabel}. Se reintentará automáticamente con backoff.`
      : 'Sin conexión con el servidor Supabase. Los reportes permanecen seguros en la cola local.';
  }
  if (lower.includes('rls') || lower.includes('auth.uid')) {
    return `Política de seguridad RLS en Supabase: ${msg}`;
  }
  if (lower.includes('sesión') || lower.includes('jwt') || lower.includes('token') || lower.includes('401')) {
    return 'Sesión expirada o no iniciada. Inicia sesión en M4 para subir los reportes pendientes.';
  }
  if (msg) {
    return contextLabel ? `Error en ${contextLabel}: ${msg}` : msg;
  }
  return 'Fallo temporal de comunicación con el servidor. Programando reintento automático.';
}

class SyncQueueService {
  constructor() {
    // Candado de exclusión mutua (Mutex)
    this.isSyncing = false;
    this.mutexCollisionsBlocked = 0;

    // Estado en vivo del motor para la UI de M5
    this.currentReportId = null;
    this.currentPhase = 'IDLE'; // 'IDLE' | 'CHECKING_NET' | 'CHECKING_AUTH' | 'PHASE_1_STORAGE' | 'PHASE_2_POSTGRES' | 'PHASE_3_CONFIRM'
    this.currentStepDetail = 'Motor de sincronización en espera';
    this.lastRunAt = null;
    this.lastTriggerSource = 'Ninguno';
    this.lastRunSummary = null;
    this.periodicTimer = null;
    this.backoffTimers = new Map();
    this.initialized = false;
    this.wasOnline = true;
    this.suppressAutoReconnectTrigger = false;
    this.forcedFailNextReportId = null; // Permite probar el backoff 30s/2min/10min en un reporte específico

    this.activityLogs = [];
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.getState();
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch {
        // ignore listener error
      }
    }
  }

  addLog(level, title, detail = '') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('es-PE', {
      timeZone: 'America/Lima',
      hour12: false
    });
    this.activityLogs.unshift({
      id: crypto.randomUUID(),
      time: timeStr,
      level, // 'info' | 'success' | 'warning' | 'error' | 'mutex'
      title,
      detail
    });
    if (this.activityLogs.length > 60) {
      this.activityLogs = this.activityLogs.slice(0, 60);
    }
    this.notify();
  }

  getState() {
    return {
      isSyncing: this.isSyncing,
      mutexCollisionsBlocked: this.mutexCollisionsBlocked,
      currentReportId: this.currentReportId,
      currentPhase: this.currentPhase,
      currentStepDetail: this.currentStepDetail,
      lastRunAt: this.lastRunAt,
      lastTriggerSource: this.lastTriggerSource,
      lastRunSummary: this.lastRunSummary,
      periodicIntervalSeconds: PERIODIC_SYNC_INTERVAL_MS / 1000,
      activeBackoffTimersCount: this.backoffTimers.size,
      forcedFailNextReportId: this.forcedFailNextReportId,
      connectivity: connectivityService.getState(),
      cloudSnapshot: supabase.getCloudSnapshot(),
      activityLogs: this.activityLogs
    };
  }

  /**
   * Inicializa el motor M5:
   * 1. Recupera cualquier reporte que haya quedado en `'sincronizando'` tras un cierre abrupto (Sección 6.2).
   * 2. Registra los 4 disparadores automáticos de la cola (Sección 6.1).
   */
  async init() {
    if (this.initialized) return this.getState();
    this.initialized = true;

    await this.recoverInterruptedSyncs();

    this.wasOnline = pwaManager.getState().isOnline;

    // Disparador 1: Cuando la app vuelve a primer plano (visibilitychange -> visible / pageshow en iOS y Android)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.addLog(
            'info',
            'Disparador #1: App en primer plano (visibilitychange -> visible)',
            'Verificando si existen reportes pendientes para sincronizar automáticamente.'
          );
          this.processQueue({ triggerSource: 'App en primer plano (visibilitychange)' });
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
          this.processQueue({ triggerSource: 'Reanudación pageshow (iOS/Safari)' });
        }
      });

      // Disparador 2A: Evento nativo `online` del navegador
      window.addEventListener('online', () => {
        this.addLog(
          'info',
          'Disparador #2: Señal de red recuperada (evento online)',
          'Iniciando confirmación de salida real a Supabase (AbortController 8 s).'
        );
        this.processQueue({ triggerSource: 'Recuperación de señal (evento online)' });
      });
    }

    // Disparador 2B: Desactivación del Modo Avión simulado en pwaManager
    pwaManager.subscribe((pwaState) => {
      const nowOnline = pwaState.isOnline;
      if (!this.wasOnline && nowOnline && !this.suppressAutoReconnectTrigger) {
        this.addLog(
          'info',
          'Disparador #2: Modo Avión desactivado (Reconectado)',
          'La PWA detectó reconexión. Ejecutando cola de sincronización M5.'
        );
        this.processQueue({ triggerSource: 'Reconectado tras Modo Avión' });
      }
      this.wasOnline = nowOnline;
    });

    // Disparador 3: Temporizador periódico cada 2 minutos mientras la app esté abierta
    this.periodicTimer = setInterval(() => {
      this.processQueue({ triggerSource: 'Temporizador automático (cada 2 min)' });
    }, PERIODIC_SYNC_INTERVAL_MS);

    this.addLog(
      'info',
      'Motor M5 inicializado y listo',
      'Candado Mutex libre (🔓), 4 disparadores activos y orden estricto Fase 1 (Storage) -> Fase 2 (Postgres).'
    );

    // Migración automática al iniciar: si hay reportes reales creados localmente que aún no subieron a Supabase Cloud Real, subirlos automáticamente
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        if (pwaManager.getState().isOnline && !this.isSyncing) {
          this.requeueLocalOnlyReportsForRealCloud({ skipDemoSeeds: true }).catch(() => {});
        }
      }, 2000);
    }

    return this.getState();
  }

  /**
   * Sección 6.2: Recuperación al iniciar.
   * Si la app se cerró o se apagó el celular a mitad de una subida y un reporte quedó en estado
   * `'sincronizando'` en IndexedDB, al arrancar sin proceso activo se devuelve automáticamente a `'pendiente'`.
   */
  async recoverInterruptedSyncs() {
    if (this.isSyncing) return 0;
    const all = await localDb.reportes.toArray();
    const interrupted = all.filter((r) => r.estado === 'sincronizando');

    for (const rep of interrupted) {
      rep.estado = 'pendiente';
      rep.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(rep);
    }

    if (interrupted.length > 0) {
      this.addLog(
        'warning',
        `Recuperación de cierre abrupto (${interrupted.length} reporte(s))`,
        `Se detectaron ${interrupted.length} reporte(s) que quedaron en estado "sincronizando" tras un corte previo y se restauraron a "pendiente".`
      );
    }
    return interrupted.length;
  }

  /**
   * Programa un temporizador automático para un reporte en estado `'error'` según su backoff (`30 s`, `2 min`, `10 min`).
   */
  scheduleBackoffRetry(reportId, delayMs, label) {
    if (this.backoffTimers.has(reportId)) {
      clearTimeout(this.backoffTimers.get(reportId));
    }

    const timer = setTimeout(() => {
      this.backoffTimers.delete(reportId);
      this.addLog(
        'info',
        `Temporizador Backoff (${label}) cumplido`,
        `Reintentando automáticamente el reporte ${reportId.slice(0, 8)}...`
      );
      this.processQueue({
        triggerSource: `Reintento automático Backoff (${label})`,
        targetReportId: reportId,
        forceManual: true
      });
    }, delayMs);

    this.backoffTimers.set(reportId, timer);
  }

  /**
   * Permite programar que el próximo intento de un reporte falle controladamente
   * para demostrar la escalera de Exponential Backoff (30 s -> 2 min -> 10 min) y mensajes en español.
   */
  setForcedFailureForReport(reportId) {
    this.forcedFailNextReportId = reportId;
    this.notify();
  }

  /**
   * Procesa secuencialmente la cola de reportes en estado `'pendiente'` o `'error'`.
   * @param {Object} options
   * @param {string} [options.triggerSource='Manual (Sincronizar ahora)']
   * @param {boolean} [options.forceManual=false] - Si es true, reinicia la espera de backoff de los reportes en error.
   * @param {string} [options.targetReportId=null] - Si se especifica, procesa únicamente ese reporte.
   * @param {number} [options.perFileDelayMs=65] - Pequeña pausa por archivo para visualizar las fases y permitir pruebas de corte a los 2s (Escenario P7).
   * @param {number} [options.pingTimeoutMs=8000] - Límite de AbortController para el ping de conexión real.
   * @param {number} [options.lieFiWaitMs] - Duración del bloqueo simulado en laboratorio P8.
   */
  async processQueue(options = {}) {
    const triggerSource = options.triggerSource || 'Manual ("Sincronizar ahora")';
    const forceManual = Boolean(options.forceManual);
    const targetReportId = options.targetReportId || null;
    const targetReportIds = Array.isArray(options.targetReportIds) ? options.targetReportIds : null;
    const perFileDelayMs = typeof options.perFileDelayMs === 'number' ? options.perFileDelayMs : 65;
    const pingTimeoutMs = options.pingTimeoutMs || DEFAULT_PING_TIMEOUT_MS;

    // 1. CANDADO DE CONCURRENCIA (MUTEX — Regla 6.2 / Escenario P8)
    if (this.isSyncing) {
      this.mutexCollisionsBlocked += 1;
      this.addLog(
        'mutex',
        `🔒 Candado Mutex bloqueó ejecución concurrente (#${this.mutexCollisionsBlocked})`,
        `Se ignoró el disparador "${triggerSource}" porque ya hay una sincronización activa en curso.`
      );
      this.notify();
      return {
        ok: false,
        skippedByMutex: true,
        processed: 0,
        synced: 0,
        failed: 0,
        mutexCollisionsBlocked: this.mutexCollisionsBlocked,
        reason: 'Candado de exclusión mutua (Mutex) activo: Ya hay una sincronización en curso.'
      };
    }

    // Adquirir candado Mutex
    this.isSyncing = true;
    this.lastTriggerSource = triggerSource;
    this.lastRunAt = new Date().toISOString();
    this.currentPhase = 'CHECKING_QUEUE';
    this.currentStepDetail = 'Inspeccionando cola local en IndexedDB...';
    this.notify();

    try {
      const allReports = await localDb.reportes.toArray();
      const nowMs = Date.now();

      // Filtrar reportes en estado 'pendiente' o 'error' ordenados del más antiguo al más reciente
      let candidates = allReports
        .filter((r) => r.estado === 'pendiente' || r.estado === 'error')
        .sort((a, b) => (a.creado_en || '').localeCompare(b.creado_en || ''));

      if (targetReportId) {
        candidates = candidates.filter((r) => r.id === targetReportId);
      } else if (targetReportIds && targetReportIds.length > 0) {
        candidates = candidates.filter((r) => targetReportIds.includes(r.id));
      } else if (!forceManual) {
        // Si no fue un clic manual en "Sincronizar ahora", respetar la ventana de espera `proximo_reintento_en` de los reportes en error
        candidates = candidates.filter((r) => {
          if (r.estado !== 'error' || !r.proximo_reintento_en) return true;
          const retryAtMs = new Date(r.proximo_reintento_en).getTime();
          return Number.isNaN(retryAtMs) || retryAtMs <= nowMs;
        });
      }

      if (candidates.length === 0) {
        this.currentPhase = 'IDLE';
        this.currentStepDetail = 'Cola limpia (0 reportes pendientes por sincronizar).';
        const emptySummary = {
          ok: true,
          processed: 0,
          synced: 0,
          failed: 0,
          reason: 'No hay reportes pendientes o listos para sincronizar en este momento.'
        };
        this.lastRunSummary = emptySummary;
        return emptySummary;
      }

      this.addLog(
        'info',
        `Iniciando cola M5 (${candidates.length} reporte(s) en cola)`,
        `Disparador: ${triggerSource}`
      );

      // 2. CONFIRMACIÓN DE CONEXIÓN REAL (Regla 4 / Sección 6.3 / Escenario P8)
      this.currentPhase = 'CHECKING_NET';
      this.currentStepDetail = `Verificando salida real a Supabase (AbortController ${Math.round(pingTimeoutMs / 1000)} s)...`;
      this.notify();

      const netCheck = await connectivityService.verifyRealInternetConnection({
        timeoutMs: pingTimeoutMs,
        lieFiWaitMs: options.lieFiWaitMs
      });

      if (!netCheck.online) {
        const spanReason = translateSyncErrorToSpanish(netCheck.reason);

        // Si estamos en Falsa Conexión ("Lie-Fi" / timeout de AbortController) o el usuario presionó "Sincronizar ahora" con fallo de servidor,
        // registramos el estado 'error' con su motivo en español y su backoff exponencial (Escenario P8)
        if (netCheck.simulatedLieFi || netCheck.abortedByTimeout) {
          for (const rep of candidates) {
            await this._markReportErrorWithBackoff(
              rep,
              'Tiempo de espera agotado (8 s con AbortController): El Wi-Fi/red no tiene salida real al servidor Supabase ("Lie-Fi").'
            );
          }
          this.addLog(
            'error',
            'Abortado por Falsa Conexión ("Lie-Fi" / Timeout 8 s)',
            `${netCheck.reason} Se programó Exponential Backoff en ${candidates.length} reporte(s).`
          );
        } else {
          this.addLog(
            'warning',
            'Sincronización pospuesta: Sin conexión de red',
            `${spanReason} Los ${candidates.length} reporte(s) permanecen intactos en la cola local.`
          );
        }

        const netFailSummary = {
          ok: false,
          abortedByNetwork: true,
          abortedByTimeout: netCheck.abortedByTimeout,
          processed: 0,
          synced: 0,
          failed: netCheck.simulatedLieFi || netCheck.abortedByTimeout ? candidates.length : 0,
          reason: spanReason
        };
        this.lastRunSummary = netFailSummary;
        return netFailSummary;
      }

      // 3. VALIDACIÓN DE SESIÓN SUPABASE AUTH (Regla 6 / Sección 6.4 / Escenario P9)
      this.currentPhase = 'CHECKING_AUTH';
      this.currentStepDetail = 'Verificando vigencia de sesión JWT en Supabase Auth...';
      this.notify();

      const authCheck = await authService.verifySessionForCloudSync();
      if (!authCheck.allowed) {
        this.addLog(
          'warning',
          'Sincronización pausada por Sesión (Regla 6 / Escenario P9)',
          authCheck.reason
        );
        const authFailSummary = {
          ok: false,
          abortedByAuth: true,
          processed: 0,
          synced: 0,
          failed: 0,
          reason: authCheck.reason
        };
        this.lastRunSummary = authFailSummary;
        return authFailSummary;
      }

      const authState = authService.getState();
      const userId = authState.user.id;

      // 4. PROCESAMIENTO SECUENCIAL REPORTE POR REPORTE (Sección 6.5 — Reglas 1, 2 y 3)
      let syncedCount = 0;
      let failedCount = 0;

      for (let idx = 0; idx < candidates.length; idx++) {
        const rep = candidates[idx];
        this.currentReportId = rep.id;

        // Paso 0: Cambiar estado local a 'sincronizando'
        rep.estado = 'sincronizando';
        rep.actualizado_en = new Date().toISOString();
        await localDb.reportes.put(rep);

        this.currentPhase = 'PHASE_1_STORAGE';
        this.currentStepDetail = `[${idx + 1}/${candidates.length}] Subiendo multimedia de ${rep.codigo_equipo} (${rep.id.slice(0, 8)}) a Supabase Storage...`;
        this.notify();

        try {
          // Comprobar si se solicitó simular un fallo en este reporte para probar el backoff
          if (this.forcedFailNextReportId === rep.id) {
            this.forcedFailNextReportId = null;
            throw new Error('Tiempo de espera agotado al subir la foto 1 a Supabase Storage (Fallo simulado para prueba de Backoff)');
          }

          // Verificar si la señal se cortó antes de iniciar la Fase 1
          this._assertSignalStillActive('el inicio de la subida a Storage');

          // ===================================================================
          // PASO A (FASE 1): SUBIDA DE FOTOS (Y VIDEO OPCIONAL) A STORAGE
          // Estructura obligatoria: {user_id}/{reporte_id}/{n}.jpg con upsert: true
          // ===================================================================
          const fotosLocales = Array.isArray(rep.fotos_locales) ? rep.fotos_locales : [];
          const existingRemotePaths = Array.isArray(rep.fotos_rutas)
            ? rep.fotos_rutas
            : Array.isArray(rep.fotos)
              ? rep.fotos
              : [];

          if (fotosLocales.length === 0 && existingRemotePaths.length === 0) {
            throw new Error('El reporte no contiene fotos locales para subir a Storage.');
          }

          const uploadedPhotoPaths =
            fotosLocales.length === 0 ? [...existingRemotePaths] : [];

          for (let fIdx = 0; fIdx < fotosLocales.length; fIdx++) {
            const fotoItem = fotosLocales[fIdx];
            if (!fotoItem?.blob && fotoItem?.ruta_remota) {
              uploadedPhotoPaths.push(fotoItem.ruta_remota);
              continue;
            }
            const photoNumber = fotoItem.indice || fIdx + 1;
            const storagePath = `${userId}/${rep.id}/${photoNumber}.jpg`;

            this.currentStepDetail = `[${idx + 1}/${candidates.length}] Fase 1 (Storage): Subiendo foto ${photoNumber}/${fotosLocales.length} -> fotos/${storagePath} (upsert: true)`;
            this.notify();

            if (perFileDelayMs > 0) {
              await new Promise((r) => setTimeout(r, perFileDelayMs));
            }

            // Si la señal se cortó a mitad de la transferencia (Escenario P7: Modo Avión a los 2 segundos)
            this._assertSignalStillActive(`la subida de la foto ${photoNumber} (${rep.codigo_equipo})`);

            const uploadRes = await supabase.storage.from('fotos').upload(storagePath, fotoItem.blob, {
              upsert: true,
              contentType: fotoItem.mime_type || 'image/jpeg',
              sizeBytes: fotoItem.peso_bytes || fotoItem.blob?.size || 68000,
              timeoutMs: 10000
            });

            if (uploadRes.error) {
              throw new Error(uploadRes.error.message || `Error al subir la foto ${photoNumber} a Storage.`);
            }

            fotoItem.ruta_remota = storagePath;
            uploadedPhotoPaths.push(storagePath);
          }

          // Subida de video y audio opcionales si existen
          const unpackedMedia = unpackVideoAudioField(rep.video);
          let uploadedVideoPath = rep.video_ruta || unpackedMedia.videoPath || null;
          if (rep.video_local && rep.video_local.blob) {
            const ext = (rep.video_local.mime_type || '').includes('webm') ? 'webm' : 'mp4';
            const videoPath = `${userId}/${rep.id}/video.${ext}`;

            this.currentStepDetail = `[${idx + 1}/${candidates.length}] Fase 1 (Storage): Subiendo video opcional -> fotos/${videoPath} (upsert: true)`;
            this.notify();

            if (perFileDelayMs > 0) {
              await new Promise((r) => setTimeout(r, perFileDelayMs));
            }
            this._assertSignalStillActive(`la subida del video de ${rep.codigo_equipo}`);

            const vidRes = await supabase.storage.from('fotos').upload(videoPath, rep.video_local.blob, {
              upsert: true,
              contentType: rep.video_local.mime_type || 'video/mp4',
              sizeBytes: rep.video_local.peso_bytes || rep.video_local.blob?.size || 450000,
              timeoutMs: 15000
            });

            if (vidRes.error) {
              throw new Error(vidRes.error.message || 'Error al subir el video opcional a Storage.');
            }
            rep.video_local.ruta_remota = videoPath;
            uploadedVideoPath = videoPath;
          }

          let uploadedAudioPath =
            rep.audio_local === null
              ? null
              : rep.audio_local?.ruta_remota || rep.audio_ruta || unpackedMedia.audioPath || null;
          let uploadedAudioDuration =
            rep.audio_local === null
              ? 0
              : rep.audio_local?.duracion_seg || unpackedMedia.audioDurationSec || 0;
          if (rep.audio_local?.blob instanceof Blob && rep.audio_local.blob.size > 0) {
            const audioExt = getAudioExtensionFromMime(rep.audio_local.mime_type || rep.audio_local.blob.type);
            const audioPath = `${userId}/${rep.id}/audio.${audioExt}`;

            this.currentStepDetail = `[${idx + 1}/${candidates.length}] Fase 1 (Storage): Subiendo audio opcional -> fotos/${audioPath} (upsert: true)`;
            this.notify();

            if (perFileDelayMs > 0) {
              await new Promise((r) => setTimeout(r, perFileDelayMs));
            }
            this._assertSignalStillActive(`la subida del audio de ${rep.codigo_equipo}`);

            const audioRes = await supabase.storage.from('fotos').upload(audioPath, rep.audio_local.blob, {
              upsert: true,
              contentType: rep.audio_local.mime_type || rep.audio_local.blob.type || 'audio/webm',
              sizeBytes: rep.audio_local.peso_bytes || rep.audio_local.blob.size || 64000,
              timeoutMs: 15000
            });

            if (audioRes.error) {
              throw new Error(audioRes.error.message || 'Error al subir el audio opcional a Storage.');
            }
            rep.audio_local.ruta_remota = audioPath;
            uploadedAudioPath = audioPath;
            uploadedAudioDuration = rep.audio_local.duracion_seg || uploadedAudioDuration;
          }

          // Subida de multimedia de seguimientos (↳) si existen
          const seguimientosRemotos = [];
          if (Array.isArray(rep.seguimientos)) {
            for (let sIdx = 0; sIdx < rep.seguimientos.length; sIdx++) {
              const seg = rep.seguimientos[sIdx];
              const segFotosRutas = [];
              const segFotos = Array.isArray(seg.fotos_locales) ? seg.fotos_locales : [];

              if (segFotos.length === 0 && Array.isArray(seg.fotos) && seg.fotos.length > 0) {
                segFotosRutas.push(...seg.fotos);
              } else {
                for (let sfIdx = 0; sfIdx < segFotos.length; sfIdx++) {
                  const sf = segFotos[sfIdx];
                  if (!sf?.blob && sf?.ruta_remota) {
                    segFotosRutas.push(sf.ruta_remota);
                    continue;
                  }
                  const segPath = `${userId}/${rep.id}/seg_${sIdx + 1}_${sfIdx + 1}.jpg`;
                  this._assertSignalStillActive(`la subida de foto de seguimiento de ${rep.codigo_equipo}`);
                  const segUp = await supabase.storage.from('fotos').upload(segPath, sf.blob, {
                    upsert: true,
                    contentType: 'image/jpeg',
                    sizeBytes: sf.peso_bytes || 64000
                  });
                  if (segUp.error) {
                    throw new Error(segUp.error.message);
                  }
                  sf.ruta_remota = segPath;
                  segFotosRutas.push(segPath);
                }
              }

              let segAudioPath =
                seg.audio_local === null
                  ? null
                  : seg.audio_local?.ruta_remota || seg.audio || null;
              let segAudioDur =
                seg.audio_local === null
                  ? 0
                  : seg.audio_local?.duracion_seg || seg.audio_duracion_seg || 0;
              if (seg.audio_local?.blob instanceof Blob && seg.audio_local.blob.size > 0) {
                const segAudioExt = getAudioExtensionFromMime(
                  seg.audio_local.mime_type || seg.audio_local.blob.type
                );
                const nextSegAudioPath = `${userId}/${rep.id}/seg_${sIdx + 1}_audio.${segAudioExt}`;
                this._assertSignalStillActive(`la subida de audio de seguimiento de ${rep.codigo_equipo}`);
                const segAudioUp = await supabase.storage.from('fotos').upload(nextSegAudioPath, seg.audio_local.blob, {
                  upsert: true,
                  contentType: seg.audio_local.mime_type || seg.audio_local.blob.type || 'audio/webm',
                  sizeBytes: seg.audio_local.peso_bytes || seg.audio_local.blob.size || 64000,
                  timeoutMs: 15000
                });
                if (segAudioUp.error) {
                  throw new Error(segAudioUp.error.message || 'Error al subir audio de seguimiento.');
                }
                seg.audio_local.ruta_remota = nextSegAudioPath;
                segAudioPath = nextSegAudioPath;
                segAudioDur = seg.audio_local.duracion_seg || segAudioDur;
              }

              const remoteSegObj = {
                id: seg.id,
                fecha: seg.fecha,
                estado_seguimiento: seg.estado_seguimiento,
                comentario: seg.comentario,
                fotos: segFotosRutas
              };
              if (segAudioPath) {
                remoteSegObj.audio = segAudioPath;
                remoteSegObj.audio_duracion_seg = segAudioDur;
              }
              seguimientosRemotos.push(remoteSegObj);
            }
          }

          // Verificar nuevamente señal antes de pasar a la Fase 2 (Postgres)
          if (perFileDelayMs > 0) {
            await new Promise((r) => setTimeout(r, perFileDelayMs));
          }
          this._assertSignalStillActive(`el paso entre Storage y Postgres para ${rep.codigo_equipo}`);

          // ===================================================================
          // PASO B (FASE 2): UPSERT DEL REGISTRO EN POSTGRES (public.reportes)
          // Solo se ejecuta si el 100 % de las fotos, video y audio se subieron sin error.
          // ===================================================================
          this.currentPhase = 'PHASE_2_POSTGRES';
          this.currentStepDetail = `[${idx + 1}/${candidates.length}] Fase 2 (Postgres): Ejecutando UPSERT en public.reportes (onConflict: 'id' -> ${rep.id.slice(0, 8)})...`;
          this.notify();

          const packedVideoField = packVideoAudioField(
            uploadedVideoPath,
            uploadedAudioPath,
            uploadedAudioDuration
          );

          const postgresPayload = {
            id: rep.id, // UUID generado en el dispositivo (idempotencia garantizada)
            codigo_equipo: rep.codigo_equipo,
            fuera_catalogo: Boolean(rep.es_nuevo_codigo),
            fecha: rep.fecha,
            hora_peru: rep.hora_peru || '',
            tipo: rep.tipo,
            prioridad: rep.prioridad,
            observacion: rep.observacion || '',
            calidad_compresion: rep.calidad_compresion || 'estandar',
            fotos: uploadedPhotoPaths,
            video: packedVideoField,
            seguimientos: seguimientosRemotos,
            creado_por: userId,
            creado_en: rep.creado_en,
            actualizado_en: new Date().toISOString(),
            dispositivo: rep.dispositivo || 'PWA Mina'
          };

          const dbRes = await supabase.from('reportes').upsert(postgresPayload, {
            onConflict: 'id',
            timeoutMs: 10000
          });

          if (dbRes.error) {
            throw new Error(dbRes.error.message || 'Error al hacer upsert en public.reportes.');
          }

          // ===================================================================
          // PASO C (FASE 3): CONFIRMACIÓN FINAL EN INDEXEDDB
          // Solo si Paso A y Paso B respondieron con éxito, pasa a 'sincronizado'.
          // ===================================================================
          this.currentPhase = 'PHASE_3_CONFIRM';
          const nowIso = new Date().toISOString();
          const upsertedRow = dbRes.data?.[0];
          rep.estado = 'sincronizado';
          rep.sincronizado_en_nube_real = upsertedRow?.cloud_mode === 'supabase-cloud-postgres';
          rep.fotos_rutas = uploadedPhotoPaths;
          rep.video_ruta = uploadedVideoPath;
          rep.audio_ruta = uploadedAudioPath;
          rep.ultimo_error = null;
          rep.proximo_reintento_en = null;
          rep.creado_por = userId;
          rep.sincronizado_en = nowIso;
          rep.actualizado_en = nowIso;

          await localDb.reportes.put(rep);
          if (this.backoffTimers.has(rep.id)) {
            clearTimeout(this.backoffTimers.get(rep.id));
            this.backoffTimers.delete(rep.id);
          }

          syncedCount++;
          this.addLog(
            'success',
            `✅ Sincronizado: ${rep.codigo_equipo} (UUID ${rep.id.slice(0, 8)}...)`,
            `Fase 1: ${uploadedPhotoPaths.length} foto(s) en Storage (${uploadedPhotoPaths[0]}) -> Fase 2: Upsert #${upsertedRow?.upsert_count || 1} en public.reportes.`
          );
          this.notify();
        } catch (err) {
          failedCount++;
          const spanishError = translateSyncErrorToSpanish(err);
          await this._markReportErrorWithBackoff(rep, spanishError);

          // Si el fallo fue porque se cortó la señal (ej. Modo Avión activado a los 2 segundos en P7),
          // detenemos inmediatamente el resto del lote dejando los demás pendientes o en error para cuando vuelva la red.
          if (!pwaManager.getState().isOnline || connectivityService.getState().simulatedLieFi) {
            this.addLog(
              'error',
              `⚡ Corte abrupto de señal detectado durante ${rep.codigo_equipo}`,
              `${spanishError} Se detuvo el ciclo tras sincronizar ${syncedCount} reporte(s). Ningún registro quedó huérfano sin fotos.`
            );
            break;
          }
        }
      }

      const finalSummary = {
        ok: failedCount === 0,
        processed: syncedCount + failedCount,
        synced: syncedCount,
        failed: failedCount,
        reason:
          failedCount === 0
            ? `Sincronización completada con éxito: ${syncedCount} reporte(s) subido(s) a Supabase Storage y Postgres.`
            : `Sincronización parcial/con errores: ${syncedCount} sincronizado(s), ${failedCount} en estado "error" con reintento Backoff programado.`
      };
      this.lastRunSummary = finalSummary;
      return finalSummary;
    } finally {
      // Liberar siempre el candado Mutex
      this.isSyncing = false;
      this.currentReportId = null;
      this.currentPhase = 'IDLE';
      this.currentStepDetail = 'Candado Mutex liberado (🔓). Motor en espera.';
      this.notify();
    }
  }

  _assertSignalStillActive(stepDescription) {
    const pwaState = pwaManager.getState();
    const connState = connectivityService.getState();
    if (!pwaState.isOnline) {
      throw new Error(`Corte abrupto de señal (Modo Avión / Sin red) durante ${stepDescription}`);
    }
    if (connState.simulatedLieFi) {
      throw new Error(`Tiempo de espera agotado durante ${stepDescription}`);
    }
  }

  async _markReportErrorWithBackoff(reporte, spanishErrorMessage) {
    const nextAttempt = (reporte.intentos_sync || 0) + 1;
    const backoff = getBackoffInfoForAttempt(nextAttempt);
    const retryDateIso = new Date(Date.now() + backoff.ms).toISOString();

    reporte.estado = 'error';
    reporte.intentos_sync = nextAttempt;
    reporte.ultimo_error = spanishErrorMessage;
    reporte.ultimo_backoff_label = backoff.label;
    reporte.ultimo_backoff_segundos = backoff.seconds;
    reporte.proximo_reintento_en = retryDateIso;
    reporte.actualizado_en = new Date().toISOString();

    await localDb.reportes.put(reporte);
    this.scheduleBackoffRetry(reporte.id, backoff.ms, backoff.label);

    this.addLog(
      'error',
      `⚠️ Error en ${reporte.codigo_equipo} (${reporte.id.slice(0, 8)}) — Intento #${nextAttempt}`,
      `Motivo: "${spanishErrorMessage}". Próximo reintento automático con Exponential Backoff en ${backoff.label}.`
    );
  }

  /**
   * Re-encola y sube a Supabase Cloud Real todos los reportes guardados en IndexedDB
   * que aún no han sido confirmados en la nube real (`sincronizado_en_nube_real !== true`).
   * Ideal cuando el usuario guardó reportes en modo local antes de iniciar sesión en Supabase Cloud.
   */
  async requeueLocalOnlyReportsForRealCloud(options = {}) {
    const skipDemoSeeds = options.skipDemoSeeds !== false;
    const cfg = supabase.getConfig();
    if (cfg.isPlaceholder || !cfg.security.valid) {
      return {
        ok: false,
        requeued: 0,
        reason: 'Configura tu Project URL y Anon Key reales de Supabase primero.'
      };
    }

    const allLocal = await localDb.reportes.toArray();
    let requeued = 0;

    for (const rep of allLocal) {
      if (skipDemoSeeds && rep.dispositivo === 'PC / Demo Local') {
        continue;
      }
      if (!rep.sincronizado_en_nube_real && Array.isArray(rep.fotos_locales) && rep.fotos_locales.length > 0) {
        rep.estado = 'pendiente';
        rep.ultimo_error = null;
        rep.proximo_reintento_en = null;
        rep.actualizado_en = new Date().toISOString();
        await localDb.reportes.put(rep);
        requeued++;
      }
    }

    if (requeued === 0) {
      return {
        ok: true,
        requeued: 0,
        reason: 'Todos tus reportes locales ya estaban confirmados en Supabase Cloud Real.'
      };
    }

    const res = await this.processQueue({
      triggerSource: 'Subida completa de reportes locales a Supabase Cloud Real',
      forceManual: true,
      perFileDelayMs: 40
    });
    return {
      ...res,
      requeued
    };
  }
}

export const syncQueue = new SyncQueueService();
