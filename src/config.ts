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
  // Token simple para proteger los endpoints /admin/*. Si está vacío, los endpoints quedan deshabilitados.
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Ventana horaria (zona horaria Argentina, UTC-3) en la que los jobs proactivos
  // pueden enviar mensajes. start es inclusivo, end es exclusivo.
  // Default: 10-21 = entre las 10:00 y las 20:59.
  jobs: {
    hourStart: Number(process.env.JOBS_HOUR_START ?? 10),
    hourEnd: Number(process.env.JOBS_HOUR_END ?? 21),
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
