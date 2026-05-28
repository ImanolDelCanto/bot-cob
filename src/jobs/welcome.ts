import { db } from '../data/index.js';
import { sendWhatsAppMessage } from '../whatsapp/webhook.js';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { appendMessages } from '../memory/conversations.js';
import { getCasoLegalPorDni } from '../casos-legales/casos-legales.js';
import type { Operacion } from '../data/types.js';

const TEMPLATE_NAME = 'bienvenida_credito';

// Cuántas horas hacia atrás considerar como "recién liquidado".
// 48hs por defecto: si el cron corre cada 2hs hay redundancia, pero la idempotencia
// (sent_messages) protege de duplicados. El extra cubre eventuales caídas del cron.
const HORAS_LOOKBACK = 48;

// Convierte una fecha ISO (yyyy-mm-dd) al formato argentino DD/MM/YYYY.
function formatFechaCorta(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Hora actual (0-23) en zona horaria Argentina (UTC-3).
// Usamos Intl para que funcione bien en cualquier server, sin importar su TZ por defecto.
function getHoraArgentina(): number {
  const horaStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return parseInt(horaStr, 10);
}

export interface WelcomeJobResult {
  total: number;
  enviados: number;
  saltados: number;
  errores: Array<{ creditoId: string; error: string }>;
  dryRun: boolean;
  skipped?: string;
}

export interface WelcomeJobOptions {
  // Si es true, no manda nada por WhatsApp ni inserta en sent_messages.
  // Solo simula y devuelve qué hubiera mandado. Útil para chequear sin gastar API calls.
  dryRun?: boolean;
  // Si es true, ignora la restricción horaria. Útil para testing fuera de la ventana.
  force?: boolean;
}

// Procesa UNA operación: chequea idempotencia, manda el welcome, registra historial.
// Devuelve qué pasó para que el caller acumule el resultado. Compartido entre el job
// automático (créditos liquidados hace poco) y el job bulk (lista subida a mano).
async function procesarOperacion(op: Operacion, dryRun: boolean, result: WelcomeJobResult): Promise<void> {
  const cliente = await db.buscarClientePorDni(op.dni);
  if (!cliente) {
    result.errores.push({ creditoId: op.id, error: 'Cliente no encontrado para el DNI ' + op.dni });
    return;
  }
  if (!cliente.telefono) {
    result.errores.push({ creditoId: op.id, error: 'Cliente sin teléfono registrado' });
    return;
  }

  // Si el socio está derivado a un estudio jurídico, NO le mandamos welcome —
  // el equipo legal lo está gestionando aparte.
  const casoLegal = await getCasoLegalPorDni(op.dni);
  if (casoLegal) {
    result.saltados++;
    return;
  }

  // ¿Ya mandamos este template para este crédito? Si sí, saltamos (idempotencia).
  const { data: yaEnviado, error: queryErr } = await supabase
    .from('sent_messages')
    .select('id')
    .eq('template_name', TEMPLATE_NAME)
    .eq('external_id', op.id)
    .maybeSingle();

  if (queryErr) {
    result.errores.push({ creditoId: op.id, error: `Error chequeando idempotencia: ${queryErr.message}` });
    return;
  }

  if (yaEnviado) {
    result.saltados++;
    return;
  }

  const monto = op.capitalOriginal.toLocaleString('es-AR');
  const fechaVenc = formatFechaCorta(op.primerVencimiento);
  const texto =
    `¡Hola ${cliente.primerNombre}! Tu crédito ya está acreditado.\n\n` +
    `📋 Resumen\n` +
    `• Monto: $${monto}\n` +
    `• Cuotas: ${op.totalCuotas}\n` +
    `• Primer vencimiento: ${fechaVenc}\n\n` +
    `🎁 Tenemos un beneficio exclusivo para vos por tu crédito nuevo.\n` +
    `Agendá este número y respondé este mensaje con un "Hola" así te lo cuento. ` +
    `Es un beneficio que te conviene aprovechar desde tu primera cuota.\n\n` +
    `Cualquier consulta sobre tu crédito también podés escribirme. — Mutu, Mutual Protecap`;

  if (dryRun) {
    console.log(`[dry-run] → ${cliente.telefono}: ${texto}`);
    result.enviados++;
    return;
  }

  try {
    await sendWhatsAppMessage(cliente.telefono, texto);

    // Guardamos el welcome en el historial de conversación para que, cuando
    // el socio responda, el LLM tenga el contexto (sino lo recibe "cold" y no
    // engancha con el hook del beneficio). Convención: nota 'user' interna +
    // mensaje 'model' para mantener la alternancia que Gemini exige.
    try {
      await appendMessages(cliente.telefono, [
        { role: 'user', parts: [{ text: '[bienvenida automática enviada por crédito recién acreditado]' }] },
        { role: 'model', parts: [{ text: texto }] },
      ]);
    } catch (err: any) {
      console.error(`Mensaje enviado pero falló guardar historial para ${op.id}:`, err?.message ?? err);
    }

    const { error: insertErr } = await supabase.from('sent_messages').insert({
      telefono: cliente.telefono,
      template_name: TEMPLATE_NAME,
      external_id: op.id,
    });
    if (insertErr) {
      console.error(`Mensaje enviado pero falló registro en sent_messages para ${op.id}:`, insertErr.message);
    }

    result.enviados++;
  } catch (err: any) {
    result.errores.push({ creditoId: op.id, error: String(err?.message ?? err) });
  }
}

// Defensa de horario: aplica a los dos jobs (cron y bulk). Si está fuera de la
// ventana configurada y no se pasó force, devolvemos un result vacío con `skipped`.
function chequearHorario(force: boolean, dryRun: boolean): WelcomeJobResult | null {
  if (force) return null;
  const hora = getHoraArgentina();
  const { hourStart, hourEnd } = config.jobs;
  if (hora < hourStart || hora >= hourEnd) {
    return {
      total: 0,
      enviados: 0,
      saltados: 0,
      errores: [],
      dryRun,
      skipped: `Fuera de horario (${hora}hs Argentina, ventana ${hourStart}-${hourEnd})`,
    };
  }
  return null;
}

// Job automático: para cada préstamo liquidado en las últimas HORAS_LOOKBACK horas,
// manda welcome. Idempotente vía sent_messages — no manda dos veces al mismo crédito.
export async function runWelcomeJob(opts: WelcomeJobOptions = {}): Promise<WelcomeJobResult> {
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const skip = chequearHorario(force, dryRun);
  if (skip) return skip;

  const operaciones = await db.getPrestamosRecienLiquidados(HORAS_LOOKBACK);
  const result: WelcomeJobResult = {
    total: operaciones.length,
    enviados: 0,
    saltados: 0,
    errores: [],
    dryRun,
  };

  for (const op of operaciones) {
    await procesarOperacion(op, dryRun, result);
  }

  return result;
}

// Bulk: para cada DNI en la lista, busca el préstamo activo más reciente
// (último fechaLiquidacion) y le manda welcome. Útil para el catch-up inicial
// donde subís una base de clientes que nunca recibieron bienvenida (por ejemplo,
// la cohorte del 21 al 20 del mes pasado).
export async function runWelcomeBulk(
  dnis: string[],
  opts: WelcomeJobOptions = {},
): Promise<WelcomeJobResult> {
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const skip = chequearHorario(force, dryRun);
  if (skip) return skip;

  const result: WelcomeJobResult = {
    total: 0,
    enviados: 0,
    saltados: 0,
    errores: [],
    dryRun,
  };

  for (const dniRaw of dnis) {
    const dni = String(dniRaw).replace(/\D/g, '');
    if (!dni) continue;

    const ops = await db.getOperacionesPorDni(dni);
    // Tomamos el préstamo activo más reciente (último fechaLiquidacion).
    const candidatos = ops
      .filter(op => op.esCredito && op.estado === 'Activa')
      .sort((a, b) => (b.fechaLiquidacion ?? '').localeCompare(a.fechaLiquidacion ?? ''));
    const op = candidatos[0];

    if (!op) {
      result.errores.push({ creditoId: dni, error: `DNI ${dni}: sin préstamos activos` });
      continue;
    }

    result.total++;
    await procesarOperacion(op, dryRun, result);
  }

  return result;
}
