/**
 * Generador de reportes iniciales de demostración en IndexedDB (solo si la tabla está vacía)
 * para visualizar de inmediato la Tabla Principal Operativa con sus 7 columnas
 * y las subsecciones de seguimiento alineadas (📌 Inicial y ↳ Seguimiento).
 */

import { localDb } from '../../db/localDb.js';
import { getFechaHoyPeru } from '../../utils/datePeru.js';

function createSyntheticPlateBlob({ codigo, titulo, subtitulo, fecha, bgColor = '#1e293b', accentColor = '#f59e0b' }) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');

    // Fondo industrial
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Marco metálico de placa
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 10;
    ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);

    // Franja superior
    ctx.fillStyle = accentColor;
    ctx.fillRect(24, 24, canvas.width - 48, 86);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(`PLACA / EVIDENCIA DE CAMPO — ${codigo}`, 52, 80);

    // Cuerpo de evidencia
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText(titulo, 56, 200);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '28px sans-serif';
    ctx.fillText(subtitulo, 56, 265);

    // Simulación de serie / horómetro legible (Escenario P3)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(56, 320, 848, 150);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.strokeRect(56, 320, 848, 150);

    ctx.fillStyle = '#fde047';
    ctx.font = 'bold 32px monospace';
    ctx.fillText(`SERIE: CAT-${codigo}-98412-PE   |   HORÓMETRO: 14,820.5 HRS`, 80, 382);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '26px monospace';
    ctx.fillText(`FECHA LIMA (UTC-5): ${fecha}   |   INSPECCIÓN VISUAL OK`, 80, 435);

    // Pie
    ctx.fillStyle = '#94a3b8';
    ctx.font = '22px sans-serif';
    ctx.fillText('M1 — Evidencia comprimida en dispositivo (Offline-First IndexedDB)', 56, 565);

    canvas.toBlob(
      (blob) => {
        resolve({
          blob,
          nombre_original: `${codigo}_${fecha}.jpg`,
          peso_original_bytes: 1850400,
          peso_bytes: blob ? blob.size : 68400,
          ancho: canvas.width,
          alto: canvas.height,
          calidad_aplicada: 'estandar',
          mime_type: 'image/jpeg',
          ruta_remota: null
        });
      },
      'image/jpeg',
      0.82
    );
  });
}

export async function ensureDemoReportsIfEmpty() {
  const count = await localDb.reportes.count();
  if (count > 0) return;

  const hoyPeru = getFechaHoyPeru();

  const fotoInicial793 = await createSyntheticPlateBlob({
    codigo: '793F-05',
    titulo: 'Fisura leve en soporte de cilindro dirección izq.',
    subtitulo: 'Inspección inicial en cambio de guardia — Tajo Norte',
    fecha: '2026-11-15',
    bgColor: '#1e293b',
    accentColor: '#f59e0b'
  });

  const fotoSeg793 = await createSyntheticPlateBlob({
    codigo: '793F-05',
    titulo: 'Seguimiento: Fisura marcada con tiza penetrante',
    subtitulo: 'Se mantiene bajo monitoreo hasta parada programada',
    fecha: hoyPeru,
    bgColor: '#31102f',
    accentColor: '#fb7185'
  });

  const fotoInicialPala = await createSyntheticPlateBlob({
    codigo: 'PALA-02',
    titulo: 'Desgaste en dientes de cuchara #3 y #4',
    subtitulo: 'Lectura de serie y espesor de labio frontal',
    fecha: hoyPeru,
    bgColor: '#0f291e',
    accentColor: '#34d399'
  });

  const demo1 = {
    id: crypto.randomUUID(),
    codigo_equipo: '793F-05',
    es_nuevo_codigo: false,
    fecha: '2026-11-15',
    tipo: 'Observación',
    prioridad: 'Alta',
    observacion: 'Se detecta fisura superficial de 3 cm en soporte de cilindro de dirección izquierdo. Placa y serie legibles.',
    calidad_compresion: 'alta',
    fotos_locales: [{ indice: 1, ...fotoInicial793 }],
    video_local: null,
    seguimientos: [
      {
        id: crypto.randomUUID(),
        fecha: hoyPeru,
        estado_seguimiento: 'Sigue observación',
        comentario: 'Se aplicó líquido penetrante en guardia diurna; longitud no creció (3 cm). Programado soldadura en PM.',
        fotos_locales: [{ indice: 1, ...fotoSeg793 }],
        video_local: null
      }
    ],
    fotos_rutas: [],
    video_ruta: null,
    estado: 'pendiente',
    ultimo_error: null,
    intentos_sync: 0,
    creado_por: null,
    creado_en: new Date(Date.now() - 86400000).toISOString(),
    actualizado_en: new Date().toISOString(),
    dispositivo: 'PC / Demo Local'
  };

  const demo2 = {
    id: crypto.randomUUID(),
    codigo_equipo: 'PALA-02',
    es_nuevo_codigo: false,
    fecha: hoyPeru,
    tipo: 'Reporte',
    prioridad: 'Media',
    observacion: 'Inspección operativa de dientes de cuchara #3 y #4. Operativa para el turno actual.',
    calidad_compresion: 'estandar',
    fotos_locales: [{ indice: 1, ...fotoInicialPala }],
    video_local: null,
    seguimientos: [],
    fotos_rutas: [],
    video_ruta: null,
    estado: 'pendiente',
    ultimo_error: null,
    intentos_sync: 0,
    creado_por: null,
    creado_en: new Date().toISOString(),
    actualizado_en: new Date().toISOString(),
    dispositivo: 'PC / Demo Local'
  };

  await localDb.reportes.put(demo1);
  await localDb.reportes.put(demo2);
}
