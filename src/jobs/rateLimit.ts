// Control de volumen para los jobs proactivos (welcome, cashback-aviso, vencimiento-aviso).
//
// Por qué existe: Meta limita cuántos socios DISTINTOS puede contactar el negocio
// por iniciativa propia cada 24hs (tier de mensajería: 250 → 1.000 → 10.000 →
// 100.000 → ilimitado). Un número recién habilitado arranca en 250. Pasarse hace
// que la API rechace y, peor, baja la calidad del número.
//
// El aviso de vencimiento llegó a encontrar 1368 candidatos en una sola corrida.
// Sin tope, eso son 1368 intentos seguidos: los primeros entran y el resto rebota.
//
// Dos controles:
//   1. Tope de envíos por corrida (config.jobs.maxEnviosPorCorrida).
//   2. Pausa entre envíos consecutivos (config.jobs.delayEntreEnviosMs).
//
// Lo que queda fuera del cupo NO se descarta en silencio: se cuenta en
// `omitidosPorCupo` y el job lo loguea. En welcome y vencimiento-aviso la
// idempotencia por `sent_messages` hace que la corrida siguiente retome donde
// quedó sin remandar lo ya enviado.

import { config } from '../config.js';

export interface Limiter {
  /** ¿Queda cupo para un envío más en esta corrida? */
  hayCupo(): boolean;
  /**
   * Reserva un envío del cupo y espera la pausa configurada.
   * Llamar SIEMPRE justo antes de mandar. Consume cupo aunque el envío falle:
   * ante la duda preferimos quedarnos cortos y no arriesgar el tier.
   */
  consumir(): Promise<void>;
  /** Envíos ya reservados en esta corrida. */
  readonly usados: number;
  readonly max: number;
}

export function crearLimiter(): Limiter {
  const max = Math.max(0, Math.floor(config.jobs.maxEnviosPorCorrida));
  const delayMs = Math.max(0, config.jobs.delayEntreEnviosMs);
  let usados = 0;
  let primero = true;

  return {
    hayCupo: () => usados < max,
    async consumir() {
      usados++;
      // La pausa va ENTRE envíos, no antes del primero.
      if (primero) {
        primero = false;
        return;
      }
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    },
    get usados() {
      return usados;
    },
    max,
  };
}

/**
 * Línea de log estándar para avisar que una corrida se quedó sin cupo.
 * Nunca truncamos en silencio: si quedó gente sin avisar, tiene que verse.
 */
export function logCupoAgotado(job: string, omitidos: number, limiter: Limiter): void {
  if (omitidos <= 0) return;
  console.warn(
    `⚠️  [${job}] cupo por corrida agotado (${limiter.usados}/${limiter.max}). ` +
    `${omitidos} destinatario(s) quedaron SIN enviar y se reintentan en la próxima corrida. ` +
    `Subí JOBS_MAX_ENVIOS_POR_CORRIDA solo si tu tier de Meta lo banca.`,
  );
}
