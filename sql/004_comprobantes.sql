-- Comprobantes de pago recibidos por WhatsApp.
--
-- Cuando el socio manda una imagen o PDF, el archivo va al bucket privado
-- `comprobantes` de Supabase Storage y la metadata queda acá. Un humano los
-- revisa desde /admin/comprobantes/pendientes.
--
-- Esta tabla existía sin DDL versionado. Este archivo refleja el esquema real.
--
-- Correr en el SQL editor de Supabase.

create table if not exists comprobantes (
  id             bigint generated always as identity primary key,
  telefono       text        not null,
  archivo_path   text        not null,   -- path dentro del bucket: `${telefono}/${timestamp}.${ext}`
  tipo_archivo   text        not null,   -- mime normalizado
  tamano_bytes   integer,
  fecha_recibido timestamptz not null default now(),
  estado         text        not null default 'pendiente',
  procesado_por  text,
  procesado_at   timestamptz,
  notas          text
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'comprobantes_estado_check'
  ) then
    alter table comprobantes
      add constraint comprobantes_estado_check
      check (estado in ('pendiente', 'procesado', 'rechazado'));
  end if;
end $$;

-- El listado de pendientes es la query que corre el operador humano todos los días.
create index if not exists comprobantes_pendientes_idx
  on comprobantes (fecha_recibido desc) where estado = 'pendiente';
create index if not exists comprobantes_telefono_idx on comprobantes (telefono);

alter table comprobantes enable row level security;

-- ─── Bucket de Storage ──────────────────────────────────────────────────────
-- El bucket `comprobantes` tiene que existir y ser PRIVADO (el bot genera URLs
-- firmadas con vencimiento para que el operador las vea). Crearlo desde el
-- dashboard, o:
--
--   insert into storage.buckets (id, name, public)
--   values ('comprobantes', 'comprobantes', false)
--   on conflict (id) do update set public = false;
--
-- Verificar que quedó privado:
--   select id, public from storage.buckets where id = 'comprobantes';
