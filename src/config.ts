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
};
