import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, isWhatsAppConfigured } from './config.js';
import { chat } from './llm/agent.js';
import { resetHistorial } from './memory/conversations.js';
import whatsappRouter from './whatsapp/webhook.js';
import { runWelcomeJob, runWelcomeBulk } from './jobs/welcome.js';
import { runCashbackAvisoJob } from './jobs/cashbackAviso.js';
import { startScheduler } from './jobs/scheduler.js';
import {
  listPendientes as listComprobantesPendientes,
  marcarProcesado as marcarComprobanteProcesado,
  marcarRechazado as marcarComprobanteRechazado,
} from './storage/comprobantes.js';
import {
  listPendientesReintegro,
  marcarReintegrado,
  descartar as descartarCashback,
} from './cashback/cashback.js';

const app = express();

// express.json con verify: captura el body crudo en req.rawBody para que el
// webhook de WhatsApp pueda verificar la firma HMAC (la firma se computa sobre
// los bytes crudos, no sobre el JSON parseado). Limit ajustado: webhooks de
// Meta son chicos, 1mb es de sobra y nos protege de payloads abusivos.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));
app.use('/whatsapp', whatsappRouter);

// Logueamos detalle del error pero NO lo devolvemos al cliente para no leakear
// internals (paths, queries, nombres de tabla). Cliente recibe { error: 'internal' }.
function internalError(res: Response, where: string, err: unknown): void {
  console.error(`Error en ${where}:`, err);
  res.status(500).json({ error: 'internal' });
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Comparación constant-time del token vía hash (cualquier diff de longitud o
// contenido tarda lo mismo, así no se puede inferir el token por timing).
function tokensMatch(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const e = createHash('sha256').update(expected).digest();
  const p = createHash('sha256').update(provided).digest();
  return timingSafeEqual(e, p);
}

// Middleware para endpoints /admin/* y los antes-públicos /chat y /reset.
// Requiere header Authorization: Bearer <ADMIN_TOKEN>.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminToken) {
    return res.status(503).json({ error: 'ADMIN_TOKEN no configurado en el server' });
  }
  const auth = req.headers.authorization ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!tokensMatch(config.adminToken, provided)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// /chat y /reset son herramientas internas (CLI / testing). Antes estaban
// expuestas sin auth, lo que permitía a cualquiera con la URL pública:
//   - quemar tokens de Gemini posteando a /chat con cualquier teléfono
//   - borrar el historial de cualquier socio del que conocieran el número
// Ahora exigen el mismo Bearer que los endpoints /admin/*.
app.post('/chat', requireAdmin, async (req: Request, res: Response) => {
  const { telefono, mensaje } = req.body ?? {};
  if (typeof telefono !== 'string' || typeof mensaje !== 'string') {
    return res.status(400).json({ error: 'Faltan campos: { telefono: string, mensaje: string }' });
  }
  try {
    const respuesta = await chat(telefono, mensaje);
    res.json({ respuesta });
  } catch (err) {
    internalError(res, '/chat', err);
  }
});

app.post('/reset', requireAdmin, async (req: Request, res: Response) => {
  const { telefono } = req.body ?? {};
  if (typeof telefono !== 'string') {
    return res.status(400).json({ error: 'Falta telefono' });
  }
  try {
    await resetHistorial(telefono);
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/reset', err);
  }
});

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
  } catch (err) {
    internalError(res, '/admin/jobs/welcome', err);
  }
});

// Welcome BULK: manda bienvenida a una lista explícita de DNIs. Útil para el
// catch-up inicial (ej: cohorte del 21 al 20 que nunca recibió welcome). Idempotente
// igual que el job normal — un crédito ya saludado se saltea.
// Body: { dnis: string[], dryRun?: boolean, force?: boolean }
app.post('/admin/jobs/welcome-bulk', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dnis = req.body?.dnis;
    if (!Array.isArray(dnis) || dnis.length === 0) {
      return res.status(400).json({ error: 'Falta dnis: string[] (lista no vacía)' });
    }
    if (dnis.length > 5000) {
      return res.status(400).json({ error: 'Demasiados DNIs (máximo 5000 por request)' });
    }
    const dryRun = req.body?.dryRun === true;
    const force = req.body?.force === true;
    const result = await runWelcomeBulk(dnis.map(String), { dryRun, force });
    res.json(result);
  } catch (err) {
    internalError(res, '/admin/jobs/welcome-bulk', err);
  }
});

// Dispara el job de aviso de cashback (recordatorio 48hs antes del vencimiento).
// Body opcional: { dryRun: true }, { force: true } (igual que el de welcome).
app.post('/admin/jobs/cashback-aviso', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const force = req.body?.force === true;
    const result = await runCashbackAvisoJob({ dryRun, force });
    res.json(result);
  } catch (err) {
    internalError(res, '/admin/jobs/cashback-aviso', err);
  }
});

// Lista los cashbacks abiertos (inscripto / aviso_enviado) para que un humano
// revise quién pagó en tiempo y forma y cierre el ciclo (reintegro o descarte).
app.get('/admin/cashback/pendientes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 100);
    const result = await listPendientesReintegro({ limit });
    res.json({ cashbacks: result });
  } catch (err) {
    internalError(res, '/admin/cashback/pendientes', err);
  }
});

// Marca un cashback como reintegrado (el humano confirmó pago en fecha + hizo la devolución).
// Body: { reintegrado_por: string, notas?: string }
app.post('/admin/cashback/:id/marcar-reintegrado', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const reintegradoPor = String(req.body?.reintegrado_por ?? '').trim();
    if (!reintegradoPor) {
      return res.status(400).json({ error: 'Falta reintegrado_por (nombre del operador)' });
    }
    await marcarReintegrado({
      id,
      reintegradoPor,
      notas: typeof req.body?.notas === 'string' ? req.body.notas : undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/admin/cashback/:id/marcar-reintegrado', err);
  }
});

// Descarta un cashback (no pagó a tiempo / no corresponde).
// Body: { motivo: string }
app.post('/admin/cashback/:id/descartar', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) {
      return res.status(400).json({ error: 'Falta motivo del descarte' });
    }
    await descartarCashback({ id, motivo });
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/admin/cashback/:id/descartar', err);
  }
});

// Lista los comprobantes en estado 'pendiente' con URLs firmadas (1h) para verlos.
// Útil para que un humano los procese desde un dashboard / cliente HTTP.
app.get('/admin/comprobantes/pendientes', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const result = await listComprobantesPendientes({ limit });
    res.json({ comprobantes: result });
  } catch (err) {
    internalError(res, '/admin/comprobantes/pendientes', err);
  }
});

// Marca un comprobante como procesado (ya registrado en el sistema interno).
// Body: { procesado_por: string, notas?: string }
app.post('/admin/comprobantes/:id/marcar-procesado', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const procesadoPor = String(req.body?.procesado_por ?? '').trim();
    if (!procesadoPor) {
      return res.status(400).json({ error: 'Falta procesado_por (nombre del operador humano)' });
    }
    await marcarComprobanteProcesado({
      id,
      procesadoPor,
      notas: typeof req.body?.notas === 'string' ? req.body.notas : undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/admin/comprobantes/:id/marcar-procesado', err);
  }
});

// Marca un comprobante como rechazado (ej: ilegible, duplicado, no corresponde).
// Body: { procesado_por: string, notas: string }
app.post('/admin/comprobantes/:id/marcar-rechazado', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const procesadoPor = String(req.body?.procesado_por ?? '').trim();
    const notas = String(req.body?.notas ?? '').trim();
    if (!procesadoPor || !notas) {
      return res.status(400).json({ error: 'Faltan procesado_por y/o notas (motivo del rechazo)' });
    }
    await marcarComprobanteRechazado({ id, procesadoPor, notas });
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/admin/comprobantes/:id/marcar-rechazado', err);
  }
});

app.listen(config.port, () => {
  console.log(`🤖 Bot mutual escuchando en http://localhost:${config.port}`);
  console.log(`   POST /chat               { telefono, mensaje }`);
  console.log(`   POST /reset              { telefono }`);
  console.log(`   GET  /health`);
  console.log(`   GET  /whatsapp/webhook   (verificación de Meta)`);
  console.log(`   POST /whatsapp/webhook   (mensajes entrantes)`);
  console.log(`   POST /admin/jobs/welcome              (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/jobs/welcome-bulk         (Bearer ADMIN_TOKEN) { dnis: [] }`);
  console.log(`   POST /admin/jobs/cashback-aviso       (Bearer ADMIN_TOKEN)`);
  console.log(`   GET  /admin/cashback/pendientes       (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/cashback/:id/marcar-reintegrado    (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/cashback/:id/descartar             (Bearer ADMIN_TOKEN)`);
  console.log(`   GET  /admin/comprobantes/pendientes   (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/comprobantes/:id/marcar-procesado  (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/comprobantes/:id/marcar-rechazado  (Bearer ADMIN_TOKEN)`);
  if (!isWhatsAppConfigured()) {
    console.log(`   ⚠️  WhatsApp NO configurado: faltan WHATSAPP_* en .env`);
  }
  if (!config.adminToken) {
    console.log(`   ⚠️  ADMIN_TOKEN no configurado: endpoints /admin/*, /chat y /reset deshabilitados`);
  }
  if (!config.whatsapp.appSecret) {
    console.log(`   ⚠️  WHATSAPP_APP_SECRET no configurado: webhook NO está verificando firma de Meta (INSEGURO en producción)`);
  }

  // Scheduler de jobs proactivos. Solo si está habilitado Y WhatsApp configurado
  // (mandar mensajes sin credenciales no tiene sentido y solo loguearía errores).
  if (config.jobs.schedulerEnabled && isWhatsAppConfigured()) {
    startScheduler();
  } else {
    const motivo = !config.jobs.schedulerEnabled ? 'JOBS_SCHEDULER_ENABLED=false' : 'WhatsApp no configurado';
    console.log(`   ⏸️  Scheduler de jobs apagado (${motivo}). Disparalos a mano por /admin/jobs/*`);
  }
});
