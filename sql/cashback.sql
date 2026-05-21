-- Tabla del programa de cashback.
-- Un socio se "inscribe" cuando responde al mensaje de bienvenida de su crédito nuevo.
-- Si paga su primera cuota en tiempo y forma, se le reintegra un % de la cuota.
--
-- Ciclo de estados:
--   inscripto      → el socio respondió y quedó anotado (lo hace el bot vía tool)
--   aviso_enviado  → se le mandó el recordatorio 48hs antes del vencimiento (job)
--   reintegrado    → pagó en tiempo y forma, se le hizo el reintegro (humano, admin)
--   descartado     → no pagó a tiempo / no corresponde (humano, admin)
--
-- Correr en el SQL editor de Supabase.

create table if not exists cashback (
  id                 bigint generated always as identity primary key,
  telefono           text        not null,
  dni                text        not null,
  credito_id         text        not null unique,   -- op.id del préstamo nuevo; unique → inscripción idempotente
  primer_vencimiento date        not null,           -- vencimiento de la 1a cuota del préstamo (deadline para pagar a tiempo)
  cuota_social_base  numeric      not null,          -- monto de la cuota social sobre el que se calcula el reintegro
  monto_cashback     numeric      not null,          -- cuota_social_base * porcentaje, congelado al inscribir
  porcentaje         numeric      not null,          -- el % aplicado (ej 0.10), por si cambia a futuro
  estado             text         not null default 'inscripto',
  fecha_inscripcion  timestamptz  not null default now(),
  fecha_aviso        timestamptz,
  fecha_reintegro    timestamptz,
  reintegrado_por    text,
  notas              text
);

create index if not exists cashback_estado_idx on cashback (estado);
create index if not exists cashback_venc_idx   on cashback (primer_vencimiento);

-- RLS prendida: el bot usa la service_role key y se la saltea (igual que las otras tablas).
alter table cashback enable row level security;
