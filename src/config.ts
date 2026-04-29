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
};

export function isWhatsAppConfigured(): boolean {
  const w = config.whatsapp;
  return !!(w.verifyToken && w.accessToken && w.phoneNumberId);
}
