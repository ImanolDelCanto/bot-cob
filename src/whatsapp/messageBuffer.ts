// Debounce / agrupado de mensajes de WhatsApp por teléfono.
//
// Problema: la gente en WhatsApp manda los pensamientos en pedazos
// ("a ver pasame las opciones" + "porque no puedo pagar" en 2 mensajes
// separados con segundos de diferencia). Si respondemos uno por uno,
// el bot dispara dos respuestas separadas que se sienten robóticas y
// no toman en cuenta el contexto completo.
//
// Solución: cuando llega un mensaje, no lo procesamos al toque. Esperamos
// `messageDebounceMs` para ver si vienen más. Si en esa ventana llega otro
// mensaje del mismo teléfono, lo agregamos al buffer y reseteamos el timer.
// Cuando hay silencio por la ventana completa, juntamos todos los mensajes
// con saltos de línea y procesamos una sola vez.
//
// El estado vive en memoria (Map). Si el server se reinicia se pierden los
// mensajes en vuelo — aceptable porque ya respondimos 200 al webhook de Meta
// y la pérdida es rara. La idempotencia importante (sent_messages,
// comprobantes) está en Supabase.

import { config } from '../config.js';

interface Buffer {
  messages: string[];
  timer: NodeJS.Timeout;
}

const buffers = new Map<string, Buffer>();

type Handler = (telefono: string, combinedText: string) => Promise<void>;

/**
 * Encola un mensaje y dispara el handler cuando termina la ventana de silencio.
 * Si la ventana es 0 (config), procesa inmediatamente.
 */
export function enqueueMessage(telefono: string, text: string, handler: Handler): void {
  const debounceMs = config.messageDebounceMs;

  if (debounceMs <= 0) {
    // Debounce desactivado: procesar al toque.
    void handler(telefono, text);
    return;
  }

  let buf = buffers.get(telefono);
  if (buf) {
    clearTimeout(buf.timer);
    buf.messages.push(text);
  } else {
    buf = { messages: [text], timer: null as any };
    buffers.set(telefono, buf);
  }

  buf.timer = setTimeout(() => {
    const current = buffers.get(telefono);
    if (!current) return;
    const combined = current.messages.join('\n').trim();
    // Vaciamos ANTES de procesar — si llega un mensaje nuevo mientras el
    // handler corre, arranca un buffer fresco con su propio timer.
    buffers.delete(telefono);
    if (current.messages.length > 1) {
      console.log(
        `🧩 ${telefono}: agrupados ${current.messages.length} mensajes en uno antes de procesar`
      );
    }
    handler(telefono, combined).catch(err => {
      console.error(`Error procesando mensajes agrupados de ${telefono}:`, err);
    });
  }, debounceMs);
}

/**
 * Si el cliente manda un mensaje no-texto (imagen, audio) mientras hay texto
 * en el buffer, conviene descartar el buffer porque el flujo de no-texto
 * tiene su propia respuesta automática. El buffer se descarta sin procesar.
 */
export function dropBuffer(telefono: string): void {
  const buf = buffers.get(telefono);
  if (!buf) return;
  clearTimeout(buf.timer);
  buffers.delete(telefono);
}
