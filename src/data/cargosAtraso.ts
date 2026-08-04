// Cálculo de cargos por atraso (punitorios) sobre cuotas vencidas.
//
// Fórmula validada contra la cuenta corriente del backoffice de la mutual:
//   cargoFijo   = CARGO_ADMINISTRATIVO × importeCuota   (desde el día 1 de atraso)
//   cargoDiario = TASA_DIARIA × importeCuota × diasAtraso
//   cargoTotal  = min(cargoFijo + cargoDiario, TOPE_MAXIMO × importeCuota)
// Ejemplo verificado: cuota $8.000 con 21 días → $1.640 (= 10% + 10,5%).
//
// Notas:
// - El cálculo es sobre el IMPORTE DE LA CUOTA, no sobre el saldo adeudado.
// - Si diasAtraso ≤ 0, el cargo es 0.
// - Se aplica a CADA cuota vencida del cliente individualmente, y se suman.
// - Cuando exista el endpoint REST /api/cargos-atraso/calcular en producción,
//   reemplazar las funciones puras por un cliente HTTP que pegue ahí. La interfaz
//   y los nombres de campos están alineados con la spec de ese endpoint.

import type { Operacion } from './types.js';
import { config } from '../config.js';

// Configurable vía env vars (CARGOS_*). Defaults = valores de producción de la
// mutual. La lectura vive en config.ts: acá se leía process.env en el top-level
// del módulo, así que si este archivo se importaba antes que config.ts, dotenv
// todavía no había corrido y los valores del .env se ignoraban en silencio.
// config.ts además valida rangos y falla el arranque si algo no cierra.
export const CARGOS_CONFIG = config.cargos;

export interface CargoAtrasoResultado {
  importeCuota: number;
  diasAtraso: number;
  cargoFijo: number;
  cargoDiario: number;
  cargoTotal: number;
  aplicoTope: boolean;
  topeMaximo: number;
}

// Redondeo a 2 decimales, away from zero. Para montos de pesos.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula el cargo por atraso para UNA cuota individual.
 * Equivalente al endpoint POST /api/cargos-atraso/calcular.
 */
export function calcularCargoPorCuota(importeCuota: number, diasAtraso: number): CargoAtrasoResultado {
  const { tasaDiaria, cargoAdministrativo, topeMaximo, umbralDiasCargoFijo } = CARGOS_CONFIG;
  const topeAbs = round2(topeMaximo * importeCuota);

  if (diasAtraso <= 0 || importeCuota <= 0) {
    return {
      importeCuota,
      diasAtraso: Math.max(0, diasAtraso),
      cargoFijo: 0,
      cargoDiario: 0,
      cargoTotal: 0,
      aplicoTope: false,
      topeMaximo: topeAbs,
    };
  }

  const cargoFijo = diasAtraso >= umbralDiasCargoFijo
    ? round2(cargoAdministrativo * importeCuota)
    : 0;
  const cargoDiario = round2(tasaDiaria * importeCuota * diasAtraso);
  const sumaSinTope = round2(cargoFijo + cargoDiario);
  const aplicoTope = sumaSinTope > topeAbs;
  const cargoTotal = aplicoTope ? topeAbs : sumaSinTope;

  return {
    importeCuota,
    diasAtraso,
    cargoFijo,
    cargoDiario,
    cargoTotal,
    aplicoTope,
    topeMaximo: topeAbs,
  };
}

/**
 * Calcula el cargo total por atraso de UNA operación, sumando el cargo de
 * cada cuota vencida individual.
 *
 * Las cuotas vencidas son las que ya pasaron su fecha de vencimiento y no
 * están pagadas. Su cantidad viene en `op.cuotasImpagasVencidas`. Las fechas
 * se derivan asumiendo cuotas mensuales:
 *   fecha cuota N = primerVencimiento + (cuotasPagadas + N) meses,
 *   donde N = 0..cuotasImpagasVencidas-1
 */
export function calcularCargoPorOperacion(op: Operacion, hoy: Date = new Date()): number {
  if (op.estado !== 'Activa' || op.cuotasImpagasVencidas <= 0) return 0;
  if (!op.primerVencimiento) return 0;
  const baseDate = new Date(op.primerVencimiento);
  if (Number.isNaN(baseDate.getTime())) return 0;

  let total = 0;
  for (let i = 0; i < op.cuotasImpagasVencidas; i++) {
    const fechaCuota = new Date(baseDate);
    fechaCuota.setMonth(fechaCuota.getMonth() + op.cuotasPagadas + i);
    const diasAtraso = Math.floor((hoy.getTime() - fechaCuota.getTime()) / 86_400_000);
    const cargo = calcularCargoPorCuota(op.importeCuota, diasAtraso);
    total += cargo.cargoTotal;
  }
  return round2(total);
}

/**
 * Calcula el cargo total por atraso de un cliente, sumando los cargos
 * de todas sus operaciones activas con cuotas vencidas.
 */
export function calcularCargoPorCliente(operaciones: Operacion[], hoy: Date = new Date()): number {
  return round2(
    operaciones
      .filter(op => op.estado === 'Activa')
      .reduce((sum, op) => sum + calcularCargoPorOperacion(op, hoy), 0)
  );
}
