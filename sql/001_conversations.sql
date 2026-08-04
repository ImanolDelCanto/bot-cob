-- Historial de conversación por teléfono.
--
-- Cada turno del chat se guarda como una fila (role + parts en formato Gemini).
-- El bot carga los últimos CONVERSATION_HISTORY_LIMIT mensajes en cada turno.
--
-- Esta tabla existía en Supabase pero NO tenía DDL versionado: se había creado a
-- mano en el editor. Este archivo refleja el esquema real (leído del proyecto) y
-- es idempotente, así que correrlo sobre la base actual no rompe nada.
--
-- Correr en el SQL editor de Supabase.

create table if not exists conversations (
  id         bigint generated always as identity primary key,
  telefono   text        not null,
  role       text        not null,   -- 'user' | 'model' (formato Gemini)
  parts      jsonb       not null,   -- [{ text: '...' }]
  created_at timestamptz not null default now()
);

-- Índice del hot path: se consulta en CADA mensaje entrante, filtrando por
-- teléfono y ordenando por fecha descendente para traer los últimos N.
-- Sin esto, con el historial creciendo, cada mensaje hace un seq scan.
create index if not exists conversations_telefono_fecha_idx
  on conversations (telefono, created_at desc, id desc);

-- Sanity check del rol, para que un bug no meta un valor que después Gemini rechaza.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversations_role_check'
  ) then
    alter table conversations
      add constraint conversations_role_check check (role in ('user', 'model'));
  end if;
end $$;

alter table conversations enable row level security;

-- NOTA DE RETENCIÓN (pendiente de decisión de producto):
-- Esta tabla crece indefinidamente y guarda PII sensible en claro (teléfono,
-- DNI que el socio escribe, montos, situación de mora). No hay TTL ni borrado
-- automático. Cuando se defina la política, algo así:
--
--   delete from conversations where created_at < now() - interval '12 months';
