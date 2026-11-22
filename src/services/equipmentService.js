/**
 * Servicio de Catálogo Dinámico y Compartido de Códigos de Equipo (Escenarios P2 y P10 / M6)
 * Permite listar, crear manualmente, normalizar, sincronizar códigos provenientes de Supabase
 * (`public.reportes`) para que cualquier código registrado por el equipo esté disponible en el selector,
 * y registrar el último uso de cada código.
 */

import { localDb } from '../db/localDb.js';
import { supabase } from '../config/supabaseClient.js';
import { normalizeEquipmentCode } from '../utils/codeNormalizer.js';

const STORAGE_DELETED_EQUIPOS_KEY = 'mineria_equipos_eliminados_v1';

function readDeletedEquipmentCodes() {
  try {
    const raw = localStorage.getItem(STORAGE_DELETED_EQUIPOS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDeletedEquipmentCodes(set) {
  try {
    localStorage.setItem(STORAGE_DELETED_EQUIPOS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore storage errors
  }
}

function markEquipmentCodeDeleted(rawCode) {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) return;
  const set = readDeletedEquipmentCodes();
  set.add(codigo);
  writeDeletedEquipmentCodes(set);
}

function unmarkEquipmentCodeDeleted(rawCode) {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) return;
  const set = readDeletedEquipmentCodes();
  if (set.delete(codigo)) {
    writeDeletedEquipmentCodes(set);
  }
}

export function isEquipmentCodeDeleted(rawCode) {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) return false;
  return readDeletedEquipmentCodes().has(codigo);
}

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
  const deletedSet = readDeletedEquipmentCodes();
  if (existing.length > 0) {
    return sortEquipmentList(existing.filter((item) => !deletedSet.has(item.codigo)));
  }

  // En producción con Supabase Cloud Real, el catálogo proviene de los reportes reales en la nube
  const cfg = typeof supabase.getConfig === 'function' ? supabase.getConfig() : null;
  if (cfg && !cfg.isPlaceholder) {
    return [];
  }

  if (deletedSet.size > 0) {
    return [];
  }

  const now = new Date().toISOString();
  for (let i = 0; i < INITIAL_SAMPLE_EQUIPOS.length; i++) {
    const item = INITIAL_SAMPLE_EQUIPOS[i];
    if (deletedSet.has(item.codigo)) continue;
    await localDb.equipos.put({
      codigo: item.codigo,
      categoria: item.categoria,
      origen: 'manual',
      ultimo_uso: new Date(Date.now() - i * 60000).toISOString(),
      creado_en: now
    });
  }

  const seeded = await localDb.equipos.toArray();
  return sortEquipmentList(seeded.filter((item) => !deletedSet.has(item.codigo)));
}

export function sortEquipmentList(list = []) {
  return [...list].sort((a, b) =>
    String(a?.codigo || '').localeCompare(String(b?.codigo || ''), 'es', {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

export async function getAllEquipments() {
  const list = await localDb.equipos.toArray();
  const deletedSet = readDeletedEquipmentCodes();
  return sortEquipmentList(list.filter((item) => !deletedSet.has(item.codigo)));
}

export async function createOrTouchEquipment(rawCode, categoria = '', origenPreferido = 'manual') {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) {
    throw new Error('Ingresa un código de equipo válido (ej. "793F-05").');
  }

  unmarkEquipmentCodeDeleted(codigo);
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

export async function renameOrUpdateEquipment(oldRawCode, newRawCode, newCategoria = '') {
  const oldCodigo = normalizeEquipmentCode(oldRawCode);
  const nuevoCodigo = normalizeEquipmentCode(newRawCode);
  if (!nuevoCodigo) {
    throw new Error('Ingresa un código de equipo válido (ej. "793F-05").');
  }

  const prev = oldCodigo ? await localDb.equipos.get(oldCodigo) : null;
  const targetExisting = await localDb.equipos.get(nuevoCodigo);
  const categoriaFinal =
    newCategoria.trim() ||
    targetExisting?.categoria ||
    prev?.categoria ||
    inferEquipmentCategory(nuevoCodigo);

  if (oldCodigo && oldCodigo !== nuevoCodigo) {
    await localDb.equipos.delete(oldCodigo);
    markEquipmentCodeDeleted(oldCodigo);
  }

  unmarkEquipmentCodeDeleted(nuevoCodigo);
  const now = new Date().toISOString();
  await localDb.equipos.put({
    codigo: nuevoCodigo,
    categoria: categoriaFinal,
    origen: 'manual',
    ultimo_uso: now,
    creado_en: targetExisting?.creado_en || prev?.creado_en || now
  });

  return {
    oldCodigo,
    nuevoCodigo,
    categoria: categoriaFinal,
    renamed: Boolean(oldCodigo && oldCodigo !== nuevoCodigo)
  };
}

export async function deleteEquipmentFromCatalog(rawCode) {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) return false;
  markEquipmentCodeDeleted(codigo);
  await localDb.equipos.delete(codigo);
  return true;
}

/**
 * M6 — Sincroniza los códigos de equipo presentes en reportes de Supabase (`public.reportes`)
 * y reportes locales hacia la tabla local `equipos` en IndexedDB (`origen: 'nube'`).
 * Garantiza que cualquier código registrado por otro técnico o dispositivo esté disponible
 * en el selector de captura (M1) y en los filtros del historial (M6).
 */
export async function syncEquipmentsFromCloudReports(cloudReports = [], localReports = [], options = {}) {
  const authoritativeCloud = Boolean(options?.authoritativeCloud);
  const deletedSet = readDeletedEquipmentCodes();
  const existingRaw = (await localDb.equipos.toArray()).filter(
    (item) => !deletedSet.has(item.codigo)
  );

  // Cuando la nube real respondió con el listado autoritativo de reportes, depurar códigos obsoletos con 0 reportes
  const existingList = [];
  if (authoritativeCloud) {
    const activeCodes = new Set();
    for (const rep of [...cloudReports, ...localReports]) {
      const code = normalizeEquipmentCode(rep?.codigo_equipo || '');
      if (code && !deletedSet.has(code)) {
        activeCodes.add(code);
      }
    }
    const sampleCodes = new Set(INITIAL_SAMPLE_EQUIPOS.map((e) => e.codigo));
    const RECENT_MANUAL_MS = 10 * 60 * 1000;
    const nowMs = Date.now();

    for (const item of existingRaw) {
      if (!activeCodes.has(item.codigo)) {
        const createdMs = item.creado_en ? new Date(item.creado_en).getTime() : 0;
        const isFreshManual =
          item.origen === 'manual' &&
          !sampleCodes.has(item.codigo) &&
          !item.sincronizado_desde_nube &&
          !Number.isNaN(createdMs) &&
          createdMs > 0 &&
          nowMs - createdMs < RECENT_MANUAL_MS;
        if (!isFreshManual) {
          await localDb.equipos.delete(item.codigo);
          continue;
        }
      }
      existingList.push(item);
    }
  } else {
    existingList.push(...existingRaw);
  }

  const existingMap = new Map(existingList.map((item) => [item.codigo, item]));
  const newlyAddedCodes = [];
  const nowIso = new Date().toISOString();

  // 1. Procesar códigos provenientes de la nube (public.reportes)
  for (const rep of cloudReports) {
    const codigo = normalizeEquipmentCode(rep?.codigo_equipo || '');
    if (!codigo || deletedSet.has(codigo)) continue;

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
    if (!codigo || deletedSet.has(codigo)) continue;

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
