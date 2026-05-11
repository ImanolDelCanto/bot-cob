import { Router, type Request, type Response } from 'express';
import { config, isWhatsAppConfigured } from '../config.js';
import { chat } from '../llm/agent.js';
import { appendMessages } from '../memory/conversations.js';
import { downloadMediaFromMeta } from './media.js';
import { saveComprobante } from '../storage/comprobantes.js';
import { enqueueMessage, dropBuffer } from './messageBuffer.js';

const HUMANO = '+54 9 11 2621-4000';
const HORARIO = 'Lun a Vie de 9 a 17hs';

// Mensajes para casos donde NO podemos procesar el archivo (audios u otros tipos).
function respuestaNoProcesable(tipo: string): string {
  if (tipo === 'audio' || tipo === 'voice') {
    return (
      `Recibí tu audio. Por ahora solo puedo leer mensajes de texto. ` +
      `¿Podés escribirme tu consulta? Si preferís hablar con un asesor: ${HUMANO} (${HORARIO}).`
    );
  }
  return (
    `Recibí tu mensaje pero solo puedo procesar texto por acá. ` +
    `Si tenés una consulta, escribime y te ayudo. Para hablar con un asesor: ${HUMANO} (${HORARIO}).`
  );
}

// Mensaje cuando GUARDAMOS bien el comprobante (imagen o PDF).
// Aclaramos que el comprobante por acá queda registrado solo internamente,
// y que para que el pago se registre en el sistema tiene que mandarlo también
// al asesor humano. La copia que guardamos sirve de auditoría: si el asesor
// no lo carga, podemos detectarlo.
function respuestaComprobanteGuardado(): string {
  return (
    `Recibí tu comprobante 🙌. Para que tu pago quede registrado en el sistema, ` +
    `te pido que también se lo envíes a nuestro asesor por WhatsApp: ${HUMANO} (${HORARIO}). ` +
    `Tu pago queda sujeto a verificación interna por nuestro equipo.`
  );
}

// Mensaje cuando el archivo es un comprobante pero no pudimos guardarlo.
// Caemos al flujo manual (que el cliente lo mande al humano).
function respuestaComprobanteFallback(): string {
  return (
    `Recibí tu archivo pero tuve un problema al guardarlo de mi lado. ` +
    `Mandalo por favor al WhatsApp de nuestro asesor para que lo registre: ${HUMANO} (${HORARIO}).`
  );
}

const router = Router();

// GET /whatsapp/webhook → verificación inicial de Meta.
// Cuando configurás el webhook en el panel de Meta, Meta hace un GET con
// hub.mode=subscribe, hub.verify_token=<el que vos pusiste>, hub.challenge=<random>.
// Tenemos que devolver el challenge tal cual si el token coincide.
router.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken && config.whatsapp.verifyToken) {
    console.log('✅ Webhook de WhatsApp verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Verificación de webhook fallida (token incorrecto o no configurado)');
  return res.sendStatus(403);
});

// POST /whatsapp/webhook → mensajes entrantes y eventos de status.
// Meta espera respuesta 200 rápida; si tardás, reintenta y duplica mensajes.
// Por eso respondemos primero y procesamos después.
router.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);

  if (!isWhatsAppConfigured()) {
    console.warn('Llegó webhook pero WhatsApp no está configurado en .env');
    return;
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Si no hay mensaje (puede ser un evento de status: delivered/read/etc.) lo ignoramos
    if (!message) return;

    const from: string = message.from;
    const text: string | undefined = message.text?.body;
    const tipo: string = message.type ?? 'unknown';

    // === Mensaje no-texto (imagen, audio, PDF, etc.) — NO llamamos al LLM ===
    if (!text) {
      // Si había mensajes de texto en cola, los descartamos: el flujo de
      // imagen/audio tiene su propia respuesta automática y mezclarla con
      // una respuesta del LLM sería confuso para el cliente.
      dropBuffer(from);
      // Imagen o documento → tratamos como posible comprobante: descargamos de Meta,
      // subimos a Supabase Storage y registramos en la tabla `comprobantes`.
      if (tipo === 'image' || tipo === 'document') {
        const mediaId: string | undefined =
          message.image?.id ?? message.document?.id;
        console.log(`📩 ${from}: [${tipo}] mediaId=${mediaId}`);

        let respuesta = respuestaComprobanteFallback();
        let notaHistorial = `[el cliente envió un ${tipo} pero no se pudo guardar]`;

        if (mediaId) {
          try {
            const media = await downloadMediaFromMeta(mediaId);
            const persistido = await saveComprobante({
              telefono: from,
              buffer: media.buffer,
              mimeType: media.mimeType,
            });
            console.log(`💾 Comprobante guardado: id=${persistido.id} path=${persistido.archivoPath} (${media.size} bytes)`);
            respuesta = respuestaComprobanteGuardado();
            notaHistorial = `[el cliente envió un comprobante (${tipo}, id=${persistido.id}) — guardado en Supabase, pendiente de procesar por humano]`;
          } catch (err: any) {
            console.error('Error guardando comprobante:', err?.message ?? err);
            // respuesta queda en fallback, notaHistorial también
          }
        }

        try {
          await appendMessages(from, [
            { role: 'user', parts: [{ text: notaHistorial }] },
            { role: 'model', parts: [{ text: respuesta }] },
          ]);
        } catch (err: any) {
          console.error('No pude guardar la nota en historial:', err?.message ?? err);
        }

        console.log(`📤 → ${from}: ${respuesta}`);
        await sendWhatsAppMessage(from, respuesta);
        return;
      }

      // Cualquier otro tipo no-texto (audio, voice, video, sticker, etc.) → respuesta fija sin guardar archivo.
      console.log(`📩 ${from}: [${tipo}] (no-procesable, respuesta automática)`);
      const respuesta = respuestaNoProcesable(tipo);

      try {
        await appendMessages(from, [
          { role: 'user', parts: [{ text: `[el cliente envió un ${tipo}, no procesado por el bot]` }] },
          { role: 'model', parts: [{ text: respuesta }] },
        ]);
      } catch (err: any) {
        console.error('No pude guardar la nota en historial:', err?.message ?? err);
      }

      console.log(`📤 → ${from}: ${respuesta}`);
      await sendWhatsAppMessage(from, respuesta);
      return;
    }

    console.log(`📩 ${from}: ${text}`);
    // Encolamos el mensaje. Si el cliente manda más mensajes en los próximos
    // `messageDebounceMs` ms, se agrupan y se procesan como una sola turno.
    enqueueMessage(from, text, async (telefono, combinedText) => {
      const respuesta = await chat(telefono, combinedText);
      console.log(`📤 → ${telefono}: ${respuesta}`);
      await sendWhatsAppMessage(telefono, respuesta);
    });
  } catch (err) {
    console.error('Error procesando webhook de WhatsApp:', err);
  }
});

// Argentina mete un "9" entre código de país (54) y código de área para celulares.
// El webhook nos llega con el 9 (5491126763301) pero la API de Meta espera el formato
// sin el 9 (541126763301) cuando el número está cargado así en la lista de autorizados.
// La normalización se aplica adentro de sendWhatsAppMessage para que cualquier caller
// (webhook, jobs proactivos) funcione sin tener que acordarse.
function normalizeArgentineMobile(phone: string): string {
  if (phone.startsWith('549') && phone.length === 13) {
    return '54' + phone.slice(3);
  }
  return phone;
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const { phoneNumberId, accessToken, apiVersion } = config.whatsapp;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const destinatario = normalizeArgentineMobile(to);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destinatario,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
}

export default router;
