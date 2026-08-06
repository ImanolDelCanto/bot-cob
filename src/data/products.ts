// Lista de "Producto" del endpoint que son PRÉSTAMOS (vs addons tipo cuota social, asistencia).
// Cualquier Producto que no esté acá se trata como addon (no dispara welcome, no aparece como
// "préstamo activo" en consultas).
//
// Fuente: lista provista por el equipo de IT de la mutual. Si aparecen productos nuevos en el
// endpoint, hay que agregarlos acá.
const PRESTAMO_PRODUCTOS = new Set<string>([
  'AMUF',
  'DEBITO EN CUENTA COMERCIO',
  'DECRETO 14/2012',
  'LIMA',
  'LOMAS DE ZAMORA',
  'TARJETA COMERCIALIZADOR',
  'TARJETA DEBITO',
  'TARJETA DE DEBITO',
]);

// Comparación tolerante a espacios accidentales y diferencias de mayúsculas/minúsculas.
export function esProductoPrestamo(producto: string | null | undefined): boolean {
  if (!producto) return false;
  return PRESTAMO_PRODUCTOS.has(producto.trim().toUpperCase());
}

// Monto mensual de la CUOTA SOCIAL al día de hoy. Para cuotas viejas, ver el
// histórico abajo — la cuota social cambia con el tiempo y usar el valor actual
// sobre cuotas de hace meses infla la deuda (se acopla cargos por atraso encima).
export const CUOTA_SOCIAL_MONTO = 15_000;

// true si el Producto es una ASISTENCIA. Importa para el cargo por atraso: las
// asistencias NO llevan el 10% fijo administrativo, sólo el 0,5% diario
// (verificado contra la cuenta corriente del backoffice). Ver cargosAtraso.ts.
export function esAsistenciaProducto(producto: string | null | undefined): boolean {
  return (producto ?? '').trim().toUpperCase().startsWith('ASIST');
}

// true si el Producto es la CUOTA SOCIAL (el addon de membresía mensual).
export function esCuotaSocial(producto: string | null | undefined): boolean {
  return (producto ?? '').trim().toUpperCase().startsWith('CUOTA SOCIAL');
}

// Histórico de la cuota social: el valor cambia con el tiempo (inflación, ajustes).
// Cada entrada tiene { desde: "yyyy-mm-dd", monto }. Para un vencimiento dado,
// devolvemos el monto vigente en esa fecha (el último "desde" <= fecha).
// Cuando la mutual suba la cuota, agregar una entrada al JSON — no se toca código.
// Espejo del archivo equivalente en mockpagos/lib/cuota-social-historico.json,
// para que bot y portal calculen los mismos montos por cuota.
import cuotaSocialHistorico from './cuota-social-historico.json' with { type: 'json' };

interface HistoricoEntry { desde: string; monto: number; }
const CUOTA_SOCIAL_HISTORICO: ReadonlyArray<HistoricoEntry> = (cuotaSocialHistorico as HistoricoEntry[])
  .slice()
  .sort((a, b) => a.desde.localeCompare(b.desde));

export function cuotaSocialEnFecha(vencimientoIso: string): number {
  if (!vencimientoIso || CUOTA_SOCIAL_HISTORICO.length === 0) {
    return CUOTA_SOCIAL_HISTORICO[CUOTA_SOCIAL_HISTORICO.length - 1]?.monto ?? CUOTA_SOCIAL_MONTO;
  }
  let vigente = CUOTA_SOCIAL_HISTORICO[0].monto;
  for (const entry of CUOTA_SOCIAL_HISTORICO) {
    if (entry.desde <= vencimientoIso) vigente = entry.monto;
    else break;
  }
  return vigente;
}

/**
 * Devuelve el importe de cuota PURA (sin punitorios ni mora) para una operación.
 *
 * El endpoint trae Imp. cuota correcto (> 1) para préstamos reales (TARJETA, AMUF, etc.),
 * pero para los addons trae 1 que es un flag, no un monto. Para esos derivamos:
 *   - CUOTA SOCIAL: monto fijo definido por la mutual (CUOTA_SOCIAL_MONTO)
 *   - ASIST XXXX: el número en el nombre es el monto. Ej: "ASIST 4410" → 4410
 *
 * Si no podemos derivar (producto desconocido sin Imp. cuota real), devolvemos 0.
 */
export function importeCuotaPura(producto: string | null | undefined, impCuotaRaw: number): number {
  if (impCuotaRaw > 1) return impCuotaRaw;

  const prod = (producto ?? '').trim().toUpperCase();

  if (prod.startsWith('CUOTA SOCIAL')) return CUOTA_SOCIAL_MONTO;

  // Para addons tipo ASIST el monto va embebido en el nombre, AL FINAL. Buscarlo
  // pegado a "ASIST" (/^ASIST\s+(\d+)/) fallaba con las variantes que llevan
  // subcategoría: "ASIST MEDICA 25000" devolvía 0 y la asistencia desaparecía de
  // la cuota mensual del socio. Espejo de mockpagos/lib/credito-mapper.ts.
  if (prod.startsWith('ASIST')) {
    const asistMatch = prod.match(/(\d+)\s*$/);
    if (asistMatch) return Number(asistMatch[1]);
  }

  return 0;
}
