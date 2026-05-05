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

// Monto mensual de la CUOTA SOCIAL. Actualizar acá cuando aumente.
const CUOTA_SOCIAL_MONTO = 15_000;

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

  // ASIST seguido de un número (con uno o más espacios). Ej: "ASIST 4410", "ASIST 20000".
  const asistMatch = prod.match(/^ASIST\s+(\d+)/);
  if (asistMatch) return Number(asistMatch[1]);

  return 0;
}
