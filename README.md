# Bot Mutual — MVP

Esqueleto local del bot de la mutual. Por ahora corre todo offline (sin WhatsApp), con datos hardcodeados, para iterar la conversación y las tools.

## Stack

- Node.js + TypeScript (ESM)
- Express 5 para el servidor HTTP
- Google Gen AI SDK (`@google/genai`) — usa Gemini, free tier sin tarjeta
- `tsx` para correr TS directo sin compilar

## Setup

### 1. Conseguir la API key de Gemini (gratis, sin tarjeta)

1. Ir a https://aistudio.google.com/apikey
2. Loguearse con cualquier cuenta de Google
3. Click en "Create API key"
4. Copiar la key

Free tier actual de `gemini-2.5-flash`: ~10 requests por minuto y 250 por día. Para iterar el MVP sobra.

### 2. Instalar y configurar

```bash
cd bot-mutual-mvp
npm install
cp .env.example .env
# editá .env y poné tu GEMINI_API_KEY
```

## Uso

### Chat por terminal (lo más cómodo para iterar)

```bash
npm run chat
# o con un teléfono específico:
npm run chat -- 5491155552222
```

Comandos dentro del chat: `salir`, `reset`.

### Servidor HTTP (para probar como si fuera el webhook de WhatsApp)

```bash
npm run dev
```

Probá con curl:

```bash
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"telefono":"5491155551111","mensaje":"Hola, quiero saber mi saldo"}'
```

Reset de historial:
```bash
curl -X POST http://localhost:3000/reset \
  -H 'Content-Type: application/json' \
  -d '{"telefono":"5491155551111"}'
```

### Job de bienvenidas (detecta liquidados y simula envío)

```bash
npm run welcome-job
```

Por ahora imprime en consola los mensajes que se mandarían. Cuando se enchufe WhatsApp, ese print se reemplaza por la llamada al SDK del BSP / Cloud API.

## Datos de prueba (mockDb.ts)

| Teléfono       | DNI       | Nombre             | Situación                      |
|----------------|-----------|--------------------|--------------------------------|
| 5491155551111  | 30123456  | Juan Pérez         | Crédito EN MORA ($45k mora)    |
| 5491155552222  | 28987654  | María González     | Crédito recién LIQUIDADO       |
| 5491155553333  | 35111222  | Carlos Rodríguez   | Crédito al día (pendiente)     |
| 5491155554444  | 40555666  | Lucía Fernández    | Crédito recién LIQUIDADO       |

## Cómo funciona el bot por dentro

1. Llega un mensaje de un teléfono.
2. Se recupera el historial de esa conversación (en memoria por ahora).
3. Se llama a Gemini con: system instruction + historial + lista de tools (function declarations).
4. Si el modelo decide llamar una tool, se ejecuta el handler y se le devuelve el resultado como `functionResponse`.
5. Esto se repite hasta que el modelo responde con texto final.
6. El texto se devuelve al usuario y queda en el historial.

## Tools disponibles para el LLM

- `identificar_cliente(telefono)` → nombre + últimos 4 del DNI.
- `verificar_dni(telefono, dni)` → true/false antes de revelar info sensible.
- `consultar_creditos(dni)` → todos los créditos con saldos, mora, vencimientos.
- `obtener_medios_de_pago()` → CBU/alias/Pago Mis Cuentas.

## Próximos pasos (cuando vuelvas a iterar)

- Reemplazar `mockDb.ts` por un cliente HTTP que pegue al endpoint real.
- Persistir conversaciones en Postgres (no perderlas al reiniciar).
- Persistir registro de bienvenidas enviadas (para no duplicar).
- Sumar el webhook de WhatsApp Cloud API (Meta) y traducir a `/chat`.
- Templates aprobados por Meta para mensajes proactivos (bienvenida, recordatorios).

## Cambiar el LLM

Hoy usamos Gemini, pero el código está aislado: `src/llm/agent.ts` y `src/tools/definitions.ts` son los únicos archivos LLM-específicos. Para cambiar a Claude, OpenAI u otro, se reemplaza esos dos archivos. El resto (handlers, mockDb, server, prompts) queda igual.
