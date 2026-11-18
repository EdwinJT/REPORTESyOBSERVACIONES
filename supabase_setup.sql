-- =============================================================================
-- SCRIPT DE CONFIGURACIÓN SUPABASE (M4 y M5)
-- Proyecto: Reportes y Observaciones de Equipos Mineros (PWA Offline-First)
-- Instrucciones: Copia y pega todo este script en "SQL Editor" -> "New query"
-- dentro de tu panel de Supabase y haz clic en "Run".
-- =============================================================================

-- 1. TABLA PRINCIPAL: public.reportes
-- Nota: 'id' viene generado desde el dispositivo (crypto.randomUUID()) para
-- garantizar idempotencia (upsert) ante cortes de señal (Escenarios P6 y P7).
CREATE TABLE IF NOT EXISTS public.reportes (
  id uuid PRIMARY KEY,
  codigo_equipo text NOT NULL,
  fuera_catalogo boolean DEFAULT false,
  fecha date NOT NULL,
  hora_peru text DEFAULT '',
  tipo text NOT NULL CHECK (tipo IN ('Reporte', 'Observación')),
  prioridad text NOT NULL CHECK (prioridad IN ('Baja', 'Media', 'Alta')),
  observacion text DEFAULT '',
  calidad_compresion text DEFAULT 'estandar',
  fotos text[] NOT NULL DEFAULT '{}',
  video text NULL,
  seguimientos jsonb DEFAULT '[]'::jsonb,
  creado_por uuid REFERENCES auth.users DEFAULT auth.uid(),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz DEFAULT now(),
  dispositivo text DEFAULT ''
);

-- 2. ÍNDICES DE RENDIMIENTO PARA HISTORIAL Y FILTROS (M6)
CREATE INDEX IF NOT EXISTS idx_reportes_codigo_equipo ON public.reportes (codigo_equipo);
CREATE INDEX IF NOT EXISTS idx_reportes_fecha ON public.reportes (fecha DESC);

-- 3. ACTIVAR ROW LEVEL SECURITY (RLS) EN public.reportes (Riesgo R7)
ALTER TABLE public.reportes ENABLE ROW LEVEL SECURITY;

-- Limpiar políticas previas si se vuelve a ejecutar el script
DROP POLICY IF EXISTS "reportes_select_authenticated" ON public.reportes;
DROP POLICY IF EXISTS "reportes_insert_own" ON public.reportes;
DROP POLICY IF EXISTS "reportes_update_own" ON public.reportes;

-- Política SELECT: Cualquier usuario autenticado puede leer todos los reportes
-- (Usuarios sin sesión 'anon' reciben 0 filas).
CREATE POLICY "reportes_select_authenticated"
  ON public.reportes
  FOR SELECT
  TO authenticated
  USING (true);

-- Política INSERT: Solo usuarios autenticados pueden insertar filas donde creado_por = auth.uid()
CREATE POLICY "reportes_insert_own"
  ON public.reportes
  FOR INSERT
  TO authenticated
  WITH CHECK (creado_por = auth.uid());

-- Política UPDATE: Solo usuarios autenticados pueden actualizar sus propias filas
-- (Obligatorio para que el UPSERT por 'id' sea idempotente en reintentos de M5)
CREATE POLICY "reportes_update_own"
  ON public.reportes
  FOR UPDATE
  TO authenticated
  USING (creado_por = auth.uid())
  WITH CHECK (creado_por = auth.uid());

-- Nota: No se crea política DELETE porque nadie puede borrar registros desde la app cliente.

-- =============================================================================
-- 4. BUCKET PRIVADO EN SUPABASE STORAGE: 'fotos'
-- Estructura de rutas:
--   Fotos (1 a 5): {user_id}/{reporte_id}/{1..5}.jpg
--   Video opcional: {user_id}/{reporte_id}/video.{ext}
-- =============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos', 'fotos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Limpiar políticas previas de storage.objects para este bucket
DROP POLICY IF EXISTS "fotos_storage_select_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_insert_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_update_own_folder" ON storage.objects;

-- Lectura (SELECT): Permitida a cualquier usuario autenticado en el bucket 'fotos' (para createSignedUrl)
CREATE POLICY "fotos_storage_select_authenticated"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'fotos');

-- Subida (INSERT): Permitida solo a usuarios autenticados en su propia carpeta {auth.uid()}/...
CREATE POLICY "fotos_storage_insert_own_folder"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'fotos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Sobreescritura por reintento (UPDATE para upsert: true): Permitida en su propia carpeta {auth.uid()}/...
CREATE POLICY "fotos_storage_update_own_folder"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'fotos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'fotos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
