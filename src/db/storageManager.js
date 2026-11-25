/**
 * Gestión de almacenamiento persistente (M2) y cálculo de cuota y peso real en IndexedDB
 */

export async function checkPersistentStorageStatus() {
  if (navigator.storage && navigator.storage.persisted) {
    try {
      return await navigator.storage.persisted();
    } catch {
      return false;
    }
  }
  return false;
}

export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persisted();
      if (isPersisted) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function getStorageUsageEstimate() {
  const isPersisted = await checkPersistentStorageStatus();
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return {
        isPersisted,
        usageBytes: usage,
        quotaBytes: quota,
        usageMB: (usage / (1024 * 1024)).toFixed(2),
        quotaMB: (quota / (1024 * 1024)).toFixed(0),
        percent: quota > 0 ? Math.min(100, Number(((usage / quota) * 100).toFixed(2))) : 0
      };
    } catch {
      return { isPersisted, usageBytes: 0, quotaBytes: 0, usageMB: '0.00', quotaMB: '0', percent: 0 };
    }
  }
  return { isPersisted, usageBytes: 0, quotaBytes: 0, usageMB: '0.00', quotaMB: '0', percent: 0 };
}

export function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * Calcula el desglose exacto de peso multimedia guardado en IndexedDB (reportes + seguimientos)
 * y el ahorro logrado por la compresión previa al guardado (M2 / Escenario P3).
 */
export function calculateReportMediaMetrics(reporte) {
  const fotosIniciales = Array.isArray(reporte?.fotos_locales) ? reporte.fotos_locales : [];
  const seguimientos = Array.isArray(reporte?.seguimientos) ? reporte.seguimientos : [];

  let fotosCount = 0;
  let fotosCompressedBytes = 0;
  let fotosOriginalBytes = 0;
  let videosCount = 0;
  let videosBytes = 0;

  for (const f of fotosIniciales) {
    fotosCount += 1;
    const comp = f.peso_bytes || f.blob?.size || 0;
    const orig = f.peso_original_bytes || comp;
    fotosCompressedBytes += comp;
    fotosOriginalBytes += orig;
  }

  if (reporte?.video_local) {
    videosCount += 1;
    videosBytes += reporte.video_local.peso_bytes || reporte.video_local.blob?.size || 0;
  }

  if (reporte?.audio_local) {
    videosBytes += reporte.audio_local.peso_bytes || reporte.audio_local.blob?.size || 0;
  }

  for (const seg of seguimientos) {
    const segFotos = Array.isArray(seg.fotos_locales) ? seg.fotos_locales : [];
    for (const sf of segFotos) {
      fotosCount += 1;
      const comp = sf.peso_bytes || sf.blob?.size || 0;
      const orig = sf.peso_original_bytes || comp;
      fotosCompressedBytes += comp;
      fotosOriginalBytes += orig;
    }
    if (seg.video_local) {
      videosCount += 1;
      videosBytes += seg.video_local.peso_bytes || seg.video_local.blob?.size || 0;
    }
    if (seg.audio_local) {
      videosBytes += seg.audio_local.peso_bytes || seg.audio_local.blob?.size || 0;
    }
  }

  const totalCompressedBytes = fotosCompressedBytes + videosBytes;
  const savedBytes = Math.max(0, fotosOriginalBytes - fotosCompressedBytes);
  const savingsPercent =
    fotosOriginalBytes > 0 ? Math.round((savedBytes / fotosOriginalBytes) * 100) : 0;

  return {
    fotosCount,
    videosCount,
    fotosCompressedBytes,
    fotosOriginalBytes,
    videosBytes,
    totalCompressedBytes,
    savedBytes,
    savingsPercent
  };
}

export function calculateAllReportsStorageMetrics(reportes = []) {
  let totalFotos = 0;
  let totalVideos = 0;
  let totalFotosBytes = 0;
  let totalOriginalFotosBytes = 0;
  let totalVideosBytes = 0;

  for (const rep of reportes) {
    const m = calculateReportMediaMetrics(rep);
    totalFotos += m.fotosCount;
    totalVideos += m.videosCount;
    totalFotosBytes += m.fotosCompressedBytes;
    totalOriginalFotosBytes += m.fotosOriginalBytes;
    totalVideosBytes += m.videosBytes;
  }

  const totalIndexedDbMediaBytes = totalFotosBytes + totalVideosBytes;
  const totalSavedBytes = Math.max(0, totalOriginalFotosBytes - totalFotosBytes);
  const totalSavingsPercent =
    totalOriginalFotosBytes > 0
      ? Math.round((totalSavedBytes / totalOriginalFotosBytes) * 100)
      : 0;

  return {
    totalReportes: reportes.length,
    totalFotos,
    totalVideos,
    totalFotosBytes,
    totalOriginalFotosBytes,
    totalVideosBytes,
    totalIndexedDbMediaBytes,
    totalSavedBytes,
    totalSavingsPercent
  };
}
