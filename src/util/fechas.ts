// Fechas y hora en zona horaria Argentina.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El proceso corre en Railway, cuyo reloj está en UTC. Argentina es UTC-3, así
// que entre las 21:00 y las 23:59 hora argentina el UTC ya está en el día
// SIGUIENTE. Todo lo que calculaba "hoy" con `new Date().toISOString()` se
// adelantaba un día durante esas 3 horas:
//
//   - Los cargos por atraso contaban un día de más sobre TODA la cartera:
//     una cuota de $100.000 que vence hoy pasaba de $0 a $10.500 de recargo
//     (10% administrativo + 0,5% diario) a las 21:00 ART, por una cuota que en
//     Argentina todavía no venció.
//   - El cashback: un socio que escribía después de las 21 recibía
//     `sin_credito_elegible`, porque su primer vencimiento "ya había pasado".
//   - Las cohortes del aviso de vencimiento apuntaban al día equivocado.
//
// La HORA (ventana 10-21hs de los jobs) ya se calculaba bien con Intl; el
// problema era la FECHA. Acá quedan las dos, para que haya una sola fuente.
//
// Todas las funciones toman ISO `yyyy-mm-dd` y devuelven ISO `yyyy-mm-dd`.
// Ese formato se compara lexicográficamente sin ambigüedad de zona horaria:
// `'2026-08-04' < '2026-08-05'` es siempre correcto. Preferilo a comparar Dates.

export const TZ_AR = 'America/Argentina/Buenos_Aires';

const fmtFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_AR,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const fmtHora = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ_AR,
  hour: 'numeric',
  hour12: false,
});

/** Hora del día (0-23) en Argentina. Para la ventana horaria de los jobs. */
export function horaAr(ahora: Date = new Date()): number {
  return parseInt(fmtHora.format(ahora), 10);
}

/** Fecha de hoy en Argentina, ISO `yyyy-mm-dd`. */
export function hoyIsoAr(ahora: Date = new Date()): string {
  const p = fmtFecha.formatToParts(ahora);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Suma (o resta, con n negativo) días calendario a una fecha ISO.
 * Aritmética sobre la fecha pura en UTC: sin horas de por medio no hay DST ni
 * corrimientos posibles.
 */
export function sumarDiasIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Hoy + n días en Argentina, ISO `yyyy-mm-dd`. */
export function isoMasDiasAr(n: number, ahora: Date = new Date()): string {
  return sumarDiasIso(hoyIsoAr(ahora), n);
}

/**
 * Días calendario entre dos fechas ISO (hasta - desde). Negativo si `hasta` es
 * anterior. Devuelve 0 si alguna fecha es inválida — el caller decide qué hacer
 * con eso, pero nunca propaga NaN a un cálculo de plata.
 */
export function diasEntreIso(desde: string, hasta: string): number {
  const a = desde?.split('-').map(Number);
  const b = hasta?.split('-').map(Number);
  if (!a || !b || !a[0] || !a[1] || !a[2] || !b[0] || !b[1] || !b[2]) return 0;
  const msA = Date.UTC(a[0], a[1] - 1, a[2]);
  const msB = Date.UTC(b[0], b[1] - 1, b[2]);
  return Math.round((msB - msA) / 86_400_000);
}

/** Días de atraso de un vencimiento respecto de hoy (0 si todavía no venció). */
export function diasDeAtrasoIso(vencimientoIso: string, hoyIso: string): number {
  const dias = diasEntreIso(vencimientoIso, hoyIso);
  return dias > 0 ? dias : 0;
}
