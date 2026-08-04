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
    const wamid = await sendWhatsAppMessage(telefono, texto);
    // Guardamos el wamid para poder correlacionar después los eventos de estado
    // que Meta manda por el webhook (delivered / read / failed).
    if (wamid) {
      const { error } = await supabase
        .from('sent_messages')
        .update({ wamid, actualizado_at: new Date().toISOString() })
        .eq('template_name', templateName)
        .eq('external_id', externalId);
      if (error) {
        console.error(`⚠️  No pude guardar el wamid de ${templateName}/${externalId}: ${error.message}`);
      }
    }
    return { resultado: 'enviado' };
  } catch (err: any) {
    const clase = claseDeError(err);

    if (clase === 'destinatario') {
      // El número no puede recibir (no está en WhatsApp, formato inválido...).
      // Dejamos la marca puesta a propósito: reintentar no cambia nada y solo
      // gasta cupo que le sirve a otro socio. Pero la marcamos como FALLIDA,
      // para que se pueda ver quién quedó sin recibir en vez de que figure
      // como enviada igual que las que sí llegaron.
      await marcarFallido(templateName, externalId, err);
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

/**
 * Marca una reserva como fallida, conservando el código de error de Meta.
 * La fila queda (no se reintenta) pero visible en /admin/envios/fallidos.
 */
async function marcarFallido(templateName: string, externalId: string, err: any): Promise<void> {
  const codigo = err instanceof WhatsAppApiError ? err.codigo ?? null : null;
  const { error } = await supabase
    .from('sent_messages')
    .update({
      estado: 'fallido',
      error_codigo: codigo,
      error_detalle: String(err?.message ?? err).slice(0, 500),
      actualizado_at: new Date().toISOString(),
    })
    .eq('template_name', templateName)
    .eq('external_id', externalId);
  if (error) {
    console.error(`⚠️  No pude marcar como fallido ${templateName}/${externalId}: ${error.message}`);
  }
}

/**
 * Aplica un evento de estado que llegó por el webhook de Meta.
 * Meta reporta buena parte de los fallos de entrega acá, NO en la respuesta del
 * POST de envío: un mensaje puede ser aceptado por la API y fallar después.
 */
export async function aplicarEstadoEntrega(
  wamid: string,
  estado: 'entregado' | 'leido' | 'fallido',
  errorCodigo?: number,
  errorDetalle?: string,
): Promise<void> {
  const patch: Record<string, unknown> = {
    estado,
    actualizado_at: new Date().toISOString(),
  };
  if (errorCodigo !== undefined) patch.error_codigo = errorCodigo;
  if (errorDetalle !== undefined) patch.error_detalle = errorDetalle.slice(0, 500);

  const { error } = await supabase.from('sent_messages').update(patch).eq('wamid', wamid);
  if (error) {
    console.error(`⚠️  No pude aplicar el estado "${estado}" al wamid ${wamid}: ${error.message}`);
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
