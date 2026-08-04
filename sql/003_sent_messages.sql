-- Idempotencia de mensajes proactivos.
--
-- ⚠️  ESTE ES EL ARCHIVO MÁS IMPORTANTE DE LA CARPETA.
--
-- src/jobs/envio.ts reserva una fila ANTES de mandar el mensaje y detecta el
-- duplicado por la violación de índice único (código 23505). Ese índice existía
-- únicamente como comentario en envio.ts:16 — nunca hubo un .sql que lo creara.
--
-- Sin el índice único:
--   • El INSERT nunca devuelve 23505, así que la rama `resultado: 'duplicado'`
--     de envio.ts es código muerto y la reserva no funciona como lock.
--   • Dos corridas solapadas (el scheduler + un POST manual a /admin/jobs/*)
--     mandan el MISMO mensaje dos veces al mismo socio.
--   • Peor: en cuanto quedan dos filas iguales, el pre-chequeo con .maybeSingle()
--     de welcome.ts y vencimientoAviso.ts devuelve error de PostgREST y ese socio
--     queda bloqueado para siempre, sin recibir nunca más un aviso.
--
-- Correr en el SQL editor de Supabase.

create table if not exists sent_messages (
  id            bigint generated always as identity primary key,
  telefono      text        not null,
  template_name text        not null,   -- 'bienvenida_credito' | 'cashback_aviso_48hs' | 'recordatorio_vencimiento'
  external_id   text        not null,   -- id del crédito, o `${dni}-${fechaCuota}` según el job
  sent_at       timestamptz not null default now()
);

-- ─── PASO 1: verificar que no haya duplicados antes de crear el índice ──────
-- Si esta consulta devuelve filas, el CREATE UNIQUE INDEX de abajo va a fallar.
-- Mirá qué son antes de borrar nada.
--
--   select template_name, external_id, count(*), min(id) as conservar
--   from sent_messages
--   group by template_name, external_id
--   having count(*) > 1;
--
-- Para deduplicar conservando la fila más vieja de cada grupo:
--
--   delete from sent_messages a
--   using sent_messages b
--   where a.template_name = b.template_name
--     and a.external_id  = b.external_id
--     and a.id > b.id;

-- ─── PASO 2: el índice ──────────────────────────────────────────────────────
create unique index if not exists sent_messages_template_external_uidx
  on sent_messages (template_name, external_id);

-- ─── PASO 3: visibilidad de entrega ─────────────────────────────────────────
-- Sin estas columnas, `sent_messages` no distingue "se entregó" de "el número no
-- existe": un socio con el teléfono mal cargado deja de recibir recordatorios
-- para siempre y nadie se entera. Meta reporta buena parte de los fallos por el
-- webhook (value.statuses[].status = 'failed'), no en la respuesta del POST.
alter table sent_messages add column if not exists estado        text not null default 'enviado';
alter table sent_messages add column if not exists error_codigo  integer;
alter table sent_messages add column if not exists error_detalle text;
alter table sent_messages add column if not exists wamid         text;
alter table sent_messages add column if not exists actualizado_at timestamptz;

-- estado: 'enviado' (aceptado por la API) | 'entregado' | 'leido' | 'fallido'
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sent_messages_estado_check'
  ) then
    alter table sent_messages
      add constraint sent_messages_estado_check
      check (estado in ('enviado', 'entregado', 'leido', 'fallido'));
  end if;
end $$;

-- Para el limiter de 24hs compartido entre jobs (cuenta envíos recientes) y
-- para el endpoint de envíos fallidos.
create index if not exists sent_messages_sent_at_idx on sent_messages (sent_at desc);
create index if not exists sent_messages_estado_idx  on sent_messages (estado) where estado = 'fallido';
create index if not exists sent_messages_wamid_idx   on sent_messages (wamid);

alter table sent_messages enable row level security;

-- ─── PASO 4: verificación ───────────────────────────────────────────────────
-- Después de correr todo, esto tiene que devolver una fila:
--
--   select indexname from pg_indexes
--   where tablename = 'sent_messages'
--     and indexname = 'sent_messages_template_external_uidx';
