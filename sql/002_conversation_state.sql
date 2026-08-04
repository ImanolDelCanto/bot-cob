-- Estado por teléfono (fuera del historial de mensajes).
--
-- La tabla ya existía con las columnas de handoff, pero el código nunca la leía
-- ni la escribía: era una tabla fantasma con una dependencia dura en /reset
-- (resetHistorial la borra, así que si no existe, /reset falla a medias).
--
-- Correr en el SQL editor de Supabase.

create table if not exists conversation_state (
  telefono            text        primary key,
  handoff             boolean     not null default false,
  handoff_at          timestamptz,
  handoff_reason      text,
  failed_dni_attempts integer     not null default 0,
  last_message_at     timestamptz,
  updated_at          timestamptz not null default now()
);

-- ─── Binding teléfono ↔ DNI verificado ──────────────────────────────────────
--
-- Hasta ahora el DNI que autorizaba el acceso a los datos financieros lo elegía
-- el LLM desde el texto del socio: `consultar_creditos({ dni })` tomaba el DNI
-- de los argumentos del modelo, sin ninguna verificación server-side de que ese
-- DNI fuera el de quien escribe. Escribiendo un DNI ajeno se obtenía nombre,
-- saldo, mora, cargos y vencimientos de otra persona.
--
-- Estas columnas guardan qué DNI verificó efectivamente cada teléfono, para que
-- la autorización deje de depender de una regla del system prompt.
alter table conversation_state add column if not exists dni_verificado     text;
alter table conversation_state add column if not exists dni_verificado_at  timestamptz;

create index if not exists conversation_state_dni_idx
  on conversation_state (dni_verificado);

alter table conversation_state enable row level security;
