# Esquema de la base (Supabase)

Todos los archivos son **idempotentes**: se pueden correr sobre la base actual
sin romper nada (`create table if not exists`, `add column if not exists`,
`create index if not exists`). Correr en orden numérico desde el SQL editor de
Supabase.

| Archivo | Tabla | Para qué |
|---|---|---|
| `001_conversations.sql` | `conversations` | Historial de mensajes por teléfono |
| `002_conversation_state.sql` | `conversation_state` | Estado por teléfono + **binding teléfono↔DNI verificado** |
| `003_sent_messages.sql` | `sent_messages` | **Idempotencia de mensajes proactivos** + estado de entrega |
| `004_comprobantes.sql` | `comprobantes` | Metadata de archivos recibidos + bucket privado |
| `cashback.sql` | `cashback` | Ciclo de vida del programa de cashback |
| `casos_legales.sql` | `casos_legales` | Socios derivados a estudios jurídicos |

## Lo más importante

**`003_sent_messages.sql` crea el índice único `(template_name, external_id)`.**
Toda la idempotencia de los mensajes proactivos depende de él y hasta ahora
existía solo como comentario en `src/jobs/envio.ts`. Sin ese índice, dos corridas
solapadas le mandan el mismo mensaje dos veces al mismo socio.

Ese archivo tiene, antes del `create index`, la consulta para detectar duplicados
preexistentes (que harían fallar la creación) y el `delete` para limpiarlos.

## Verificación después de correr todo

```sql
-- 1. Las 6 tablas existen
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('conversations','conversation_state','sent_messages',
                     'comprobantes','cashback','casos_legales')
order by table_name;

-- 2. El índice único crítico está
select indexname from pg_indexes
where tablename = 'sent_messages'
  and indexname = 'sent_messages_template_external_uidx';

-- 3. RLS prendida en las 6
select relname, relrowsecurity from pg_class
where relname in ('conversations','conversation_state','sent_messages',
                  'comprobantes','cashback','casos_legales')
order by relname;

-- 4. El bucket de comprobantes es privado
select id, public from storage.buckets where id = 'comprobantes';
```

Las tres primeras tienen que devolver 6, 1 y 6 filas con `relrowsecurity = true`.
La cuarta, `public = false`.

## Nota sobre el rename de `cuota_social_base`

Si en algún momento se corrió una versión vieja de `cashback.sql` con la columna
`cuota_social_base`, hay que renombrarla:

```sql
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'cashback' and column_name = 'cuota_social_base'
  ) then
    alter table cashback rename column cuota_social_base to importe_cuota;
  end if;
end $$;
```

El lado código de ese cambio ya está hecho (commit `d5a2ce9`); esto es solo por
si la base quedó atrás.
