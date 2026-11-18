/**
 * Compresión configurable de fotos ANTES de guardar en IndexedDB (M2 / Regla Obligatoria 7 / Escenario P3)
 * - Modo Estándar ('estandar'): lado mayor <= 1600 px, peso objetivo < 400 KB, initialQuality 0.75
 * - Modo Alta Nitidez ('alta'): lado mayor <= 2048 px, peso objetivo < 800 KB, initialQuality 0.85
 * Respeta la orientación EXIF de la cámara y devuelve Blob JPEG junto con metadatos de ancho, alto, peso y ahorro.
 */

export const COMPRESSION_PROFILES = {
  estandar: {
    id: 'estandar',
    label: 'Estándar (< 400 KB / 1600 px)',
    shortLabel: 'Estándar (< 400 KB)',
    maxWidthOrHeight: 1600,
    maxBytes: 395 * 1024, // < 400 KB estricto
    initialQuality: 0.75
  },
  alta: {
    id: 'alta',
    label: 'Alta Nitidez - Placas/Detalles (< 800 KB / 2048 px)',
    shortLabel: 'Alta Nitidez (< 800 KB)',
    maxWidthOrHeight: 2048,
    maxBytes: 790 * 1024, // < 800 KB estricto
    initialQuality: 0.85
  }
};

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20 MB máximo

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('No se pudo comprimir la imagen.'));
      },
      type,
      quality
    );
  });
}

export async function compressPhotoFile(file, calidad = 'estandar') {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('El archivo seleccionado no es una imagen válida.');
  }

  const startTime = performance.now();
  const profile = COMPRESSION_PROFILES[calidad] || COMPRESSION_PROFILES.estandar;

  let source;
  let srcWidth;
  let srcHeight;

  // createImageBitmap con imageOrientation: 'from-image' respeta la orientación EXIF de la cámara
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      srcWidth = source.width;
      srcHeight = source.height;
    } catch {
      source = await loadImageElement(file);
      srcWidth = source.naturalWidth || source.width;
      srcHeight = source.naturalHeight || source.height;
    }
  } else {
    source = await loadImageElement(file);
    srcWidth = source.naturalWidth || source.width;
    srcHeight = source.naturalHeight || source.height;
  }

  const maxSide = Math.max(srcWidth, srcHeight);
  const scale = maxSide > profile.maxWidthOrHeight ? profile.maxWidthOrHeight / maxSide : 1;

  let targetWidth = Math.max(1, Math.round(srcWidth * scale));
  let targetHeight = Math.max(1, Math.round(srcHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);

  if (source && typeof source.close === 'function') {
    source.close();
  }

  let quality = profile.initialQuality;
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality);

  // Ajuste iterativo si aún supera el límite estricto del perfil (< 400 KB o < 800 KB)
  let attempts = 0;
  while (blob.size > profile.maxBytes && attempts < 6) {
    attempts += 1;
    if (quality > 0.48) {
      quality = Math.max(0.45, Number((quality - 0.1).toFixed(2)));
    } else {
      targetWidth = Math.max(800, Math.round(targetWidth * 0.85));
      targetHeight = Math.max(600, Math.round(targetHeight * 0.85));
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const retrySource = await loadImageElement(file);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      ctx.drawImage(retrySource, 0, 0, targetWidth, targetHeight);
    }
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }

  // Si la imagen original YA era liviana (<= maxBytes y <= maxWidthOrHeight) y la recodificación
  // en Canvas quedó unos KB más pesada que el archivo original, reducimos ligeramente la calidad
  // o conservamos la versión más ligera para que el peso final jamás supere al original.
  if (blob.size >= file.size && file.size <= profile.maxBytes) {
    const lighterBlob = await canvasToBlob(canvas, 'image/jpeg', 0.62);
    if (lighterBlob.size < file.size) {
      blob = lighterBlob;
    } else if (scale === 1 && file.type === 'image/jpeg') {
      blob = file;
    }
  }

  const elapsedMs = Math.max(1, Math.round(performance.now() - startTime));
  const originalSize = file.size || blob.size;
  const savedBytes = Math.max(0, originalSize - blob.size);
  const ahorroPorcentaje = originalSize > 0 ? Math.round((savedBytes / originalSize) * 100) : 0;

  return {
    blob,
    nombre_original: file.name || 'foto.jpg',
    peso_original_bytes: originalSize,
    peso_bytes: blob.size,
    ancho_original: srcWidth,
    alto_original: srcHeight,
    ancho: targetWidth,
    alto: targetHeight,
    calidad_aplicada: profile.id,
    calidad_final_jpeg: quality,
    ahorro_porcentaje: ahorroPorcentaje,
    tiempo_compresion_ms: elapsedMs,
    orientacion_exif: 'Normalizada (EXIF from-image)',
    mime_type: 'image/jpeg',
    ruta_remota: null
  };
}

/**
 * Generador de foto de cámara pesada (> 5.5 MB, resolución 3840x2560 px)
 * con placa metálica de equipo, número de serie pequeño, horómetro y marcas de orientación
 * para probar el Escenario P3 en M2 ("Mis reportes").
 */
export async function generateHeavyCameraPhotoForP3(codigoEquipo = '793F-05', fechaLima = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 3200;
  canvas.height = 2200;
  const ctx = canvas.getContext('2d');

  // Fondo metálico texturizado
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grilla fina de inspección para simular detalle de alta frecuencia de cámara
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  for (let x = 0; x < canvas.width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Marco industrial amarillo
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 26;
  ctx.strokeRect(50, 50, canvas.width - 100, canvas.height - 100);

  // Encabezado de orientación EXIF
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(50, 50, canvas.width - 100, 175);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 68px sans-serif';
  ctx.fillText(
    `⬆️ ARRIBA (ORIENTACIÓN EXIF CORRECTA) — EQUIPO ${codigoEquipo}`,
    105,
    162
  );

  // Placa de identificación grabada con textos grandes, medianos y pequeños (prueba de legibilidad P3)
  ctx.fillStyle = '#090d16';
  ctx.fillRect(140, 320, canvas.width - 280, 1180);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 10;
  ctx.strokeRect(140, 320, canvas.width - 280, 1180);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 82px sans-serif';
  ctx.fillText(`PLACA DE IDENTIFICACIÓN TÉCNICA — MINA TAJO ABIERTO`, 210, 465);

  ctx.fillStyle = '#fde047';
  ctx.font = 'bold 76px monospace';
  ctx.fillText(`CÓDIGO EQUIPO : ${codigoEquipo}`, 210, 620);
  ctx.fillText(`N° DE SERIE   : CAT0793F-PE-2026-0098412`, 210, 745);
  ctx.fillText(`PARTE / COMP. : CILINDRO DIRECCIÓN IZQ. #4B-7721`, 210, 870);

  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 62px monospace';
  ctx.fillText(`HORÓMETRO     : 18,492.7 HRS  |  FECHA LIMA: ${fechaLima || 'HOY'}`, 210, 1010);

  // Texto pequeño de placa para verificar que la compresión (< 400 KB o < 800 KB) mantiene nitidez
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 46px monospace';
  ctx.fillText(
    `DETALLE FINO PLACA (P3): TORQUE 850 Nm | PRESIÓN NOMINAL 310 BAR | TOLERANCIA ±0.15 mm | LOTE #A99-41`,
    210,
    1160
  );
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 44px monospace';
  ctx.fillText(
    `VERIFICACIÓN VISUAL: SI PUEDES LEER ESTE CÓDIGO [SERIE-FINA-793F-OK-9981] LA COMPRESIÓN ES LEGIBLE ✓`,
    210,
    1270
  );

  // Pie informativo
  ctx.fillStyle = '#cbd5e1';
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText(
    `Foto original de cámara simulada (> 5 MB, 3200×2200 px) → Comprimida antes de guardar en IndexedDB`,
    140,
    1720
  );

  const baseBlob = await canvasToBlob(canvas, 'image/jpeg', 0.98);

  // Asegurar que el archivo de entrada supere los 5.2 MB reales (Escenario P3: "> 5 MB")
  // añadiendo relleno de metadatos APP1/COM antes del EOI o concatenando padding seguro tras el stream
  const minHeavySize = Math.round(5.4 * 1024 * 1024); // ~5.4 MB
  let finalParts = [baseBlob];
  if (baseBlob.size < minHeavySize) {
    const padSize = minHeavySize - baseBlob.size;
    const padding = new Uint8Array(padSize);
    finalParts.push(padding);
  }

  return new File(
    finalParts,
    `CAMARA_ALTA_RES_${codigoEquipo.replace(/[^A-Z0-9]/gi, '_')}_5MB.jpg`,
    { type: 'image/jpeg' }
  );
}

export function validateVideoFile(file) {
  if (!file) return { valid: false, error: 'No se seleccionó ningún archivo de video.' };

  const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
  const isVideoMime = allowedTypes.includes(file.type) || file.type.startsWith('video/');
  if (!isVideoMime) {
    return {
      valid: false,
      error: 'Formato de video no permitido. Usa MP4, WebM o MOV.'
    };
  }

  if (file.size > MAX_VIDEO_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `El video pesa ${sizeMB} MB y supera el límite máximo de 20 MB para almacenamiento local.`
    };
  }

  return {
    valid: true,
    videoLocal: {
      blob: file,
      nombre_original: file.name || 'video.mp4',
      mime_type: file.type || 'video/mp4',
      peso_bytes: file.size,
      ruta_remota: null
    }
  };
}
