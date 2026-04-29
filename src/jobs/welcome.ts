import { getCreditosLiquidados, buscarClientePorDni } from '../data/mockDb.js';
import { sendWhatsAppMessage } from '../whatsapp/webhook.js';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';

const TEMPLATE_NAME = 'bienvenida_credito';

// Convierte una fecha ISO (yyyy-mm-dd) al formato argentino DD/MM/YYYY.
function formatFechaCorta(iso: string): string {
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

// Job de bienvenida: para cada crédito recién liquidado, manda un mensaje al cliente
// confirmando la acreditación. Idempotente: usa la tabla sent_messages para no
// mandar dos veces el mismo template al mismo crédito.
export async function runWelcomeJob(opts: WelcomeJobOptions = {}): Promise<WelcomeJobResult> {
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  // Defensa en profundidad: aunque el cron dispare a una hora rara, no enviamos
  // mensajes fuera de la ventana configurada. force=true lo saltea para testing.
  if (!force) {
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
  }

  const creditos = getCreditosLiquidados();
  const result: WelcomeJobResult = {
    total: creditos.length,
    enviados: 0,
    saltados: 0,
    errores: [],
    dryRun,
  };

  for (const credito of creditos) {
    const cliente = buscarClientePorDni(credito.dni);
    if (!cliente) {
      result.errores.push({ creditoId: credito.id, error: 'Cliente no encontrado' });
      continue;
    }

    // ¿Ya mandamos este template para este crédito? Si sí, saltamos.
    const { data: yaEnviado, error: queryErr } = await supabase
      .from('sent_messages')
      .select('id')
      .eq('template_name', TEMPLATE_NAME)
      .eq('external_id', credito.id)
      .maybeSingle();

    if (queryErr) {
      result.errores.push({ creditoId: credito.id, error: `Error chequeando idempotencia: ${queryErr.message}` });
      continue;
    }

    if (yaEnviado) {
      result.saltados++;
      continue;
    }

    const primerNombre = cliente.nombre.split(' ')[0];
    const monto = credito.monto.toLocaleString('es-AR');
    const fechaVenc = formatFechaCorta(credito.proximoVencimiento);
    const texto =
      `¡Hola ${primerNombre}! Tu crédito ya está acreditado.\n\n` +
      `📋 Resumen\n` +
      `• Monto: $${monto}\n` +
      `• Cuotas: ${credito.cuotas}\n` +
      `• Primer vencimiento: ${fechaVenc}\n\n` +
      `Para ver medios de pago o consultar saldo, respondé "MEDIOS" o "SALDO".\n` +
      `Si necesitás otra cosa, escribime y te ayudo. — Mutu, Mutual Protecap`;

    if (dryRun) {
      console.log(`[dry-run] → ${cliente.telefono}: ${texto}`);
      result.enviados++;
      continue;
    }

    try {
      await sendWhatsAppMessage(cliente.telefono, texto);

      const { error: insertErr } = await supabase.from('sent_messages').insert({
        telefono: cliente.telefono,
        template_name: TEMPLATE_NAME,
        external_id: credito.id,
      });
      if (insertErr) {
        // Si llegamos acá el mensaje ya se mandó pero no pudimos registrar idempotencia.
        // Logueamos pero no lo contamos como error de envío.
        console.error(`Mensaje enviado pero falló registro en sent_messages para ${credito.id}:`, insertErr.message);
      }

      result.enviados++;
    } catch (err: any) {
      result.errores.push({ creditoId: credito.id, error: String(err?.message ?? err) });
    }
  }

  return result;
}
