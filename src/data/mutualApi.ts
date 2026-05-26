// Cliente HTTP del endpoint /external/listcreditos de la mutual.
// Implementa el contrato DataSource para que el resto del bot no se entere
// de si los datos vienen del mock o de este endpoint.

import { config } from '../config.js';
import { esProductoPrestamo, importeCuotaPura } from './products.js';
import { calcularResumenConsolidado } from './consolidador.js';
import type { Cliente, DataSource, Operacion } from './types.js';

// Shape crudo que devuelve el endpoint /external/listcreditos.
interface CreditoRaw {
  Documento: string;
  Nombre: string;
  Operación: number;
  'Ctas. impagas': number;
  'Ctas. Imp. Venc.': number;
  'Saldo venc.': number;
  'Saldo total': number;
  Capital: number;
  Interes: number;
  Cargos: number;
  Cobranza: number;
  'Cobranza capital': number;
  'Cobranza interés': number;
  'Cobranza cargos': number;
  Punitorios: number;
  'Imp. cuota': number;
  'Total ctas': number;
  Estado: string;
  'Fecha liquidación': string;
  Teléfono: string;
  Cuil: number;
  'Primer vto.': string;
  Producto: string;
  Plan: string;
}

// El endpoint NO filtra por DNI server-side aunque le pasemos el parámetro: siempre
// devuelve TODA la base de la empresa (~38MB, ~50K registros, ~8 segundos de transferencia).
// Por eso cacheamos el snapshot completo una sola vez y filtramos por DNI en memoria.
//
// TTL configurable. Default 5 minutos: el primer cliente del día (o el primer cron) paga
// los 8 segundos, los siguientes leen del cache hasta que expire.
let snapshot: CreditoRaw[] | null = null;
let snapshotExpires = 0;
let inflightFetch: Promise<CreditoRaw[]> | null = null;

async function fetchSnapshot(): Promise<CreditoRaw[]> {
  // Si hay un fetch en curso, todos los callers esperan al mismo (evita stampede).
  if (inflightFetch) return inflightFetch;

  const { baseUrl, ticket, empresaId, timeoutMs } = config.endpoint;
  const url = `${baseUrl}/external/listcreditos?ticket=${ticket}&empresaId=${empresaId}`;

  inflightFetch = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Endpoint mutual ${res.status}: ${await res.text().catch(() => '')}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error('Endpoint mutual no devolvió un array');
      }
      const arr = data as CreditoRaw[];
      const ms = Date.now() - t0;
      console.log(`📥 Snapshot mutualApi cargado: ${arr.length} registros en ${ms}ms`);
      return arr;
    } finally {
      clearTimeout(timer);
    }
  })();

  try {
    snapshot = await inflightFetch;
    snapshotExpires = Date.now() + config.endpoint.cacheTtlMs;
    return snapshot;
  } finally {
    inflightFetch = null;
  }
}

async function getSnapshot(): Promise<CreditoRaw[]> {
  if (snapshot && Date.now() < snapshotExpires) return snapshot;
  return fetchSnapshot();
}

// Pre-carga el snapshot en background. Llamar al arrancar el bot para que el primer
// cliente del día no espere los 8 segundos. No tira excepción si falla — solo loguea.
export async function warmUpSnapshot(): Promise<void> {
  try {
    await fetchSnapshot();
  } catch (err: any) {
    console.error('⚠️  Warm-up de mutualApi falló:', err?.message ?? err);
  }
}

async function fetchCreditos(dni?: string): Promise<CreditoRaw[]> {
  const all = await getSnapshot();
  if (!dni) return all;
  return all.filter(c => String(c.Documento ?? '') === dni);
}

// "GONZALEZ, MARIO DANIEL" → "Mario Daniel Gonzalez"
function invertirApellidoNombre(raw: string): string {
  const parts = raw.split(',').map(p => p.trim());
  const compuesto = parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw;
  return capitalizar(compuesto);
}

// "GONZALEZ, MARIO DANIEL" → "Mario"
function extraerPrimerNombre(raw: string): string {
  const parts = raw.split(',').map(p => p.trim());
  const nombres = parts.length === 2 ? parts[1] : raw;
  return capitalizar(nombres.split(/\s+/)[0]);
}

function capitalizar(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

// Convierte teléfonos locales argentinos al formato que necesita WhatsApp (5491155551111).
// Ejemplos:
//   "3413 979584"   → "5493413979584"  (Rosario, área 3413)
//   "11 2222 3333"  → "5491122223333"  (CABA, área 11)
//   "0341 5979584"  → "5493415979584"  (con 0 inicial)
//   "+54 9 11 2222 3333" → "5491122223333"
function normalizarTelefonoAr(raw: string): string {
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  // Sacamos 0 inicial si vino "0341..."
  if (digits.startsWith('0')) digits = digits.slice(1);
  // Sacamos 15 al principio del subscriber number es raro acá pero por las dudas
  // Si ya viene con 549 o 54, devolvemos como está (con 549 si era solo 54)
  if (digits.startsWith('549')) return digits;
  if (digits.startsWith('54')) return '549' + digits.slice(2);
  // Asumimos celular argentino sin código país: prefijamos 549
  return '549' + digits;
}

function isoSoloFecha(iso: string): string {
  // El endpoint devuelve "2024-10-17T16:14:00". Nos quedamos con la parte de fecha.
  if (!iso) return '';
  return iso.slice(0, 10);
}

function rawToCliente(row: CreditoRaw): Cliente {
  return {
    dni: String(row.Documento),
    nombre: invertirApellidoNombre(row.Nombre ?? ''),
    primerNombre: extraerPrimerNombre(row.Nombre ?? ''),
    telefono: normalizarTelefonoAr(row.Teléfono ?? ''),
    cuil: row.Cuil ? String(row.Cuil) : undefined,
  };
}

function rawToOperacion(row: CreditoRaw): Operacion {
  const totalCuotas = Number(row['Total ctas'] ?? 0);
  const cuotasImpagas = Number(row['Ctas. impagas'] ?? 0);
  const capitalRestante = Number(row.Capital ?? 0);
  const cobranzaCapital = Number(row['Cobranza capital'] ?? 0);
  const esCredito = esProductoPrestamo(row.Producto);

  // Para préstamos, el monto original lo derivamos sumando lo restante + lo cobrado.
  // Para addons (cuota social, asistencia), no aplica el concepto de "monto otorgado".
  const capitalOriginal = esCredito ? capitalRestante + cobranzaCapital : 0;

  // Imp. cuota viene como 1 (flag) para CUOTA SOCIAL y ASIST. Lo derivamos por reglas
  // (ver products.ts → importeCuotaPura). Para préstamos reales el endpoint trae el valor.
  const impCuotaRaw = Number(row['Imp. cuota'] ?? 0);
  const saldoTotal = Number(row['Saldo total'] ?? 0);
  const importeCuota = importeCuotaPura(row.Producto, impCuotaRaw);

  return {
    id: String(row.Operación),
    dni: String(row.Documento),
    producto: row.Producto ?? '',
    plan: row.Plan ?? '',
    estado: row.Estado ?? '',
    esCredito,
    fechaLiquidacion: isoSoloFecha(row['Fecha liquidación']),
    primerVencimiento: isoSoloFecha(row['Primer vto.']),
    totalCuotas,
    cuotasPagadas: Math.max(0, totalCuotas - cuotasImpagas),
    cuotasImpagas,
    cuotasImpagasVencidas: Number(row['Ctas. Imp. Venc.'] ?? 0),
    importeCuota,
    capitalOriginal,
    saldoTotal,
    saldoEnMora: Number(row['Saldo venc.'] ?? 0),
    punitorios: Number(row.Punitorios ?? 0),
  };
}

export const mutualApi: DataSource = {
  async buscarClientePorDni(dni: string) {
    const rows = await fetchCreditos(dni);
    if (rows.length === 0) return undefined;
    return rawToCliente(rows[0]);
  },

  async getOperacionesPorDni(dni: string) {
    const rows = await fetchCreditos(dni);
    return rows.map(rawToOperacion);
  },

  async getResumenPorDni(dni: string) {
    const rows = await fetchCreditos(dni);
    if (rows.length === 0) return undefined;
    const cliente = rawToCliente(rows[0]);
    const ops = rows.map(rawToOperacion);
    // Usa el consolidador (misma lógica que el portal): sintetiza cuotas mes a
    // mes, aplica cargos por atraso a vencidas, filtra por mesesVisibles y
    // consolida — así el bot y el portal muestran exactamente los mismos números.
    return calcularResumenConsolidado(cliente, ops);
  },

  async getPrestamosRecienLiquidados(horasAtras: number) {
    const rows = await fetchCreditos();
    const cutoff = Date.now() - horasAtras * 3_600_000;
    return rows
      .map(rawToOperacion)
      .filter(op => {
        if (!op.esCredito) return false;
        if (op.estado !== 'Activa') return false;
        const t = new Date(op.fechaLiquidacion).getTime();
        return !Number.isNaN(t) && t >= cutoff;
      });
  },
};
