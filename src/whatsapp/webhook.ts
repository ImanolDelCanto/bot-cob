import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isWhatsAppConfigured } from '../config.js';
import { chat } from '../llm/agent.js';
import { appendMessages } from '../memory/conversations.js';
import { downloadMediaFromMeta } from './media.js';
import { saveComprobante } from '../storage/comprobantes.js';
import { enqueueMessage, dropBuffer } from './messageBuffer.js';
import { WhatsAppApiError } from './errores.js';

// Verifica el header X-Hub-Signature-256 que Meta envía con cada webhook.
// El valor es "sha256=<hex>" donde el HMAC se computa sobre el body crudo
// usando el App Secret. Sin esto, cualquiera con la URL pública podría
// fabricar mensajes falsos y hacer que el bot procese/responda.
function verifyMetaSignature(rawBody: Buffer | undefined, sigHeader: string | undefined, appSecret: string): boolean {
  if (!rawBody || !sigHeader || !appSecret) return false;
  const [algo, sig] = sigHeader.split('=');
  if (algo !== 'sha256' || !sig) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Solo logueamos el warning una vez por proceso para no inundar los logs
// si Meta hace miles de POSTs sin App Secret configurado.
let warnedAboutMissingAppSecret = false;

const HUMANO = '+54 9 11 2621-4000';
const HORARIO = 'Lun a Vie de 9 a 17hs';

// Detecta si el mensaje del cliente es un cierre puro: "gracias" / variantes
// o solo emojis. En esos casos respondemos 👍 sin consultar al LLM para no
// reabrir la conversación con un párrafo cuando el cliente ya se estaba
// despidiendo. Saltea el costo y latencia de una llamada a Gemini.
//
// Conservador a propósito: solo matchea cierres muy claros. Si el cliente
// dice "ok, una cosa más", "perfecto, ¿y los intereses?", etc., NO matchea
// y cae al flujo normal del LLM.
const GRACIAS_REGEX = /^[\s¡!.,;]*(?:muchas\s+|mil\s+)?(?:gracias|graciass+|graci+as|thanks?|thx|grax)[\s.,;!¡?¿]*$/iu;
// Sin letras ni números — solo puntuación, símbolos y/o emojis.
const NO_LETTERS_REGEX = /^[^\p{L}\p{N}]+$/u;
// Tiene que haber al menos un emoji real (no basta puntuación tipo "..." o "??").
const HAS_EMOJI_REGEX = /\p{Extended_Pictographic}/u;

export function isTerminalCloser(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Mensajes largos no son cierre. 40 chars cubre "muchísimas gracias!!!" tranquilo.
  if (trimmed.length > 40) return false;
  if (GRACIAS_REGEX.test(trimmed)) return true;
  // Solo símbolos + al menos un emoji = cierre. Un "??" solo NO cierra (cliente confundido).
  if (NO_LETTERS_REGEX.test(trimmed) && HAS_EMOJI_REGEX.test(trimmed)) return true;
  return false;
}

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
// Por eso verificamos firma rápido y respondemos 200, después procesamos.
router.post('/webhook', async (req: Request, res: Response) => {
  // Verificación de firma HMAC-SHA256 contra el App Secret. Si está configurado
  // y la firma no coincide → 401 (Meta loguea como entrega fallida y nosotros
  // no procesamos un payload potencialmente falso).
  if (config.whatsapp.appSecret) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const sigHeader = req.header('x-hub-signature-256') ?? undefined;
    if (!verifyMetaSignature(rawBody, sigHeader, config.whatsapp.appSecret)) {
      console.warn('❌ Webhook con firma inválida — rechazado');
      return res.sendStatus(401);
    }
  } else if (!warnedAboutMissingAppSecret) {
    console.warn(
      '⚠️  Webhook recibido SIN verificación de firma (WHATSAPP_APP_SECRET vacío). ' +
      'Inseguro para producción — cualquiera con la URL pública puede fabricar mensajes.'
    );
    warnedAboutMissingAppSecret = true;
  }

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
      // Short-circuit: si el cliente solo está cerrando ("gracias" o un
      // emoji), respondemos 👍 sin gastar una llamada al LLM. Esto cierra
      // la conversación con calidez sin que el bot vuelva a tirar opciones.
      if (isTerminalCloser(combinedText)) {
        const respuesta = '👍';
        console.log(`📤 → ${telefono}: [closer] ${respuesta}`);
        await appendMessages(telefono, [
          { role: 'user', parts: [{ text: combinedText }] },
          { role: 'model', parts: [{ text: respuesta }] },
        ]);
        await sendWhatsAppMessage(telefono, respuesta);
        return;
      }

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

// Limpia el texto antes de mandarlo a WhatsApp.
// El LLM tiende a tirar sintaxis Markdown (**negrita**, URLs envueltas en
// asteriscos) por inercia, y por el prompt no se le va del todo. WhatsApp NO
// renderiza Markdown — usa *negrita*, _cursiva_, ~tachado~. Lo de **X** queda
// con los asteriscos visibles y se ve roto.
//
// Reglas:
// 1) URLs no llevan NUNCA asteriscos alrededor. Los strippeamos.
// 2) Cualquier corrida de 2+ asteriscos se colapsa a uno solo (Markdown bold
//    → WhatsApp bold). También cubre *** ó **** que algunos modelos meten.
export function sanitizeForWhatsApp(text: string): string {
  let out = text;
  // 1) URLs envueltas en *, **, *** → URL pelada.
  //    \S+? para que pare antes del asterisco de cierre, y un lookahead que
  //    excluye puntuación final si quedara fuera del wrap.
  out = out.replace(/\*+(https?:\/\/\S+?)\*+/g, '$1');
  // 2) Colapsar corridas de 2+ asteriscos a uno solo.
  out = out.replace(/\*{2,}/g, '*');
  return out;
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const { phoneNumberId, accessToken, apiVersion } = config.whatsapp;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const destinatario = normalizeArgentineMobile(to);
  const cuerpo = sanitizeForWhatsApp(text);

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
      text: { body: cuerpo },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Error tipado: los jobs necesitan distinguir "le falla a este socio" de
    // "le va a fallar a todos" para no hacer 1000 llamadas inútiles seguidas.
    throw new WhatsAppApiError(res.status, body);
  }
}

export default router;
