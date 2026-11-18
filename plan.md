# Plan de Arquitectura e Implementación: PWA de Reportes y Observaciones de Equipos Mineros

## 1. Resumen Ejecutivo y Meta ("Terminado")

Esta aplicación web progresiva (PWA) está diseñada para supervisores y técnicos en operación minera (condiciones de **señal intermitente o nula, uso de guantes y luz solar intensa**). Sigue una arquitectura **Offline-First**: toda captura se guarda primero de forma segura en el dispositivo (IndexedDB con Dexie) y se sincroniza de manera autónoma e idempotente con la nube (Supabase Auth, Postgres y Storage) cuando existe conectividad real verificada.

### Definición de "Terminado" (Meta Medible)
> *(Nota: Puedes ajustar estas métricas según tu meta exacta del Paso 2)*
1. **Velocidad de captura en campo:** Un supervisor o técnico con guantes puede registrar un reporte completo (1 a 5 fotos + 1 video opcional, código de equipo, fecha local, tipo, prioridad y observación) en **menos de 60 segundos**, tanto en celular como en PC, con o sin internet.
2. **Cero pérdida y cero duplicidad:** El 100 % de los reportes creados sin señal o durante cortes abruptos se almacenan localmente con `UUID` generado en el dispositivo y se sincronizan mediante `upsert` al recuperar conexión real, sin duplicar filas ni dejar registros huérfanos sin multimedia.
3. **Control de calidad y peso multimedia:** Cada foto se comprime antes de guardarse localmente según el perfil de calidad elegido por el usuario (por defecto: lado mayor `1600 px`, objetivo `< 400 KB`; modo alta nitidez para placas/detalles: lado mayor `2048 px`, objetivo `< 800 KB`), manteniendo legibilidad de códigos y placas. El video opcional se valida con límite de duración/tamaño para proteger el almacenamiento local.
4. **Resiliencia de sesión y fechas exactas:** Ningún reporte cambia de día por desfase UTC después de las 19:00 h en Perú (`America/Lima`), y el vencimiento de sesión sin señal **nunca bloquea** la creación de nuevos reportes en campo.
5. **Supervisión y exportación:** El historial unifica registros locales y en la nube, permite filtrar por equipo, fechas, tipo, prioridad y texto, y exporta los resultados filtrados a Excel (`.xlsx`) sin incluir URLs firmadas caducables.

---

## 2. Plan de Entregas y Módulos

El proyecto se divide en **2 entregas de 3 módulos cada una** para validar primero la operación en campo sin depender de la nube:

### Entrega 1: Operación 100 % Local y Offline (Sin Nube)
- **M1 — Captura ("Nuevo reporte" e interfaz principal unificada tipo tabla/panel):**
  - **Cuadro de Códigos de Equipos Creados (Selector + Filtro Rápido):** Un cuadro visible con todos los códigos de equipos que ya fueron creados; al hacer clic en cualquier código filtra automáticamente la tabla inferior por ese equipo (con opción `"Todos"` para limpiar el filtro) y también lo preselecciona al crear un nuevo reporte.
  - **Panel de Creación de Reporte:** Incluye los botones **"📷 Cámara"** y **"📎 Adjuntar"** (para tomar las 1 a 5 fotos o adjuntar el video al momento de crear el reporte), selector de calidad de compresión y el botón **"+ Agregar otra observación"** para registrar varias observaciones en el mismo reporte.
  - **Tabla Principal con Orden de Lectura Operativo (`Equipo -> Fecha -> Vista Previa -> Multimedia y Acciones`):**
    - Orden de columnas en la tabla: **`1. Equipo` -> `2. Fecha (Inicial / Seg.)` -> `3. Vista Previa (Inicial / Seg.)` -> `4. Multimedia y Acciones (Inicial / Seg.)` -> `5. Tipo / Prioridad` -> `6. Observación Principal y Comentarios Posteriores` -> `7. Estado`**.
    - Iniciar con **`Equipo`** y **`Fecha`** permite identificar al instante la máquina y la línea de tiempo (inicial y seguimientos), viendo inmediatamente al lado la **`Vista Previa`** y sus botones de **`Multimedia y Acciones`** (`🔄 Cambiar`, `⬇️ Descargar`).
    - **Subsección de Seguimiento alineada en todas las columnas (`Fecha`, `Vista Previa`, `Multimedia y Acciones` y `Observación`):** Cuando una observación principal continúa (sigue activa) o tiene un nuevo seguimiento, cada dato se muestra directamente debajo en su propia columna respectiva:
      - En **`Fecha`** (Col. 2): Arriba la fecha inicial (`📌`), y debajo (`↳`) la fecha en que se generó el seguimiento.
      - En **`Vista Previa`** (Col. 3): Arriba la miniatura de la foto/video inicial, y debajo (`↳`) la miniatura de la foto/video del seguimiento.
      - En **`Multimedia y Acciones`** (Col. 4): Arriba las fotos/video iniciales con sus botones (`🔄 Cambiar`, `⬇️ Descargar`), y debajo (`↳`) las fotos/video del seguimiento con sus propios botones.
      - En **`Observación`** (Col. 6): Arriba la observación principal (`📌`), y debajo (`↳`) el estado (`⚠️ Sigue observación`) y el comentario posterior.
  - Captura de **1 a 5 fotos** desde cámara (`capture="environment"`) o adjuntando archivo/galería, con vista previa y botón para quitar cada archivo.
  - Selector de **calidad de compresión de foto** (Estándar `< 400 KB / 1600 px` por defecto, o Alta Nitidez `< 800 KB / 2048 px` cuando se requiera mayor detalle en placas, fisuras o números de parte).
  - Opción para adjuntar o grabar **1 video corto opcional** (`accept="video/mp4,video/webm,video/quicktime"`, validado a máx. 15–20 MB / ~30 s para no saturar IndexedDB ni la cola móvil).
  - **Selector e ingreso de Código de Equipo dinámico (Lista Desplegable + Creación Manual):** En el campo de Equipo incluye una **lista desplegable (`<select>`)** con todos los códigos ya creados anteriormente para verlos y elegirlos directamente, junto con una opción / campo para escribir y **"+ Crear"** un nuevo código normalizado a MAYÚSCULAS y formato estándar (ej. `"793f 05"` -> `"793F-05"`), el cual se agrega de inmediato tanto a la lista desplegable como al cuadro superior de filtros.
  - **Fecha:** Calculada por defecto como el día de HOY en zona horaria `America/Lima` en formato texto `AAAA-MM-DD` (editable).
  - **Clasificación y Múltiples Observaciones:** Tipo (`Reporte` / `Observación`), Prioridad (`Baja` / `Media` / `Alta`) y Observación en texto libre con botón **"+ Agregar otra observación"** para registrar varios puntos u observaciones adicionales de forma ordenada sin salir de la pantalla.
  - Interfaz pensada para mina: botones de mínimo `48 px` de alto, alto contraste para sol directo y tema oscuro para guardia nocturna.
- **M2 — Guardado Local e Imágenes Comprimidas:**
  - Compresión de cada foto **antes** de escribir en IndexedDB usando `browser-image-compression`, respetando la orientación EXIF de la cámara.
  - Persistencia en IndexedDB mediante **Dexie**: tabla `reportes` (metadatos + Blobs multimedia) y tabla `equipos` (códigos creados manualmente e historial de uso).
  - Solicitud de almacenamiento persistente (`navigator.storage.persist()`) e indicador de espacio utilizado (`navigator.storage.estimate()`).
  - Pantalla **"Mis reportes"**: listado local con miniatura, código de equipo, fecha, estado (`pendiente`, `sincronizando`, `sincronizado`, `error`) y tamaño en KB/MB de cada archivo.
- **M3 — PWA Instalable y Modo Sin Conexión:**
  - Configuración con `vite-plugin-pwa` (Workbox `generateSW`, `registerType: 'prompt'`).
  - Web App Manifest (`display: standalone`, íconos `192x192` y `512x512`, colores de alto contraste).
  - Precaché completo del App Shell (HTML, JS, CSS, íconos y activos estáticos) para abrir en modo avión tras cerrar completamente la app.
  - Indicador visible de estado de red (`En línea` / `Sin conexión`), aviso de nueva versión disponible y botón `"Instalar app"` (con instrucciones explícitas `"Compartir → Agregar a inicio"` en iOS/Safari).

### Entrega 2: Autenticación, Sincronización en la Nube e Historial
- **M4 — Inicio de Sesión Resiliente (Supabase Auth):**
  - Login con correo y contraseña mediante `@supabase/supabase-js` usando únicamente `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` desde `.env` (jamás `service_role`).
  - Sin registro público de usuarios.
  - **Desacoplamiento Offline:** Si no hay internet o el token expiró en campo, la app abre normalmente y permite seguir creando y guardando reportes locales. Solo solicita reautenticación al momento de intentar sincronizar con Supabase.
  - Botón `"Cerrar sesión"` que advierte si existen reportes en estado `pendiente` o `error` y **nunca borra** los datos locales de IndexedDB.
- **M5 — Motor y Cola de Sincronización:**
  - Procesamiento secuencial con candado de exclusión mutua (mutex) de reportes en estado `pendiente` o `error`.
  - Verificación de internet real (ping HTTP con `AbortController` y timeout de 8 segundos a Supabase) sin confiar ciegamente en `navigator.onLine`.
  - Subida en dos fases estrictas: **1) Multimedia primero** a Supabase Storage con `upsert: true`; **2) Registro después** a Postgres `public.reportes` con `upsert` por `id`.
  - Reintentos con *exponential backoff* (`30 s`, `2 min`, `10 min`) y mensajes de error claros en español.
- **M6 — Historial Unificado, Catálogo Compartido y Exportación a Excel:**
  - Vista combinada (registros locales + registros en Supabase de todo el equipo).
  - Sincronización de códigos de equipo creados para que cualquier código registrado esté disponible en el selector.
  - Carga diferida (*lazy loading*) de fotos y video desde la nube mediante URLs firmadas (`createSignedUrl`) únicamente al abrir el detalle de un reporte.
  - Filtros por código de equipo, rango de fechas (`desde` / `hasta`), tipo, prioridad y búsqueda por texto en observación.
  - Diseño adaptable: vista de **tarjetas** en celular y **tabla** en PC (con layout de dos columnas en pantallas anchas).
  - Exportación a Excel (`.xlsx` con SheetJS / `xlsx`) de los registros filtrados (sin incluir URLs firmadas que caducan).

---

## 3. Estructura de Carpetas Propuesta

```text
REPORTES Y OBSERVACIONES DE EQUIPOS/
├── .env.example                 # Plantilla de variables: VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
├── .gitignore                   # Ignora node_modules/, dist/, .env, *.local
├── index.html                   # Entrada principal con meta tags PWA e íconos Apple Touch
├── package.json                 # Dependencias: react, dexie, browser-image-compression, @supabase/supabase-js, xlsx, vite-plugin-pwa
├── vite.config.js               # Configuración de Vite + VitePWA (manifest y workbox)
├── plan.md                      # Este documento de arquitectura y plan de pruebas
├── datos/                       # Archivos de referencia y plan de pruebas
│   ├── catalogo_equipos.csv     # Semilla opcional de códigos iniciales (si aplica)
│   └── plan_de_pruebas.xlsx     # Matriz de validación de escenarios P1 a P10
├── fotos_prueba/                # Fotos y videos de prueba para validación local (M1-M5)
├── public/
│   ├── pwa-192x192.png          # Ícono PWA estándar
│   ├── pwa-512x512.png          # Ícono PWA alta resolución y maskable
│   └── apple-touch-icon.png     # Ícono para iOS Safari ("Agregar a inicio")
└── src/
    ├── main.jsx                 # Punto de entrada React y registro del Service Worker
    ├── App.jsx                  # Layout principal, barra de estado (red/pendientes/sesión) y navegación
    ├── index.css                # Estilos de alto contraste (modo día/sol y modo noche) y botones >= 48px
    ├── config/
    │   └── supabaseClient.js    # Inicialización de Supabase con variables VITE_*
    ├── db/
    │   ├── localDb.js           # Instancia Dexie: tablas 'reportes' y 'equipos'
    │   └── storageManager.js    # Solicitud de persist() y cálculo de espacio usado (estimate())
    ├── services/
    │   ├── connectivity.js      # Verificación real de conexión (fetch con timeout de 8s, no solo navigator.onLine)
    │   ├── imageCompressor.js   # Compresión configurable (Estándar 1600px/<400KB o Alta Nitidez 2048px/<800KB) y validación de video
    │   ├── equipmentService.js  # Creación manual, normalización y autocompletado de códigos de equipo
    │   ├── syncQueue.js         # Cola de sincronización (mutex, orden foto/video -> registro, backoff)
    │   └── excelExporter.js     # Generación de archivo .xlsx con SheetJS
    ├── utils/
    │   ├── datePeru.js          # Cálculo estricto de fecha local America/Lima (AAAA-MM-DD) sin toISOString()
    │   └── codeNormalizer.js    # Normalización de códigos ("793f 05" -> "793F-05")
    └── components/
        ├── CapturaReporte/      # M1: Formulario Nuevo Reporte, selector de equipos, cámara/galería (1-5 fotos + 1 video)
        ├── MisReportes/         # M2: Lista local, estado de sincronización, peso de archivos y espacio en disco
        ├── PwaBanner/           # M3: Botón instalar PWA, guía iPhone, indicador En línea/Sin conexión, aviso de actualización
        ├── Auth/                # M4: Pantalla/modal de Login y cierre de sesión seguro
        ├── SyncStatus/          # M5: Contador "X pendientes", botón "Sincronizar ahora", alertas de error en español
        └── Historial/           # M6: Lista unificada (PC tabla / Celular tarjetas), filtros, modal de detalle y botón Excel
```

---

## 4. Modelo de Datos: Local (Dexie / IndexedDB) y Nube (Supabase)

### 4.1. Cálculo de Fecha Local en Perú (Regla Obligatoria 5)
Nunca se usará `new Date().toISOString().slice(0, 10)` porque a partir de las 19:00 h en Perú (`UTC-5`) el reloj UTC ya está en el día siguiente.
La fecha por defecto se obtendrá siempre con `Intl.DateTimeFormat`:
- Se extrae `year`, `month` y `day` usando `timeZone: 'America/Lima'`.
- Se ensambla directamente la cadena `AAAA-MM-DD` (ej. `"2026-11-17"`).

### 4.2. Modelo Local en el Dispositivo (Dexie / IndexedDB)
Base de datos Dexie: `MineriaReportesDB`

#### Tabla 1: `reportes`
Índice en Dexie: `'id, codigo_equipo, fecha, tipo, prioridad, estado, creado_en'`

| Campo | Tipo en IndexedDB | Descripción |
| :--- | :--- | :--- |
| `id` | `string` (UUID v4) | Generado en el dispositivo al crear (`crypto.randomUUID()`). Clave primaria única en local y nube. |
| `codigo_equipo` | `string` | Código normalizado en mayúsculas (ej. `"793F-05"`). |
| `es_nuevo_codigo` | `boolean` | Indica si el código fue creado manualmente por primera vez en este registro. |
| `fecha` | `string` | Texto en formato `AAAA-MM-DD` calculado en hora local (`America/Lima`). |
| `tipo` | `string` | `"Reporte"` \| `"Observación"`. |
| `prioridad` | `string` | `"Baja"` \| `"Media"` \| `"Alta"`. |
| `observacion` | `string` | Texto descriptivo del hallazgo o reporte. |
| `calidad_compresion` | `string` | `"estandar"` (`1600px` / `<400KB`) \| `"alta"` (`2048px` / `<800KB`). |
| `fotos_locales` | `Array<FotoLocal>` | Arreglo de **1 a 5 objetos**: `{ indice: 1..5, blob: Blob, peso_bytes: number, ancho: number, alto: number, ruta_remota: string \| null }`. |
| `video_local` | `VideoLocal \| null` | Objeto opcional (0 o 1): `{ blob: Blob, mime_type: string, peso_bytes: number, ruta_remota: string \| null }`. |
| `fotos_rutas` | `Array<string>` | Rutas en Supabase Storage una vez subidas (`["{user_id}/{id}/1.jpg", ...]`). |
| `video_ruta` | `string \| null` | Ruta en Supabase Storage si incluye video (`"{user_id}/{id}/video.mp4"`). |
| `estado` | `string` | `"pendiente"` \| `"sincronizando"` \| `"sincronizado"` \| `"error"`. |
| `ultimo_error` | `string \| null` | Mensaje en español si el último intento de sincronización falló. |
| `intentos_sync` | `number` | Contador de reintentos para el *backoff* automático. |
| `creado_por` | `string \| null` | `user_id` de la sesión (si existía al crear) o asignado al sincronizar. |
| `creado_en` | `string` | Timestamp ISO de creación exacta para auditoría y ordenamiento. |
| `actualizado_en` | `string` | Timestamp ISO de última modificación/sincronización. |
| `dispositivo` | `string` | Identificador descriptivo de plataforma (User-Agent resumido: Android/iOS/PC). |

#### Tabla 2: `equipos` (Catálogo Dinámico de Códigos de Equipo)
Índice en Dexie: `'codigo, ultimo_uso, creado_en'`

| Campo | Tipo en IndexedDB | Descripción |
| :--- | :--- | :--- |
| `codigo` | `string` (PK) | Código normalizado en mayúsculas (ej. `"793F-05"`). |
| `categoria` | `string` | Opcional: descripción o familia del equipo si el usuario desea anotarla al crearlo. |
| `origen` | `string` | `"manual"` (creado por el usuario en la app) \| `"nube"` (descargado de reportes previos). |
| `ultimo_uso` | `string` | Timestamp de la última vez que se seleccionó (para mostrar los más usados primero). |
| `creado_en` | `string` | Timestamp de creación. |

> **Flujo del Código de Equipo:**
> 1. Al inicio, si la tabla `equipos` está vacía (o cuando llega un equipo nuevo a la mina), el usuario escribe el código, la app lo normaliza a MAYÚSCULAS y formato estándar, y con un toque en **"+ Crear y usar código [CÓDIGO]"** lo guarda en la tabla `equipos` y lo asigna al reporte.
> 2. En los siguientes reportes, el selector muestra inmediatamente los códigos ya creados (ordenados por el último usado arriba y con búsqueda instantánea). Si el usuario escribe un código que aún no existe en la lista, aparece de inmediato la opción **"+ Crear nuevo código: [CÓDIGO]"**.

---

### 4.3. Modelo en la Nube (Supabase: Postgres + Storage + RLS)

#### Tabla Postgres: `public.reportes`
| Columna | Tipo SQL | Restricciones / Default |
| :--- | :--- | :--- |
| `id` | `uuid` | `PRIMARY KEY` (viene del dispositivo, **sin** `default gen_random_uuid()`). |
| `codigo_equipo` | `text` | `NOT NULL` |
| `fuera_catalogo` | `boolean` | `DEFAULT false` (indica si fue creado dinámicamente en campo). |
| `fecha` | `date` | `NOT NULL` (recibe el texto `AAAA-MM-DD` local). |
| `tipo` | `text` | `NOT NULL CHECK (tipo IN ('Reporte', 'Observación'))` |
| `prioridad` | `text` | `NOT NULL CHECK (prioridad IN ('Baja', 'Media', 'Alta'))` |
| `observacion` | `text` | `DEFAULT ''` |
| `fotos` | `text[]` | `NOT NULL` — Arreglo de 1 a 5 rutas en Storage (`{user_id}/{id}/{n}.jpg`). |
| `video` | `text` | `NULL` — Ruta opcional en Storage (`{user_id}/{id}/video.mp4` o `.webm`). |
| `creado_por` | `uuid` | `REFERENCES auth.users DEFAULT auth.uid()` |
| `creado_en` | `timestamptz` | `NOT NULL` |
| `actualizado_en` | `timestamptz` | `DEFAULT now()` |
| `dispositivo` | `text` | Metadato del dispositivo emisor. |

- **Índices SQL:** Índice por `codigo_equipo` (`idx_reportes_codigo_equipo`) e índice por `fecha DESC` (`idx_reportes_fecha`).
- **Políticas RLS (`public.reportes`):**
  - `SELECT`: Cualquier usuario autenticado (`authenticated`) puede leer todos los reportes (para el historial y para poblar los códigos de equipo existentes). Usuarios sin sesión (`anon`) reciben `0 filas`.
  - `INSERT`: Solo usuarios autenticados pueden insertar filas donde `creado_por = auth.uid()`.
  - `UPDATE`: Solo usuarios autenticados pueden actualizar filas donde `creado_por = auth.uid()` (necesario para que el `upsert` sea idempotente en reintentos).
  - `DELETE`: Nadie puede borrar registros desde la aplicación cliente.

#### Bucket en Supabase Storage: `fotos` (Privado)
- **Estructura de rutas obligatoria:**
  - Fotos (`n` de `1` a `5`): `{user_id}/{id}/{n}.jpg`
  - Video opcional: `{user_id}/{id}/video.{ext}`
- **Políticas de Storage (`storage.objects`):**
  - Lectura (`SELECT`): Permitida a cualquier usuario `authenticated` en el bucket `fotos` (mediante `createSignedUrl`).
  - Subida y sobreescritura por reintento (`INSERT` y `UPDATE`): Permitida solo a usuarios `authenticated` cuando la primera carpeta de la ruta coincide con su `auth.uid()` (`(storage.foldername(name))[1] = auth.uid()::text`).
  - Borrado (`DELETE`): Denegado desde la app.

---

## 5. Compresión de Fotos y Manejo de Video (Regla Obligatoria 7)

1. **Compresión antes de guardar en IndexedDB:**
   - Al tomar o elegir cada una de las **1 a 5 fotos**, antes de guardar el registro en Dexie se procesa con `browser-image-compression` (`useWebWorker: true`, `preserveExif: false` tras aplicar la rotación correcta de cámara, formato `image/jpeg`).
   - **Modo Estándar (por defecto):** `maxWidthOrHeight: 1600`, `maxSizeMB: 0.39` (< 400 KB), `initialQuality: 0.75`.
   - **Modo Alta Nitidez (variable a elección del usuario):** Si el técnico activa el switch *"Mayor nitidez (placas / detalles pequeños)"* en el reporte o en una foto, se usa `maxWidthOrHeight: 2048`, `maxSizeMB: 0.8` (< 800 KB), `initialQuality: 0.85` para que los textos pequeños o fisuras se distingan con claridad sin subir archivos crudos de 8–12 MB.
2. **Manejo del Video Opcional:**
   - Además de las 1 a 5 fotos obligatorias, el reporte permite adjuntar o grabar **hasta 1 video**.
   - Se valida antes de guardar que no supere el tamaño máximo permitido (ej. `20 MB`), almacenándose como `Blob` en IndexedDB y subiéndose junto con las fotos antes de registrar la fila en Postgres.

---

## 6. Funcionamiento de la Cola de Sincronización (Reglas Obligatorias 1, 2, 3, 4 y 6)

### 6.1. Disparadores de la Cola
La cola revisa si existen reportes locales con `estado IN ('pendiente', 'error')` en cuatro momentos:
1. **Al abrir la aplicación** (o cuando la app vuelve a primer plano con el evento `visibilitychange` -> `visible`).
2. **Al recuperar la señal** (evento `online` del navegador, seguido de verificación real).
3. **Cada 2 minutos** mediante un temporizador periódico mientras la app esté abierta.
4. **Manualmente** al tocar el botón `"Sincronizar ahora"` (que reinicia el contador de espera de los reportes en `error`).

### 6.2. Candado de Concurrencia (Mutex) y Recuperación de Cierres Abruptos
- Una bandera en memoria (`isSyncing = true/false`) impide que dos ejecuciones de la cola corran al mismo tiempo (por ejemplo, si el usuario presiona `"Sincronizar ahora"` justo cuando se dispara el evento `online`).
- **Recuperación al iniciar:** Si la app se cerró o se apagó el celular a mitad de una subida y un reporte quedó en estado `"sincronizando"` en IndexedDB, al arrancar la app cualquier registro en `"sincronizando"` sin proceso activo se devuelve automáticamente a `"pendiente"` para reintentarse de forma segura.

### 6.3. Confirmación de Conexión Real (Regla 4)
- Nunca se asume que `navigator.onLine === true` significa internet real (en mina es común estar conectado a un Wi-Fi local o repetidor sin salida a internet).
- Antes de procesar la cola, `connectivity.js` realiza un `fetch` ligero (HEAD/GET al endpoint REST/Auth de Supabase) con un `AbortController` de **8 segundos de límite**. Si expira o falla, se aborta el ciclo sin tocar los reportes pendientes.

### 6.4. Validación de Sesión (Regla 6)
- Si hay conexión real pero el usuario no ha iniciado sesión o el `refresh_token` de Supabase expiró, los reportes locales permanecen intactos en `"pendiente"` y la interfaz muestra un aviso claro: *"Sesión expirada. Inicia sesión para subir X reportes pendientes"*, sin impedir que siga registrando nuevos reportes.

### 6.5. Secuencia Estricta por Reporte (Reglas 1, 2 y 3)
Para cada reporte en la cola (ordenado del más antiguo al más reciente):
1. Cambia el estado local a `"sincronizando"`.
2. **Paso A — Subida de Fotos (y Video si existe) a Storage:**
   - Por cada foto `n` (`1` a `5`), sube el `Blob` a la ruta `{user_id}/{id}/{n}.jpg` en el bucket `fotos` con `{ upsert: true, contentType: 'image/jpeg' }`.
   - Si el reporte incluye video, sube el `Blob` a `{user_id}/{id}/video.{ext}` con `{ upsert: true }`.
   - Cada subida individual se envuelve en un timeout de seguridad para evitar promesas colgadas cuando la señal cae a mitad de la transferencia.
3. **Paso B — Upsert del Registro en Postgres:**
   - **Solo si el 100 % de las fotos (y el video opcional) se subieron sin error**, se ejecuta `supabase.from('reportes').upsert({...}, { onConflict: 'id' })` enviando el mismo `id` UUID creado en el dispositivo y el arreglo de rutas `fotos`.
4. **Paso C — Confirmación Final:**
   - **Solo si el Paso A y el Paso B respondieron con éxito**, el estado local en Dexie pasa a `"sincronizado"`. Para liberar espacio en el celular sin perder el historial local, se conservan los metadatos (y miniatura ligera) una vez confirmada la subida.
   - Si falla cualquiera de los pasos (A o B), el estado pasa a `"error"`, se guarda el motivo traducido al español en `ultimo_error` (ej. `"Tiempo de espera agotado al subir la foto 2"`, `"Sin conexión con el servidor"`) y se programa el reintento automático con *exponential backoff* (`30 s`, luego `2 min`, luego `10 min`).

---

## 7. ¿Qué pasa en iPhone (iOS) y en Android con la App Cerrada?

Es fundamental conocer el comportamiento real de los sistemas operativos móviles frente a las PWAs:

### En iPhone / iPad (iOS Safari y WebKit Standalone)
1. **Sin ejecución en segundo plano real:** iOS **no soporta** la API `Background Sync` de Service Workers y suspende los temporizadores de JavaScript pocos segundos después de bloquear la pantalla, cambiar de app o cerrar la PWA. Por lo tanto, **mientras la app está cerrada en iPhone, no se suben datos en segundo plano**.
2. **Reanudación automática al abrir:** Para compensar esto de forma transparente, el motor de sincronización escucha el evento `visibilitychange` (`document.visibilityState === 'visible'`) y `pageshow`. Apenas el supervisor desbloquea el celular o vuelve a abrir la PWA teniendo señal, la cola arranca en el primer segundo sin que tenga que presionar nada.
3. **Política de purga de 7 días de WebKit (ITP):** En iOS, si una web se usa solo desde una pestaña normal de Safari y no se abre durante 7 días, iOS puede borrar IndexedDB. **Mitigación en el diseño:**
   - En M3 se guía al usuario a **instalar la PWA en la pantalla de inicio** (`Compartir → Agregar a inicio`), lo que le otorga un contenedor `standalone` más aislado.
   - En M2 se invoca `navigator.storage.persist()` al primer uso.
   - En la barra superior se muestra de forma permanente el contador `"X pendientes"` con alerta visual si hay reportes sin subir acumulados.

### En Android (Chrome / Edge)
1. **Mejor persistencia y soporte PWA:** Al instalar la PWA desde Chrome (`Instalar aplicación`), Android crea un WebAPK nativo con almacenamiento persistente mucho más estable.
2. **App en segundo plano o cerrada:** Aunque Android permite cierta actividad breve del Service Worker al recuperar red, el sistema de ahorro de batería de muchos fabricantes (Samsung, Xiaomi, Motorola) mata los procesos en segundo plano si la pantalla lleva varios minutos apagada o si el usuario desliza y cierra la app.
3. **Comportamiento garantizado:** Tanto en Android como en iPhone, los reportes guardados en IndexedDB **persisten en la memoria flash del teléfono aunque se cierre la app o se reinicie el equipo**, y la cola los sube automáticamente en cuanto la app se abre con conexión o mediante el botón `"Sincronizar ahora"`.

---

## 8. Matriz de Riesgos y Mitigaciones

| # | Riesgo en Operación Minera | Impacto | Mitigación en la Arquitectura |
| :- | :--- | :--- | :--- |
| **R1** | **Falso positivo de conexión ("Lie-Fi"):** El celular marca Wi-Fi o 4G en interior mina o campamento, pero el enlace satelital/red no tiene salida a internet. | La sincronización se queda colgada indefinidamente en `"sincronizando"`. | No confiar en `navigator.onLine`. Hacer petición real (`fetch` a Supabase) con `AbortController` de 8 segundos antes de sincronizar y timeout por cada archivo subido. |
| **R2** | **Corte de señal a mitad de la subida:** Se suben 2 de 4 fotos y se corta la señal antes de insertar en la base de datos, o se inserta el reporte en un reintento. | Reportes duplicados o registros en la nube sin sus fotos. | Orden estricto **Fotos/Video -> Registro**, `upsert: true` en Storage (sobreescribe sin fallar la foto ya subida) y `upsert` por `id` UUID en Postgres. |
| **R3** | **Desfase de fecha nocturno (Trampa UTC):** Un técnico de guardia nocturna registra un reporte a las 21:30 h en Perú (`02:30 UTC` del día siguiente). | El reporte queda registrado con fecha de mañana. | Prohibido usar `toISOString()` para fechas de negocio. Uso obligatorio de `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' })` -> `AAAA-MM-DD`. |
| **R4** | **Llenado del almacenamiento del celular:** Fotos de cámaras modernas (8–15 MB c/u, hasta 5 fotos + video por reporte) saturan el espacio en días sin señal. | Fallo de `QuotaExceededError` en IndexedDB o lentitud extrema al sincronizar. | Compresión previa al guardado en IndexedDB (`< 400 KB` estándar / `< 800 KB` alta nitidez), límite de tamaño para el video opcional y monitor de cuota (`navigator.storage.estimate()`). |
| **R5** | **Foto borrosa o placa ilegible por sobrecompresión:** Una placa sucia o serie pequeña no se distingue a `1600 px` con compresión agresiva. | El área de mantenimiento no puede leer el código o falla en la foto. | Compresión variable configurable en la pantalla de captura: opción de *"Alta nitidez"* (`2048 px` / calidad `0.85` / `< 800 KB`) cuando el usuario requiere mayor detalle. |
| **R6** | **Sesión de Supabase vencida en zona sin cobertura:** El token JWT expira mientras el técnico está en tajo o socavón sin señal. | El usuario no puede abrir el formulario y pierde el registro. | Separación total entre captura local (M1/M2) y autenticación (M4). Se permite registrar siempre sin sesión válida; el login solo se exige para ejecutar M5 (sincronización). |
| **R7** | **Exposición de credenciales o datos abiertos en Supabase:** Uso accidental de `service_role` en el frontend o tablas sin RLS. | Cualquier persona con el enlace podría leer, modificar o borrar toda la base de datos. | Uso exclusivo de `VITE_SUPABASE_ANON_KEY`, `.env` en `.gitignore`, y políticas RLS estrictas en Postgres y Storage verificadas sin sesión. |
| **R8** | **Ergonomía en mina (guantes, polvo, sol fuerte):** Botones pequeños o texto gris claro ilegible bajo el sol de tajo abierto. | Errores de tipeo y rechazo de la herramienta por los técnicos. | Botones táctiles de mínimo `48 px` de alto, alto contraste, selector rápido con los códigos de equipo ya creados y sugerencia del último equipo utilizado. |

---

## 9. Cobertura de los Escenarios de Prueba (P1 a P10)

A continuación se detalla cómo el diseño cubre y permite verificar cada uno de los escenarios de `datos/plan_de_pruebas.xlsx`:

| Escenario | Situación de Prueba (Trampa Común) | Cómo lo cubre la arquitectura | Cómo se verifica ("Sí" en el Plan de Pruebas) |
| :--- | :--- | :--- | :--- |
| **P1** | **Fecha en guardia nocturna (después de las 19:00 h Perú / 23:30 h):** Registrar un reporte de noche en Perú (`UTC-5`), cuando en UTC ya es el día siguiente. | `datePeru.js` calcula la fecha con `Intl.DateTimeFormat` en zona `America/Lima` y guarda texto plano `AAAA-MM-DD`, sin usar `toISOString()`. | Cambiar el reloj de la PC/celular a las `23:30 h` (hora Lima). Abrir "Nuevo reporte": la fecha por defecto y la fecha guardada deben mostrar el día actual en Perú, no el día siguiente. |
| **P2** | **Código de equipo (creación manual, normalización y reutilización):** Ingresar códigos con minúsculas, espacios o formatos variados (ej. `"793f 05"`) o crear un código nuevo que no existía. | `codeNormalizer.js` transforma a MAYÚSCULAS y formato estándar (`"793F-05"`). `equipmentService.js` permite crear los primeros códigos manualmente y los guarda en Dexie para elegirlos de la lista en los siguientes reportes (o crear otro si no existe). | 1) Crear manualmente un primer código escribiendo `"793f 05"` -> verifica que se normalice a `"793F-05"` y se guarde. 2) En un segundo reporte, comprobar que `"793F-05"` ya aparece como opción seleccionable, y probar también la opción de crear un código distinto nuevo. |
| **P3** | **Compresión y legibilidad de fotos (1 a 5 fotos + opción de video):** Adjuntar fotos pesadas de cámara (> 5 MB) y verificar que pesen poco pero se lean las placas/detalles. | `imageCompressor.js` comprime cada foto **antes** de guardarla en IndexedDB (modo estándar `< 400 KB / 1600 px` o modo alta nitidez `< 800 KB / 2048 px`), respetando la orientación de la cámara. Permite de 1 a 5 fotos y 1 video opcional. | Crear un reporte con fotos pesadas (incluyendo placa de equipo). En "Mis reportes", verificar que el peso por foto sea `< 400 KB` (en modo estándar) o el rango elegido en alta nitidez, y al abrir la foto comprobar que la placa es perfectamente legible y no está girada. |
| **P4** | **Validación de campos obligatorios y límites multimedia:** Intentar guardar sin fotos, con más de 5 fotos, o sin código de equipo. | El formulario M1 valida mínimo 1 foto y máximo 5 fotos (más 1 video opcional), código de equipo obligatorio y fecha válida antes de habilitar/ejecutar el guardado. | Intentar guardar un reporte con 0 fotos o sin código de equipo: la app muestra aviso claro en español y no guarda un registro incompleto. Agregar hasta 5 fotos y comprobar que no permite una sexta. |
| **P5** | **Funcionamiento 100 % Offline (Modo Avión + Cerrar y Abrir App):** Activar modo avión, cerrar completamente la PWA y volver a abrirla sin señal. | `vite-plugin-pwa` precachea todo el App Shell en el Service Worker (M3) y Dexie lee los reportes y el catálogo local de códigos directamente de IndexedDB (M2). | Compilar (`npm run build && npm run preview` o versión instalada en celular), activar Modo Avión, cerrar la app por completo, volver a abrirla, ver la lista de reportes previos y registrar un reporte nuevo sin error. |
| **P6** | **Sincronización automática al volver la conexión:** Registrar reportes en modo avión y luego desactivar el modo avión. | `syncQueue.js` detecta la recuperación de red, confirma salida real a Supabase (`fetch` con timeout de 8 s), sube primero las fotos/video a Storage y luego el registro a Postgres. | Registrar 2 reportes sin internet (quedan en `"pendiente"`). Reconectar internet: el contador `"X pendientes"` baja a `0`, el estado cambia a `"sincronizado"` y aparecen en Supabase (`public.reportes` y bucket `fotos`). |
| **P7** | **Corte abrupto de señal a los 2 segundos de sincronizar (Anti-duplicados y Anti-huérfanos):** Tener 5 reportes pendientes, iniciar sincronización y activar modo avión a los 2 segundos; luego reconectar. | Cada reporte tiene un `id` UUID creado en el dispositivo. Se sube primero a Storage con `upsert: true` y luego a Postgres con `upsert` por `id`. Solo se marca `"sincronizado"` si ambos pasos terminan bien. | Crear 5 reportes offline, tocar `"Sincronizar ahora"`, activar Modo Avión a los 2 segundos. Luego reconectar y dejar terminar. En Supabase Table Editor debe haber **exactamente 5 filas** (ningún duplicado) y en Storage cada una debe tener todas sus fotos completas. |
| **P8** | **Falsa conexión ("Wi-Fi sin internet" / servidor caído) y exclusión mutua:** Estar conectado a una red que no llega a Supabase o presionar varias veces seguidas `"Sincronizar ahora"`. | Verificación real con límite de 8 segundos (`AbortController`) y candado `isSyncing` que impide dos sincronizaciones simultáneas. Si falla, pasa a `"error"`, muestra motivo en español y aplica *backoff* (`30 s`, `2 min`, `10 min`). | Simular bloqueo de red a Supabase (o throttling lento/offline en DevTools con `navigator.onLine` activo) y tocar `"Sincronizar ahora"` varias veces: la app no se congela, aborta a los 8 s, muestra el motivo en español y no duplica peticiones. |
| **P9** | **Sesión vencida o cerrada estando sin internet:** El token de Supabase caduca (o no hay sesión activa) cuando el técnico está en mina sin señal. | M4 desacopla la captura local de la sesión remota. La pantalla "Nuevo reporte" y el guardado en Dexie funcionan siempre sin sesión activa; solo M5 pide iniciar sesión para subir a la nube. | En Modo Avión (o tras invalidar/vencer el token sin red), abrir la app y crear un reporte nuevo: la app permite guardarlo localmente como `"pendiente"` sin bloquear al usuario en una pantalla de login. |
| **P10** | **Sincronización entre dispositivos, Historial y Exportación a Excel:** Un reporte creado en el celular debe verse en la PC, filtrarse y exportarse a `.xlsx`. | M6 une los datos locales y los de `public.reportes` en Supabase, carga las fotos bajo demanda con URLs firmadas al abrir el detalle, y exporta con SheetJS las columnas de datos sin URLs firmadas caducables. | Registrar y sincronizar en el celular; abrir la app en la PC, filtrar por el código de equipo, abrir el detalle para ver sus fotos y exportar a Excel verificando que solo salgan los reportes filtrados con sus columnas completas. |
