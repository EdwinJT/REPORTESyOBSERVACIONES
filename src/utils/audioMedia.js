/**
 * Utilidades de Grabación de Audio Opcional (Notas de Voz en Campo) y
 * Empaquetado Retrocompatible de Multimedia (Video + Audio) para Supabase.
 *
 * - Permite grabar audio opcional con MediaRecorder (WebM/Opus, MP4/AAC, Ogg)
 *   en PC, Android e iOS sin bloquear la escritura ni requerir migración SQL.
 * - Empaqueta `video` + `audio` en el campo `video` de `public.reportes`:
 *   si solo hay video, guarda el string de ruta normal; si hay audio, guarda JSON.
 */

export const MAX_AUDIO_DURATION_SEC = 120; // 2 minutos máx. por nota de voz
export const MAX_AUDIO_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB máx.

/**
 * Empaqueta la ruta de video opcional y la ruta de audio opcional en un solo valor
 * compatible con la columna `video text NULL` de `public.reportes`.
 */
export function packVideoAudioField(videoPath = null, audioPath = null, audioDurationSec = 0) {
  const cleanVideo = videoPath ? String(videoPath).trim() : null;
  const cleanAudio = audioPath ? String(audioPath).trim() : null;
  if (!cleanAudio) {
    return cleanVideo || null;
  }
  return JSON.stringify({
    video: cleanVideo || null,
    audio: cleanAudio,
    audio_duracion_seg: Math.max(0, Math.round(Number(audioDurationSec) || 0))
  });
}

/**
 * Desempaqueta la columna `video` de `public.reportes` (string de ruta o JSON).
 */
export function unpackVideoAudioField(rawVideoField) {
  if (!rawVideoField || typeof rawVideoField !== 'string') {
    return { videoPath: null, audioPath: null, audioDurationSec: 0 };
  }
  const trimmed = rawVideoField.trim();
  if (!trimmed) {
    return { videoPath: null, audioPath: null, audioDurationSec: 0 };
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return {
          videoPath: typeof parsed.video === 'string' && parsed.video.trim() ? parsed.video.trim() : null,
          audioPath: typeof parsed.audio === 'string' && parsed.audio.trim() ? parsed.audio.trim() : null,
          audioDurationSec: Math.max(0, Math.round(Number(parsed.audio_duracion_seg) || 0))
        };
      }
    } catch {
      // Si no es JSON válido, tratar como ruta directa de video
    }
  }
  return { videoPath: trimmed, audioPath: null, audioDurationSec: 0 };
}

/**
 * Selecciona el mejor MIME de audio soportado por MediaRecorder en el navegador actual.
 */
export function pickSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // continuar
    }
  }
  return '';
}

/**
 * Determina la extensión de archivo a partir del MIME type de audio.
 */
export function getAudioExtensionFromMime(mimeType = '') {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * Formatea una duración en segundos como MM:SS (ej. 00:14).
 */
export function formatAudioDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Controlador reutilizable de grabación de audio con limpieza automática de micrófono.
 */
export class AudioRecorderController {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.timerId = null;
    this.startedAtMs = 0;
    this.elapsedSec = 0;
    this.isRecording = false;
    this.mimeType = '';
  }

  _cleanupResources() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.stream) {
      try {
        this.stream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      this.stream = null;
    }
    this.mediaRecorder = null;
    this.isRecording = false;
  }

  async start({ onTick, onAutoStop, maxDurationSec = MAX_AUDIO_DURATION_SEC } = {}) {
    if (this.isRecording) {
      this.cancel();
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      throw new Error(
        'Tu navegador no soporta grabación directa de audio. Usa Chrome, Edge o Safari actualizado en HTTPS.'
      );
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error(
          'Permiso de micrófono denegado. Habilita el micrófono en la barra del navegador e intenta de nuevo.'
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new Error('No se detectó ningún micrófono disponible en este dispositivo.');
      }
      throw new Error(err?.message || 'No se pudo iniciar el micrófono.');
    }

    const preferredMime = pickSupportedAudioMimeType();
    let recorder = null;
    try {
      recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime, audioBitsPerSecond: 48000 })
        : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }

    this.stream = stream;
    this.mediaRecorder = recorder;
    this.mimeType = recorder.mimeType || preferredMime || 'audio/webm';
    this.chunks = [];
    this.startedAtMs = Date.now();
    this.elapsedSec = 0;
    this.isRecording = true;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    };

    recorder.start(250);

    this.timerId = setInterval(() => {
      this.elapsedSec = Math.max(1, Math.floor((Date.now() - this.startedAtMs) / 1000));
      if (typeof onTick === 'function') {
        onTick(this.elapsedSec);
      }
      if (this.elapsedSec >= maxDurationSec && this.isRecording) {
        if (typeof onAutoStop === 'function') {
          onAutoStop();
        }
      }
    }, 500);
  }

  async stop() {
    if (!this.isRecording || !this.mediaRecorder) {
      this._cleanupResources();
      return null;
    }

    const recorder = this.mediaRecorder;
    const durationSec = Math.max(1, Math.round((Date.now() - this.startedAtMs) / 1000));
    const mimeType = this.mimeType || recorder.mimeType || 'audio/webm';

    const blob = await new Promise((resolve) => {
      const finalize = () => {
        const resultBlob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        this._cleanupResources();
        resolve(resultBlob);
      };

      if (recorder.state === 'inactive') {
        finalize();
        return;
      }

      recorder.onstop = finalize;
      try {
        recorder.stop();
      } catch {
        finalize();
      }
    });

    if (!blob || blob.size === 0) {
      throw new Error('La grabación quedó vacía. Intenta hablar unos segundos antes de detener.');
    }

    if (blob.size > MAX_AUDIO_SIZE_BYTES) {
      throw new Error('El audio grabado supera el límite de 10 MB.');
    }

    return {
      blob,
      mime_type: blob.type || mimeType,
      peso_bytes: blob.size,
      duracion_seg: durationSec,
      ruta_remota: null,
      signedUrl: ''
    };
  }

  cancel() {
    const recorder = this.mediaRecorder;
    this.chunks = [];
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.onstop = null;
        recorder.stop();
      } catch {
        // ignore
      }
    }
    this._cleanupResources();
  }
}
