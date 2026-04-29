import express, { type NextFunction, type Request, type Response } from 'express';
import { config, isWhatsAppConfigured } from './config.js';
import { chat } from './llm/agent.js';
import { resetHistorial } from './memory/conversations.js';
import whatsappRouter from './whatsapp/webhook.js';
import { runWelcomeJob } from './jobs/welcome.js';

const app = express();
app.use(express.json());
app.use('/whatsapp', whatsappRouter);

app.post('/chat', async (req: Request, res: Response) => {
  const { telefono, mensaje } = req.body ?? {};
  if (typeof telefono !== 'string' || typeof mensaje !== 'string') {
    return res.status(400).json({ error: 'Faltan campos: { telefono: string, mensaje: string }' });
  }
  try {
    const respuesta = await chat(telefono, mensaje);
    res.json({ respuesta });
  } catch (err: any) {
    console.error('Error en /chat:', err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.post('/reset', async (req: Request, res: Response) => {
  const { telefono } = req.body ?? {};
  if (typeof telefono !== 'string') {
    return res.status(400).json({ error: 'Falta telefono' });
  }
  try {
    await resetHistorial(telefono);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error en /reset:', err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Middleware simple para endpoints /admin/*: requiere header
//   Authorization: Bearer <ADMIN_TOKEN>
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminToken) {
    return res.status(503).json({ error: 'ADMIN_TOKEN no configurado en el server' });
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Dispara el job de bienvenidas.
// Body opcional:
//   { dryRun: true } → simula sin enviar ni guardar en sent_messages
//   { force: true }  → ignora la restricción horaria (útil para testing)
app.post('/admin/jobs/welcome', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const force = req.body?.force === true;
    const result = await runWelcomeJob({ dryRun, force });
    res.json(result);
  } catch (err: any) {
    console.error('Error en /admin/jobs/welcome:', err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.listen(config.port, () => {
  console.log(`🤖 Bot mutual escuchando en http://localhost:${config.port}`);
  console.log(`   POST /chat               { telefono, mensaje }`);
  console.log(`   POST /reset              { telefono }`);
  console.log(`   GET  /health`);
  console.log(`   GET  /whatsapp/webhook   (verificación de Meta)`);
  console.log(`   POST /whatsapp/webhook   (mensajes entrantes)`);
  console.log(`   POST /admin/jobs/welcome (requiere Authorization: Bearer ADMIN_TOKEN)`);
  if (!isWhatsAppConfigured()) {
    console.log(`   ⚠️  WhatsApp NO configurado: faltan WHATSAPP_* en .env`);
  }
  if (!config.adminToken) {
    console.log(`   ⚠️  ADMIN_TOKEN no configurado: endpoints /admin/* deshabilitados`);
  }
});
