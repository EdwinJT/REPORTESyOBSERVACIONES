/**
 * Base de datos local IndexedDB: MineriaReportesDB
 * Tablas:
 *  - reportes: 'id, codigo_equipo, fecha, tipo, prioridad, estado, creado_en'
 *  - equipos:  'codigo, ultimo_uso, creado_en'
 */

const DB_NAME = 'MineriaReportesDB';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('reportes')) {
        const reportesStore = db.createObjectStore('reportes', { keyPath: 'id' });
        reportesStore.createIndex('codigo_equipo', 'codigo_equipo', { unique: false });
        reportesStore.createIndex('fecha', 'fecha', { unique: false });
        reportesStore.createIndex('tipo', 'tipo', { unique: false });
        reportesStore.createIndex('prioridad', 'prioridad', { unique: false });
        reportesStore.createIndex('estado', 'estado', { unique: false });
        reportesStore.createIndex('creado_en', 'creado_en', { unique: false });
      }

      if (!db.objectStoreNames.contains('equipos')) {
        const equiposStore = db.createObjectStore('equipos', { keyPath: 'codigo' });
        equiposStore.createIndex('ultimo_uso', 'ultimo_uso', { unique: false });
        equiposStore.createIndex('creado_en', 'creado_en', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createTableHelper(storeName) {
  return {
    async toArray() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async get(key) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    async put(item) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(item);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async delete(key) {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    },

    async count() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      });
    }
  };
}

export const localDb = {
  reportes: createTableHelper('reportes'),
  equipos: createTableHelper('equipos')
};
