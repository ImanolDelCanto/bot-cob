# PROCESOS DEL BOT MUTU — ESTADO ACTUAL

**Mutual Protecap** — Bot de cobranza por WhatsApp
Documento de relevamiento de procesos al **11/05/2026**

---

## 1. Resumen ejecutivo

El bot actual (llamado **Mutu**) es el sucesor de Rogelio. A diferencia de aquel, este bot está enfocado **principalmente en cobranza**, no en venta. La idea central es generar un "círculo de confianza" con el socio: que la persona converse con el bot, que se sienta cómoda, y que el bot lo acompañe en su relación con la mutual.

Hoy el bot vive como un servidor Node.js + TypeScript que se integra con:

- **WhatsApp Cloud API** (Meta) para mensajería entrante y saliente.
- **Gemini 2.5 Flash** (Google Gen AI) como motor conversacional con function calling.
- **Supabase** (Postgres + Storage) para persistencia de historial, comprobantes e idempotencia.
- **Endpoint interno de la mutual** (`/external/listcreditos`) para los datos de socios y créditos.

---

## 2. Identidad y tono del bot

| Atributo | Valor |
|---|---|
| Nombre | Mutu |
| Empresa | Mutual Protecap |
| Personalidad | Cálido, paciente, profesional |
| Idioma | Castellano rioplatense (vos / tuteo argentino) |
| Estilo | Mensajes cortos estilo WhatsApp, sin emojis excesivos |
| Contacto humano | +54 9 11 2621-4000, Lun a Vie 9-17hs |

**Variación obligatoria:** el bot nunca debe repetir el mismo mensaje palabra por palabra. Si vuelve a pedir algo (DNI, por ejemplo), debe reformularlo.

---

## 3. Reglas duras del bot (no se rompen nunca)

1. **No se identifica al usuario por número de teléfono.** Siempre se pide DNI (muchos contactan desde números de familiares o amigos).
2. En el **primer mensaje** se presenta como Mutu de Mutual Protecap y pide DNI. En los siguientes mensajes NO se vuelve a presentar.
3. **No revela información financiera** (saldos, montos, vencimientos, números de crédito, días de mora) hasta que `verificar_dni` devuelva `true`.
4. Si `verificar_dni` devuelve `false`, pide reintentar. **A los 3 intentos fallidos** deriva al teléfono humano.
5. **Nunca inventa datos.** Si una tool no devuelve info, dice que no la encuentra y ofrece contacto humano.
6. **No da consejo financiero, legal ni impositivo.**
7. **No promete condonaciones, refinanciaciones ni quitas.** Esos casos se derivan a un asesor humano.
8. Si el cliente menciona **violencia, salud grave o situación crítica**, responde con empatía y deriva a humano.
9. La deuda del cliente se presenta como **UNA SOLA**, aunque internamente sean varias operaciones (préstamo + cuota social + asistencia). Solo se desglosa si el cliente pregunta explícitamente por sus productos.
10. **Estado de pago:** si está en mora, habla del saldo vencido y los días de atraso (nunca de "próximo vencimiento" como fecha futura, eso confunde). Si está al día, informa la próxima fecha de vencimiento.
11. **Cuota mensual pura:** lo que paga sin punitorios ni recargos por mora. Suma préstamo + cuota social ($15.000 fijo) + asistencia.

---

## 4. Procesos que el bot HACE hoy

### 4.1. Proceso: Bienvenida e identificación

**Disparador:** primer mensaje del socio al bot.

**Flujo:**
1. Bot se presenta como Mutu de Mutual Protecap.
2. Pide el DNI del socio (sin puntos ni espacios).
3. Si el socio ya envió DNI antes en la conversación, no lo vuelve a pedir.
4. En mensajes posteriores sin DNI todavía, lo recuerda brevemente con palabras distintas cada vez.

**Tools usadas:** ninguna en esta etapa.

---

### 4.2. Proceso: Verificación de DNI

**Disparador:** el socio envía algo que parece un DNI.

**Flujo:**
1. Bot llama a la tool `verificar_dni(dni)`.
2. Si existe: continúa con consultas que requieran datos.
3. Si no existe: pide reintentar.
4. A los **3 intentos fallidos**, deriva al +54 9 11 2621-4000.

**Tool involucrada:** `verificar_dni`
**Fuente de datos:** endpoint `/external/listcreditos` (o mock en desarrollo).

---

### 4.3. Proceso: Consulta de saldo / situación crediticia

**Disparador:** socio (ya verificado) pregunta cuánto debe, cuál es su cuota, cuándo vence, etc.

**Flujo:**
1. Bot llama a `consultar_creditos(dni)`.
2. Se calcula el **resumen agregado** (suma préstamo + cuota social + asistencia).
3. Según `resumen.estado`:
   - **`en_mora`:** informa saldo vencido + días de atraso + fecha de la cuota más vieja sin pagar.
   - **`al_dia`:** informa próxima fecha de vencimiento + cuota mensual pura.
4. NUNCA lista los productos por separado, salvo que el cliente pregunte explícitamente "¿qué productos tengo?".

**Tool involucrada:** `consultar_creditos`
**Campos clave del endpoint usados:**
- `Saldo total`, `Saldo venc.`, `Imp. cuota`, `Ctas. impagas`, `Ctas. Imp. Venc.`, `Primer vto.`, `Fecha liquidación`, `Estado`, `Producto`.

---

### 4.4. Proceso: Información de medios de pago

**Disparador:** socio pregunta cómo pagar.

**Flujo:**
1. Bot llama a `obtener_medios_de_pago()`.
2. Devuelve 3 opciones:
   - **Transferencia bancaria** (CBU, alias, CUIT) — directa.
   - **Rapipago** — requiere asesor humano para generar la boleta.
   - **Tarjeta de crédito (Mercado Pago)** — requiere asesor humano para enviar link.
3. Después de pagar, le pide al socio enviar el comprobante por el mismo chat.

**Datos actuales:**
- Empresa: PROTECAP — CUIT 30-70954656-9
- Banco Patagonia, cuenta corriente en pesos 145-145005454-000
- Alias: ESPEJO.ASTRO.LITIO
- CBU: 0340145900145005454004

**Tool involucrada:** `obtener_medios_de_pago`

---

### 4.5. Proceso: Recepción de comprobantes (imagen / PDF)

**Disparador:** el socio envía una imagen o documento por WhatsApp.

**Flujo (NO pasa por el LLM):**
1. Webhook detecta `message.type === 'image'` o `'document'`.
2. Descarga el archivo desde Meta (proceso de 2 pasos: pedir URL temporal → bajar binario).
3. Sube el archivo a Supabase Storage (bucket `comprobantes`, privado).
4. Registra en la tabla `comprobantes` con estado `pendiente`.
5. Responde automáticamente al socio: "Recibí tu comprobante, para que se registre mandalo también al asesor +54 9 11 2621-4000". El pago **queda sujeto a verificación humana**.
6. Si falla la descarga/guardado: fallback que pide mandarlo al humano.

**Nota crítica para el LLM:** el bot **NO procesa pagos**. Solo guarda copia de auditoría. Quien efectivamente carga el pago es el asesor humano cuando el socio se lo manda directo.

**Storage:** Supabase Storage (`comprobantes/<telefono>/<timestamp>.<ext>`) + tabla `comprobantes`.

**Estados de un comprobante:**
- `pendiente` — recién recibido, esperando que un humano lo procese.
- `procesado` — humano confirmó el pago y lo cargó en el sistema interno.
- `rechazado` — humano lo descartó (ilegible, duplicado, no corresponde, etc.).

---

### 4.6. Proceso: Manejo de mensajes no procesables (audio, video, sticker)

**Disparador:** el socio envía un audio, video, sticker u otro tipo de archivo distinto a imagen/PDF.

**Flujo (NO pasa por el LLM):**
1. Webhook detecta el tipo no procesable.
2. Responde automáticamente: "Por ahora solo puedo leer mensajes de texto. ¿Podés escribirme?".
3. Para audios específicamente: "Recibí tu audio. Por ahora solo puedo leer texto…".
4. Guarda en el historial una nota indicando que el cliente envió ese tipo de archivo.

---

### 4.7. Proceso proactivo: Bienvenida por crédito recién liquidado

**Disparador:** job (cron) que corre periódicamente. Disparable también vía endpoint admin `POST /admin/jobs/welcome`.

**Flujo:**
1. Job consulta `getPrestamosRecienLiquidados(48h)` — préstamos con `Estado === "Activa"` y `Fecha liquidación` dentro de las últimas 48 horas.
2. Para cada préstamo:
   - Verifica que el cliente tenga teléfono registrado.
   - Verifica en la tabla `sent_messages` que **NO se haya mandado ya** (idempotencia por `template_name + external_id`).
   - Envía mensaje de bienvenida con: nombre, monto, cuotas, primer vencimiento.
   - Registra el envío en `sent_messages`.
3. Protección de ventana horaria: por defecto solo entre **10:00 y 21:00 hora Argentina**. Configurable.
4. Soporta `dryRun` (simula sin enviar) y `force` (ignora horario).

**Texto enviado (ejemplo):**
> ¡Hola Juan! Tu crédito ya está acreditado.
> 📋 Resumen
> • Monto: $500.000
> • Cuotas: 12
> • Primer vencimiento: 10/12/2025
> Para ver medios de pago o consultar saldo, respondé "MEDIOS" o "SALDO".

**Template:** `bienvenida_credito`.

---

### 4.8. Proceso: Memoria conversacional

**Disparador:** todo mensaje entrante / saliente.

**Flujo:**
1. Antes de llamar al LLM, se trae el historial desde Supabase (tabla `conversations`), últimos N mensajes (default 60).
2. Se valida que el comienzo del historial sea "limpio" (no empieza con un function call/response huérfano) para no romper a Gemini.
3. Se manda el historial completo al LLM como contexto.
4. Después del turno, se guardan los mensajes nuevos (usuario + modelo + tool calls + tool responses) en `conversations`.
5. Endpoint `POST /reset` borra el historial de un teléfono.

**Persistencia:** Supabase (tabla `conversations`, columnas `telefono`, `role`, `parts`).

---

### 4.9. Proceso administrativo: Gestión de comprobantes

**Disparador:** uso por parte del equipo humano vía endpoints `/admin/*` (protegidos por Bearer token).

**Endpoints:**
- `GET /admin/comprobantes/pendientes` — lista los comprobantes en estado `pendiente`, con URLs firmadas (1 hora) para verlos.
- `POST /admin/comprobantes/:id/marcar-procesado` — el operador (`procesado_por`) confirma que cargó el pago en el sistema interno. Notas opcionales.
- `POST /admin/comprobantes/:id/marcar-rechazado` — el operador descarta el comprobante. Requiere notas (motivo).

**Uso esperado:** un dashboard interno o el asesor humano revisa los pendientes y los marca conforme avanza la imputación.

---

## 5. Herramientas (tools) disponibles para el LLM

El bot expone 3 tools al modelo Gemini vía function calling:

| Tool | Input | Output | Cuándo se usa |
|---|---|---|---|
| `verificar_dni` | `dni: string` | `{ verificado, nombre }` | Antes de revelar cualquier dato financiero. |
| `consultar_creditos` | `dni: string` | Resumen agregado (saldo, mora, cuota, estado) + detalle por producto | Después de DNI verificado. |
| `obtener_medios_de_pago` | — | 3 medios + contacto humano | Cuando el socio pregunta cómo pagar. |

---

## 6. Modelo de datos

### 6.1. Cliente
- `dni`, `nombre`, `primerNombre`, `telefono`, `cuil?`

### 6.2. Operación (cada producto contratado)
- `id`, `dni`, `producto`, `plan`, `estado` (Activa, Cancelada, …)
- `esCredito` (boolean — true para préstamos, false para addons como cuota social/asistencia)
- `fechaLiquidacion`, `primerVencimiento`
- `totalCuotas`, `cuotasPagadas`, `cuotasImpagas`, `cuotasImpagasVencidas`
- `importeCuota` (cuota mensual pura), `capitalOriginal`, `saldoTotal`, `saldoEnMora`, `punitorios`

### 6.3. Resumen Cliente (agregado para WhatsApp)
- Suma de `saldoTotal`, `saldoEnMora`, `cuotaMensualTotal`, `cuotasImpagas` de las operaciones **activas**.
- Flag `hayPrestamoActivo`.

### 6.4. Productos clasificados como préstamo
- AMUF, DEBITO EN CUENTA COMERCIO, DECRETO 14/2012, LIMA, LOMAS DE ZAMORA, TARJETA COMERCIALIZADOR, TARJETA DEBITO, TARJETA DE DEBITO.
- Cualquier otro producto se trata como **addon** (no dispara bienvenida, no aparece como préstamo activo).

### 6.5. Cuota social y asistencias
- Cuota social: monto fijo de **$15.000/mes** (hardcodeado, actualizar cuando suba).
- Asistencias: el monto va embebido en el nombre del producto (ej: "ASIST 4410" → $4.410).

---

## 7. Arquitectura técnica

```
WhatsApp Cloud API (Meta)
        │
        ▼
  POST /whatsapp/webhook  ──▶  ¿es imagen/PDF? ──▶ saveComprobante (Supabase Storage)
        │                            │
        │                            ▼
        │                       respuesta automática
        │
        ▼ (texto)
   chat(telefono, msg)
        │
        ├──▶ getHistorial (Supabase: conversations)
        │
        ├──▶ Gemini 2.5 Flash + tools
        │        │
        │        ├──▶ verificar_dni     ──▶ DataSource
        │        ├──▶ consultar_creditos ──▶ DataSource
        │        └──▶ obtener_medios_de_pago (hardcoded)
        │
        └──▶ appendMessages (Supabase: conversations)
                │
                ▼
      sendWhatsAppMessage  ──▶  WhatsApp Cloud API
```

**Datos:**
- En desarrollo: `mockDb` con 4 socios de prueba.
- En producción: `mutualApi` — pega a `/external/listcreditos` (devuelve TODA la base, ~50K registros, ~8s). Se cachea en memoria 5 minutos. Pre-carga al arrancar.

---

## 8. Tablas en Supabase

| Tabla | Para qué |
|---|---|
| `conversations` | Historial de mensajes. Cada fila: telefono, role, parts (jsonb), created_at. |
| `conversation_state` | Estado lateral de la conversación (placeholder, borrado en `/reset`). |
| `sent_messages` | Idempotencia de envíos proactivos. Key: `template_name + external_id`. |
| `comprobantes` | Metadatos de comprobantes recibidos. Estados: `pendiente`, `procesado`, `rechazado`. |

**Bucket Storage:** `comprobantes` (privado). Path: `<telefono>/<timestamp>.<ext>`.

---

## 9. Endpoints HTTP del bot

### Públicos / integración
- `POST /chat` — entrada simple (telefono + mensaje). Útil para testing.
- `POST /reset` — borra historial de un teléfono.
- `GET /health` — healthcheck.
- `GET /whatsapp/webhook` — verificación de Meta.
- `POST /whatsapp/webhook` — mensajes entrantes y eventos de status.

### Admin (requieren `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /admin/jobs/welcome` — dispara el job de bienvenida. Body opcional: `{ dryRun, force }`.
- `GET /admin/comprobantes/pendientes?limit=50` — lista pendientes con URLs firmadas.
- `POST /admin/comprobantes/:id/marcar-procesado` — body: `{ procesado_por, notas? }`.
- `POST /admin/comprobantes/:id/marcar-rechazado` — body: `{ procesado_por, notas }`.

---

## 10. Comparación con Rogelio (qué NO hace el bot todavía)

El bot anterior (Rogelio) cubría procesos que **hoy Mutu no implementa**. Esta sección sirve para decidir qué incorporar y qué descartar.

### 10.1. Procesos de Rogelio que NO están en Mutu

| Proceso Rogelio | Descripción | ¿Lo queremos en Mutu? |
|---|---|---|
| **Acuerdos de pago (mora > 90 días)** | 3 opciones: 1 pago con 25% quita / 4 cuotas sin quita / 10 cuotas con 25% recargo. Aviso de gestión judicial inminente. | A definir |
| **Negociación cuando no puede pagar** | Si ofrece > 50% del saldo → +25% en 2 cuotas. Si ofrece < 50% → quita 20% en 2 cuotas. | A definir |
| **Renovación de crédito** | Para socios con ≥51% de cuotas pagas o saldados. Consulta base de elegibles, ofrece, deriva a gestor. | A definir |
| **Venta de nuevos préstamos (precalificación)** | 3 preguntas: empleado/jubilado 12+ meses → ingreso > $400k → banco habilitado. Pre-oferta según ingreso. | NO (foco actual = cobranza) |
| **Sorteo mensual socio al día** | Confirma participación, requisitos, premios, fechas. | A definir |
| **Compromiso de pago a 5 días** | Agendar fecha de pago, recordarla. | A definir — sí encaja con cobranza |
| **Aviso "te debitamos en exceso" → derivar a Lucio** | Reclamo por débito incorrecto. | A definir |
| **Cierre con emoji** | Si el socio responde solo "gracias" o un emoji → bot responde 👍 y cierra. | A definir |
| **Etiquetado de conversación** | 8 etiquetas para clasificar conversaciones (1_info_sorteo, 2_primarios, 3_renovar, 4a_con_oferta, 4b_rechaza_oferta, 4c_no_pauta_no_responde, 5a_saldo_deudor, 5b_compromiso_pago, 5c_envia_comprobante, 6_ver_caso_otras_consultas). | A definir — útil para dashboard |
| **Asignación a agentes por nombre** | Bienvenidas / Ventas / Jimena / Soledad / Lucio. | A definir |
| **Tool `llamar_agente`** | Disparaba intervención humana en cualquier momento del flujo. | Equivale al "deriva a +54 9 11 2621-4000" actual, pero sin handoff automático |
| **Tool `fecha_actual`** | Para calcular compromiso de pago a +5 / +7 días. | Sí, si se implementa compromiso de pago |
| **Integraciones específicas** | `Lista_Bancos`, `capital_cuotas`, `BasesSorteo`, `basedecanceladospararenovar`, `BASE-ACUERDOS`, `informacion-cbu`. | Solo las que correspondan a procesos que mantengamos |

### 10.2. Procesos de Rogelio que SÍ están en Mutu (aunque distintos)

| Proceso Rogelio | Cómo lo hace Mutu |
|---|---|
| Atención por aviso de vencimiento | `consultar_creditos` → bloque `al_dia` con próximo vencimiento + cuota pura. |
| Atención por aviso de mora | `consultar_creditos` → bloque `mora` con saldo vencido + días de atraso. |
| Formas de pago | `obtener_medios_de_pago` (transferencia directa + Rapipago / MP con derivación humana). |
| Recepción de comprobante | Webhook detecta imagen/PDF, lo guarda en Supabase, responde automático, deriva al humano para imputación. |
| Pedido de DNI | Regla 1+2 del system prompt. Sin 3 intentos antes de derivar. |

---

## 11. Mensajes "no pasan por el LLM" — respuestas automáticas

Hay situaciones donde el bot **no consulta a Gemini** y responde con texto fijo. Esto baja latencia, costo y riesgo de alucinación:

- Recepción de imagen / PDF (asume comprobante).
- Recepción de audio / video / sticker / otro tipo.
- Verificación del webhook (GET de Meta).

Todo lo demás (texto plano) sí entra al LLM con el system prompt completo + tools + historial.

---

## 12. Datos sensibles y seguridad

- **Service role key de Supabase:** solo backend, jamás se expone.
- **Token del webhook:** validación contra `WHATSAPP_VERIFY_TOKEN`.
- **Admin endpoints:** Bearer token (`ADMIN_TOKEN`).
- **Bucket de comprobantes:** privado. Acceso vía URLs firmadas con expiración de 1 hora.
- **DNI:** se solicita siempre antes de revelar info financiera. No se identifica por número de teléfono.

---

## 13. Puntos a definir / pendientes (input para próximas iteraciones)

Esta sección queda para que el equipo discuta:

1. **Compromiso de pago.** ¿Lo agendamos? ¿En qué tabla? ¿Recordatorios?
2. **Acuerdos de pago / quitas / refinanciaciones.** ¿Las habilitamos en el bot, o siempre derivamos a humano?
3. **Cierre con emoji/gracias → 👍.** Bajo costo, alto cierre limpio.
4. **Etiquetado de conversaciones.** ¿Lo queremos para un dashboard?
5. **Handoff a humano explícito** (tool `llamar_agente` estilo Rogelio) vs el modelo actual de simplemente dar el teléfono.
6. **Recordatorios proactivos de cuota próxima a vencer** (similar al welcome job, pero T-3 / T-1 días).
7. **Recordatorios de mora** (días 1, 7, 15 de atraso, por ejemplo).
8. **Detección de tono emocional** (cliente molesto, situaciones críticas) — ya está en el prompt, pero sin métrica.
9. **Multi-canal** (mail, SMS) — por ahora solo WhatsApp.
10. **Reporte de auditoría** comprobantes pendientes vs procesados (SLA del asesor humano).

---

*Documento generado el 11/05/2026 a partir del relevamiento del código en `bot-mutual-mvp/`.*
