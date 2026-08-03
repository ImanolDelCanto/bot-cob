# INSTRUCTIVO — Bot Mutu (Mutual Protecap)

**Estado al 27/05/2026** — supersedes `PROCESOS_BOT_ACTUAL.md` (que quedó desactualizado).

Este documento describe **todo lo que hace el bot hoy** y, al final, **qué falta para salir a producción**.

---

## 1. Qué es

Bot de cobranza + atención por WhatsApp, llamado **Mutu**. Es un servidor Node.js + TypeScript, deployado en **Railway**. Integra:

| Sistema | Para qué |
|---|---|
| WhatsApp Cloud API (Meta) | Mensajería entrante/saliente |
| Gemini 2.5 Flash | Motor conversacional con function calling |
| Supabase (Postgres + Storage) | Historial, comprobantes, idempotencia, cashback |
| Endpoint mutual `/external/listcreditos` | Datos del socio (saldos, cuotas, mora) |
| Portal mockpagos.vercel.app | Pago autogestionable y acuerdos visibles |

---

## 2. Personalidad del bot

- Nombre: **Mutu**, asistente de Mutual Protecap.
- Castellano rioplatense (vos, tuteo argentino).
- Mensajes cortos estilo WhatsApp. Sin párrafos largos. Sin listas numeradas tipo folleto.
- **Formato WhatsApp**: negrita con un solo asterisco (`*así*`). Nunca Markdown (`**así**`). URLs siempre peladas, sin asteriscos.
- Prohibido mandar mensajes "puente" (`"dame un segundito"`, `"ya te confirmo"`) — las tools se ejecutan en el acto, hay que responder con el resultado en el mismo turno.

---

## 3. Las 4 herramientas que tiene

| Tool | Qué hace | Requisito |
|---|---|---|
| `verificar_dni` | Busca el socio por DNI en el endpoint. Devuelve `{verificado, nombre}`. | Obligatorio antes de revelar info financiera |
| `consultar_creditos` | Devuelve el resumen consolidado del socio (saldo con cargos, cuotas, mora, datos de renovación). | DNI verificado |
| `obtener_medios_de_pago` | Devuelve los medios de pago (portal, transferencia, rapipago, Mercado Pago). | — |
| `inscribir_cashback` | Inscribe al socio en el programa de cashback (10% de la primera cuota). | DNI verificado |

---

## 4. Flujos principales

### 4.1 Identificación
- Siempre pide DNI — nunca confía en el teléfono (puede ser de familiar/amigo).
- Primera vez se presenta como Mutu. Mensajes siguientes no se vuelve a presentar.
- Si el DNI no verifica, le da tips (sin puntos, sin espacios, DNI vigente). Después de **5 intentos fallidos** ofrece humano (`+54 9 11 2621-4000`).

### 4.2 Consulta de saldo y mora
- Una vez verificado, llama `consultar_creditos` y arma la respuesta.
- Suma todos los productos en **un saldo único**. Internamente hay préstamo + cuota social + asistencia, pero el cliente NUNCA los ve separados (excepto si pregunta explícitamente "qué productos tengo").
- Si está **en mora**: habla del saldo a regularizar (con cargos por atraso ya incluidos) y los días de atraso. Nunca menciona una fecha futura.
- Si está **al día**: dice cuándo vence la próxima cuota y el monto.
- Si la deuda es **grande (>$300k)**: empatía amplificada. Valida antes de tirar el número, suaviza el monto, pregunta cómo está.

### 4.3 "No puedo pagar" — toolbox empático
Es la conversación más importante de cobranza. El objetivo NO es derivar, es buscar la forma de cobrar algo.

| Herramienta | Cuándo usarla |
|---|---|
| **Pago parcial** | Deudas chicas/medias (≤ $500k) donde el cliente sugiere que puede aportar algo |
| **Compromiso de pago a fecha** | "No puedo ahora", "tengo que esperar el sueldo" |
| **Cuenta corriente online** | Para cerrar dejándole una salida autogestionable |
| **Acuerdo en cuotas con quita** | Solo si mora >90 días. Con quita sobre **capital + intereses**. Cliente lo ve cargado en mockpagos |

Regla: **una opción por mensaje**, esperando la respuesta antes de probar otra. Nunca disparar 4 opciones juntas.

Para deudas >$500k, el acuerdo es la **primera** opción, no la última.

### 4.4 Renovación / nuevo crédito
Cuando el socio pregunta por renovar o sacar otro crédito:

| Caso | Qué hace el bot |
|---|---|
| En mora activa | Le dice (con mucho tacto) que primero hay que regularizar |
| Al día + ≥80% pagado **O** crédito cancelado previo | Deriva al **asesor de ventas** (otro número que el de cobranza) |
| Al día pero <80% y sin créditos cancelados | "Todavía no, falta un poco más" |
| Sin crédito (solo cuota social) | Deriva a ventas para evaluar un primer crédito |

Reglas: nunca expone el umbral 80% como regla fría, nunca confunde ventas con cobranza, nunca promete que está aprobado.

### 4.5 Cashback (programa de bienvenida)

**Flujo completo:**

1. **Welcome (job proactivo)** — Cuando se acredita un crédito nuevo, el bot manda mensaje con resumen + hook `"agendá y respondé este mensaje, tenemos un beneficio"`.
2. **Cliente responde** — Pregunta por el beneficio.
3. **Bot inscribe** — Pide DNI, verifica, llama `inscribir_cashback` y explica: 10% de la primera cuota como reintegro si paga en tiempo y forma.
4. **Aviso 48hs antes (job proactivo)** — Le recuerda el vencimiento.
5. **Cliente paga a tiempo** — Verificación manual.
6. **Reintegro 48hs después** — Un humano hace la transferencia desde `/admin/cashback/pendientes`.

**Elegibilidad (filtros que aplica `inscribir_cashback`):**
- El socio tiene un préstamo con `esCredito=true`, `estado='Activa'`.
- `cuotasPagadas === 0` (primera cuota todavía no se pagó).
- `primerVencimiento >= hoy` (primera cuota todavía no venció). Si ya pasó, no inscribe — sería prometer algo imposible de cumplir.

**Regla del 21 (importante para entender el primer vencimiento):**
- Si un crédito se vende ENTRE los días 1 y 20 del mes, la primera cuota se cobra el primer día del **mes siguiente**.
- Si un crédito se vende DESDE el día 21 en adelante, la primera cuota se cobra el primer día del **mes subsiguiente** (se "saltea" un mes).
- Ejemplo: vendido 15-abril → primera cuota 1-mayo. Vendido 21-abril → primera cuota 1-junio.
- El endpoint de la mutual ya devuelve `Primer vto.` con la fecha correcta — el bot lo usa tal cual, sin recalcular.
- Esto define la **cohorte mensual** del cashback: clientes con primera cuota en el mismo mes son la misma cohorte (ej: todos los del 21-abril al 20-mayo tienen primera cuota el 1-junio).

**Reglas de comunicación:**
- El monto del reintegro lo decide la tool, el bot **nunca lo inventa**.
- Es por única vez, solo aplica a la primera cuota del crédito nuevo.
- Si el socio no tiene crédito elegible, el bot le dice con honestidad que el cashback es para créditos nuevos.

### 4.6 Comprobantes de pago
- Si el cliente menciona en texto que va a mandar comprobante: el bot le pide que también se lo mande al asesor humano (`+54 9 11 2621-4000`), porque el bot solo lo guarda de respaldo, no lo carga.
- Si el cliente **manda directamente** una imagen o PDF: el sistema lo guarda en Supabase Storage automáticamente, **sin pasar por el LLM**, y le contesta con un mensaje fijo que también lo mande al asesor humano.

### 4.7 Pagos por débito automático
Si el cliente dice "ya se debitó pero no figura": el bot le explica que el banco informa dentro de las 48hs hábiles, que no tiene que hacer nada, y que después de 48hs hábiles sí avise para que un asesor revise. **NO** le pide comprobante en este caso (es débito, no transferencia).

### 4.8 Servicios de la mutual
Si el socio pregunta qué ofrece la mutual: el bot le cuenta los 5 servicios (ayudas económicas, salud, electrohogar, turismo, Comunidad Protecap) y le pasa los links. Si está en mora, le aclara que requieren estar al día. **No** los menciona espontáneamente si está en mora — suena a vender mientras se cobra.

### 4.9 Socios en estudio jurídico

Tabla `casos_legales` en Supabase. Cuando un socio está derivado a un estudio externo, el equipo de la mutual lo carga ahí (con DNI + nombre del estudio + contacto). A partir de ese momento:

- **Welcome / cashback aviso / recordatorio de vencimiento** → skip automático. El bot no le manda nada proactivo.
- **Si el socio escribe al bot** → la tool `verificar_dni` devuelve `en_estudio_legal: true` + datos del estudio. El bot le explica con respeto que su caso lo lleva el estudio y le pasa el contacto. No avanza con saldos ni acuerdos.

Operativa:
- Cargar caso: `POST /admin/casos-legales` con `{dni, estudio_nombre, estudio_contacto, notas?}`.
- Listar activos: `GET /admin/casos-legales`.
- Dar de baja (cuando el caso se cierra y el socio vuelve al bot): `POST /admin/casos-legales/:id/baja`.

### 4.10 Casos extremos que SÍ se derivan a humano

Solo en estos casos el bot deriva sin dudarlo:
- Cliente lo pide explícitamente.
- Violencia o salud grave.
- Reclamo de débito en exceso, cobro indebido o pago no acreditado (pero antes de derivar, gathera datos).
- Sospecha de fraude o robo de identidad.
- Error administrativo demostrable.
- Pedido formal de baja.

**Importante:** "perdí el trabajo" / "no puedo pagar este mes" **NO** es un caso para derivar — es exactamente la conversación que el bot tiene que manejar (toolbox empático).

---

## 5. Lo que pasa automágicamente detrás

### 5.1 Buffer de mensajes (debounce + serialización)
- Si el cliente manda 3 mensajes seguidos, el bot espera 10s de silencio y los procesa **juntos** como un solo turno.
- Si el cliente escribe mientras el LLM está pensando, los mensajes nuevos se acumulan y disparan otro ciclo después — nunca dos respuestas overlappeadas.

### 5.2 Short-circuits sin LLM
- "Gracias" o solo emojis → responde 👍 directo, sin gastar tokens.
- Imagen / PDF → se guarda y se responde con texto fijo.
- Audio / video / sticker → respuesta fija "solo proceso texto".

### 5.3 Cálculo del saldo (consolidador)
El bot **replica la lógica de mockpagos** en [src/data/consolidador.ts](src/data/consolidador.ts) para que el saldo en bot y portal coincida al peso:
- Sintetiza las cuotas mes a mes (el endpoint solo trae agregados).
- Filtra meses donde algún addon falta (`mesesVisibles`).
- Distribuye `Saldo venc.` entre vencidas (pagos parciales).
- Usa monto histórico de cuota social según el mes del vencimiento.
- Suma cargos por atraso (10% admin desde día 1 + 0,5% diario, tope 110%).
- Consolida por mes en una cuota única.

### 5.4 Sanitizador de WhatsApp
[src/whatsapp/webhook.ts](src/whatsapp/webhook.ts) `sanitizeForWhatsApp`: antes de mandar cualquier mensaje, colapsa `**bold**` (Markdown) a `*bold*` (WhatsApp) y le saca asteriscos a URLs. Defensa contra el LLM que escapa la regla del prompt.

### 5.5 Historial de conversación
Cada turno se guarda en la tabla `conversations` de Supabase. El bot carga los últimos 60 mensajes para mantener contexto. Cuando el welcome o el cashback aviso disparan, **también guardan** una nota interna + el mensaje del bot, así cuando el socio responde el LLM ya tiene contexto.

### 5.6 Jobs proactivos (scheduler interno)
Mientras el server está arriba, tres jobs corren solos:
- **Welcome** cada 2hs — manda bienvenida a créditos liquidados en últimas 48hs.
- **Cashback aviso** cada 6hs — recordatorio del cashback a inscriptos cuya primera cuota vence en ≤2 días.
- **Vencimiento aviso** cada 6hs — recordatorio de cuota próxima a todos los socios cuya próxima cuota vence en 2 días (excepto los que están en estudio jurídico, o que ya tienen cashback aviso para la misma fecha).
- Todos respetan ventana horaria (10-21hs ARG) y son idempotentes.
- Se gatean por `JOBS_SCHEDULER_ENABLED` + WhatsApp configurado.
- **Tope de envíos por corrida** (`JOBS_MAX_ENVIOS_POR_CORRIDA`, default 60) más una
  pausa entre envíos (`JOBS_DELAY_ENTRE_ENVIOS_MS`, default 1s). Ver [src/jobs/rateLimit.ts](src/jobs/rateLimit.ts).
  Lo que queda fuera del cupo se loguea con `⚠️ cupo por corrida agotado` y se
  retoma en la corrida siguiente — nunca se descarta en silencio.
- Mientras dura una corrida el snapshot del endpoint queda **congelado**
  (`retenerDatos()` / `liberarDatos()`), así no se re-descargan los ~38MB a mitad
  de camino cuando vence el TTL de 5 min.

### 5.7 Límites de mensajería de Meta (importante antes de escalar)

Meta limita cuántos socios **distintos** podés contactar por iniciativa propia cada
24hs: tier 250 → 1.000 → 10.000 → 100.000 → ilimitado. Un número recién habilitado
arranca en **250**. Se sube solo con volumen sostenido + buena calidad (verde), y
pasarse o acumular bloqueos/reportes baja el tier o restringe el número.

Dimensión real medida el 3/8/2026: una sola corrida de vencimiento-aviso encontró
**1368 candidatos**. Con tier 250 no entran — hay que definir una política de
priorización (¿por monto? ¿solo al día? ¿escalonado en varios días?). El tope por
corrida evita quemar el número, pero la política de a quién avisar es decisión de
producto, no de código.

---

## 6. Endpoints HTTP

### Públicos
- `GET /health` — healthcheck.
- `GET /whatsapp/webhook` — verificación inicial de Meta.
- `POST /whatsapp/webhook` — mensajes entrantes (firma HMAC validada si `WHATSAPP_APP_SECRET`).

### Protegidos (`Authorization: Bearer ADMIN_TOKEN`)
- `POST /chat` — disparar conversación manual.
- `POST /reset` — borrar historial de un teléfono.
- `POST /admin/jobs/welcome` — disparar job de welcome (créditos liquidados en últimas 48hs).
- `POST /admin/jobs/welcome-bulk` — body `{dnis: string[]}`. Manda welcome a una lista explícita de DNIs (catch-up inicial, cohortes históricas). Idempotente.
- `POST /admin/jobs/cashback-aviso` — disparar job de aviso de cashback.
- `POST /admin/jobs/vencimiento-aviso` — disparar job de recordatorio de vencimiento.
- `POST /admin/casos-legales` — body `{dni, estudio_nombre, estudio_contacto?, notas?}`. Derivar un socio al estudio (el bot deja de hablarle).
- `GET /admin/casos-legales` — listar casos activos.
- `POST /admin/casos-legales/:id/baja` — dar de baja un caso (el socio vuelve al bot).
- `GET /admin/cashback/pendientes` — listar cashbacks abiertos.
- `POST /admin/cashback/:id/marcar-reintegrado` — humano confirma reintegro.
- `POST /admin/cashback/:id/descartar` — no pagó a tiempo.
- `GET /admin/comprobantes/pendientes` — listar comprobantes a revisar.
- `POST /admin/comprobantes/:id/marcar-procesado` — humano confirmó pago.
- `POST /admin/comprobantes/:id/marcar-rechazado` — humano rechazó.

---

## 7. Persistencia (Supabase)

| Tabla | Para qué |
|---|---|
| `conversations` | Historial completo de mensajes por teléfono |
| `conversation_state` | Estado por teléfono (no se está usando hoy, pero existe) |
| `sent_messages` | Idempotencia: qué template/welcome se mandó a qué crédito |
| `comprobantes` | Metadata + estado de archivos recibidos |
| `cashback` | Ciclo de vida del programa de cashback |
| `casos_legales` | Socios derivados a estudios jurídicos (el bot no les habla) |
| Bucket `comprobantes` | Archivos reales (imágenes/PDFs), privado |

---

## 8. Seguridad — qué está cubierto

| Riesgo | Estado |
|---|---|
| Endpoints públicos `/chat` y `/reset` | ✅ Protegidos con `requireAdmin` |
| Webhook de WhatsApp falsificable | ✅ Verifica firma HMAC con `WHATSAPP_APP_SECRET` (si está seteado) |
| Timing attack en token admin | ✅ `crypto.timingSafeEqual` con hash SHA-256 |
| Errores filtran internals | ✅ Respuestas genéricas `{error: 'internal'}` |
| Subida de archivos sin validar | ✅ Whitelist mime + tope 10MB + teléfono numérico (anti path traversal) |
| Secretos en repo | ✅ `.env` en `.gitignore`, nunca commiteado |

---

## 9. Variables de entorno necesarias

```env
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
PORT=3000

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_APP_SECRET=                 # ← CRÍTICO para producción

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_BUCKET_COMPROBANTES=comprobantes

CONVERSATION_HISTORY_LIMIT=60
MESSAGE_DEBOUNCE_MS=10000

ADMIN_TOKEN=                         # ← rotar antes de prod

JOBS_HOUR_START=10
JOBS_HOUR_END=21
JOBS_SCHEDULER_ENABLED=true          # apagarlo si no querés que el scheduler corra solo
JOBS_WELCOME_EVERY_HOURS=2
JOBS_CASHBACK_EVERY_HOURS=6
JOBS_MAX_ENVIOS_POR_CORRIDA=60       # ← tope por corrida (ver "Límites de Meta")
JOBS_DELAY_ENTRE_ENVIOS_MS=1000      # pausa entre envíos consecutivos

USE_MOCK_DB=false                    # true para testing local con datos mock
ENDPOINT_BASE_URL=
ENDPOINT_TICKET=
ENDPOINT_EMPRESA_ID=
ENDPOINT_TIMEOUT_MS=30000
ENDPOINT_CACHE_TTL_MS=300000
ENDPOINT_STALE_MAX_MS=1800000        # cuánto se sirve el snapshot viejo mientras refresca atrás

CASHBACK_PORCENTAJE=0.1
CASHBACK_AVISO_DIAS_ANTES=2

# Cargos por atraso (defaults validados contra el sistema de la mutual)
CARGOS_TASA_DIARIA=0.005
CARGOS_CARGO_ADMINISTRATIVO=0.10
CARGOS_TOPE_MAXIMO=1.10
CARGOS_UMBRAL_DIAS=1                 # 10% admin desde el día 1
```

---

# 🚧 LO QUE FALTA — antes de producción

## 🔴 Bloqueantes reales

### 1. Plantilla aprobada de WhatsApp en Meta
**El más importante.** Sin esto, no se puede iniciar conversación con un cliente que no escribió primero. Welcome y aviso de cashback van a fallar para clientes nuevos.

**Pasos:**
1. Crear las plantillas en Meta Business Manager → tu app → Plantillas de mensajes.
2. Sugeridas: `bienvenida_credito` (con variables para nombre, monto, cuotas, vencimiento) y `cashback_aviso_48hs` (nombre, monto, fecha, reintegro).
3. Esperar aprobación de Meta (horas a días).
4. **Cambio de código necesario:** `sendWhatsAppMessage` hoy manda `type: 'text'`. Hay que agregar `sendWhatsAppTemplate(to, templateName, params)` que mande `type: 'template'`, y que los jobs welcome + cashback-aviso lo usen.

### 2. Proceso operacional de reintegros del cashback
El bot promete *"el reintegro 48hs después de que pagues"*, pero la transferencia real la hace **una persona** desde `/admin/cashback/pendientes`. Sin alguien encargado:
- Prometemos algo que no cumplimos → daño reputacional.
- Riesgo de bloqueos por parte de socios decepcionados.

Decidir quién es esa persona, cuándo revisa, qué medio usa para transferir.

### 3. Correr SQLs en Supabase
- [sql/cashback.sql](sql/cashback.sql) — tabla del programa de cashback. Si ya corriste una versión vieja con columna `cuota_social_base`, renombrala: `alter table cashback rename column cuota_social_base to importe_cuota;`
- [sql/casos_legales.sql](sql/casos_legales.sql) — tabla de socios derivados a estudios jurídicos.

### 4. Variables a setear en Railway antes de salir
- **`ADMIN_TOKEN`** — rotar el actual (el de testing quedó expuesto). Generar con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **`WHATSAPP_APP_SECRET`** — el de Meta Business → Configuración → Básica.
- **`USE_MOCK_DB=false`** — confirmar que está en false (hoy quedó en true para testing).

### 5. Número real del asesor de ventas
Hoy hay un placeholder `+54 9 11 1234-5678` en [src/llm/prompts.ts](src/llm/prompts.ts). Cuando lo tengas, reemplazar (un solo cambio).

---

## 🟡 Validación pendiente (tests funcionales)

Probar en WhatsApp real cada flujo end-to-end:

| Caso | DNI sugerido | Qué verificar |
|---|---|---|
| Cobranza + acuerdo + quita | DNI en mora >90 días | Bot menciona quita capital+intereses, cierra en portal |
| Renovación caso A | DNI en mora | "No puedo, primero regularicemos" con tacto |
| Renovación caso B | DNI al día + ≥80% pagado | Deriva al asesor de ventas |
| Renovación caso C | DNI al día <80% | "Todavía no, falta más" |
| Renovación caso D | DNI sin crédito | Deriva a ventas para primer crédito |
| Cashback | Cliente con crédito nuevo (cuotasPagadas=0) | Inscribe + da monto correcto ($X = 10% de cuota) |
| Saldo coincide con portal | DNI 31203887 (Andrea) | Bot dice ≈ $560.945 (mismo que portal) |
| Sanitizer | Cualquiera | No aparecen `**` ni URLs con asteriscos |
| Comprobante | Cualquiera + manda imagen | Se guarda + responde el texto fijo |
| Débito automático | DNI que pagó por débito | Explica las 48hs hábiles, no pide comprobante |

---

## 🟢 Mejoras técnicas pendientes (no bloquean salida)

| Mejora | Por qué importa |
|---|---|
| PII enmascarada en logs | Hoy Railway loguea teléfono completo + texto del mensaje. Riesgo de exposición |
| Rate limiting en `/whatsapp/webhook` | Sin esto, un atacante (si tiene la firma) puede DoS el endpoint |
| Política de retención de `conversations` | Crece indefinidamente, PII sensible sin TTL. Pensar GDPR / regulación local |
| Tests automatizados | Funciones puras (`cargosAtraso`, `sanitizeForWhatsApp`, `isTerminalCloser`, `consolidador`) — para algo con plata real |
| Alerting (Sentry / Slack) | Errores en jobs hoy mueren en logs de Railway, nadie es alertado |
| `mockpagos` link de "Hablar con Mutu" | Confirmar que apunta al número final cuando esté |

---

## 📋 Checklist de lanzamiento

Cuando todos estos estén ✅, podemos salir:

- [ ] Plantillas de WhatsApp aprobadas en Meta
- [ ] Código actualizado para mandar templates (welcome + cashback-aviso)
- [ ] `sql/cashback.sql` corrido en Supabase
- [ ] Persona designada para revisar reintegros del cashback a diario
- [ ] `ADMIN_TOKEN` rotado en Railway
- [ ] `WHATSAPP_APP_SECRET` seteado en Railway
- [ ] `USE_MOCK_DB=false` confirmado en Railway
- [ ] Número real del asesor de ventas en el prompt
- [ ] 10 flujos de la tabla de validación probados en WhatsApp real
- [ ] Saldo del bot coincide con el portal para 2-3 DNIs reales (incluyendo Andrea)
