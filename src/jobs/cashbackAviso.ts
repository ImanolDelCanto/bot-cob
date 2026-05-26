import { db } from '../data/index.js';
import { sendWhatsAppMessage } from '../whatsapp/webhook.js';
import { config } from '../config.js';
import { listParaAviso, marcarAvisoEnviado, type CashbackRow } from '../cashback/cashback.js';
import { appendMessages } from '../memory/conversations.js';

// Convierte una fecha ISO (yyyy-mm-dd) al formato argentino DD/MM/YYYY.
function formatFechaCorta(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Hora actual (0-23) en zona horaria Argentina (UTC-3).
function getHoraArgentina(): number {
  const horaStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return parseInt(horaStr, 10);
}

export interface CashbackAvisoJobResult {
  total: number;
  enviados: number;
  errores: Array<{ cashbackId: number; error: string }>;
  dryRun: boolean;
  skipped?: string;
}

export interface CashbackAvisoJobOptions {
  dryRun?: boolean;
  force?: boolean;
}

// Job de aviso de cashback: para cada inscripción cuya primera cuota vence dentro
// de los próximos `avisoDiasAntes` días, manda un recordatorio para que pague en
// tiempo y forma y no pierda el reintegro. Idempotente: al enviar marca el cashback
// como 'aviso_enviado', así no se reenvía.
export async function runCashbackAvisoJob(opts: CashbackAvisoJobOptions = {}): Promise<CashbackAvisoJobResult> {
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  // Misma defensa horaria que el job de bienvenida.
  if (!force) {
    const hora = getHoraArgentina();
    const { hourStart, hourEnd } = config.jobs;
    if (hora < hourStart || hora >= hourEnd) {
      return {
        total: 0,
        enviados: 0,
        errores: [],
        dryRun,
        skipped: `Fuera de horario (${hora}hs Argentina, ventana ${hourStart}-${hourEnd})`,
      };
    }
  }

  const pendientes = await listParaAviso(config.cashback.avisoDiasAntes);
  const result: CashbackAvisoJobResult = {
    total: pendientes.length,
    enviados: 0,
    errores: [],
    dryRun,
  };

  for (const cb of pendientes) {
    try {
      const texto = await armarMensaje(cb);

      if (dryRun) {
        console.log(`[dry-run cashback-aviso] → ${cb.telefono}: ${texto}`);
        result.enviados++;
        continue;
      }

      await sendWhatsAppMessage(cb.telefono, texto);

      // Guardamos el aviso en el historial para dar contexto al LLM cuando el
      // socio responda (mismo motivo que el welcome). Si falla el guardado el
      // mensaje ya salió, así que no abortamos.
      try {
        await appendMessages(cb.telefono, [
          { role: 'user', parts: [{ text: '[aviso automático: recordatorio de cashback 48hs antes del vencimiento]' }] },
          { role: 'model', parts: [{ text: texto }] },
        ]);
      } catch (err: any) {
        console.error(`Aviso enviado pero falló guardar historial para cashback ${cb.id}:`, err?.message ?? err);
      }

      await marcarAvisoEnviado(cb.id);
      result.enviados++;
    } catch (err: any) {
      result.errores.push({ cashbackId: cb.id, error: String(err?.message ?? err) });
    }
  }

  return result;
}

// Arma el texto del recordatorio. Personaliza con el primer nombre si lo
// encontramos por DNI; si no, cae a un saludo neutro.
async function armarMensaje(cb: CashbackRow): Promise<string> {
  let nombre = '';
  try {
    const cliente = await db.buscarClientePorDni(cb.dni);
    nombre = cliente?.primerNombre ?? '';
  } catch {
    // Si falla la consulta seguimos sin nombre — el aviso igual vale.
  }

  const saludo = nombre ? `¡Hola ${nombre}!` : '¡Hola!';
  const fecha = formatFechaCorta(cb.primer_vencimiento);
  const reintegro = cb.monto_cashback.toLocaleString('es-AR');

  return (
    `${saludo} Te recordamos que tu primera cuota vence el ${fecha}.\n\n` +
    `🎁 Si la pagás en tiempo y forma, te reintegramos $${reintegro} (tu cashback). ` +
    `El reintegro se hace 48hs después del pago.\n\n` +
    `Si necesitás los medios de pago o tenés cualquier duda, escribime. — Mutu, Mutual Protecap`
  );
}
