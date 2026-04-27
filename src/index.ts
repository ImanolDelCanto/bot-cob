import express, { type Request, type Response } from 'express';
import { config } from './config.js';
import { chat } from './llm/agent.js';
import { resetHistorial } from './memory/conversations.js';

const app = express();
app.use(express.json());

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

app.post('/reset', (req: Request, res: Response) => {
  const { telefono } = req.body ?? {};
  if (typeof telefono !== 'string') {
    return res.status(400).json({ error: 'Falta telefono' });
  }
  resetHistorial(telefono);
  res.json({ ok: true });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`🤖 Bot mutual escuchando en http://localhost:${config.port}`);
  console.log(`   POST /chat   { telefono, mensaje }`);
  console.log(`   POST /reset  { telefono }`);
  console.log(`   GET  /health`);
});
