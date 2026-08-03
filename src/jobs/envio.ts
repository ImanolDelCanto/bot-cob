// Envío de mensajes proactivos con idempotencia e interpretación de errores.
//
// Reemplaza el patrón anterior (mandar y DESPUÉS marcar en sent_messages), que
// tenía dos agujeros observados en producción:
//
//   1. Si el INSERT fallaba, el mensaje ya había salido pero no quedaba marca:
//      la corrida siguiente lo volvía a mandar. Duplicado real al socio.
//   2. Si el ENVÍO fallaba, tampoco quedaba marca, así que se reintentaba cada
//      2hs indefinidamente aunque el error no fuera a resolverse solo.
//
// Ahora se reserva primero y se libera la reserva solo si el fallo es
// reintentable. La reserva funciona además como lock entre corridas solapadas,
// SIEMPRE Y CUANDO exista un índice único sobre (template_name, external_id)
// en la tabla `sent_messages`. Si no existe, hay que crearlo:
//
//   create unique index if not exists sent_messages_template_external_uidx
//     on sent_messages (template_name, external_id);

import { supabase } from '../db/supabase.js';
import { sendWhatsAppMessage } from '../whatsapp/webhook.js';
import { WhatsAppApiError, claseDeError } from '../whatsapp/errores.js';

// Código de Postgres para violación de índice único.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Error de cuenta: le va a fallar a TODOS los destinatarios (número en modo
 * prueba, token vencido, falta plantilla). Los jobs lo dejan propagar para
 * cortar la corrida en vez de repetir el mismo fallo N veces.
 */
export class AbortarCorrida extends Error {
  constructor(readonly causa: WhatsAppApiError) {
    super(
      `Error de cuenta de WhatsApp (#${causa.codigo ?? '?'}): le va a fallar a todos los ` +
      `destinatarios, corto la corrida. Detalle: ${causa.message}`,
    );
    this.name = 'AbortarCorrida';
  }
}

export type ResultadoEnvio =
  | 'enviado'
  /** Ya había una marca para ese external_id: otra corrida lo mandó. */
  | 'duplicado'
  /** Falló por algo propio del destinatario. La marca queda: no se reintenta. */
  | 'fallo_destinatario'
  /** Falló por algo pasajero. Se liberó la marca: se reintenta en la próxima. */
  | 'fallo_transitorio';

export interface EnvioIdempotente {
  telefono: string;
  texto: string;
  templateName: string;
  externalId: string;
}

export async function enviarConIdempotencia(
  envio: EnvioIdempotente,
): Promise<{ resultado: ResultadoEnvio; error?: string }> {
  const { telefono, texto, templateName, externalId } = envio;

  // 1. Reservar ANTES de mandar. Si ya existe, otro lo tomó.
  const { error: reservaErr } = await supabase.from('sent_messages').insert({
    telefono,
    template_name: templateName,
    external_id: externalId,
  });

  if (reservaErr) {
    if (reservaErr.code === PG_UNIQUE_VIOLATION) {
      return { resultado: 'duplicado' };
    }
    // No pudimos reservar por otra razón: mejor no mandar, porque si mandamos
    // sin marca volvemos exactamente al bug que estamos arreglando.
    return { resultado: 'fallo_transitorio', error: `No pude reservar el envío: ${reservaErr.message}` };
  }

  // 2. Mandar.
  try {
    await sendWhatsAppMessage(telefono, texto);
    return { resultado: 'enviado' };
  } catch (err: any) {
    const clase = claseDeError(err);

    if (clase === 'destinatario') {
      // El número no puede recibir (no está en WhatsApp, formato inválido...).
      // Dejamos la marca puesta a propósito: reintentar no cambia nada y solo
      // gasta cupo que le sirve a otro socio.
      return { resultado: 'fallo_destinatario', error: String(err?.message ?? err) };
    }

    // Transitorio o de cuenta: liberamos la reserva para que se reintente.
    await liberarReserva(templateName, externalId);

    if (clase === 'cuenta' && err instanceof WhatsAppApiError) {
      throw new AbortarCorrida(err);
    }
    return { resultado: 'fallo_transitorio', error: String(err?.message ?? err) };
  }
}

async function liberarReserva(templateName: string, externalId: string): Promise<void> {
  const { error } = await supabase
    .from('sent_messages')
    .delete()
    .eq('template_name', templateName)
    .eq('external_id', externalId);
  if (error) {
    // Si no pudimos liberar, el socio queda marcado como enviado sin haberlo
    // recibido. Es preferible a mandarle dos veces, pero hay que poder verlo.
    console.error(
      `⚠️  No pude liberar la reserva de ${templateName}/${externalId}: ${error.message}. ` +
      `Ese destinatario NO va a reintentarse.`,
    );
  }
}
