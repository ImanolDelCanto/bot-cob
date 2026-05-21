import dotenv from 'dotenv';
dotenv.config({ override: true });
function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
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
    welcomeEveryHours: Number(process.env.JOBS_WELCOME_EVERY_HOURS ?? 2),
    cashbackAvisoEveryHours: Number(process.env.JOBS_CASHBACK_EVERY_HOURS ?? 6),
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
    timeoutMs: Number(process.env.ENDPOINT_TIMEOUT_MS ?? 30_000),
    // TTL del cache en memoria del snapshot completo. Default 5 min.
    // Subirlo si los datos cambian poco; bajarlo si necesitás info más fresca.
    cacheTtlMs: Number(process.env.ENDPOINT_CACHE_TTL_MS ?? 300_000),
  },
};

export function isWhatsAppConfigured(): boolean {
  const w = config.whatsapp;
  return !!(w.verifyToken && w.accessToken && w.phoneNumberId);
}
