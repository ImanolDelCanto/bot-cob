import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, isWhatsAppConfigured } from './config.js';
import { chat } from './llm/agent.js';
import { resetHistorial } from './memory/conversations.js';
import whatsappRouter from './whatsapp/webhook.js';
import { runWelcomeJob, runWelcomeBulk } from './jobs/welcome.js';
import { runCashbackAvisoJob } from './jobs/cashbackAviso.js';
import { runVencimientoAvisoJob } from './jobs/vencimientoAviso.js';
import { startScheduler, stopScheduler, jobsEnCurso } from './jobs/scheduler.js';
import { supabase } from './db/supabase.js';
import { datosDisponibles } from './data/index.js';
import { flushAll, pendientes } from './whatsapp/messageBuffer.js';
import { estaCerrando, marcarCerrando } from './util/shutdown.js';
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
import {
  crearCasoLegal,
  listCasosActivos,
  darDeBajaCasoLegal,
} from './casos-legales/casos-legales.js';

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

// Healthcheck. Antes devolvía { ok: true } incondicionalmente: con Supabase
// caído o el snapshot del endpoint muerto seguía dando 200, así que Railway
// nunca se enteraba de que el bot no podía atender a nadie.
// Durante el apagado devuelve 503 a propósito, para que el balanceador deje de
// mandarnos tráfico antes de que cerremos.
app.get('/health', async (_req: Request, res: Response) => {
  if (estaCerrando()) {
    return res.status(503).json({ ok: false, estado: 'cerrando' });
  }

  const checks: Record<string, string> = {};
  let ok = true;

  // Supabase: una consulta mínima. Si la base no responde, no hay historial ni
  // idempotencia ni cashback — el bot está roto aunque el proceso viva.
  try {
    const { error } = await supabase.from('sent_messages').select('id').limit(1);
    if (error) throw new Error(error.message);
    checks.supabase = 'ok';
  } catch (err: any) {
    ok = false;
    checks.supabase = `error: ${err?.message ?? err}`;
  }

  // Fuente de datos de la mutual: que haya un snapshot utilizable.
  const datos = datosDisponibles();
  if (!datos.ok) ok = false;
  checks.datos = datos.detalle;

  res.status(ok ? 200 : 503).json({
    ok,
    modo: config.useMockDb ? 'mock' : 'produccion',
    checks,
    conversacionesPendientes: pendientes(),
    jobsEnCurso: jobsEnCurso(),
  });
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

// Dispara el job de recordatorio de vencimiento (manda aviso N días antes de la
// próxima cuota a vencer, para todos los socios menos los derivados a estudio legal).
// Body opcional: { dryRun, force, diasAntes }.
app.post('/admin/jobs/vencimiento-aviso', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const force = req.body?.force === true;
    const diasAntes = typeof req.body?.diasAntes === 'number' ? req.body.diasAntes : undefined;
    const result = await runVencimientoAvisoJob({ dryRun, force, diasAntes });
    res.json(result);
  } catch (err) {
    internalError(res, '/admin/jobs/vencimiento-aviso', err);
  }
});

// === Casos legales (socios derivados a estudios jurídicos) ===

// Crea un caso (deriva un socio al estudio jurídico). Body:
//   { dni: string, estudio_nombre: string, estudio_contacto?: string, notas?: string }
app.post('/admin/casos-legales', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dni = String(req.body?.dni ?? '').trim();
    const estudio_nombre = String(req.body?.estudio_nombre ?? '').trim();
    if (!dni || !estudio_nombre) {
      return res.status(400).json({ error: 'Faltan dni y/o estudio_nombre' });
    }
    const caso = await crearCasoLegal({
      dni,
      estudio_nombre,
      estudio_contacto: typeof req.body?.estudio_contacto === 'string' ? req.body.estudio_contacto : undefined,
      notas: typeof req.body?.notas === 'string' ? req.body.notas : undefined,
    });
    res.json(caso);
  } catch (err) {
    internalError(res, '/admin/casos-legales', err);
  }
});

// Lista casos activos.
app.get('/admin/casos-legales', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 200);
    const casos = await listCasosActivos({ limit });
    res.json({ casos });
  } catch (err) {
    internalError(res, '/admin/casos-legales', err);
  }
});

// Da de baja un caso (el estudio cerró, el socio vuelve al bot).
// Body opcional: { notas: string }
app.post('/admin/casos-legales/:id/baja', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const notas = typeof req.body?.notas === 'string' ? req.body.notas : undefined;
    await darDeBajaCasoLegal(id, notas);
    res.json({ ok: true });
  } catch (err) {
    internalError(res, '/admin/casos-legales/:id/baja', err);
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

// Envíos proactivos que NO llegaron, con el código de error de Meta.
// Sin esto, un socio con el teléfono mal cargado deja de recibir recordatorios
// para siempre y nadie se entera: la fila en sent_messages figuraba igual que
// las que sí se entregaron.
// Query opcional: ?limit=100&horas=168 (default: últimos 7 días).
app.get('/admin/envios/fallidos', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
    const horas = Math.min(Math.max(Number(req.query.horas ?? 168) || 168, 1), 24 * 90);
    const desde = new Date(Date.now() - horas * 3_600_000).toISOString();

    const { data, error } = await supabase
      .from('sent_messages')
      .select('id, telefono, template_name, external_id, sent_at, estado, error_codigo, error_detalle')
      .eq('estado', 'fallido')
      .gte('sent_at', desde)
      .order('sent_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    res.json({ desde, total: data?.length ?? 0, fallidos: data ?? [] });
  } catch (err) {
    internalError(res, '/admin/envios/fallidos', err);
  }
});

// Cuántos mensajes proactivos salieron en las últimas 24hs, contra el tope
// configurado. Es el número que hay que mirar antes de subir de tier en Meta.
app.get('/admin/envios/cupo', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const desde = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { count, error } = await supabase
      .from('sent_messages')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', desde);
    if (error) throw new Error(error.message);

    const usados = count ?? 0;
    const max = config.jobs.maxEnvios24h;
    res.json({ ventana: '24h', usados, max, restante: Math.max(0, max - usados) });
  } catch (err) {
    internalError(res, '/admin/envios/cupo', err);
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

const server = app.listen(config.port, () => {
  console.log(`🤖 Bot mutual escuchando en http://localhost:${config.port}`);
  console.log(`   POST /chat               { telefono, mensaje }`);
  console.log(`   POST /reset              { telefono }`);
  console.log(`   GET  /health`);
  console.log(`   GET  /whatsapp/webhook   (verificación de Meta)`);
  console.log(`   POST /whatsapp/webhook   (mensajes entrantes)`);
  console.log(`   POST /admin/jobs/welcome              (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/jobs/welcome-bulk         (Bearer ADMIN_TOKEN) { dnis: [] }`);
  console.log(`   POST /admin/jobs/cashback-aviso       (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/jobs/vencimiento-aviso    (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/casos-legales             (Bearer ADMIN_TOKEN) { dni, estudio_nombre, ... }`);
  console.log(`   GET  /admin/casos-legales             (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/casos-legales/:id/baja    (Bearer ADMIN_TOKEN)`);
  console.log(`   GET  /admin/cashback/pendientes       (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/cashback/:id/marcar-reintegrado    (Bearer ADMIN_TOKEN)`);
  console.log(`   POST /admin/cashback/:id/descartar             (Bearer ADMIN_TOKEN)`);
  console.log(`   GET  /admin/envios/fallidos           (Bearer ADMIN_TOKEN) ?limit=&horas=`);
  console.log(`   GET  /admin/envios/cupo               (Bearer ADMIN_TOKEN) cupo de 24hs vs tier de Meta`);
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
    console.log(`   ⚠️  WHATSAPP_APP_SECRET no configurado: el webhook RECHAZA todo POST (401)`);
  }

  // Scheduler de jobs proactivos. Solo si está habilitado Y WhatsApp configurado
  // (mandar mensajes sin credenciales no tiene sentido y solo loguearía errores).
  //
  // Guarda extra: en modo mock los jobs le mandarían mensajes REALES a los
  // teléfonos hardcodeados de mockDb.ts usando el token de producción. Un
  // `npm run dev` con el .env de siempre disparaba eso a los 30 segundos.
  if (config.useMockDb && isWhatsAppConfigured()) {
    console.log(`   ⏸️  Scheduler apagado: USE_MOCK_DB=true con WhatsApp configurado. Los jobs mandarían mensajes reales a los teléfonos del mock.`);
  } else if (config.jobs.schedulerEnabled && isWhatsAppConfigured()) {
    startScheduler();
  } else {
    const motivo = !config.jobs.schedulerEnabled ? 'JOBS_SCHEDULER_ENABLED=false' : 'WhatsApp no configurado';
    console.log(`   ⏸️  Scheduler de jobs apagado (${motivo}). Disparalos a mano por /admin/jobs/*`);
  }
});

// ─── Apagado prolijo ────────────────────────────────────────────────────────
//
// Railway manda SIGTERM en cada deploy y SIGKILL unos segundos después. Sin
// esto, cada deploy perdía los mensajes en la ventana de debounce (Meta ya
// recibió el 200, así que no reintenta) y podía morir entre la reserva en
// sent_messages y el envío, dejando socios marcados como avisados sin haber
// recibido nada.

const CIERRE_TIMEOUT_MS = 20_000;

async function cerrar(senal: string): Promise<void> {
  if (estaCerrando()) return;
  marcarCerrando();
  console.log(`\n🛑 ${senal} recibido. Cerrando...`);

  // Red de seguridad: si algo se cuelga, salimos igual antes del SIGKILL.
  const guarda = setTimeout(() => {
    console.error(`⚠️  El cierre tardó más de ${CIERRE_TIMEOUT_MS}ms. Salgo forzado.`);
    process.exit(1);
  }, CIERRE_TIMEOUT_MS);
  guarda.unref();

  try {
    // 1. Frenar los timers del scheduler. Las corridas en curso cortan solas
    //    entre envíos porque consultan estaCerrando().
    stopScheduler();
    const enCurso = jobsEnCurso();
    if (enCurso.length > 0) {
      console.log(`   Jobs en curso al cerrar: ${enCurso.join(', ')} (cortan en el próximo envío)`);
    }

    // 2. Dejar de aceptar conexiones nuevas.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // 3. Procesar lo que quedó en el buffer de debounce en vez de tirarlo.
    const p = pendientes();
    if (p > 0) console.log(`   Vaciando ${p} conversaciones pendientes...`);
    await flushAll(CIERRE_TIMEOUT_MS - 5_000);

    console.log('✅ Cierre completo.');
    clearTimeout(guarda);
    process.exit(0);
  } catch (err: any) {
    console.error('Error durante el cierre:', err?.message ?? err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void cerrar('SIGTERM'));
process.on('SIGINT', () => void cerrar('SIGINT'));

// Una promesa rechazada sin catch mata el proceso en Node 20+ — para TODOS los
// socios, no solo para la conversación que falló. Logueamos y seguimos vivos.
process.on('unhandledRejection', (razon) => {
  console.error('⚠️  Promesa rechazada sin manejar:', razon);
});
