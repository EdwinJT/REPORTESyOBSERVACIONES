-- =============================================================================
-- SCRIPT DE CONFIGURACIÓN SUPABASE (SINCRONIZACIÓN MULTI-DISPOSITIVO)
-- Proyecto: Reportes y Observaciones de Equipos Mineros (PWA Offline-First)
-- Instrucciones: Copia y pega TODO este script en tu panel de Supabase:
-- "SQL Editor" -> "New query" -> Pegar -> Clic en "Run".
-- =============================================================================

-- 1. TABLA PRINCIPAL: public.reportes
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
  creado_por uuid NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz DEFAULT now(),
  dispositivo text DEFAULT ''
);

-- Si la tabla ya existía, remover la restricción de clave foránea a auth.users
-- para que celulares y computadoras puedan sincronizar sin requerir confirmación por email
ALTER TABLE public.reportes DROP CONSTRAINT IF EXISTS reportes_creado_por_fkey;
ALTER TABLE public.reportes ALTER COLUMN creado_por DROP NOT NULL;

-- 2. ÍNDICES DE RENDIMIENTO PARA HISTORIAL Y FILTROS (M6)
CREATE INDEX IF NOT EXISTS idx_reportes_codigo_equipo ON public.reportes (codigo_equipo);
CREATE INDEX IF NOT EXISTS idx_reportes_fecha ON public.reportes (fecha DESC);

-- 3. ACTIVAR ROW LEVEL SECURITY (RLS) EN public.reportes
ALTER TABLE public.reportes ENABLE ROW LEVEL SECURITY;

-- Limpiar políticas previas
DROP POLICY IF EXISTS "reportes_select_authenticated" ON public.reportes;
DROP POLICY IF EXISTS "reportes_insert_own" ON public.reportes;
DROP POLICY IF EXISTS "reportes_update_own" ON public.reportes;
DROP POLICY IF EXISTS "reportes_select_all" ON public.reportes;
DROP POLICY IF EXISTS "reportes_insert_all" ON public.reportes;
DROP POLICY IF EXISTS "reportes_update_all" ON public.reportes;

-- Políticas de lectura, subida y actualización para anon y authenticated
CREATE POLICY "reportes_select_all"
  ON public.reportes
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "reportes_insert_all"
  ON public.reportes
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "reportes_update_all"
  ON public.reportes
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- 4. BUCKET EN SUPABASE STORAGE: 'fotos'
-- =============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos', 'fotos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Limpiar políticas previas de storage.objects
DROP POLICY IF EXISTS "fotos_storage_select_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_insert_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_update_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_select_all" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_insert_all" ON storage.objects;
DROP POLICY IF EXISTS "fotos_storage_update_all" ON storage.objects;

-- Lectura de fotos para cualquier dispositivo
CREATE POLICY "fotos_storage_select_all"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'fotos');

-- Subida de fotos desde cualquier dispositivo
CREATE POLICY "fotos_storage_insert_all"
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'fotos');

-- Sobreescritura por reintento (upsert: true)
CREATE POLICY "fotos_storage_update_all"
  ON storage.objects
  FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'fotos')
  WITH CHECK (bucket_id = 'fotos');
