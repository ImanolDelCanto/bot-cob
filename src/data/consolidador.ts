// Consolidador del saldo del cliente.
//
// REPLICA la lógica del portal de pagos (mockpagos/lib/credito-mapper.ts) para
// que el bot y el portal muestren los MISMOS números al socio. Si la fórmula
// del portal cambia, hay que reflejar el cambio acá también.
//
// Qué hace:
//   1. Sintetiza las cuotas individuales de cada operación (la mutual NO trae
//      detalle cuota-por-cuota, solo agregados — derivamos asumiendo cuotas
//      mensuales desde "Primer vto.").
//   2. Para cuotas VENCIDAS: suma el cargo por atraso al monto puro de la cuota.
//   3. Para CUOTA SOCIAL: el monto puro depende del mes de vencimiento
//      (cuotaSocialEnFecha — histórico vigente). Para PRÉSTAMOS con pagos
//      parciales: distribuye el "Saldo venc." entre las cuotas vencidas.
//   4. Filtra por "meses visibles" — meses cubiertos por TODOS los addons
//      activos a la vez. En un mes donde falta algún addon, mostrar la cuota
//      al cliente engañaría con un monto parcial.
//   5. Consolida cuotas del mismo mes en una sola: monto = suma del préstamo +
//      cuota social + asistencias de ese mes. Coincide con el "Cuota mensual"
//      que paga el cliente.
//   6. Devuelve totales: saldoEnMora (con cargos), saldoTotal (para cancelar
//      todo), cuotaMensualTotal (cuota actual, con cuota social vigente hoy).

import { calcularCargoPorCuota } from './cargosAtraso.js';
import { esCuotaSocial, cuotaSocialEnFecha } from './products.js';
import type { Cliente, Operacion, ResumenCliente } from './types.js';

interface CuotaSintetica {
  vencimiento: string;     // ISO yyyy-mm-dd
  monto: number;           // ya con cargo si es vencida
  montoPuro: number;       // sin cargo (informativo)
  cargo: number;           // 0 si no es vencida
  estado: 'pagada' | 'vencida' | 'proxima';
  esCreditoOp: boolean;
}

// Suma N meses manteniendo el día, CLAMPEANDO al último día del mes destino.
//
// Sin el clamp, Date.UTC(2026, 0 + 1, 31) desborda a 2026-03-03: para un socio
// con primer vencimiento el 29, 30 o 31, febrero se saltea y marzo recibe dos
// cuotas. Eso corrompe el estado de las cuotas, el saldo y la intersección de
// mesesVisibles. Verificado: '2026-01-31' + 1 daba '2026-03-03'.
function sumarMeses(iso: string, n: number): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  // Día 0 del mes siguiente = último día del mes destino.
  const ultimoDia = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, ultimoDia)));
  return dt.toISOString().slice(0, 10);
}

function bucketMes(iso: string): string {
  return iso.slice(0, 7);
}

function diasDeAtraso(iso: string, hoy: Date): number {
  if (!iso) return 0;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const venc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const hoyUtc = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate(), 12, 0, 0);
  const ms = hoyUtc - venc;
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Sintetiza las cuotas de UNA operación, marcando estado y aplicando cargo a vencidas.
function sintetizar(op: Operacion, hoy: Date): CuotaSintetica[] {
  if (op.totalCuotas <= 0 || !op.primerVencimiento) return [];

  const totalCuotas = op.totalCuotas;
  const cuotasImpagas = Math.min(op.cuotasImpagas, totalCuotas);
  const cuotasPagadas = Math.max(0, totalCuotas - cuotasImpagas);
  const cuotasVencidas = Math.min(op.cuotasImpagasVencidas, cuotasImpagas);

  const esSocial = esCuotaSocial(op.producto);

  // Pagos parciales sobre vencidas: si "Saldo venc." es MENOR que importeCuota *
  // cuotasVencidas, hay abonos parciales. Distribuimos uniformemente entre vencidas
  // para reflejar lo que falta pagar. Solo para préstamos (donde importeCuota refleja
  // el valor real); para cuota social usamos el histórico por mes.
  const importePuroVencidaParcial =
    !esSocial && op.esCredito && cuotasVencidas > 0 && op.saldoEnMora > 0
      ? op.saldoEnMora / cuotasVencidas
      : null;

  const cuotas: CuotaSintetica[] = [];
  for (let i = 1; i <= totalCuotas; i++) {
    const venc = sumarMeses(op.primerVencimiento, i - 1);

    let estado: CuotaSintetica['estado'];
    if (i <= cuotasPagadas) estado = 'pagada';
    else if (i <= cuotasPagadas + cuotasVencidas) estado = 'vencida';
    else estado = 'proxima';

    // Monto puro de la cuota:
    //  - CUOTA SOCIAL: usar histórico vigente en la fecha del vencimiento.
    //  - Préstamo vencida con pagos parciales: usar saldo distribuido.
    //  - Resto: usar op.importeCuota tal cual (ya procesado por importeCuotaPura).
    let montoPuro: number;
    if (esSocial) {
      montoPuro = cuotaSocialEnFecha(venc);
    } else if (estado === 'vencida' && importePuroVencidaParcial !== null) {
      montoPuro = importePuroVencidaParcial;
    } else {
      montoPuro = op.importeCuota;
    }

    let cargo = 0;
    if (estado === 'vencida' && montoPuro > 0) {
      const dias = diasDeAtraso(venc, hoy);
      cargo = calcularCargoPorCuota(montoPuro, dias).cargoTotal;
    }

    cuotas.push({
      vencimiento: venc,
      montoPuro,
      cargo,
      monto: montoPuro + cargo,
      estado,
      esCreditoOp: op.esCredito,
    });
  }
  return cuotas;
}

// Meses (yyyy-mm) cubiertos por TODOS los addons activos al mismo tiempo.
// Si NO hay addons → vacío. El caller decide cómo lo trata (mockpagos no
// muestra nada; el bot cae a un fallback que toma todos los meses).
function calcularMesesVisibles(addonsActivos: Operacion[]): Set<string> {
  if (addonsActivos.length === 0) return new Set();
  const mesesPorAddon = addonsActivos.map(op => {
    const meses = new Set<string>();
    if (!op.primerVencimiento) return meses;
    for (let i = 0; i < op.totalCuotas; i++) {
      meses.add(bucketMes(sumarMeses(op.primerVencimiento, i)));
    }
    return meses;
  });
  const [first, ...rest] = mesesPorAddon;
  return new Set([...first].filter(m => rest.every(s => s.has(m))));
}

interface CuotaConsolidada {
  mes: string;
  vencimiento: string;
  monto: number;       // total del mes (con cargos)
  montoPuro: number;   // total del mes sin cargos
  cargo: number;       // suma de cargos del mes
  estado: 'pagada' | 'vencida' | 'proxima';
}

// Agrupa cuotas del mismo MES en UNA cuota consolidada. Solo conserva los meses
// que están en mesesVisibles (intersección de meses cubiertos por TODOS los addons).
function consolidar(cuotas: CuotaSintetica[], mesesVisibles: Set<string>): CuotaConsolidada[] {
  if (cuotas.length === 0 || mesesVisibles.size === 0) return [];

  const buckets = new Map<string, CuotaSintetica[]>();
  for (const c of cuotas) {
    const mes = bucketMes(c.vencimiento);
    if (!mesesVisibles.has(mes)) continue;
    const arr = buckets.get(mes) ?? [];
    arr.push(c);
    buckets.set(mes, arr);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, grupo]) => {
      const vencimiento = grupo.map(c => c.vencimiento).sort()[0];
      const noPagadas = grupo.filter(c => c.estado !== 'pagada');
      const refs = noPagadas.length > 0 ? noPagadas : grupo;
      const monto = refs.reduce((s, c) => s + c.monto, 0);
      const montoPuro = refs.reduce((s, c) => s + c.montoPuro, 0);
      const cargo = refs.reduce((s, c) => s + c.cargo, 0);
      let estado: CuotaConsolidada['estado'];
      if (noPagadas.length === 0) estado = 'pagada';
      else if (noPagadas.some(c => c.estado === 'vencida')) estado = 'vencida';
      else estado = 'proxima';
      return { mes, vencimiento, monto, montoPuro, cargo, estado };
    });
}

export interface ResumenConsolidado extends ResumenCliente {
  // Cargos por atraso acumulados al día de hoy (informativo).
  cargoPorAtrasoAcumulado: number;
}

// Función principal: dadas las operaciones activas+canceladas y los datos del cliente,
// devuelve el resumen consolidado replicando la lógica del portal.
export function calcularResumenConsolidado(
  cliente: Cliente,
  operaciones: Operacion[],
  hoy: Date = new Date(),
): ResumenConsolidado {
  const activas = operaciones.filter(op => op.estado === 'Activa');
  const addonsActivos = activas.filter(op => !op.esCredito);

  // mesesVisibles: si NO hay addons activos (cliente solo con préstamos sueltos,
  // raro pero posible en testing), caemos al conjunto completo de meses de las
  // operaciones activas — mostrar 0 sería peor que mostrar parcial.
  let mesesVisibles = calcularMesesVisibles(addonsActivos);
  if (mesesVisibles.size === 0 && activas.length > 0) {
    mesesVisibles = new Set<string>();
    for (const op of activas) {
      if (!op.primerVencimiento) continue;
      for (let i = 0; i < op.totalCuotas; i++) {
        mesesVisibles.add(bucketMes(sumarMeses(op.primerVencimiento, i)));
      }
    }
  }

  const cuotasPorOp = activas.flatMap(op => sintetizar(op, hoy));
  const consolidadas = consolidar(cuotasPorOp, mesesVisibles);

  const visibles = consolidadas.filter(c => c.estado !== 'pagada');
  const vencidas = consolidadas.filter(c => c.estado === 'vencida');

  const saldoVisible = visibles.reduce((s, c) => s + c.monto, 0);
  const saldoEnMora = vencidas.reduce((s, c) => s + c.monto, 0);
  const cargoPorAtrasoAcumulado = vencidas.reduce((s, c) => s + c.cargo, 0);

  // Cuotas ocultas: meses del préstamo que quedan fuera de la intersección de
  // addons. Las sumamos al saldoTotal (para cancelar todo) pero NO al saldoVisible.
  const mesesConsolidados = new Set(consolidadas.map(c => c.mes));
  const saldoOculto = cuotasPorOp
    .filter(c => c.estado !== 'pagada' && !mesesConsolidados.has(bucketMes(c.vencimiento)))
    .reduce((s, c) => s + c.monto, 0);

  // Cuota mensual ACTUAL (lo que paga por mes hoy/próxima): préstamo + addons,
  // con cuota social al monto VIGENTE HOY (no histórico).
  const hoyIso = hoy.toISOString().slice(0, 10);
  const cuotaMensualTotal = activas.reduce((s, op) => {
    const monto = esCuotaSocial(op.producto) ? cuotaSocialEnFecha(hoyIso) : op.importeCuota;
    return s + monto;
  }, 0);

  return {
    cliente,
    operaciones,
    saldoTotal: round2(saldoVisible + saldoOculto),
    saldoEnMora: round2(saldoEnMora),
    cuotaMensualTotal: round2(cuotaMensualTotal),
    cuotasImpagas: activas.reduce((s, op) => s + op.cuotasImpagas, 0),
    cuotasImpagasVencidas: vencidas.length,
    hayPrestamoActivo: activas.some(op => op.esCredito),
    cargoPorAtrasoAcumulado: round2(cargoPorAtrasoAcumulado),
  };
}
