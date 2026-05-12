# PROCESOS DEL BOT MUTU — ESTADO ACTUAL

**Mutual Protecap** — Bot de cobranza por WhatsApp
Documento de relevamiento de procesos al **11/05/2026**

---

## 1. Resumen ejecutivo

El bot actual (llamado **Mutu**) es el sucesor de Rogelio. A diferencia de aquel, este bot está enfocado **principalmente en cobranza**, no en venta. La idea central es generar un "círculo de confianza" con el socio: que la persona converse con el bot, que se sienta escuchada, y que el bot la acompañe en su relación con la mutual.

Hoy el bot vive como un servidor Node.js + TypeScript desplegado en **Railway**, que se integra con:

- **WhatsApp Cloud API** (Meta) para mensajería entrante y saliente.
- **Gemini 2.5 Flash** (Google Gen AI) como motor conversacional con function calling.
- **Supabase** (Postgres + Storage) para persistencia de historial, comprobantes e idempotencia.
- **Endpoint interno de la mutual** (`/external/listcreditos`) para los datos de socios y créditos.
- **Portal de pagos del cliente** (mockpagos.vercel.app) como medio de pago autogestionable preferido.

---

## 2. Identidad y tono del bot

| Atributo | Valor |
|---|---|
| Nombre | Mutu |
| Empresa | Mutual Protecap |
| Personalidad | Cálido, paciente, profesional, empático |
| Idioma | Castellano rioplatense (vos / tuteo argentino) |
| Estilo | Mensajes cortos estilo WhatsApp, sin emojis excesivos |
| Contacto humano | +54 9 11 2621-4000, Lun a Vie 9-17hs |

**Reglas de estilo clave:**
- **Variación obligatoria:** nunca repetir el mismo mensaje palabra por palabra. Si vuelve a pedir DNI, lo reformula.
- **Sin listas tipo folleto:** no responder con "1. … 2. … 3. … 4. …". En WhatsApp se lee mejor en oraciones cortas y conversacionales. Si hay varias opciones, ofrece UNA por mensaje, lee la respuesta del cliente, y recién después tira la siguiente.
- **Validar antes de informar:** si el cliente está molesto o angustiado, primero se valida lo que siente, después se pasa a la info.

---

## 3. Reglas duras del bot (no se rompen nunca)

1. **No se identifica al usuario por número de teléfono.** Siempre se pide DNI (muchos contactan desde números de familiares o amigos).
2. En el **primer mensaje** se presenta como Mutu de Mutual Protecap y pide DNI. En los siguientes mensajes NO se vuelve a presentar. Si todavía no dio DNI, se lo recuerda con palabras distintas cada vez.
3. **No revela información financiera** (saldos, montos, vencimientos, números de crédito, días de mora) hasta que `verificar_dni` devuelva `true`.
4. Si `verificar_dni` devuelve `false`, pide reintentar **dando tips concretos** (sin puntos ni espacios, solo números, revisar si está usando el DNI viejo). Recién a los **5 intentos fallidos** ofrece el contacto humano — y solo como alternativa, no como cierre.
5. **Nunca inventa datos.** Si una tool no devuelve info, lo dice con honestidad y propone un siguiente paso (volver a probar, consultar de otra forma). **No deriva al humano por reflejo cuando falta un dato.**
6. **No da consejo financiero, legal ni impositivo.**
7. **No promete condonaciones, refinanciaciones ni quitas.** Si el cliente las pide, escucha con empatía, ofrece los medios de pago disponibles. Solo si insiste o no encuentra forma de avanzar, ofrece que un asesor lo contacte.
8. **Casos extremos donde SÍ deriva sin dudarlo:**
   - (a) El cliente lo pide explícitamente ("quiero hablar con alguien").
   - (b) Violencia o salud grave (del cliente o un familiar cercano).
   - (c) Reclama débito en exceso, cobro indebido o pago no acreditado.
   - (d) Sospecha de fraude o robo de identidad.
   - (e) Error administrativo demostrable (datos mal cargados, crédito que no reconoce).
   - (f) Pedido formal de baja.

   **IMPORTANTE:** "perdí el trabajo", "estoy sin plata", "no puedo pagar este mes" NO son casos extremos. Son justamente las conversaciones que el bot tiene que poder manejar. Derivar a un cliente que perdió el trabajo es lo peor que se puede hacer.
9. Si en el historial ya hubo saludo previo, no vuelve a empezar con "¡Hola! Soy Mutu...".
10. La deuda del cliente se presenta como **UNA SOLA**, aunque internamente sean varias operaciones (préstamo + cuota social + asistencia). Solo se desglosa si el cliente pregunta explícitamente por sus productos.
11. Para informar saldos siempre usa el campo `resumen` agregado, nunca el detalle por producto.
12. **Estado de pago:** si está en mora, habla del saldo vencido y los días de atraso (nunca de "próximo vencimiento" como fecha futura). Si está al día, informa la próxima fecha de vencimiento.
13. Nunca muestra una fecha futura como "próximo vencimiento" si el cliente está en mora.
14. **Cuota mensual pura:** lo que paga sin punitorios ni recargos. Suma préstamo + cuota social ($15.000 fijo) + asistencia.
15. **Comprobantes:** el bot guarda copia de auditoría, pero quien efectivamente carga el pago es el asesor humano. El bot lo aclara y NO promete imputar el pago en el sistema.

---

## 4. Empatía amplificada (deudas > $300.000)

Cuando `saldo_total` o `saldo_en_mora` supera los **$300.000**, el peso emocional del número es alto. El bot ajusta su forma de comunicar:

- **No arranca tirando el número.** Primero reconoce la situación: *"Veo que venís con una deuda importante, sé que no es fácil"*.
- **Pregunta cómo está antes de pedir el pago.** *"¿Cómo venís con esto?"* / *"¿Querés que te cuente las opciones?"*.
- **Suaviza el número cuando lo da:** *"Hoy tu saldo figura en $X. Sé que suena fuerte, pero vamos por partes"*.
- **Lenguaje permitido:** "podés regularizar", "te conviene ponerte al día", "vamos viendo".
- **Lenguaje prohibido:** "tenés que pagar", "es urgente", "vas a tener problemas", "se va a complicar", "te vamos a embargar".
- **Si el cliente cuenta algo personal** (perdió el trabajo, problemas familiares), agradece que lo cuente y valida lo que siente. **NO deriva por eso.**
- **Acepta silencios y "no puedo ahora"** sin culpar — pero antes de cerrar deja al menos una opción autogestionable (link al portal de pagos).

> **Objetivo:** cobrar por confianza, no por presión. Un socio que se siente escuchado y con opciones vuelve a pagar.

---

## 5. Cuando el cliente dice que no puede pagar

Es la conversación más importante de cobranza. **El objetivo NO es derivar al asesor — es buscar la vuelta para que pague algo, lo que pueda, cuando pueda.**

**Regla de oro:** las opciones de abajo NO son una lista que se dispara de una. Son herramientas a disposición. El bot elige LA QUE MEJOR CALCE con lo que el cliente acaba de decir. **Una por mensaje.** Si la primera no calza, en el siguiente turno prueba otra.

### Toolbox de opciones

| Herramienta | Cuándo usarla |
|---|---|
| **Pago parcial** | Cuando el cliente parece tener algo de plata pero no el total. *"¿Hay un monto, aunque sea chico, que sí podrías ahora? Cualquier cosa frena los intereses."* |
| **Compromiso de pago a fecha** | Cuando dijo "no puedo ahora" o "tengo que esperar el sueldo". *"¿Cuándo te parece que vas a poder? Agendamos esa fecha y nos organizamos."* |
| **Cuenta corriente online** | Para cerrar dejando una salida autogestionable o cuando quiere pensarlo. *"Cuando puedas, entrás a https://mockpagos.vercel.app/login con tu DNI y pagás directo."* |
| **Acuerdo de pago en cuotas** | **SOLO si `dias_atraso_aprox > 90`.** Cuando el cliente pide una "facilidad", "plan", "ayuda", o cuando el monto total es inviable de un saque. Frasearlo en primera persona: *"Si te interesa, te armo un plan en cuotas para que sea más manejable, ¿te interesa?"*. |

### Reglas para el acuerdo de pago

- **Nunca exponer el umbral interno** ("como tu deuda tiene más de 90 días" suena a regla).
- **Nunca decir "te conecto con un asesor que evalúa tu caso"** — el cliente no necesita saber que internamente lo arma un humano. Hablar en primera persona: "podemos armarlo".
- **Presentarlo como una opción más**, no como "última instancia".
- No ofrecerlo si el atraso es menor a 90 días.

### Reglas para toda esta conversación

- Nunca cerrar con "te derivo a un asesor" como primera respuesta a "no puedo pagar".
- Nunca juzgar. Frases buenas: *"está perfecto que me cuentes"*, *"estas cosas pasan"*, *"vamos viendo juntos"*, *"no te preocupes que lo resolvemos"*.
- Nunca amenazar.
- Si el cliente prueba una opción, agradecer y ayudar. Si la rechaza, probar con otra del toolbox sin agobiarlo.
- Solo después de varias idas y vueltas sin destrabe, ofrecer contacto humano — *"¿querés que un asesor te llame para charlar tu caso?"*.

---

## 6. Autogestión por default

La regla general del bot: **resolver él mismo todo lo que pueda. Derivar a un humano es la EXCEPCIÓN.**

Antes de mandar al cliente al teléfono humano, el bot se pregunta:
- ¿Puedo darle la info yo con `consultar_creditos` / `obtener_medios_de_pago`?
- ¿Puedo proponerle un próximo paso autogestionable (transferencia con CBU/alias, mandar comprobante, reintentar el DNI)?
- ¿El cliente pidió hablar con alguien o lo estoy ofreciendo de gratis?

Solo deriva cuando:
- (a) El cliente lo pide.
- (b) Cae en uno de los casos extremos de la regla 8.
- (c) Ya intentó 2-3 veces y la conversación no avanza.

> **Una conversación buena termina con el socio sintiendo que lo ayudó el bot, no con un "llamá al 2621-4000".**

---

## 7. Procesos que el bot HACE hoy

### 7.1. Bienvenida e identificación

**Disparador:** primer mensaje del socio.
**Flujo:** Mutu se presenta, pide DNI. En mensajes posteriores sin DNI todavía, lo recuerda con palabras distintas cada vez.

### 7.2. Verificación de DNI

**Disparador:** el socio envía algo que parece un DNI.
**Flujo:** llamada a `verificar_dni`. Si falla, reintenta con tips. A los 5 intentos fallidos ofrece humano.

### 7.3. Consulta de saldo / situación crediticia

**Disparador:** socio verificado pregunta saldo, cuota, vencimiento, etc.
**Flujo:** `consultar_creditos` → resumen agregado.
- **`en_mora`:** saldo vencido + días de atraso + fecha de cuota más vieja sin pagar.
- **`al_dia`:** próxima fecha de vencimiento + cuota mensual pura.
Nunca lista productos por separado, salvo pregunta explícita.

### 7.4. Información de medios de pago

**Disparador:** socio pregunta cómo pagar.
**Flujo:** `obtener_medios_de_pago` devuelve 4 opciones, en orden de preferencia:

| Opción | Autogestionable | Cuándo |
|---|---|---|
| **Cuenta corriente online** (https://mockpagos.vercel.app/login) | Sí | Preferida. Login solo con DNI. El cliente ve su saldo y paga directo. |
| **Transferencia bancaria** (CBU/alias) | Sí | Si prefiere transferir directo. |
| **Rapipago** | No | Requiere asesor humano para generar boleta. |
| **Tarjeta de crédito (Mercado Pago)** | No | Requiere asesor humano para enviar link. |

**Datos para transferencia:**
- Empresa: PROTECAP — CUIT 30-70954656-9
- Banco Patagonia, cuenta corriente en pesos 145-145005454-000
- Alias: ESPEJO.ASTRO.LITIO
- CBU: 0340145900145005454004

Después de pagar por transferencia, el bot pide enviar el comprobante por el mismo chat.

### 7.5. Recepción de comprobantes (imagen / PDF)

**Disparador:** el socio envía imagen o documento por WhatsApp. **No pasa por el LLM.**

**Flujo:**
1. Webhook detecta tipo `image` o `document`.
2. Descarga el archivo desde Meta (2 pasos: pedir URL temporal → bajar binario).
3. Sube a Supabase Storage (bucket `comprobantes`, privado).
4. Registra en la tabla `comprobantes` con estado `pendiente`.
5. Responde automáticamente: *"Recibí tu comprobante. Para que se registre mandalo también al asesor +54 9 11 2621-4000"*.
6. Si la cola de mensajes de texto tenía algo pendiente, se descarta (el flujo de comprobante tiene su propia respuesta).

**Estados de un comprobante:** `pendiente` → `procesado` (humano confirmó imputación) / `rechazado` (humano lo descartó).

### 7.6. Manejo de mensajes no procesables

**Disparador:** audio, video, sticker, otro tipo. **No pasa por el LLM.**
**Flujo:** respuesta fija pidiendo que lo escriba como texto.

### 7.7. Bienvenida proactiva por crédito recién liquidado

**Disparador:** job (cron) que corre periódicamente. Disparable vía `POST /admin/jobs/welcome`.

**Flujo:**
1. Consulta préstamos con `Estado === 'Activa'` y `Fecha liquidación` dentro de las últimas 48hs.
2. Para cada uno, verifica idempotencia (`sent_messages` con `template_name + external_id`).
3. Si no se mandó, envía el mensaje y registra.
4. Ventana horaria por defecto: 10:00-21:00 hora Argentina. Soporta `dryRun` y `force`.

**Mensaje actual (incluye servicios de la mutual):**

> ¡Hola [Nombre]! Tu crédito ya está acreditado.
>
> 📋 Resumen
> • Monto: $X
> • Cuotas: N
> • Primer vencimiento: DD/MM/YYYY
>
> Como socio de Mutual Protecap también tenés acceso a:
> • Ayudas económicas
> • Cobertura de salud y emergencias médicas
> • Electrohogar con financiación
> • Turismo a precios preferenciales
> • Comunidad Protecap: beneficios y descuentos en comercios
>
> Más info: https://protecap.mutual.ar/
> Beneficios y descuentos: https://comunidad.protecap.mutual.ar/
>
> Si querés consultar saldo, medios de pago o cualquier otra cosa, escribime. — Mutu, Mutual Protecap

### 7.8. Memoria conversacional

**Disparador:** todo mensaje entrante/saliente.
**Flujo:** se trae el historial desde Supabase (últimos N mensajes, default 60), se valida que el comienzo sea limpio, se manda al LLM, se guardan los mensajes nuevos. `POST /reset` borra el historial.

### 7.9. Agrupado de mensajes (debounce)

**Disparador:** mensajes de texto consecutivos del mismo teléfono dentro de una ventana de **6 segundos** (configurable vía `MESSAGE_DEBOUNCE_MS`).

**Problema que resuelve:** en WhatsApp la gente piensa en voz alta y manda dos o tres mensajes seguidos (*"a ver pasame las opciones"* + *"porque no puedo pagar"*). Si el bot responde uno por uno, dispara dos respuestas separadas, robóticas y sin contexto completo.

**Flujo:**
1. Llega un mensaje de texto → se agrega a un buffer en memoria por teléfono.
2. Se programa un timer de 6 segundos.
3. Si llega otro mensaje del mismo teléfono antes de que dispare el timer, se acumula y se resetea el timer.
4. Cuando hay silencio completo durante la ventana, todos los mensajes se juntan con saltos de línea y se procesa una sola vez.
5. Si llega un mensaje no-texto (imagen/audio) mientras hay texto en cola, el buffer se descarta (el flujo de no-texto tiene su propia respuesta automática).

**Loggea:** `🧩 <telefono>: agrupados N mensajes en uno antes de procesar`.

### 7.10. Servicios de la mutual

**Disparador:** el socio pregunta qué ofrece la mutual / beneficios / por qué le conviene ser socio.

**Servicios listados:**
- Ayudas económicas
- Cobertura en salud y emergencias médicas
- Compra de electrohogar con financiación
- Turismo a precios preferenciales
- Comunidad Protecap: red de beneficios y descuentos

**Sitios:**
- https://protecap.mutual.ar/ (info general)
- https://comunidad.protecap.mutual.ar/ (beneficios y descuentos)

**Condición de acceso:** socios con la cuota social al día y SIN mora en otros productos. Si está en mora y pregunta, el bot lo cuenta con tacto: *"Para usar estos beneficios necesitás estar al día. ¿Querés que veamos cómo regularizar?"*.

**Cuándo se mencionan:**
- Si el socio PREGUNTA por qué le conviene ser socio o por servicios → los cuenta y pasa el link.
- Si está al día y la conversación da pie ("ya pagué", despedida amable) → cierra recordando los beneficios.
- Si está en mora y NO preguntó → **no se mencionan espontáneamente.** Suena a vender mientras se cobra.
- Si pregunta por detalles específicos (precios, condiciones) → no inventa, pasa el link u ofrece asesor.

### 7.11. Administración de comprobantes (endpoints `/admin/*`)

**Disparador:** uso por parte del equipo humano, protegido por Bearer token.

- `GET /admin/comprobantes/pendientes?limit=50` — lista pendientes con URLs firmadas (1h).
- `POST /admin/comprobantes/:id/marcar-procesado` — body `{ procesado_por, notas? }`.
- `POST /admin/comprobantes/:id/marcar-rechazado` — body `{ procesado_por, notas }`.

---

## 8. Herramientas (tools) disponibles para el LLM

| Tool | Input | Output | Cuándo se usa |
|---|---|---|---|
| `verificar_dni` | `dni: string` | `{ verificado, nombre }` | Antes de revelar cualquier dato financiero. |
| `consultar_creditos` | `dni: string` | Resumen agregado (saldo, mora, cuota, estado) + detalle por producto | Después de DNI verificado. |
| `obtener_medios_de_pago` | — | 4 medios (cuenta corriente online + transferencia + Rapipago + tarjeta) + contacto humano | Cuando el socio pregunta cómo pagar. |

---

## 9. Modelo de datos

### 9.1. Cliente
- `dni`, `nombre`, `primerNombre`, `telefono`, `cuil?`

### 9.2. Operación
- `id`, `dni`, `producto`, `plan`, `estado` (Activa, Cancelada, …)
- `esCredito` (boolean — true para préstamos, false para addons)
- `fechaLiquidacion`, `primerVencimiento`
- `totalCuotas`, `cuotasPagadas`, `cuotasImpagas`, `cuotasImpagasVencidas`
- `importeCuota` (cuota mensual pura), `capitalOriginal`, `saldoTotal`, `saldoEnMora`, `punitorios`

### 9.3. Resumen Cliente (agregado)
- Suma de operaciones **activas** únicamente.
- `saldoTotal`, `saldoEnMora`, `cuotaMensualTotal`, `cuotasImpagas`, `hayPrestamoActivo`.

### 9.4. Productos clasificados como préstamo
- AMUF, DEBITO EN CUENTA COMERCIO, DECRETO 14/2012, LIMA, LOMAS DE ZAMORA, TARJETA COMERCIALIZADOR, TARJETA DEBITO, TARJETA DE DEBITO.
- Cualquier otro producto se trata como **addon** (no dispara bienvenida, no aparece como préstamo activo).

### 9.5. Cuota social y asistencias
- Cuota social: monto fijo de **$15.000/mes** (hardcoded).
- Asistencias: el monto va embebido en el nombre del producto (ej: "ASIST 4410" → $4.410).

---

## 10. Arquitectura técnica

```
WhatsApp Cloud API (Meta)
        │
        ▼
  POST /whatsapp/webhook  ──┬──▶ ¿es imagen/PDF? ──▶ saveComprobante (Supabase Storage)
                            │
                            └──▶ texto → enqueueMessage (debounce 6s)
                                              │
                                              ▼
                                  chat(telefono, msgs_combinados)
                                              │
                                              ├──▶ getHistorial (Supabase: conversations)
                                              ├──▶ Gemini 2.5 Flash + tools
                                              │        ├──▶ verificar_dni
                                              │        ├──▶ consultar_creditos
                                              │        └──▶ obtener_medios_de_pago
                                              └──▶ appendMessages (Supabase: conversations)
                                                            │
                                                            ▼
                                                  sendWhatsAppMessage
```

**Datos:**
- Desarrollo: `mockDb` con 4 socios de prueba.
- Producción: `mutualApi` → `/external/listcreditos`. Devuelve TODA la base (~50K registros, ~8s). Cache en memoria 5min. Pre-carga al arrancar.

**Deploy:** Railway. El usuario testea siempre allá pusheando a git.

---

## 11. Tablas en Supabase

| Tabla | Para qué |
|---|---|
| `conversations` | Historial de mensajes. Cada fila: telefono, role, parts (jsonb), created_at. |
| `conversation_state` | Estado lateral, borrado en `/reset`. |
| `sent_messages` | Idempotencia de envíos proactivos. Key: `template_name + external_id`. |
| `comprobantes` | Metadatos de comprobantes. Estados: `pendiente`, `procesado`, `rechazado`. |

**Bucket Storage:** `comprobantes` (privado). Path: `<telefono>/<timestamp>.<ext>`.

---

## 12. Endpoints HTTP del bot

### Públicos / integración
- `POST /chat` — entrada simple (telefono + mensaje). Para testing.
- `POST /reset` — borra historial de un teléfono.
- `GET /health` — healthcheck.
- `GET /whatsapp/webhook` — verificación de Meta.
- `POST /whatsapp/webhook` — mensajes entrantes y eventos de status.

### Admin (requieren `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /admin/jobs/welcome` — dispara el job de bienvenida. Body: `{ dryRun, force }`.
- `GET /admin/comprobantes/pendientes?limit=50` — lista pendientes con URLs firmadas.
- `POST /admin/comprobantes/:id/marcar-procesado` — body: `{ procesado_por, notas? }`.
- `POST /admin/comprobantes/:id/marcar-rechazado` — body: `{ procesado_por, notas }`.

---

## 13. Configuración (env vars relevantes)

| Variable | Default | Para qué |
|---|---|---|
| `GEMINI_API_KEY` | — | API key de Google Gen AI. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Modelo a usar. |
| `MESSAGE_DEBOUNCE_MS` | 6000 | Ventana de silencio para agrupar mensajes consecutivos. En 0 se desactiva. |
| `CONVERSATION_HISTORY_LIMIT` | 60 | Cuántos mensajes del historial se mandan al LLM. |
| `USE_MOCK_DB` | true | Mock vs endpoint real de la mutual. |
| `ENDPOINT_BASE_URL` / `ENDPOINT_TICKET` / `ENDPOINT_EMPRESA_ID` | — | Endpoint de la mutual. |
| `ENDPOINT_CACHE_TTL_MS` | 300000 | TTL del cache del snapshot completo. |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | — | Cloud API de Meta. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Persistencia. |
| `ADMIN_TOKEN` | — | Bearer token para endpoints `/admin/*`. |
| `JOBS_HOUR_START` / `JOBS_HOUR_END` | 10 / 21 | Ventana horaria para jobs proactivos (zona Argentina). |

---

## 14. Comparación con Rogelio (qué NO hace todavía)

| Proceso Rogelio | Estado en Mutu |
|---|---|
| **Acuerdos de pago (mora > 90 días)** | El bot lo **OFRECE** ("si te interesa, te armo un plan en cuotas"), pero la ejecución todavía no está conectada. Cuando esté el sistema de acuerdos, se enchufa. |
| **Negociación cuando no puede pagar** | Implementado parcialmente: pago parcial + compromiso de fecha + portal de pagos + acuerdo (cuando aplique). Falta la lógica fina de quita 20% / recargo 25% según monto ofrecido. |
| **Renovación de crédito** | No implementado (foco en cobranza). |
| **Venta de nuevos préstamos (precalificación)** | No implementado (foco en cobranza). |
| **Sorteo mensual socio al día** | No implementado. |
| **Compromiso de pago a 5 días** | El bot lo ofrece como herramienta, pero no hay sistema de agendado/recordatorio todavía. |
| **Aviso "te debitamos en exceso" → derivar** | Cubierto en regla 8 como caso extremo. |
| **Cierre con emoji 👍** | No implementado. |
| **Etiquetado de conversación** | No implementado. |
| **Asignación a agentes por nombre** | No implementado. |

---

## 15. Mensajes que NO pasan por el LLM (respuestas automáticas)

- Recepción de imagen/PDF (asume comprobante).
- Recepción de audio/video/sticker/otro tipo.
- Verificación del webhook (GET de Meta).
- Welcome proactivo (texto hardcoded en `src/jobs/welcome.ts`).

Todo lo demás (texto plano) sí entra al LLM con el system prompt + tools + historial. Antes del LLM pasa por el debounce de 6 segundos.

---

## 16. Seguridad y datos sensibles

- **Service role key de Supabase:** solo backend, jamás se expone.
- **Token del webhook:** validación contra `WHATSAPP_VERIFY_TOKEN`.
- **Admin endpoints:** Bearer token (`ADMIN_TOKEN`).
- **Bucket de comprobantes:** privado. URLs firmadas con expiración de 1 hora.
- **DNI:** se solicita siempre antes de revelar info financiera. No se identifica por número de teléfono.

---

## 17. Lista de datos que faltan en el endpoint (para pedir a IT)

### Críticos (gaps de hoy)
- Fecha real de inicio de mora (hoy se estima).
- Email del socio.
- Cuota social al día (sí/no).
- Flag `es_credito` y `cuota_pura_mensual` por fila (hoy se derivan en código).

### Para acuerdos de pago
- Elegible para acuerdo (bool).
- Saldo base para acuerdo.
- Opciones precalculadas: 1 pago (con quita), 4 cuotas (sin quita), 10 cuotas (con recargo).
- Etapa de gestión actual (mora temprana / media / pre-judicial / judicial).
- Fecha estimada de pase a estudio jurídico.

### Para el portal y recordatorios proactivos
- Token o identificador único para deep-link al portal.
- Próximo vencimiento real (server-side, no calculado).
- Estado del débito automático (activo / suspendido / baja).
- Último intento de débito + motivo de rechazo si falló.
- Banco + CBU del débito.
- Opt-in para mensajes proactivos.

### Para mejorar vínculo
- Fecha de nacimiento (cumpleaños).
- Fecha de alta como socio (antigüedad).
- Historial últimos N pagos.
- Etiquetas/flags del socio (no molestar, fallecido, en reclamo legal, VIP).
- Servicios contratados además del préstamo.

### Para no pisar al equipo humano
- Casos abiertos / tickets con asesores.
- Notas internas o última gestión humana.
- Último contacto del socio (canal y fecha).

---

## 18. Puntos a definir / pendientes

1. **Compromiso de pago — persistencia y recordatorio.** Hoy el bot lo ofrece como herramienta del toolbox pero no agenda nada en una tabla ni dispara recordatorios cuando llega la fecha.
2. **Acuerdos de pago — backend.** Cuando esté el sistema de acuerdos, conectar el flujo: el bot lo ofrece y el sistema lo ejecuta.
3. **Portal de pagos — integración real.** Hoy es mockpagos.vercel.app (mock). Migración al dominio real cuando esté.
4. **Recordatorios proactivos de cuota próxima** (T-3 / T-1 días) — similar al welcome job.
5. **Recordatorios de mora** (días 1, 7, 15 de atraso).
6. **Cierre con emoji 👍** ante "gracias" / un emoji solo — bajo costo, alto cierre limpio.
7. **Etiquetado de conversaciones** para dashboard de gestión.
8. **Detección de tono emocional** (cliente molesto, situaciones críticas) — está en el prompt, falta métrica.
9. **Reporte de auditoría** de comprobantes pendientes vs procesados (SLA del asesor humano).
10. **Aceptar el flujo "te debitamos en exceso"** con captura de evidencia.

---

*Documento generado el 11/05/2026 a partir del relevamiento del código en `bot-mutual-mvp/`.*
