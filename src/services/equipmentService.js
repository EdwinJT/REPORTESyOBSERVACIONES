/**
 * Servicio de Catálogo Dinámico y Compartido de Códigos de Equipo (Escenarios P2 y P10 / M6)
 * Permite listar, crear manualmente, normalizar, sincronizar códigos provenientes de Supabase
 * (`public.reportes`) para que cualquier código registrado por el equipo esté disponible en el selector,
 * y registrar el último uso de cada código.
 */

import { localDb } from '../db/localDb.js';
import { normalizeEquipmentCode } from '../utils/codeNormalizer.js';

const INITIAL_SAMPLE_EQUIPOS = [
  { codigo: '793F-01', categoria: 'Camión Minero CAT 793F' },
  { codigo: '793F-05', categoria: 'Camión Minero CAT 793F' },
  { codigo: 'PALA-02', categoria: 'Pala Eléctrica' },
  { codigo: 'PERF-04', categoria: 'Perforadora Rotativa' }
];

export function inferEquipmentCategory(codigo = '') {
  const upper = String(codigo || '').toUpperCase();
  if (upper.startsWith('793') || upper.startsWith('797') || upper.startsWith('CAM')) {
    return 'Camión Minero de Acarreo';
  }
  if (upper.startsWith('PALA') || upper.startsWith('PC')) {
    return 'Pala Eléctrica / Hidráulica';
  }
  if (upper.startsWith('PERF') || upper.startsWith('PV')) {
    return 'Perforadora Rotativa';
  }
  if (upper.startsWith('EXC') || upper.startsWith('390') || upper.startsWith('374')) {
    return 'Excavadora Hidráulica de Tajo';
  }
  if (upper.startsWith('CARG') || upper.startsWith('994') || upper.startsWith('992')) {
    return 'Cargador Frontal de Ruedas';
  }
  if (upper.startsWith('MOTO') || upper.startsWith('24M') || upper.startsWith('16M')) {
    return 'Motoniveladora de Vías Mina';
  }
  if (upper.startsWith('TRACT') || upper.startsWith('D10') || upper.startsWith('D11')) {
    return 'Tractor de Orugas';
  }
  return 'Equipo de Operación Minera';
}

export async function ensureInitialEquipmentCatalog() {
  const existing = await localDb.equipos.toArray();
  if (existing.length > 0) {
    return sortEquipmentList(existing);
  }

  const now = new Date().toISOString();
  for (let i = 0; i < INITIAL_SAMPLE_EQUIPOS.length; i++) {
    const item = INITIAL_SAMPLE_EQUIPOS[i];
    await localDb.equipos.put({
      codigo: item.codigo,
      categoria: item.categoria,
      origen: 'manual',
      ultimo_uso: new Date(Date.now() - i * 60000).toISOString(),
      creado_en: now
    });
  }

  const seeded = await localDb.equipos.toArray();
  return sortEquipmentList(seeded);
}

export function sortEquipmentList(list = []) {
  return [...list].sort((a, b) => {
    const tA = a.ultimo_uso || a.creado_en || '';
    const tB = b.ultimo_uso || b.creado_en || '';
    return tB.localeCompare(tA);
  });
}

export async function getAllEquipments() {
  const list = await localDb.equipos.toArray();
  return sortEquipmentList(list);
}

export async function createOrTouchEquipment(rawCode, categoria = '', origenPreferido = 'manual') {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) {
    throw new Error('Ingresa un código de equipo válido (ej. "793F-05").');
  }

  const existing = await localDb.equipos.get(codigo);
  const now = new Date().toISOString();

  const record = {
    codigo,
    categoria: categoria.trim() || existing?.categoria || inferEquipmentCategory(codigo),
    origen: existing?.origen || origenPreferido || 'manual',
    ultimo_uso: now,
    creado_en: existing?.creado_en || now
  };

  await localDb.equipos.put(record);
  return {
    record,
    es_nuevo_codigo: !existing
  };
}

/**
 * M6 — Sincroniza los códigos de equipo presentes en reportes de Supabase (`public.reportes`)
 * y reportes locales hacia la tabla local `equipos` en IndexedDB (`origen: 'nube'`).
 * Garantiza que cualquier código registrado por otro técnico o dispositivo esté disponible
 * en el selector de captura (M1) y en los filtros del historial (M6).
 */
export async function syncEquipmentsFromCloudReports(cloudReports = [], localReports = []) {
  const existingList = await localDb.equipos.toArray();
  const existingMap = new Map(existingList.map((item) => [item.codigo, item]));
  const newlyAddedCodes = [];
  const nowIso = new Date().toISOString();

  // 1. Procesar códigos provenientes de la nube (public.reportes)
  for (const rep of cloudReports) {
    const codigo = normalizeEquipmentCode(rep?.codigo_equipo || '');
    if (!codigo) continue;

    const repTimestamp = rep.actualizado_en || rep.creado_en || nowIso;
    const current = existingMap.get(codigo);

    if (!current) {
      const newEquip = {
        codigo,
        categoria: inferEquipmentCategory(codigo),
        origen: 'nube',
        ultimo_uso: repTimestamp,
        creado_en: rep.creado_en || nowIso,
        sincronizado_desde_nube: true,
        autor_nube: rep.creado_por_email || rep.dispositivo || 'Supabase Cloud'
      };
      await localDb.equipos.put(newEquip);
      existingMap.set(codigo, newEquip);
      newlyAddedCodes.push(codigo);
    } else if (repTimestamp > (current.ultimo_uso || '')) {
      current.ultimo_uso = repTimestamp;
      await localDb.equipos.put(current);
    }
  }

  // 2. Asegurar también cualquier código presente en reportes locales
  for (const rep of localReports) {
    const codigo = normalizeEquipmentCode(rep?.codigo_equipo || '');
    if (!codigo) continue;

    if (!existingMap.has(codigo)) {
      const localEquip = {
        codigo,
        categoria: inferEquipmentCategory(codigo),
        origen: 'manual',
        ultimo_uso: rep.actualizado_en || rep.creado_en || nowIso,
        creado_en: rep.creado_en || nowIso
      };
      await localDb.equipos.put(localEquip);
      existingMap.set(codigo, localEquip);
    }
  }

  const finalList = sortEquipmentList(Array.from(existingMap.values()));
  const manualCount = finalList.filter((e) => e.origen !== 'nube').length;
  const cloudImportedCount = finalList.filter((e) => e.origen === 'nube').length;

  return {
    equipos: finalList,
    totalCatalogCount: finalList.length,
    manualCount,
    cloudImportedCount,
    newlyAddedCodes
  };
}
