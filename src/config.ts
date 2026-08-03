import dotenv from 'dotenv';
dotenv.config({ override: true });
function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

// Lee una variable numérica con default. Si viene vacía, con coma decimal o con
// cualquier cosa que no parsee, avisa fuerte y usa el default en vez de propagar
// un NaN. Un NaN acá no explota: se filtra silenciosamente hasta convertir un
// setInterval en un loop cerrado o apagar un tope de envíos.
function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`⚠️  ${name}="${raw}" no es un número válido. Uso el default ${def}.`);
    return def;
  }
  return n;
}

export const config = {
  geminiApiKey: mustGetEnv('GEMINI_API_KEY'),
  model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  port: Number(process.env.PORT ?? 3000),
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
    // App Secret de la app de Meta. Se usa para verificar el HMAC-SHA256 de cada
    // webhook entrante (header X-Hub-Signature-256). Si está vacío, el webhook NO
    // verifica firma — inseguro para producción. Conseguir en developers.facebook.com
    // → tu app → Configuración → Básica → App Secret.
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
  },
  supabase: {
    url: mustGetEnv('SUPABASE_URL'),
    serviceRoleKey: mustGetEnv('SUPABASE_SERVICE_ROLE_KEY'),
    // Nombre del bucket privado donde guardamos comprobantes recibidos por WhatsApp.
    bucketComprobantes: process.env.SUPABASE_BUCKET_COMPROBANTES ?? 'comprobantes',
  },
  // Cuántos mensajes del historial le mandamos a Gemini en cada turno.
  // Si la conversación crece más, se envían solo los últimos N.
  historyLimit: Number(process.env.CONVERSATION_HISTORY_LIMIT ?? 60),
  // Ventana de "silencio" para agrupar mensajes consecutivos del mismo teléfono
  // antes de invocar al LLM. Si el cliente manda 2-3 mensajes seguidos (típico
  // en WhatsApp donde la gente piensa en voz alta), los juntamos y respondemos
  // una sola vez. En 0 se desactiva el debounce.
  // 10s probó ser suficiente para capturar tandas típicas de 3-4 mensajes
  // sin sentirse lento en mensajes únicos.
  messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS ?? 10000),
  // Token simple para proteger los endpoints /admin/*. Si está vacío, los endpoints quedan deshabilitados.
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Ventana horaria (zona horaria Argentina, UTC-3) en la que los jobs proactivos
  // pueden enviar mensajes. start es inclusivo, end es exclusivo.
  // Default: 10-21 = entre las 10:00 y las 20:59.
  jobs: {
    hourStart: Number(process.env.JOBS_HOUR_START ?? 10),
    hourEnd: Number(process.env.JOBS_HOUR_END ?? 21),
    // Si true, el server corre los jobs proactivos (welcome, cashback-aviso) solo,
    // con un scheduler en proceso. Si false, hay que dispararlos a mano por /admin/jobs/*.
    // Igual NO corre si WhatsApp no está configurado (no tiene sentido mandar mensajes).
    schedulerEnabled: (process.env.JOBS_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Cada cuántas horas corre cada job. El horario (hourStart/hourEnd) igual los frena fuera de ventana.
    welcomeEveryHours: numEnv('JOBS_WELCOME_EVERY_HOURS', 2),
    cashbackAvisoEveryHours: numEnv('JOBS_CASHBACK_EVERY_HOURS', 6),
    // Recordatorio de vencimiento: lo corremos cada 6h (idempotente, así un solo
    // disparo del día efectivamente manda). Pensado para que la primera corrida
    // del día caiga dentro de la ventana matinal.
    vencimientoAvisoEveryHours: numEnv('JOBS_VENCIMIENTO_EVERY_HOURS', 6),

    // ─── Control de volumen de mensajes proactivos ───────────────────────────
    // Meta limita cuántos socios DISTINTOS podés contactar vos primero cada 24hs
    // (tier de mensajería: 250 → 1.000 → 10.000 → 100.000). Un número nuevo
    // arranca en 250, y pasarse castiga la calidad del número.
    //
    // Tope de envíos por corrida de cada job. Lo que queda afuera NO se pierde:
    // se loguea y se reintenta en la corrida siguiente (la idempotencia por
    // sent_messages evita duplicar lo ya enviado).
    // Default conservador: 60 por corrida. Con welcome cada 2hs y los otros dos
    // cada 6hs dentro de la ventana 10-21, el peor caso queda holgadamente
    // debajo de 250/día. Subilo recién cuando Meta te suba de tier.
    maxEnviosPorCorrida: numEnv('JOBS_MAX_ENVIOS_POR_CORRIDA', 60),
    // Pausa entre envíos consecutivos, para no ráfagar la API de WhatsApp.
    delayEntreEnviosMs: numEnv('JOBS_DELAY_ENTRE_ENVIOS_MS', 1000),
  },
  // Programa de cashback: reintegro de un % de la primera cuota del crédito
  // si el socio paga en tiempo y forma. Ver src/cashback/cashback.ts.
  cashback: {
    // Porcentaje de la cuota que se reintegra. 0.10 = 10%.
    porcentaje: Number(process.env.CASHBACK_PORCENTAJE ?? 0.1),
    // Cuántos días antes del primer vencimiento se manda el aviso recordatorio.
    avisoDiasAntes: Number(process.env.CASHBACK_AVISO_DIAS_ANTES ?? 2),
  },
  // Toggle para alternar entre mock y endpoint real de la mutual.
  // true → usa el mock embebido en src/data/mockDb.ts (default, dev/testing)
  // false → usa el endpoint real (requiere ENDPOINT_* abajo configurados)
  useMockDb: (process.env.USE_MOCK_DB ?? 'true').toLowerCase() !== 'false',
  endpoint: {
    baseUrl: process.env.ENDPOINT_BASE_URL ?? '',
    ticket: process.env.ENDPOINT_TICKET ?? '',
    empresaId: Number(process.env.ENDPOINT_EMPRESA_ID ?? 0),
    timeoutMs: numEnv('ENDPOINT_TIMEOUT_MS', 30_000),
    // TTL del cache en memoria del snapshot completo. Default 5 min.
    // Subirlo si los datos cambian poco; bajarlo si necesitás info más fresca.
    cacheTtlMs: numEnv('ENDPOINT_CACHE_TTL_MS', 300_000),
    // Cuánto tiempo MÁS allá del TTL seguimos sirviendo el snapshot viejo
    // mientras se refresca en background. El endpoint tarda ~30-50s en
    // responder: sin esto, el socio que escribe justo cuando vence el TTL
    // espera todo eso para recibir su saldo. Default 30 min.
    staleMaxMs: numEnv('ENDPOINT_STALE_MAX_MS', 1_800_000),
  },
};

export function isWhatsAppConfigured(): boolean {
  const w = config.whatsapp;
  return !!(w.verifyToken && w.accessToken && w.phoneNumberId);
}
