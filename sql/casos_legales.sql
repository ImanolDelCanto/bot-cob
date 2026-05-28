-- Tabla de socios derivados a estudios jurídicos.
-- Cuando un socio cae acá, el bot NO le inicia conversación (welcome, recordatorios
-- de cuota, cashback aviso, etc.). Si el socio escribe, el bot le explica que su
-- caso está siendo gestionado por el estudio y pasa los datos de contacto.
--
-- Esto evita que el bot moleste a clientes que ya están en proceso legal y que el
-- equipo jurídico maneja por separado.
--
-- Correr en el SQL editor de Supabase.

create table if not exists casos_legales (
  id                 bigint generated always as identity primary key,
  dni                text        not null,
  estudio_nombre     text        not null,
  estudio_contacto   text,                                 -- tel / email / lo que sea útil para el socio
  fecha_derivacion   date        not null default current_date,
  notas              text,
  creado_at          timestamptz not null default now(),
  activo             boolean     not null default true     -- false si el caso se cerró y el socio vuelve al bot
);

-- Un DNI puede estar en estudio una sola vez activo a la vez (lookup rápido por DNI).
create unique index if not exists casos_legales_dni_activo_idx
  on casos_legales (dni)
  where activo = true;

create index if not exists casos_legales_dni_idx on casos_legales (dni);

-- RLS prendida: el bot usa la service_role key y se la saltea (igual que las otras tablas).
alter table casos_legales enable row level security;
