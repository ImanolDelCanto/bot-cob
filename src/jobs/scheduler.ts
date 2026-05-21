// Scheduler en proceso para los jobs proactivos (welcome, cashback-aviso).
// No usa cron externo: mientras el server esté arriba, dispara cada job en su
// intervalo. Los jobs son idempotentes y tienen guarda horaria adentro, así que
// correrlos de más es inofensivo (no duplican mensajes ni mandan fuera de hora).
//
// Se arranca desde index.ts solo si config.jobs.schedulerEnabled && WhatsApp configurado.

import { config } from '../config.js';
import { runWelcomeJob } from './welcome.js';
import { runCashbackAvisoJob } from './cashbackAviso.js';

const HORA_MS = 3_600_000;

// Demora antes de la primera corrida, para no pegarle a la fuente de datos
// en el mismo instante del arranque (que ya dispara el warm-up del snapshot).
const ARRANQUE_MS = 30_000;

function programar(nombre: string, cadaHoras: number, fn: () => Promise<unknown>): void {
  const tick = async () => {
    try {
      const r = await fn();
      console.log(`[scheduler ${nombre}] ${JSON.stringify(r)}`);
    } catch (err: any) {
      console.error(`[scheduler ${nombre}] error: ${err?.message ?? err}`);
    }
  };
  setTimeout(tick, ARRANQUE_MS);
  setInterval(tick, Math.max(1, cadaHoras) * HORA_MS);
}

export function startScheduler(): void {
  console.log(
    `⏰ Scheduler activo: welcome cada ${config.jobs.welcomeEveryHours}h, ` +
    `cashback-aviso cada ${config.jobs.cashbackAvisoEveryHours}h ` +
    `(ventana ${config.jobs.hourStart}-${config.jobs.hourEnd}hs).`
  );
  programar('welcome', config.jobs.welcomeEveryHours, () => runWelcomeJob());
  programar('cashback-aviso', config.jobs.cashbackAvisoEveryHours, () => runCashbackAvisoJob());
}
