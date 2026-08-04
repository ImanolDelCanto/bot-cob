// Debounce + serialización de mensajes de WhatsApp por teléfono.
//
// Dos problemas que resuelve:
//
// 1) **Mensajes en pedazos.** La gente en WhatsApp manda los pensamientos
//    fraccionados ("como pago" + "no puedo pagar 1 millón" + "es imposible"
//    en 3 mensajes separados). Si respondemos uno por uno, el bot dispara
//    múltiples respuestas robóticas sin tomar en cuenta el contexto completo.
//    → Debounce: cuando llega un mensaje, esperamos `messageDebounceMs`. Si
//    llega otro del mismo teléfono en esa ventana, reseteamos el timer y lo
//    sumamos al buffer. Cuando hay silencio completo, procesamos todo junto.
//
// 2) **Mensajes que llegan mientras procesamos.** Si el cliente escribe
//    "msg1", el timer fires, arranca chat() (toma ~3-5s), y mientras tanto
//    el cliente escribe "msg2" y "msg3" — con el diseño viejo eso disparaba
//    un SEGUNDO chat() en paralelo que respondía sin saber de la primera
//    respuesta. Resultado: dos respuestas redundantes back-to-back.
//    → Serialización: mientras hay un chat() en vuelo para un teléfono, los
//    mensajes nuevos van a una cola "post-process". Cuando el chat() termina,
//    si hay cola, arranca un nuevo ciclo de debounce con ella. Las respuestas
//    quedan ordenadas y la segunda ve a la primera en el historial.
//
// Estado en memoria. Si el server reinicia se pierden los mensajes en vuelo —
// aceptable porque ya respondimos 200 al webhook de Meta. La idempotencia
// importante (sent_messages, comprobantes) está en Supabase.

import { config } from '../config.js';

interface State {
  buffer: string[];                  // mensajes esperando que dispare el debounce
  timer: NodeJS.Timeout | null;
  isProcessing: boolean;             // hay un handler() corriendo para este teléfono
  postProcessQueue: string[];        // mensajes que llegaron mientras procesábamos
  handler: Handler | null;           // último handler visto, para poder hacer flush al cerrar
}

const states = new Map<string, State>();

// Handlers en vuelo, para poder esperarlos en el apagado.
const enVuelo = new Set<Promise<void>>();

type Handler = (telefono: string, combinedText: string) => Promise<void>;

function getOrCreate(telefono: string): State {
  let s = states.get(telefono);
  if (!s) {
    s = { buffer: [], timer: null, isProcessing: false, postProcessQueue: [], handler: null };
    states.set(telefono, s);
  }
  return s;
}

/**
 * Encola un mensaje. El handler se dispara cuando termina la ventana de
 * silencio (`messageDebounceMs`). Si la ventana es 0, procesa al toque.
 */
export function enqueueMessage(telefono: string, text: string, handler: Handler): void {
  const debounceMs = config.messageDebounceMs;

  if (debounceMs <= 0) {
    // Sin debounce el handler queda suelto. Antes era `void handler(...)`: un
    // throw de Gemini o de Meta se volvía unhandled rejection y en Node 20+ eso
    // MATA el proceso — para todos los socios, no solo para este.
    const p = handler(telefono, text).catch((err: any) => {
      console.error(`Error procesando mensaje de ${telefono}:`, err?.message ?? err);
    });
    enVuelo.add(p);
    void p.finally(() => enVuelo.delete(p));
    return;
  }

  const s = getOrCreate(telefono);
  s.handler = handler;

  if (s.isProcessing) {
    // Ya hay un chat() corriendo para este teléfono. Acumulamos para procesar
    // después en un batch nuevo, así no se dispara una segunda respuesta
    // overlappeada.
    s.postProcessQueue.push(text);
    return;
  }

  // Modo normal: agregar al buffer y resetear el timer.
  s.buffer.push(text);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => fire(telefono, handler), debounceMs);
}

function fire(telefono: string, handler: Handler): void {
  const p = fireInterno(telefono, handler);
  enVuelo.add(p);
  void p.finally(() => enVuelo.delete(p));
}

async function fireInterno(telefono: string, handler: Handler): Promise<void> {
  const s = states.get(telefono);
  if (!s) return;

  if (s.buffer.length === 0) {
    s.timer = null;
    return;
  }

  const combined = s.buffer.join('\n').trim();
  if (s.buffer.length > 1) {
    console.log(`🧩 ${telefono}: agrupados ${s.buffer.length} mensajes en uno antes de procesar`);
  }

  s.buffer = [];
  s.timer = null;
  s.isProcessing = true;

  try {
    await handler(telefono, combined);
  } catch (err: any) {
    console.error(`Error procesando mensajes agrupados de ${telefono}:`, err?.message ?? err);
  } finally {
    s.isProcessing = false;

    // ¿Llegaron mensajes mientras procesábamos? Arrancamos un nuevo ciclo
    // de debounce con ellos. Si en esa ventana llegan más, se siguen
    // sumando como en el flujo normal.
    if (s.postProcessQueue.length > 0) {
      s.buffer.push(...s.postProcessQueue);
      s.postProcessQueue = [];
      const debounceMs = config.messageDebounceMs;
      s.timer = setTimeout(() => fire(telefono, handler), debounceMs);
    } else if (s.buffer.length === 0) {
      // Nada pendiente: liberamos el estado del Map.
      states.delete(telefono);
    }
  }
}

/**
 * Descarta cualquier mensaje pendiente para este teléfono (buffer + cola
 * post-process). Se usa cuando llega un mensaje no-texto (imagen, audio),
 * que tiene su propia respuesta automática y no debería mezclarse con la
 * respuesta del LLM.
 *
 * Si hay un handler() corriendo en este momento, NO lo cancela (su respuesta
 * va a salir). Solo limpia lo que viene después.
 */
export function dropBuffer(telefono: string): void {
  const s = states.get(telefono);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.buffer = [];
  s.timer = null;
  s.postProcessQueue = [];
  if (!s.isProcessing) {
    states.delete(telefono);
  }
}

/**
 * Apagado prolijo: dispara YA todos los debounces pendientes (sin esperar la
 * ventana de silencio) y espera a que terminen los handlers en vuelo.
 *
 * Sin esto, cada deploy de Railway se comía los mensajes que estaban en la
 * ventana de debounce: Meta ya recibió el 200, así que no reintenta, y el socio
 * se queda sin respuesta sin que nadie se entere.
 *
 * Devuelve cuántos teléfonos tenían algo pendiente.
 */
export async function flushAll(timeoutMs = 15_000): Promise<number> {
  let disparados = 0;

  for (const [telefono, s] of states) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    // Lo que quedó en la cola post-process también se procesa en esta tanda.
    if (s.postProcessQueue.length > 0 && !s.isProcessing) {
      s.buffer.push(...s.postProcessQueue);
      s.postProcessQueue = [];
    }
    if (s.buffer.length > 0 && !s.isProcessing && s.handler) {
      disparados++;
      fire(telefono, s.handler);
    }
  }

  // Esperamos lo que esté en vuelo, con techo: es preferible perder un mensaje
  // a que Railway nos mande SIGKILL a mitad de un envío.
  const limite = Date.now() + timeoutMs;
  while (enVuelo.size > 0 && Date.now() < limite) {
    await Promise.race([
      Promise.allSettled([...enVuelo]),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }

  if (enVuelo.size > 0) {
    console.warn(`⚠️  Quedaron ${enVuelo.size} conversaciones sin terminar al cerrar (timeout de ${timeoutMs}ms).`);
  }
  return disparados;
}

/** Cuántas conversaciones tienen algo pendiente. Para el /health y el cierre. */
export function pendientes(): number {
  let n = 0;
  for (const s of states.values()) {
    if (s.buffer.length > 0 || s.postProcessQueue.length > 0 || s.isProcessing) n++;
  }
  return n;
}
