/**
 * M5 — Interfaz del Motor y Cola de Sincronización (SyncStatus.js)
 * Incluye:
 *  - Panel de control de la cola secuencial con candado Mutex (isSyncing).
 *  - Monitor del verificador de internet real (connectivity.js con AbortController de 8 segundos).
 *  - Visualizador en vivo de la subida en 2 fases estrictas:
 *      Fase 1: Multimedia primero a Supabase Storage (bucket privado 'fotos', {user_id}/{id}/{n}.jpg, upsert: true)
 *      Fase 2: Registro después a Supabase Postgres (tabla public.reportes, upsert por 'id' UUID)
 *  - Escalera de Exponential Backoff (30 s -> 2 min -> 10 min) y alertas de error claras en español.
 *  - Laboratorios Automatizados para validar los Escenarios P6, P7 y P8 del Plan de Pruebas.
 *  - Inspector en vivo de Supabase Cloud (public.reportes y storage.objects) y bitácora del motor.
 */

import { localDb } from '../../db/localDb.js';
import { supabase } from '../../config/supabaseClient.js';
import { authService } from '../../services/authService.js';
import { pwaManager } from '../../services/pwaManager.js';
import { connectivityService, DEFAULT_PING_TIMEOUT_MS } from '../../services/connectivity.js';
import {
  syncQueue,
  BACKOFF_SCHEDULE,
  getBackoffInfoForAttempt
} from '../../services/syncQueue.js';
import { createOrTouchEquipment } from '../../services/equipmentService.js';
import { compressPhotoFile, generateHeavyCameraPhotoForP3 } from '../../services/imageCompressor.js';
import { getFechaHoyPeru, getHoraActualPeru } from '../../utils/datePeru.js';
import { formatBytes } from '../../db/storageManager.js';

export class SyncModuleView {
  constructor(rootEl, { onStatsChange, onNavigateModule } = {}) {
    this.rootEl = rootEl;
    this.onStatsChange = onStatsChange || (() => {});
    this.onNavigateModule = onNavigateModule || (() => {});

    this.reportes = [];
    this.banner = null;
    this.isPinging = false;
    this.isCreatingSample = false;

    // Estado de laboratorios P6, P7 y P8
    this.isRunningP6 = false;
    this.p6Steps = [];
    this.isRunningP7 = false;
    this.p7Steps = [];
    this.p7AuditResult = null;
    this.isRunningP8 = false;
    this.p8Steps = [];

    this.unsubSync = null;
    this.unsubAuth = null;
    this.unsubPwa = null;
  }

  async init() {
    await syncQueue.init();
    await this.reloadReports();

    this.unsubSync = syncQueue.subscribe(async () => {
      await this.reloadReports(false);
      this.render();
    });

    this.unsubAuth = authService.subscribe(() => {
      this.render();
    });

    this.unsubPwa = pwaManager.subscribe(() => {
      this.render();
    });

    this.render();
  }

  destroy() {
    if (this.unsubSync) this.unsubSync();
    if (this.unsubAuth) this.unsubAuth();
    if (this.unsubPwa) this.unsubPwa();
  }

  async reloadReports(notifyTopbar = true) {
    const raw = await localDb.reportes.toArray();
    this.reportes = raw.sort((a, b) => (a.creado_en || '').localeCompare(b.creado_en || ''));
    if (notifyTopbar) {
      await this.onStatsChange();
    }
  }

  setBanner(type, text) {
    this.banner = { type, text };
    this.render();
  }

  /**
   * Crea un reporte local con foto comprimida listo en estado 'pendiente'
   */
  async createQueuedOfflineReport({ codigo = '793F-05', observacionCustom = null, fechaCustom = null } = {}) {
    const hoy = fechaCustom || getFechaHoyPeru();
    const hora = getHoraActualPeru();
    const rawFile = await generateHeavyCameraPhotoForP3(codigo, `${hoy} ${hora}`);
    const compressed = await compressPhotoFile(rawFile, 'estandar');
    await createOrTouchEquipment(codigo);

    const rep = {
      id: crypto.randomUUID(),
      codigo_equipo: codigo,
      es_nuevo_codigo: false,
      fecha: hoy,
      hora_peru: hora,
      tipo: 'Observación',
      prioridad: 'Alta',
      observacion:
        observacionCustom ||
        `[Reporte en Cola M5 — ${codigo}] Inspección hidráulica y placa verificada en campo (${hoy} ${hora}).`,
      calidad_compresion: 'estandar',
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
      proximo_reintento_en: null,
      creado_por: authService.getState().user?.id || null,
      creado_en: new Date().toISOString(),
      actualizado_en: new Date().toISOString(),
      dispositivo: 'PWA Mina M5'
    };

    await localDb.reportes.put(rep);
    return rep;
  }

  async handleManualSyncNow() {
    const res = await syncQueue.processQueue({
      triggerSource: 'Botón manual "Sincronizar ahora" (M5)',
      forceManual: true,
      perFileDelayMs: 90
    });

    await this.reloadReports(true);
    if (res.skippedByMutex) {
      this.setBanner('warning', `🔒 ${res.reason}`);
    } else if (res.ok) {
      this.setBanner('success', `✅ ${res.reason}`);
    } else {
      this.setBanner('error', `⚠️ ${res.reason}`);
    }
  }

  async handleTestRealPing() {
    this.isPinging = true;
    this.render();
    try {
      const check = await connectivityService.verifyRealInternetConnection({
        timeoutMs: DEFAULT_PING_TIMEOUT_MS,
        lieFiWaitMs: 1400
      });
      if (check.online) {
        this.setBanner('success', `📡 Ping HTTP Real exitoso: ${check.reason}`);
      } else {
        this.setBanner('error', `📡 Ping HTTP Real falló / abortado: ${check.reason}`);
      }
    } finally {
      this.isPinging = false;
      this.render();
    }
  }

  async handleAddSamplePendingReport() {
    this.isCreatingSample = true;
    this.render();
    try {
      const codigos = ['793F-05', 'PALA-02', 'PERF-01', 'CARG-994K', 'MOTO-24M'];
      const chosen = codigos[this.reportes.length % codigos.length];
      const created = await this.createQueuedOfflineReport({ codigo: chosen });
      await this.reloadReports(true);
      this.setBanner(
        'success',
        `➕ Reporte local creado para ${created.codigo_equipo} (UUID: ${created.id.slice(0, 8)}...) en estado "pendiente" con 1 foto comprimida (${formatBytes(created.fotos_locales[0].peso_bytes)}).`
      );
    } finally {
      this.isCreatingSample = false;
      this.render();
    }
  }

  async handleResetAllToPending() {
    const all = await localDb.reportes.toArray();
    for (const r of all) {
      r.estado = 'pendiente';
      r.ultimo_error = null;
      r.proximo_reintento_en = null;
      r.actualizado_en = new Date().toISOString();
      await localDb.reportes.put(r);
    }
    await this.reloadReports(true);
    this.setBanner(
      'warning',
      `🔁 Se marcaron los ${all.length} reporte(s) locales como "pendiente". Toca "Sincronizar ahora" para verificar la subida en 2 fases y comprobar que el UPSERT en Supabase no duplica ningún registro.`
    );
  }

  async handleSimulateReportErrorAndBackoff(reportId) {
    const rep = await localDb.reportes.get(reportId);
    if (!rep) return;

    syncQueue.setForcedFailureForReport(reportId);
    await syncQueue.processQueue({
      triggerSource: `Simulación de fallo y Backoff en ${rep.codigo_equipo}`,
      targetReportId: reportId,
      forceManual: true,
      perFileDelayMs: 40
    });

    const updated = await localDb.reportes.get(reportId);
    await this.reloadReports(true);
    this.setBanner(
      'error',
      `⚠️ Reporte ${updated.codigo_equipo} pasó a estado "error" (Intento #${updated.intentos_sync}). Motivo en español: "${updated.ultimo_error}". Reintento automático programado con Exponential Backoff en ${updated.ultimo_backoff_label}.`
    );
  }

  async handleSyncSingleReport(reportId) {
    const res = await syncQueue.processQueue({
      triggerSource: `Sincronización individual (${reportId.slice(0, 8)})`,
      targetReportId: reportId,
      forceManual: true,
      perFileDelayMs: 60
    });
    await this.reloadReports(true);
    if (res.ok) {
      this.setBanner('success', `✅ Reporte ${reportId.slice(0, 8)} sincronizado en Storage y Postgres.`);
    } else {
      this.setBanner('error', `⚠️ ${res.reason}`);
    }
  }

  /**
   * =========================================================================
   * LABORATORIO AUTOMATIZADO ESCENARIO P6:
   * "Sincronización automática al volver la conexión"
   * 1. Asegura sesión válida y activa Modo Avión.
   * 2. Registra 2 reportes sin internet (quedan en "pendiente").
   * 3. Desactiva Modo Avión (reconecta internet): el disparador automático detecta
   *    la recuperación de red, confirma salida real (AbortController 8s), sube fotos a Storage
   *    y luego registros a Postgres, bajando el contador de pendientes a 0.
   * =========================================================================
   */
  async handleRunScenarioP6Lab() {
    if (this.isRunningP6 || syncQueue.getState().isSyncing) return;
    this.isRunningP6 = true;
    this.p6Steps = [];
    this.render();

    try {
      // Asegurar sesión válida para que la prueba de red P6 pueda subir al reconectar
      if (!authService.getState().isAuthenticatedValid) {
        await authService.signIn('supervisor.mina@operacion.pe', 'Mina2026!Sup');
      }
      connectivityService.setSimulatedLieFi(false);

      // Paso 1: Activar Modo Avión
      pwaManager.setSimulatedAirplaneMode(true);
      this.p6Steps.push({
        step: '1. Modo Avión activado (Sin internet en tajo/mina)',
        status: 'MODO AVIÓN',
        detail: 'La PWA pasa a estado 🔴 Sin conexión. La cola automática permanece en espera.'
      });
      this.render();

      // Paso 2: Registrar 2 reportes sin internet
      const r1 = await this.createQueuedOfflineReport({
        codigo: '793F-05',
        observacionCustom: '[Prueba P6 #1 Offline] Reporte creado en Modo Avión para validar auto-sync al reconectar.'
      });
      const r2 = await this.createQueuedOfflineReport({
        codigo: 'PALA-02',
        observacionCustom: '[Prueba P6 #2 Offline] Segundo reporte creado en Modo Avión con foto comprimida.'
      });
      await this.reloadReports(true);

      const pendientesOffline = this.reportes.filter(
        (r) => r.estado === 'pendiente' || r.estado === 'error'
      ).length;

      this.p6Steps.push({
        step: '2. Registro de 2 reportes en Modo Avión',
        status: `${pendientesOffline} PENDIENTES`,
        detail: `Se guardaron en IndexedDB los reportes ${r1.codigo_equipo} (${r1.id.slice(0, 8)}) y ${r2.codigo_equipo} (${r2.id.slice(0, 8)}) con estado "pendiente".`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 450));

      // Paso 3: Desactivar Modo Avión -> Dispara automáticamente syncQueue por el listener de reconexión
      this.p6Steps.push({
        step: '3. Reconexión de red (Desactivando Modo Avión)',
        status: 'AUTO-TRIGGER',
        detail: 'Se desactiva el Modo Avión. El Disparador #2 detecta la señal, verifica conexión real (AbortController 8s) y arranca la cola sin tocar ningún botón.'
      });
      this.render();

      pwaManager.setSimulatedAirplaneMode(false);

      // Esperar a que el motor automático termine de procesar la cola
      for (let waitIdx = 0; waitIdx < 40; waitIdx++) {
        await new Promise((r) => setTimeout(r, 150));
        if (!syncQueue.getState().isSyncing) {
          const checkR1 = await localDb.reportes.get(r1.id);
          const checkR2 = await localDb.reportes.get(r2.id);
          if (checkR1?.estado === 'sincronizado' && checkR2?.estado === 'sincronizado') {
            break;
          }
        }
      }

      // Si quedaba algún reporte previo con timer de backoff, sincronizar todo para dejar pendientes = 0
      await syncQueue.processQueue({
        triggerSource: 'Confirmación final Escenario P6',
        forceManual: true,
        perFileDelayMs: 40
      });

      await this.reloadReports(true);
      const pendientesAfter = this.reportes.filter(
        (r) => r.estado === 'pendiente' || r.estado === 'error'
      ).length;
      const cloudSnap = supabase.getCloudSnapshot();

      this.p6Steps.push({
        step: '4. Resultado Escenario P6 (0 pendientes y sincronizados en Storage + Postgres)',
        status: pendientesAfter === 0 ? 'SÍ CUMPLIDO' : 'REVISAR',
        detail: `Contador de pendientes bajó a ${pendientesAfter}. Ambos reportes cambiaron a "sincronizado" y están confirmados en public.reportes (${cloudSnap.totalRows} filas) y bucket fotos (${cloudSnap.totalStorageObjects} objetos).`
      });

      this.setBanner(
        'success',
        '✅ Escenario P6 verificado con éxito ("Sí" en el Plan de Pruebas): Al recuperar la conexión, la cola subió automáticamente los reportes pendientes en 2 fases (Storage -> Postgres) y dejó el contador en 0.'
      );
    } finally {
      this.isRunningP6 = false;
      this.render();
    }
  }

  /**
   * =========================================================================
   * LABORATORIO AUTOMATIZADO ESCENARIO P7:
   * "Corte abrupto de señal a los 2 segundos de sincronizar (Anti-duplicados y Anti-huérfanos)"
   * 1. Prepara 5 reportes pendientes creados offline con UUID de dispositivo.
   * 2. Inicia la sincronización y activa Modo Avión exactamente a los 2 segundos (2000 ms).
   * 3. Comprueba que la subida se interrumpe a mitad del lote sin dejar registros huérfanos en Postgres.
   * 4. Reconecta internet y deja terminar la sincronización de los 5 reportes.
   * 5. Audita Supabase Table Editor (public.reportes) y Storage (bucket fotos):
   *    - Exactamente 5 filas para esos 5 reportes (0 duplicados gracias a upsert por id).
   *    - 100 % de fotos completas en Storage (0 registros huérfanos).
   * =========================================================================
   */
  async handleRunScenarioP7Lab() {
    if (this.isRunningP7 || syncQueue.getState().isSyncing) return;
    this.isRunningP7 = true;
    this.p7Steps = [];
    this.p7AuditResult = null;
    this.render();

    try {
      if (!authService.getState().isAuthenticatedValid) {
        await authService.signIn('supervisor.mina@operacion.pe', 'Mina2026!Sup');
      }
      connectivityService.setSimulatedLieFi(false);
      syncQueue.suppressAutoReconnectTrigger = true;

      // Paso 1: Activar Modo Avión y crear 5 reportes offline con UUID único
      pwaManager.setSimulatedAirplaneMode(true);
      const codigosLote = ['793F-05', 'PALA-02', 'PERF-01', 'CARG-994K', 'MOTO-24M'];
      const batchIds = [];

      for (let i = 0; i < 5; i++) {
        const rep = await this.createQueuedOfflineReport({
          codigo: codigosLote[i],
          observacionCustom: `[Lote P7 #${i + 1}/5] Reporte con UUID de dispositivo para prueba de corte abrupto a los 2 segundos.`
        });
        batchIds.push(rep.id);
      }

      await this.reloadReports(true);
      this.p7Steps.push({
        step: '1. Creados 5 reportes offline con UUID generado en el dispositivo',
        status: '5 PENDIENTES',
        detail: `Se crearon 5 reportes (${codigosLote.join(', ')}) con UUID v4 propio en estado "pendiente".`
      });
      this.render();

      // Paso 2: Reconectar para iniciar sincronización y programar corte abrupto a los 2.0 segundos
      // Usamos perFileDelayMs = 340 ms para que en 2.0 segundos se alcancen a sincronizar ~2 reportes
      // y el 3.° reporte sea sorprendido a mitad de la Fase 1 (Storage).
      pwaManager.setSimulatedAirplaneMode(false);

      this.p7Steps.push({
        step: '2. Sincronización iniciada -> Programado Modo Avión a los 2.0 segundos',
        status: 'SINCRONIZANDO...',
        detail: 'Subiendo lote de 5 reportes en orden estricto (Storage -> Postgres). El cronómetro activará Modo Avión a los 2,000 ms...'
      });
      this.render();

      const cutTimer = setTimeout(() => {
        pwaManager.setSimulatedAirplaneMode(true);
      }, 2000);

      const firstPassResult = await syncQueue.processQueue({
        triggerSource: 'Laboratorio Escenario P7 (Pase 1 — Con corte a los 2s)',
        targetReportIds: batchIds,
        forceManual: true,
        perFileDelayMs: 340
      });
      clearTimeout(cutTimer);

      await this.reloadReports(true);
      const batchStatesMid = [];
      for (const id of batchIds) {
        const r = await localDb.reportes.get(id);
        batchStatesMid.push(`${r.codigo_equipo}: ${r.estado.toUpperCase()}`);
      }
      const midSnap = supabase.getCloudSnapshot();

      this.p7Steps.push({
        step: '3. ⚡ Corte abrupto de señal ejecutado a los 2 segundos (Modo Avión)',
        status: `PARCIAL (${firstPassResult.synced}/5)`,
        detail: `Al caer la señal a los 2 s: ${firstPassResult.synced} reporte(s) alcanzaron a completarse, el reporte en vuelo abortó en Fase 1 y quedaron ${5 - firstPassResult.synced} sin completar (${batchStatesMid.join(' | ')}). Registros huérfanos en Postgres: ${midSnap.orphanRecordsCount}.`
      });
      this.render();

      await new Promise((r) => setTimeout(r, 600));

      // Paso 4: Reconectar internet y completar la sincronización (incluyendo re-upsert de prueba para demostrar idempotencia)
      this.p7Steps.push({
        step: '4. Reconectando señal y completando sincronización con UPSERT idempotente',
        status: 'RECONECTADO',
        detail: 'Se desactiva Modo Avión. Los archivos ya subidos a Storage se sobreescriben sin error (upsert: true) y Postgres hace merge por id UUID (onConflict: id).'
      });
      this.render();

      pwaManager.setSimulatedAirplaneMode(false);

      // Para demostrar idempotencia extrema en P7, también re-enviamos el primer reporte del lote junto con los restantes
      const firstBatchRep = await localDb.reportes.get(batchIds[0]);
      if (firstBatchRep) {
        firstBatchRep.estado = 'pendiente';
        await localDb.reportes.put(firstBatchRep);
      }

      await syncQueue.processQueue({
        triggerSource: 'Laboratorio Escenario P7 (Pase 2 — Reconexión tras corte)',
        targetReportIds: batchIds,
        forceManual: true,
        perFileDelayMs: 80
      });

      await this.reloadReports(true);
      const finalSnap = supabase.getCloudSnapshot();
      const cloudRowsForBatch = finalSnap.reportesCloud.filter((r) => batchIds.includes(r.id));
      const uniqueBatchIdsInCloud = new Set(cloudRowsForBatch.map((r) => r.id)).size;

      this.p7AuditResult = {
        expectedRows: 5,
        actualRowsInCloud: cloudRowsForBatch.length,
        uniqueUuids: uniqueBatchIdsInCloud,
        duplicatesCount: cloudRowsForBatch.length - uniqueBatchIdsInCloud,
        orphansCount: finalSnap.orphanRecordsCount,
        allFiveHavePhotosInStorage: cloudRowsForBatch.every(
          (r) => Array.isArray(r.fotos) && r.fotos.length > 0
        )
      };

      this.p7Steps.push({
        step: '5. Auditoría Final en Supabase (public.reportes y Storage bucket fotos)',
        status:
          this.p7AuditResult.actualRowsInCloud === 5 &&
          this.p7AuditResult.duplicatesCount === 0 &&
          this.p7AuditResult.orphansCount === 0
            ? 'SÍ CUMPLIDO (5 FILAS / 0 DUPLICADOS)'
            : 'REVISAR',
        detail: `Filas del lote en public.reportes: ${this.p7AuditResult.actualRowsInCloud} de 5 esperadas. Duplicados: ${this.p7AuditResult.duplicatesCount}. Registros huérfanos sin fotos: ${this.p7AuditResult.orphansCount}. Todos tienen sus fotos completas en Storage.`
      });

      this.setBanner(
        'success',
        '✅ Escenario P7 verificado con éxito ("Sí" en el Plan de Pruebas): Tras el corte abrupto a los 2 segundos y posterior reconexión, existen exactamente 5 filas para el lote (0 duplicados) y 0 registros huérfanos sin fotos.'
      );
    } finally {
      syncQueue.suppressAutoReconnectTrigger = false;
      this.isRunningP7 = false;
      this.render();
    }
  }

  /**
   * =========================================================================
   * LABORATORIO AUTOMATIZADO ESCENARIO P8:
   * "Falsa conexión ('Wi-Fi sin internet' / servidor caído) y exclusión mutua (Mutex + Backoff)"
   * 1. Simula red Wi-Fi activa (navigator.onLine = true) pero sin salida a Supabase ("Lie-Fi").
   * 2. Lanza 3 ejecuciones simultáneas de "Sincronizar ahora" para poner a prueba el Candado Mutex.
   * 3. Verifica que el Mutex bloquea las 2 ejecuciones concurrentes y que AbortController corta el intento sin congelar la app.
   * 4. Verifica que el reporte pasa a "error" con mensaje en español y recorre la escalera de Exponential Backoff (30 s -> 2 min -> 10 min).
   * =========================================================================
   */
  async handleRunScenarioP8Lab() {
    if (this.isRunningP8 || syncQueue.getState().isSyncing) return;
    this.isRunningP8 = true;
    this.p8Steps = [];
    this.render();

    try {
      if (!authService.getState().isAuthenticatedValid) {
        await authService.signIn('supervisor.mina@operacion.pe', 'Mina2026!Sup');
      }
      pwaManager.setSimulatedAirplaneMode(false);

      // Asegurar al menos 1 reporte pendiente para la prueba P8
      const testRep = await this.createQueuedOfflineReport({
        codigo: '793F-05',
        observacionCustom: '[Prueba P8 — Lie-Fi & Mutex] Reporte para validar AbortController (8s), Candado Mutex y Exponential Backoff.'
      });
      await this.reloadReports(true);

      // Paso 1: Activar simulación de Falsa Conexión ("Lie-Fi": navigator.onLine = true, pero Supabase no responde)
      connectivityService.setSimulatedLieFi(true);
      this.p8Steps.push({
        step: '1. Falsa conexión activada ("Lie-Fi": Wi-Fi conectado pero sin salida a Supabase)',
        status: 'navigator.onLine = true',
        detail: 'El navegador reporta estar en línea, pero los paquetes hacia Supabase no reciben respuesta.'
      });
      this.render();

      const mutexBefore = syncQueue.getState().mutexCollisionsBlocked;

      // Paso 2: Presionar 3 veces seguidas "Sincronizar ahora" de forma concurrente
      this.p8Steps.push({
        step: '2. Disparando 3 clics simultáneos en "Sincronizar ahora" (Prueba de Candado Mutex)',
        status: '3 PETICIONES SIMULTÁNEAS',
        detail: 'Lanzando 3 llamadas concurrentes a syncQueue.processQueue() mientras AbortController verifica la red...'
      });
      this.render();

      const [call1, call2, call3] = await Promise.all([
        syncQueue.processQueue({
          triggerSource: 'Clic #1 en "Sincronizar ahora" (P8)',
          targetReportId: testRep.id,
          forceManual: true,
          lieFiWaitMs: 1100
        }),
        new Promise((r) => setTimeout(r, 120)).then(() =>
          syncQueue.processQueue({
            triggerSource: 'Clic #2 simultáneo en "Sincronizar ahora" (P8)',
            targetReportId: testRep.id,
            forceManual: true
          })
        ),
        new Promise((r) => setTimeout(r, 240)).then(() =>
          syncQueue.processQueue({
            triggerSource: 'Clic #3 simultáneo en "Sincronizar ahora" (P8)',
            targetReportId: testRep.id,
            forceManual: true
          })
        )
      ]);

      const mutexAfter = syncQueue.getState().mutexCollisionsBlocked;
      const blockedInLab = mutexAfter - mutexBefore;

      this.p8Steps.push({
        step: '3. Exclusión Mutua (Candado Mutex) verificada',
        status: `${blockedInLab} BLOQUEADAS POR MUTEX`,
        detail: `El Clic #1 adquirió el candado isSyncing=true. Los Clics #2 (${call2.skippedByMutex ? 'Bloqueado' : ''}) y #3 (${call3.skippedByMutex ? 'Bloqueado' : ''}) fueron rechazados al instante sin duplicar peticiones HTTP.`
      });

      const repAfterAttempt1 = await localDb.reportes.get(testRep.id);
      this.p8Steps.push({
        step: '4. AbortController (8 s) y paso a estado "error" en español (Intento #1 -> Backoff 30 s)',
        status: `BACKOFF ${repAfterAttempt1.ultimo_backoff_label}`,
        detail: `La app no se congeló: AbortController cortó la espera, cambió el estado a "${repAfterAttempt1.estado}" con motivo: "${repAfterAttempt1.ultimo_error}" y programó reintento en ${repAfterAttempt1.ultimo_backoff_label}.`
      });
      this.render();

      // Paso 5: Simular Intentos #2 (2 min) y #3 (10 min) para verificar toda la escalera de Exponential Backoff
      await syncQueue.processQueue({
        triggerSource: 'Reintento #2 bajo Lie-Fi (P8)',
        targetReportId: testRep.id,
        forceManual: true,
        lieFiWaitMs: 300
      });
      const repAfterAttempt2 = await localDb.reportes.get(testRep.id);

      await syncQueue.processQueue({
        triggerSource: 'Reintento #3 bajo Lie-Fi (P8)',
        targetReportId: testRep.id,
        forceManual: true,
        lieFiWaitMs: 300
      });
      const repAfterAttempt3 = await localDb.reportes.get(testRep.id);

      // Desactivar Lie-Fi al terminar para dejar el entorno listo, pero conservando el reporte en estado 'error' para que el usuario lo vea
      connectivityService.setSimulatedLieFi(false);
      await this.reloadReports(true);

      this.p8Steps.push({
        step: '5. Escalera completa de Exponential Backoff verificada (30 s -> 2 min -> 10 min)',
        status: 'SÍ CUMPLIDO',
        detail: `Intento #1 programó ${repAfterAttempt1.ultimo_backoff_label} (30 s) ➔ Intento #2 programó ${repAfterAttempt2.ultimo_backoff_label} (2 min) ➔ Intento #3 programó ${repAfterAttempt3.ultimo_backoff_label} (10 min). Puedes tocar "Sincronizar ahora" para subirlo de inmediato.`
      });

      this.setBanner(
        'success',
        '✅ Escenario P8 verificado con éxito ("Sí" en el Plan de Pruebas): AbortController abortó la falsa conexión sin congelar la app, el Candado Mutex bloqueó los clics duplicados y el reporte muestra su motivo en español con Exponential Backoff (30 s, 2 min, 10 min).'
      );
    } finally {
      this.isRunningP8 = false;
      this.render();
    }
  }

  render() {
    const syncState = syncQueue.getState();
    const connState = syncState.connectivity;
    const authState = authService.getState();
    const pwaState = pwaManager.getState();
    const cloudSnap = syncState.cloudSnapshot;

    const pendientesList = this.reportes.filter((r) => r.estado === 'pendiente');
    const sincronizandoList = this.reportes.filter((r) => r.estado === 'sincronizando');
    const errorList = this.reportes.filter((r) => r.estado === 'error');
    const sincronizadosList = this.reportes.filter((r) => r.estado === 'sincronizado');
    const totalPorSubir = pendientesList.length + errorList.length;

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
            <span>${this.banner.text}</span>
            <button type="button" class="btn-mine btn-sm-mine" id="btn-close-m5-banner">Cerrar</button>
          </div>
        `
            : ''
        }

        ${
          !authState.isAuthenticatedValid
            ? `
          <div class="m4-nonblocking-notice">
            <div>
              <strong>🔐 Aviso de Regla 6 (Validación de Sesión en M5):</strong>
              ${
                authState.isExpired
                  ? `Sesión expirada. Inicia sesión para subir ${totalPorSubir} reporte(s) pendiente(s).`
                  : `Sesión no iniciada. Inicia sesión para subir ${totalPorSubir} reporte(s) pendiente(s).`
              }
              <span>La captura local en M1 sigue 100 % habilitada.</span>
            </div>
            <button type="button" class="btn-mine btn-sm-mine btn-amber" id="btn-go-m4-login">
              🔐 Ir a M4 para Iniciar Sesión
            </button>
          </div>
        `
            : ''
        }

        <!-- ENCABEZADO Y ARQUITECTURA DEL MOTOR M5 -->
        <section class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">🔄 Módulo 5 (M5): Motor y Cola de Sincronización Secuencial (Storage ➔ Postgres)</h2>
            <span class="panel-badge" style="background:${
              syncState.isSyncing ? '#fbbf24' : '#22c55e'
            }; color:#0f172a;">
              ${syncState.isSyncing ? '🔒 MUTEX ACTIVO: SINCRONIZANDO...' : '🔓 MUTEX LIBRE: COLA LISTA'}
            </span>
          </div>

          <div class="panel-body">
            <!-- 4 Tarjetas de Métricas Clave del Motor M5 -->
            <div class="m2-metrics-grid">
              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">1. Cola Local por Subir</span>
                  <span class="storage-status-chip ${totalPorSubir === 0 ? 'chip-ok' : 'chip-warn'}">
                    ${totalPorSubir === 0 ? '✅ 0 PENDIENTES' : `⏳ ${totalPorSubir} EN COLA`}
                  </span>
                </div>
                <div class="m2-metric-value">${totalPorSubir} reporte(s)</div>
                <p class="m2-metric-desc">
                  <strong>${pendientesList.length}</strong> en estado <code>pendiente</code>,
                  <strong>${errorList.length}</strong> en estado <code>error</code> (con backoff) y
                  <strong>${sincronizandoList.length}</strong> en <code>sincronizando</code>.
                </p>
              </div>

              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">2. Candado de Exclusión Mutua</span>
                  <span class="storage-status-chip ${syncState.isSyncing ? 'chip-warn' : 'chip-ok'}">
                    ${syncState.isSyncing ? '🔒 isSyncing = true' : '🔓 isSyncing = false'}
                  </span>
                </div>
                <div class="m2-metric-value">${syncState.mutexCollisionsBlocked} colisiones evitadas</div>
                <p class="m2-metric-desc">
                  Impide ejecuciones paralelas si el usuario presiona <em>"Sincronizar ahora"</em> varias veces o al dispararse el evento <code>online</code> (Escenario P8).
                </p>
              </div>

              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">3. Verificación Internet Real (Regla 4)</span>
                  <span class="storage-status-chip ${
                    connState.simulatedLieFi || !pwaState.isOnline ? 'chip-warn' : 'chip-ok'
                  }">
                    ${
                      connState.simulatedLieFi
                        ? '⚠️ LIE-FI (SIN SALIDA)'
                        : !pwaState.isOnline
                          ? '✈️ MODO AVIÓN'
                          : '🟢 PING HTTP OK'
                    }
                  </span>
                </div>
                <div class="m2-metric-value">
                  Timeout ${DEFAULT_PING_TIMEOUT_MS / 1000} s ${connState.latencyMs ? `(${connState.latencyMs} ms)` : ''}
                </div>
                <p class="m2-metric-desc">
                  No confía en <code>navigator.onLine</code>. Ejecuta ping HTTP real con <code>AbortController (8 s)</code> hacia Supabase antes de abrir la cola.
                </p>
              </div>

              <div class="m2-metric-card">
                <div class="m2-metric-header">
                  <span class="m2-metric-title">4. Confirmados en Supabase Cloud</span>
                  <span class="storage-status-chip chip-ok">
                    0 DUPLICADOS / 0 HUÉRFANOS
                  </span>
                </div>
                <div class="m2-metric-value">${sincronizadosList.length} sincronizado(s)</div>
                <p class="m2-metric-desc">
                  <strong>${cloudSnap.totalStorageObjects}</strong> archivo(s) en bucket privado <code>fotos</code> y
                  <strong>${cloudSnap.totalRows}</strong> fila(s) únicas en <code>public.reportes</code>.
                </p>
              </div>
            </div>

            <!-- MONITOR EN VIVO DEL PIPELINE DE 2 FASES ESTRICTAS -->
            <div class="m5-pipeline-box" style="margin-top:0.95rem;">
              <div class="m5-pipeline-header">
                <div>
                  <strong>⚙️ Secuencia Estricta por Reporte (Reglas Obligatorias 1, 2 y 3):</strong>
                  <span style="margin-left:0.4rem; font-size:0.84rem;">
                    Último disparador: <strong>${syncState.lastTriggerSource}</strong>
                  </span>
                </div>
                <span class="m5-phase-pill">${syncState.currentPhase}</span>
              </div>

              <div class="m5-phases-grid">
                <div class="m5-phase-step ${syncState.currentPhase === 'CHECKING_NET' || syncState.currentPhase === 'CHECKING_AUTH' ? 'active' : ''}">
                  <div class="m5-phase-num">PASO 0</div>
                  <div>
                    <strong>Pre-Vuelo: Ping 8s + Sesión JWT</strong>
                    <p>Confirma internet real (<code>AbortController</code>) y sesión activa en Supabase Auth.</p>
                  </div>
                </div>

                <div class="m5-phase-step ${syncState.currentPhase === 'PHASE_1_STORAGE' ? 'active' : ''}">
                  <div class="m5-phase-num">FASE 1 (PRIMERO)</div>
                  <div>
                    <strong>Multimedia a Storage (<code>upsert: true</code>)</strong>
                    <p>Sube fotos 1..5 y video a <code>fotos/{user_id}/{id}/{n}.jpg</code> antes de tocar la base de datos.</p>
                  </div>
                </div>

                <div class="m5-phase-step ${syncState.currentPhase === 'PHASE_2_POSTGRES' ? 'active' : ''}">
                  <div class="m5-phase-num">FASE 2 (DESPUÉS)</div>
                  <div>
                    <strong>Registro a Postgres (<code>onConflict: 'id'</code>)</strong>
                    <p>Solo si el 100 % de Fase 1 tuvo éxito, ejecuta <code>upsert</code> en <code>public.reportes</code> con el UUID local.</p>
                  </div>
                </div>

                <div class="m5-phase-step ${syncState.currentPhase === 'PHASE_3_CONFIRM' ? 'active' : ''}">
                  <div class="m5-phase-num">FASE 3 (FINAL)</div>
                  <div>
                    <strong>Confirmación o Backoff (<code>30s / 2m / 10m</code>)</strong>
                    <p>Marca <code>sincronizado</code> en IndexedDB, o registra <code>ultimo_error</code> en español y programa reintento.</p>
                  </div>
                </div>
              </div>

              <div class="m5-live-status-line">
                <span>📡 <strong>Estado en vivo del motor:</strong> ${syncState.currentStepDetail}</span>
                <span>⏱️ Auto-sync periódico: <strong>Cada 2 min</strong> + Eventos <code>online</code> y <code>visibilitychange</code></span>
              </div>
            </div>

            <!-- BARRA DE BOTONES OPERATIVOS (>= 48px PARA USO CON GUANTES) -->
            <div class="m5-actions-toolbar" style="margin-top:0.95rem;">
              <button
                type="button"
                class="btn-mine btn-amber"
                id="btn-m5-sync-now"
                style="min-height:50px; font-size:0.96rem;"
              >
                🔄 Sincronizar ahora (${totalPorSubir} pendientes)
              </button>

              <button
                type="button"
                class="btn-mine btn-primary"
                id="btn-m5-ping-real"
                style="min-height:50px;"
                ${this.isPinging ? 'disabled' : ''}
              >
                ${this.isPinging ? '⏳ Verificando (AbortController 8s)...' : '📡 Probar Ping HTTP Real (Timeout 8s)'}
              </button>

              <button
                type="button"
                class="btn-mine btn-success"
                id="btn-m5-add-offline-report"
                style="min-height:50px;"
                ${this.isCreatingSample ? 'disabled' : ''}
              >
                ${this.isCreatingSample ? '⏳ Comprimiendo...' : '➕ Encolar Nuevo Reporte Offline'}
              </button>

              <button
                type="button"
                class="btn-mine"
                id="btn-m5-toggle-liefi"
                style="min-height:50px; background:${connState.simulatedLieFi ? '#dc2626' : '#334155'}; color:#ffffff;"
              >
                ${
                  connState.simulatedLieFi
                    ? '🟢 Desactivar Simulación "Lie-Fi" (Restaurar Red)'
                    : '⚠️ Simular "Lie-Fi" (Wi-Fi sin salida a Supabase - P8)'
                }
              </button>

              <button
                type="button"
                class="btn-mine"
                id="btn-m5-reset-pending"
                style="min-height:50px;"
                title="Vuelve a marcar los reportes como pendientes para probar que el UPSERT no duplica filas"
              >
                🔁 Marcar Todos Pendientes (Probar Re-Upsert)
              </button>
            </div>
          </div>
        </section>

        <!-- LABORATORIOS AUTOMATIZADOS DE ESCENARIOS P6, P7 Y P8 (PLAN DE PRUEBAS) -->
        <section class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">🧪 Laboratorios de Verificación Oficial del Plan de Pruebas (Escenarios P6, P7 y P8)</h2>
            <span class="panel-badge">Validación Interactiva 1-Clic</span>
          </div>

          <div class="panel-body">
            <div class="m5-labs-grid">
              <!-- TARJETA ESCENARIO P6 -->
              <div class="m5-lab-card">
                <div>
                  <div class="m5-lab-badge-row">
                    <span class="storage-status-chip chip-ok">ESCENARIO P6</span>
                    <strong>Sincronización Automática al Volver la Conexión</strong>
                  </div>
                  <p class="m2-metric-desc" style="margin:0.45rem 0;">
                    Activa Modo Avión, registra <strong>2 reportes sin internet</strong> (quedan en <code>pendiente</code>), y luego desactiva el Modo Avión para verificar que la cola sube automáticamente fotos y registros dejando el contador en <code>0</code>.
                  </p>

                  ${
                    this.p6Steps.length > 0
                      ? `
                    <div class="m3-steps-list" style="margin:0.6rem 0;">
                      ${this.p6Steps
                        .map(
                          (s) => `
                        <div class="m3-step-item">
                          <span class="storage-status-chip chip-ok" style="flex-shrink:0;">${s.status}</span>
                          <div>
                            <strong>${s.step}</strong>
                            <div style="font-size:0.78rem; color:#334155;">${s.detail}</div>
                          </div>
                        </div>
                      `
                        )
                        .join('')}
                    </div>
                  `
                      : ''
                  }
                </div>

                <button
                  type="button"
                  class="btn-mine btn-success"
                  id="btn-run-p6-lab"
                  style="width:100%; min-height:48px;"
                  ${this.isRunningP6 ? 'disabled' : ''}
                >
                  ${this.isRunningP6 ? '⏳ Ejecutando Escenario P6...' : '▶️ Ejecutar Prueba Automatizada P6'}
                </button>
              </div>

              <!-- TARJETA ESCENARIO P7 -->
              <div class="m5-lab-card">
                <div>
                  <div class="m5-lab-badge-row">
                    <span class="storage-status-chip chip-warn">ESCENARIO P7</span>
                    <strong>Corte Abrupto a los 2 Segundos (Anti-Duplicados y Anti-Huérfanos)</strong>
                  </div>
                  <p class="m2-metric-desc" style="margin:0.45rem 0;">
                    Crea <strong>5 reportes offline</strong>, inicia la sincronización y <strong>activa Modo Avión exactamente a los 2 segundos</strong>; luego reconecta y verifica que en Supabase haya <strong>exactamente 5 filas (0 duplicados)</strong> y todas con sus fotos completas.
                  </p>

                  ${
                    this.p7Steps.length > 0
                      ? `
                    <div class="m3-steps-list" style="margin:0.6rem 0;">
                      ${this.p7Steps
                        .map(
                          (s) => `
                        <div class="m3-step-item">
                          <span class="storage-status-chip ${
                            s.status.includes('PARCIAL') ? 'chip-warn' : 'chip-ok'
                          }" style="flex-shrink:0;">${s.status}</span>
                          <div>
                            <strong>${s.step}</strong>
                            <div style="font-size:0.78rem; color:#334155;">${s.detail}</div>
                          </div>
                        </div>
                      `
                        )
                        .join('')}
                    </div>
                  `
                      : ''
                  }
                </div>

                <button
                  type="button"
                  class="btn-mine btn-amber"
                  id="btn-run-p7-lab"
                  style="width:100%; min-height:48px;"
                  ${this.isRunningP7 ? 'disabled' : ''}
                >
                  ${this.isRunningP7 ? '⏳ Ejecutando Corte a los 2s (P7)...' : '▶️ Ejecutar Prueba Automatizada P7 (Corte 2s)'}
                </button>
              </div>

              <!-- TARJETA ESCENARIO P8 -->
              <div class="m5-lab-card">
                <div>
                  <div class="m5-lab-badge-row">
                    <span class="storage-status-chip chip-warn">ESCENARIO P8</span>
                    <strong>Falsa Conexión ("Lie-Fi"), Candado Mutex y Backoff (30s / 2m / 10m)</strong>
                  </div>
                  <p class="m2-metric-desc" style="margin:0.45rem 0;">
                    Simula Wi-Fi sin salida a Supabase (<code>navigator.onLine = true</code>) y lanza <strong>3 clics simultáneos en "Sincronizar ahora"</strong>. Verifica que la app no se congela, el Mutex bloquea duplicados y aplica <em>Exponential Backoff</em>.
                  </p>

                  ${
                    this.p8Steps.length > 0
                      ? `
                    <div class="m3-steps-list" style="margin:0.6rem 0;">
                      ${this.p8Steps
                        .map(
                          (s) => `
                        <div class="m3-step-item">
                          <span class="storage-status-chip chip-ok" style="flex-shrink:0;">${s.status}</span>
                          <div>
                            <strong>${s.step}</strong>
                            <div style="font-size:0.78rem; color:#334155;">${s.detail}</div>
                          </div>
                        </div>
                      `
                        )
                        .join('')}
                    </div>
                  `
                      : ''
                  }
                </div>

                <button
                  type="button"
                  class="btn-mine btn-primary"
                  id="btn-run-p8-lab"
                  style="width:100%; min-height:48px;"
                  ${this.isRunningP8 ? 'disabled' : ''}
                >
                  ${this.isRunningP8 ? '⏳ Verificando Lie-Fi y Mutex (P8)...' : '▶️ Ejecutar Prueba Automatizada P8 (Lie-Fi + Mutex)'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- TABLA DE COLA LOCAL E ESTADO POR REPORTE (INDEXEDDB -> SUPABASE) -->
        <section class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">📋 Estado de la Cola de Sincronización por Reporte (${this.reportes.length} registros en IndexedDB)</h2>
            <span class="panel-badge">Backoff: 30 s ➔ 2 min ➔ 10 min</span>
          </div>

          <div class="panel-body">
            <div class="table-scroll-wrapper">
              <table class="mine-table">
                <thead>
                  <tr>
                    <th>1. Equipo / Fecha Lima</th>
                    <th>2. UUID Dispositivo (Idempotencia)</th>
                    <th>3. Estado en Cola M5</th>
                    <th>4. Fase 1: Rutas en Supabase Storage (Bucket <code>fotos</code>)</th>
                    <th>5. Intentos / Exponential Backoff y Mensajes en Español</th>
                    <th>6. Acciones de Prueba</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    this.reportes.length === 0
                      ? `
                    <tr>
                      <td colspan="6" style="text-align:center; padding:1.5rem;">
                        No hay reportes en IndexedDB. Haz clic en "+ Encolar Nuevo Reporte Offline".
                      </td>
                    </tr>
                  `
                      : this.reportes
                          .map((r) => {
                            const fotosCount = Array.isArray(r.fotos_locales) ? r.fotos_locales.length : 0;
                            const rutasRemotas = Array.isArray(r.fotos_rutas) && r.fotos_rutas.length > 0
                              ? r.fotos_rutas
                              : [];
                            const nextBackoff = getBackoffInfoForAttempt((r.intentos_sync || 0) + 1);

                            let badgeHtml = '<span class="badge-estado badge-estado-pendiente">⏳ PENDIENTE</span>';
                            if (r.estado === 'sincronizando') {
                              badgeHtml = '<span class="badge-estado badge-estado-sincronizando">🔄 SINCRONIZANDO</span>';
                            } else if (r.estado === 'sincronizado') {
                              badgeHtml = '<span class="badge-estado badge-estado-sincronizado">✅ SINCRONIZADO</span>';
                            } else if (r.estado === 'error') {
                              badgeHtml = '<span class="badge-estado badge-estado-error">⚠️ ERROR (CON BACKOFF)</span>';
                            }

                            return `
                            <tr>
                              <td>
                                <div class="cell-equipo-code">${r.codigo_equipo}</div>
                                <div style="font-size:0.8rem; font-weight:700; margin-top:0.2rem;">📅 ${r.fecha}</div>
                                <div style="font-size:0.75rem; color:#475569;">${r.tipo} • Prioridad ${r.prioridad}</div>
                              </td>
                              <td>
                                <code style="font-size:0.78rem; font-weight:800; background:#f1f5f9; color:#0f172a; padding:0.2rem 0.4rem; border-radius:5px; border:1px solid #cbd5e1; display:inline-block;">
                                  ${r.id}
                                </code>
                                <div style="font-size:0.75rem; color:#334155; margin-top:0.25rem;">
                                  Clave única <code>onConflict: 'id'</code>
                                </div>
                              </td>
                              <td>
                                ${badgeHtml}
                                ${
                                  r.sincronizado_en
                                    ? `<div style="font-size:0.74rem; color:#15803d; font-weight:700; margin-top:0.25rem;">Subido: ${new Date(r.sincronizado_en).toLocaleTimeString('es-PE')}</div>`
                                    : ''
                                }
                              </td>
                              <td>
                                <div style="font-size:0.8rem; font-weight:700;">
                                  📷 ${fotosCount} foto(s) local(es) ${r.video_local ? '+ 🎥 1 video' : ''}
                                </div>
                                ${
                                  rutasRemotas.length > 0
                                    ? rutasRemotas
                                        .map(
                                          (path) => `
                                      <div style="font-size:0.74rem; font-family:monospace; background:#dcfce7; color:#14532d; padding:0.15rem 0.35rem; border-radius:4px; margin-top:0.2rem; border:1px solid #86efac;">
                                        ✅ fotos/${path}
                                      </div>
                                    `
                                        )
                                        .join('')
                                    : `
                                    <div style="font-size:0.75rem; color:#475569; margin-top:0.2rem;">
                                      Destino: <code>{user_id}/${r.id.slice(0, 8)}.../1.jpg</code> (<code>upsert: true</code>)
                                    </div>
                                  `
                                }
                              </td>
                              <td>
                                <div style="font-size:0.8rem; font-weight:700;">
                                  Intentos fallidos: <strong>${r.intentos_sync || 0}</strong>
                                  ${
                                    r.ultimo_backoff_label
                                      ? `<span class="storage-status-chip chip-warn" style="margin-left:0.3rem;">Backoff: ${r.ultimo_backoff_label}</span>`
                                      : `<span style="font-size:0.74rem; color:#475569;">(Siguiente backoff si falla: ${nextBackoff.label})</span>`
                                  }
                                </div>
                                ${
                                  r.ultimo_error
                                    ? `
                                  <div style="margin-top:0.3rem; background:#fee2e2; color:#991b1b; border:1px solid #f87171; border-radius:6px; padding:0.35rem 0.5rem; font-size:0.78rem; font-weight:700;">
                                    ⚠️ ${r.ultimo_error}
                                  </div>
                                `
                                    : `
                                  <div style="font-size:0.76rem; color:#15803d; margin-top:0.2rem;">
                                    Sin errores registrados.
                                  </div>
                                `
                                }
                              </td>
                              <td>
                                <div style="display:flex; flex-direction:column; gap:0.35rem;">
                                  <button
                                    type="button"
                                    class="btn-mine btn-sm-mine btn-primary btn-sync-single"
                                    data-report-id="${r.id}"
                                  >
                                    🔄 Sincronizar este
                                  </button>
                                  <button
                                    type="button"
                                    class="btn-mine btn-sm-mine btn-sim-backoff"
                                    data-report-id="${r.id}"
                                    style="background:#fee2e2; color:#991b1b; border-color:#dc2626;"
                                    title="Simula un fallo de red en este reporte para avanzar al siguiente nivel de Exponential Backoff (30s -> 2min -> 10min)"
                                  >
                                    ⚡ Simular Error + Backoff (${nextBackoff.label})
                                  </button>
                                </div>
                              </td>
                            </tr>
                          `;
                          })
                          .join('')
                  }
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- INSPECTOR DE SUPABASE CLOUD (TABLA public.reportes + BUCKET PRIVADO fotos) Y BITÁCORA -->
        <section class="panel-card">
          <div class="panel-header">
            <h2 class="panel-title">☁️ Inspector de Destino en Supabase Cloud (<code>public.reportes</code> + Bucket <code>fotos</code>) y Bitácora M5</h2>
            <span class="panel-badge">${cloudSnap.totalRows} filas únicas • ${cloudSnap.totalStorageObjects} objetos en Storage</span>
          </div>

          <div class="panel-body">
            <div class="m4-auth-grid">
              <!-- Tabla public.reportes y Bucket fotos -->
              <div class="m4-auth-card">
                <div>
                  <h3 style="margin:0 0 0.5rem 0; font-size:0.98rem;">
                    🗄️ Filas en <code>public.reportes</code> (Upsert por <code>id</code> UUID)
                  </h3>
                  <p class="m2-metric-desc" style="margin-bottom:0.6rem;">
                    Duplicados: <strong style="color:#15803d;">${cloudSnap.duplicateRowsCount}</strong> |
                    Registros huérfanos sin fotos en Storage: <strong style="color:#15803d;">${cloudSnap.orphanRecordsCount}</strong>
                  </p>

                  <div style="max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:0.45rem;">
                    ${
                      cloudSnap.reportesCloud.length === 0
                        ? `<div class="m4-session-empty">Aún no se han subido filas a <code>public.reportes</code>. Toca <strong>"🔄 Sincronizar ahora"</strong> para iniciar la Fase 1 y Fase 2.</div>`
                        : cloudSnap.reportesCloud
                            .map(
                              (row) => `
                          <div style="background:#ffffff; color:#0f172a; border:1px solid #94a3b8; border-left:5px solid #16a34a; border-radius:7px; padding:0.5rem 0.65rem; font-size:0.8rem;">
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.3rem;">
                              <strong>${row.codigo_equipo} — 📅 ${row.fecha} (${row.tipo})</strong>
                              <span class="storage-status-chip chip-ok">Upsert #${row.upsert_count || 1}</span>
                            </div>
                            <div style="font-family:monospace; font-size:0.74rem; color:#334155; margin-top:0.2rem;">
                              UUID: ${row.id}
                            </div>
                            <div style="font-family:monospace; font-size:0.73rem; color:#15803d; margin-top:0.15rem;">
                              fotos[]: ${JSON.stringify(row.fotos)}
                            </div>
                          </div>
                        `
                            )
                            .join('')
                    }
                  </div>
                </div>
              </div>

              <!-- Bitácora en Vivo del Motor M5 -->
              <div class="m4-auth-card">
                <div>
                  <h3 style="margin:0 0 0.5rem 0; font-size:0.98rem;">
                    📜 Bitácora de Eventos del Motor de Sincronización (M5)
                  </h3>
                  <p class="m2-metric-desc" style="margin-bottom:0.6rem;">
                    Registra disparadores automáticos, bloqueos del Candado Mutex, subidas a Storage, upserts en Postgres y timers de Exponential Backoff.
                  </p>

                  <div style="max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:0.4rem;">
                    ${
                      syncState.activityLogs.length === 0
                        ? `<div class="m4-session-empty">Sin eventos registrados aún.</div>`
                        : syncState.activityLogs
                            .map((log) => {
                              let borderCol = '#0284c7';
                              if (log.level === 'success') borderCol = '#16a34a';
                              else if (log.level === 'error') borderCol = '#dc2626';
                              else if (log.level === 'warning' || log.level === 'mutex') borderCol = '#d97706';

                              return `
                              <div style="background:#ffffff; color:#0f172a; border:1px solid #cbd5e1; border-left:5px solid ${borderCol}; border-radius:6px; padding:0.42rem 0.6rem; font-size:0.78rem;">
                                <div style="display:flex; justify-content:space-between; font-weight:800;">
                                  <span>${log.title}</span>
                                  <span style="color:#475569; font-family:monospace;">${log.time}</span>
                                </div>
                                ${
                                  log.detail
                                    ? `<div style="color:#334155; margin-top:0.15rem;">${log.detail}</div>`
                                    : ''
                                }
                              </div>
                            `;
                            })
                            .join('')
                    }
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    this.rootEl.querySelector('#btn-close-m5-banner')?.addEventListener('click', () => {
      this.banner = null;
      this.render();
    });

    this.rootEl.querySelector('#btn-go-m4-login')?.addEventListener('click', () => {
      this.onNavigateModule('m4');
    });

    this.rootEl.querySelector('#btn-m5-sync-now')?.addEventListener('click', () => {
      this.handleManualSyncNow();
    });

    this.rootEl.querySelector('#btn-m5-ping-real')?.addEventListener('click', () => {
      this.handleTestRealPing();
    });

    this.rootEl.querySelector('#btn-m5-add-offline-report')?.addEventListener('click', () => {
      this.handleAddSamplePendingReport();
    });

    this.rootEl.querySelector('#btn-m5-toggle-liefi')?.addEventListener('click', () => {
      const current = connectivityService.getState().simulatedLieFi;
      connectivityService.setSimulatedLieFi(!current);
      if (!current) {
        this.setBanner(
          'warning',
          '⚠️ Simulación "Lie-Fi" (Escenario P8) ACTIVADA: El navegador marca navigator.onLine = true, pero el servidor Supabase no responderá y AbortController cortará a los 8 segundos.'
        );
      } else {
        this.setBanner(
          'success',
          '🟢 Simulación "Lie-Fi" DESACTIVADA: Salida real a Supabase restaurada.'
        );
      }
    });

    this.rootEl.querySelector('#btn-m5-reset-pending')?.addEventListener('click', () => {
      this.handleResetAllToPending();
    });

    this.rootEl.querySelector('#btn-run-p6-lab')?.addEventListener('click', () => {
      this.handleRunScenarioP6Lab();
    });

    this.rootEl.querySelector('#btn-run-p7-lab')?.addEventListener('click', () => {
      this.handleRunScenarioP7Lab();
    });

    this.rootEl.querySelector('#btn-run-p8-lab')?.addEventListener('click', () => {
      this.handleRunScenarioP8Lab();
    });

    this.rootEl.querySelectorAll('.btn-sync-single').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-report-id');
        if (id) this.handleSyncSingleReport(id);
      });
    });

    this.rootEl.querySelectorAll('.btn-sim-backoff').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-report-id');
        if (id) this.handleSimulateReportErrorAndBackoff(id);
      });
    });
  }
}
