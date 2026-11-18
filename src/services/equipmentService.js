/**
 * Servicio de Catálogo Dinámico de Códigos de Equipo (Escenario P2)
 * Permite listar, crear manualmente, normalizar y registrar el último uso de cada código.
 */

import { localDb } from '../db/localDb.js';
import { normalizeEquipmentCode } from '../utils/codeNormalizer.js';

const INITIAL_SAMPLE_EQUIPOS = [
  { codigo: '793F-01', categoria: 'Camión Minero CAT 793F' },
  { codigo: '793F-05', categoria: 'Camión Minero CAT 793F' },
  { codigo: 'PALA-02', categoria: 'Pala Eléctrica' },
  { codigo: 'PERF-04', categoria: 'Perforadora Rotativa' }
];

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

export async function createOrTouchEquipment(rawCode, categoria = '') {
  const codigo = normalizeEquipmentCode(rawCode);
  if (!codigo) {
    throw new Error('Ingresa un código de equipo válido (ej. "793F-05").');
  }

  const existing = await localDb.equipos.get(codigo);
  const now = new Date().toISOString();

  const record = {
    codigo,
    categoria: categoria.trim() || existing?.categoria || 'Equipo de Operación Minera',
    origen: existing?.origen || 'manual',
    ultimo_uso: now,
    creado_en: existing?.creado_en || now
  };

  await localDb.equipos.put(record);
  return {
    record,
    es_nuevo_codigo: !existing
  };
}
