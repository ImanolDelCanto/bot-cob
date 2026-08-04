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
// Tres controles:
//   1. Tope de envíos por corrida (config.jobs.maxEnviosPorCorrida).
//   2. Pausa entre envíos consecutivos (config.jobs.delayEntreEnviosMs).
//   3. Tope de envíos en las últimas 24hs (config.jobs.maxEnvios24h), COMPARTIDO
//      entre los tres jobs y contado contra `sent_messages`.
//
// El (3) es el que realmente acota el tier de Meta. El tope por corrida NO
// alcanza: se crea un limiter NUEVO en cada corrida, así que con welcome cada
// 2hs (5-6 corridas dentro de la ventana 10-21) más cashback y vencimiento cada
// 6hs, el techo real era ~600 socios/día contra un tier de 250. Cada POST manual
// a /admin/jobs/* sumaba su propio cupo por encima.
//
// Contarlo contra `sent_messages` en vez de en memoria hace que sobreviva a los
// reinicios (Railway redeploya seguido) y que los disparos manuales cuenten.
//
// Lo que queda fuera del cupo NO se descarta en silencio: se cuenta en
// `omitidosPorCupo` y el job lo loguea. En welcome y vencimiento-aviso la
// idempotencia por `sent_messages` hace que la corrida siguiente retome donde
// quedó sin remandar lo ya enviado.

import { config } from '../config.js';
import { supabase } from '../db/supabase.js';

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
  /** Envíos que ya había en las últimas 24hs cuando arrancó la corrida. */
  readonly previos24h: number;
}

/**
 * Cuántos mensajes proactivos salieron en las últimas 24hs, según `sent_messages`.
 * Si la consulta falla devolvemos el tope: preferimos frenar una corrida a
 * quemar el número por no poder contar.
 */
async function contarEnviados24h(): Promise<number> {
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('sent_messages')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', desde);

  if (error) {
    console.error(
      `⚠️  No pude contar los envíos de las últimas 24hs (${error.message}). ` +
      `Asumo el tope alcanzado para no arriesgar el tier de Meta.`,
    );
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

/**
 * Crea el limiter de una corrida. Es async porque consulta cuántos envíos ya
 * salieron en las últimas 24hs.
 */
export async function crearLimiter(): Promise<Limiter> {
  const maxCorrida = Math.max(0, Math.floor(config.jobs.maxEnviosPorCorrida));
  const max24h = Math.max(0, Math.floor(config.jobs.maxEnvios24h));
  const delayMs = Math.max(0, config.jobs.delayEntreEnviosMs);

  const previos24h = await contarEnviados24h();
  // El cupo efectivo es el menor entre lo que permite la corrida y lo que queda
  // de la ventana de 24hs.
  const restante24h = Math.max(0, max24h - previos24h);
  const max = Math.min(maxCorrida, restante24h);

  if (restante24h < maxCorrida) {
    console.warn(
      `⚠️  Cupo de 24hs casi agotado: ${previos24h}/${max24h} mensajes proactivos ya enviados. ` +
      `Esta corrida puede mandar como mucho ${max}.`,
    );
  }

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
    previos24h,
  };
}

/**
 * Línea de log estándar para avisar que una corrida se quedó sin cupo.
 * Nunca truncamos en silencio: si quedó gente sin avisar, tiene que verse.
 */
export function logCupoAgotado(job: string, omitidos: number, limiter: Limiter): void {
  if (omitidos <= 0) return;
  const total24h = limiter.previos24h + limiter.usados;
  console.warn(
    `⚠️  [${job}] cupo agotado (${limiter.usados}/${limiter.max} en esta corrida, ` +
    `${total24h}/${config.jobs.maxEnvios24h} en las últimas 24hs). ` +
    `${omitidos} destinatario(s) quedaron SIN enviar y se reintentan en la próxima corrida. ` +
    `Subí JOBS_MAX_ENVIOS_24H solo cuando Meta te suba de tier.`,
  );
}
