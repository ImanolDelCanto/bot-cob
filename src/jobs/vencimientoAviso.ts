// Recordatorio de vencimiento de cuota.
//
// Cada día a la mañana revisa todas las operaciones activas. Si la PRÓXIMA cuota
// del socio (primerVencimiento + cuotasPagadas meses) cae a hoy + N días, le manda
// un recordatorio para que no se le pase.
//
// Reglas:
//   - Skip si el socio está derivado a un estudio jurídico (casos_legales).
//   - Skip si hay un cashback inscripto para ese crédito con primer_vencimiento
//     igual a la fecha del recordatorio — el cashbackAviso lo cubre con su mensaje
//     propio (que incluye el monto del reintegro).
//   - Idempotente: registra en sent_messages con external_id = `${dni}-${fechaCuota}`.
//     Una sola notificación por socio por fecha de vencimiento.
//   - Agrupa por DNI: si el socio tiene préstamo + cuota social + asistencia que
//     vencen el mismo día, recibe UN solo mensaje con el monto total.

import { db, retenerDatos, liberarDatos } from '../data/index.js';
import { sendWhatsAppMessage } from '../whatsapp/webhook.js';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { crearLimiter, logCupoAgotado, type Limiter } from './rateLimit.js';
import { enviarConIdempotencia, AbortarCorrida } from './envio.js';
import { appendMessages } from '../memory/conversations.js';
import { getCasoLegalPorDni } from '../casos-legales/casos-legales.js';
import { esCuotaSocial, cuotaSocialEnFecha } from '../data/products.js';
import type { Operacion } from '../data/types.js';

const TEMPLATE_NAME = 'recordatorio_vencimiento';

function formatFechaCorta(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function getHoraArgentina(): number {
  const horaStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return parseInt(horaStr, 10);
}

// Suma N meses manteniendo el día del mes, CLAMPEANDO al último día del mes
// destino. Misma lógica que consolidador.ts (ver la explicación ahí).
// Sin el clamp, a los socios con vencimiento 29/30/31 la fecha calculada nunca
// coincidía con hoy+2 y el aviso no les salía nunca, o salía el día equivocado.
function sumarMeses(isoFecha: string, meses: number): string {
  if (!isoFecha) return '';
  const [y, m, d] = isoFecha.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(y, m - 1 + meses + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(y, m - 1 + meses, Math.min(d, ultimoDia)));
  return dt.toISOString().slice(0, 10);
}

// hoy + N días en ISO yyyy-mm-dd, en zona horaria Argentina (para evitar drifts).
function hoyMasNDiasIso(n: number): string {
  const hoy = new Date();
  const dt = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + n));
  return dt.toISOString().slice(0, 10);
}

export interface VencimientoAvisoJobResult {
  total: number;
  enviados: number;
  saltados: number;
  // Candidatos válidos que quedaron fuera del cupo de la corrida. No se pierden:
  // la corrida siguiente los retoma (idempotencia por sent_messages).
  omitidosPorCupo: number;
  errores: Array<{ dni: string; error: string }>;
  dryRun: boolean;
  skipped?: string;
  // Corrida cortada por un error que afecta a toda la cuenta de WhatsApp.
  abortado?: string;
}

export interface VencimientoAvisoJobOptions {
  dryRun?: boolean;
  force?: boolean;
  // Por defecto avisa para cuotas que vencen en config.cashback.avisoDiasAntes días.
  // Se puede override pasándolo explícito (útil para testing).
  diasAntes?: number;
}

interface CandidatoAviso {
  dni: string;
  fechaVencimiento: string;
  montoTotal: number;             // suma de las cuotas de ese día (préstamo + cuota social + asistencia)
  primerVencimientoBase: string;  // primer vencimiento de uno de los créditos del DNI (para chequear duplicado con cashback)
}

export async function runVencimientoAvisoJob(
  opts: VencimientoAvisoJobOptions = {},
): Promise<VencimientoAvisoJobResult> {
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;
  const diasAntes = opts.diasAntes ?? config.cashback.avisoDiasAntes;

  if (!force) {
    const hora = getHoraArgentina();
    const { hourStart, hourEnd } = config.jobs;
    if (hora < hourStart || hora >= hourEnd) {
      return {
        total: 0,
        enviados: 0,
        saltados: 0,
        omitidosPorCupo: 0,
        errores: [],
        dryRun,
        skipped: `Fuera de horario (${hora}hs Argentina, ventana ${hourStart}-${hourEnd})`,
      };
    }
  }

  const fechaTarget = hoyMasNDiasIso(diasAntes);
  const hoyIso = hoyMasNDiasIso(0);

  // Este job recorre TODO el padrón activo (>50k operaciones) y después manda de
  // a uno esperando la API de WhatsApp. Sin congelar el snapshot, el TTL de 5min
  // vence a mitad de corrida y se re-bajan los ~38MB varias veces seguidas.
  retenerDatos();
  try {
    return await correr(fechaTarget, hoyIso, diasAntes, dryRun);
  } finally {
    liberarDatos();
  }
}

async function correr(
  fechaTarget: string,
  hoyIso: string,
  diasAntes: number,
  dryRun: boolean,
): Promise<VencimientoAvisoJobResult> {
  // 1. Traemos todas las operaciones activas y filtramos las que tienen una cuota
  //    que vence exactamente en la fecha target.
  const operacionesActivas = await db.getOperacionesActivas();
  const candidatosPorDni = new Map<string, CandidatoAviso>();

  for (const op of operacionesActivas) {
    if (!op.primerVencimiento || op.totalCuotas <= 0) continue;

    // Próxima cuota a vencer = primerVto + cuotasPagadas meses. Si todavía hay
    // cuotas por pagar y esa fecha == target, es candidata.
    if (op.cuotasPagadas >= op.totalCuotas) continue;
    const fechaProx = sumarMeses(op.primerVencimiento, op.cuotasPagadas);
    if (fechaProx !== fechaTarget) continue;

    const montoOp = montoOpEnFecha(op, fechaProx);
    const existente = candidatosPorDni.get(op.dni);
    if (existente) {
      existente.montoTotal += montoOp;
    } else {
      candidatosPorDni.set(op.dni, {
        dni: op.dni,
        fechaVencimiento: fechaProx,
        montoTotal: montoOp,
        primerVencimientoBase: op.primerVencimiento,
      });
    }
  }

  const result: VencimientoAvisoJobResult = {
    total: candidatosPorDni.size,
    enviados: 0,
    saltados: 0,
    omitidosPorCupo: 0,
    errores: [],
    dryRun,
  };
  const limiter = crearLimiter();

  console.log(
    `[vencimiento-aviso] ${candidatosPorDni.size} candidatos con cuota que vence el ${fechaTarget} ` +
    `(hoy=${hoyIso}, diasAntes=${diasAntes}, cupo=${limiter.max})`,
  );

  for (const cand of candidatosPorDni.values()) {
    try {
      await procesarCandidato(cand, dryRun, result, limiter);
    } catch (err: any) {
      if (err instanceof AbortarCorrida) {
        result.abortado = err.message;
        console.error(`🛑 [vencimiento-aviso] ${err.message}`);
        break;
      }
      result.errores.push({ dni: cand.dni, error: String(err?.message ?? err) });
    }
  }

  logCupoAgotado('vencimiento-aviso', result.omitidosPorCupo, limiter);
  return result;
}

// Monto de una operación para la cuota que vence en `fechaIso`. Para cuota social
// usa el monto histórico vigente; para el resto usa op.importeCuota.
function montoOpEnFecha(op: Operacion, fechaIso: string): number {
  if (esCuotaSocial(op.producto)) return cuotaSocialEnFecha(fechaIso);
  return op.importeCuota;
}

async function procesarCandidato(
  cand: CandidatoAviso,
  dryRun: boolean,
  result: VencimientoAvisoJobResult,
  limiter: Limiter,
): Promise<void> {
  // 1. Skip si está en estudio legal.
  const casoLegal = await getCasoLegalPorDni(cand.dni);
  if (casoLegal) {
    result.saltados++;
    return;
  }

  // 2. Skip si hay un cashback inscripto para ese crédito con la misma fecha
  //    de vencimiento — el cashbackAviso le va a mandar SU mensaje específico
  //    (que incluye el monto del reintegro). No queremos duplicar.
  const { data: cashbackMismaFecha, error: cbErr } = await supabase
    .from('cashback')
    .select('id, estado')
    .eq('dni', cand.dni)
    .eq('primer_vencimiento', cand.fechaVencimiento)
    .in('estado', ['inscripto', 'aviso_enviado'])
    .maybeSingle();

  if (cbErr) {
    result.errores.push({ dni: cand.dni, error: `Error chequeando cashback: ${cbErr.message}` });
    return;
  }
  if (cashbackMismaFecha) {
    result.saltados++;
    return;
  }

  // 3. Idempotencia: ya mandamos este aviso para este DNI+fecha? (chequeo barato;
  //    la reserva autoritativa la hace enviarConIdempotencia más abajo).
  const externalId = `${cand.dni}-${cand.fechaVencimiento}`;
  const { data: yaEnviado, error: queryErr } = await supabase
    .from('sent_messages')
    .select('id')
    .eq('template_name', TEMPLATE_NAME)
    .eq('external_id', externalId)
    .maybeSingle();

  if (queryErr) {
    result.errores.push({ dni: cand.dni, error: `Error chequeando idempotencia: ${queryErr.message}` });
    return;
  }
  if (yaEnviado) {
    result.saltados++;
    return;
  }

  // 4. Datos del cliente.
  const cliente = await db.buscarClientePorDni(cand.dni);
  if (!cliente) {
    result.errores.push({ dni: cand.dni, error: 'Cliente no encontrado' });
    return;
  }
  if (!cliente.telefono) {
    result.errores.push({ dni: cand.dni, error: 'Cliente sin teléfono' });
    return;
  }

  // 5. Armar y mandar el mensaje.
  const monto = cand.montoTotal.toLocaleString('es-AR');
  const fecha = formatFechaCorta(cand.fechaVencimiento);
  const texto =
    `¡Hola ${cliente.primerNombre}! Te recordamos que tu cuota de $${monto} vence el ${fecha}.\n\n` +
    `Si vas a pagar por transferencia, escribime y te paso los datos. ` +
    `También podés pagar online desde https://mockpagos.vercel.app/login con tu DNI.\n\n` +
    `— Mutu, Mutual Protecap`;

  if (dryRun) {
    console.log(`[dry-run vencimiento-aviso] → ${cliente.telefono}: ${texto}`);
    result.enviados++;
    return;
  }

  // Cupo: se chequea recién acá, con todos los filtros ya pasados, así no se
  // gasta en candidatos que igual no iban a recibir nada.
  if (!limiter.hayCupo()) {
    result.omitidosPorCupo++;
    return;
  }
  await limiter.consumir();

  // 6. Reservar la marca, mandar, y liberarla solo si el fallo es reintentable.
  const { resultado, error } = await enviarConIdempotencia({
    telefono: cliente.telefono,
    texto,
    templateName: TEMPLATE_NAME,
    externalId,
  });

  if (resultado === 'duplicado') {
    result.saltados++;
    return;
  }
  if (resultado !== 'enviado') {
    result.errores.push({ dni: cand.dni, error: error ?? 'error desconocido' });
    return;
  }

  // 7. Guardar en historial para que el LLM tenga contexto si el socio responde.
  try {
    await appendMessages(cliente.telefono, [
      { role: 'user', parts: [{ text: '[aviso automático: recordatorio de cuota próxima a vencer]' }] },
      { role: 'model', parts: [{ text: texto }] },
    ]);
  } catch (err: any) {
    console.error(`Aviso enviado pero falló guardar historial para ${cand.dni}:`, err?.message ?? err);
  }

  result.enviados++;
}
