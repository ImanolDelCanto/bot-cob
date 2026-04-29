import { Router, type Request, type Response } from 'express';
import { config, isWhatsAppConfigured } from '../config.js';
import { chat } from '../llm/agent.js';

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

    if (!text) {
      console.log(`📩 Mensaje no-texto de ${from} (tipo: ${message.type}), ignorando`);
      return;
    }

    console.log(`📩 ${from}: ${text}`);
    const respuesta = await chat(from, text);
    console.log(`📤 → ${from}: ${respuesta}`);

    await sendWhatsAppMessage(from, respuesta);
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
