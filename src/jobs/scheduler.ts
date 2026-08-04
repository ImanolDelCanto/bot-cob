// Scheduler en proceso para los jobs proactivos (welcome, cashback-aviso).
// No usa cron externo: mientras el server esté arriba, dispara cada job en su
// intervalo. Los jobs son idempotentes y tienen guarda horaria adentro, así que
// correrlos de más es inofensivo (no duplican mensajes ni mandan fuera de hora).
//
// Se arranca desde index.ts solo si config.jobs.schedulerEnabled && WhatsApp configurado.

import { config } from '../config.js';
import { runWelcomeJob } from './welcome.js';
import { runCashbackAvisoJob } from './cashbackAviso.js';
import { runVencimientoAvisoJob } from './vencimientoAviso.js';
import { estaCerrando } from '../util/shutdown.js';

const HORA_MS = 3_600_000;

// Demora antes de la primera corrida, para no pegarle a la fuente de datos
// en el mismo instante del arranque (que ya dispara el warm-up del snapshot).
const ARRANQUE_MS = 30_000;

// Handles de los timers, para poder frenarlos en el apagado.
const timers: Array<NodeJS.Timeout> = [];

// Guarda de reentrancia: si una corrida tarda más que su intervalo (el job de
// vencimiento recorre >50k operaciones y manda de a uno), el setInterval
// dispararía una segunda corrida encima de la primera, con las dos compitiendo
// por el mismo cupo y el mismo snapshot.
const corriendo = new Set<string>();

function programar(nombre: string, cadaHoras: number, fn: () => Promise<unknown>): void {
  const tick = async () => {
    if (estaCerrando()) return;
    if (corriendo.has(nombre)) {
      console.warn(`[scheduler ${nombre}] la corrida anterior sigue activa, salteo este tick.`);
      return;
    }
    corriendo.add(nombre);
    try {
      const r = await fn();
      console.log(`[scheduler ${nombre}] ${JSON.stringify(r)}`);
    } catch (err: any) {
      console.error(`[scheduler ${nombre}] error: ${err?.message ?? err}`);
    } finally {
      corriendo.delete(nombre);
    }
  };
  timers.push(setTimeout(tick, ARRANQUE_MS));
  timers.push(setInterval(tick, Math.max(1, cadaHoras) * HORA_MS));
}

/** Frena los timers. Las corridas ya en curso cortan solas por `estaCerrando()`. */
export function stopScheduler(): void {
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.length = 0;
}

/** Nombres de los jobs con una corrida activa. Para el cierre y el /health. */
export function jobsEnCurso(): string[] {
  return [...corriendo];
}

export function startScheduler(): void {
  console.log(
    `⏰ Scheduler activo: welcome cada ${config.jobs.welcomeEveryHours}h, ` +
    `cashback-aviso cada ${config.jobs.cashbackAvisoEveryHours}h, ` +
    `vencimiento-aviso cada ${config.jobs.vencimientoAvisoEveryHours}h ` +
    `(ventana ${config.jobs.hourStart}-${config.jobs.hourEnd}hs).`
  );
  programar('welcome', config.jobs.welcomeEveryHours, () => runWelcomeJob());
  programar('cashback-aviso', config.jobs.cashbackAvisoEveryHours, () => runCashbackAvisoJob());
  programar('vencimiento-aviso', config.jobs.vencimientoAvisoEveryHours, () => runVencimientoAvisoJob());
}
