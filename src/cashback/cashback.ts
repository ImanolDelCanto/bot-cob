// Programa de cashback: reintegro de un % de la primera cuota si el socio
// paga en tiempo y forma. Persistencia en la tabla `cashback` (ver sql/cashback.sql).
//
// Flujo:
//   1. inscribir(): el bot lo llama (vía tool) cuando el socio responde al
//      mensaje de bienvenida. Congela monto y vencimiento. Idempotente por credito_id.
//   2. listParaAviso() / marcarAvisoEnviado(): el job de aviso (cashbackAviso.ts)
//      manda el recordatorio N días antes del primer vencimiento.
//   3. listPendientesReintegro() / marcarReintegrado() / descartar(): un humano
//      revisa quién pagó a tiempo y cierra el ciclo desde los endpoints /admin.

import { supabase } from '../db/supabase.js';
import { db } from '../data/index.js';
import { config } from '../config.js';

export type CashbackEstado = 'inscripto' | 'aviso_enviado' | 'reintegrado' | 'descartado';

export interface CashbackRow {
  id: number;
  telefono: string;
  dni: string;
  credito_id: string;
  primer_vencimiento: string; // ISO yyyy-mm-dd — vencimiento de la 1a cuota del préstamo nuevo
  importe_cuota: number;      // cuota del crédito sobre la que se calcula el reintegro
  monto_cashback: number;     // importe_cuota * porcentaje
  porcentaje: number;
  estado: CashbackEstado;
  fecha_inscripcion: string;
  fecha_aviso: string | null;
  fecha_reintegro: string | null;
  reintegrado_por: string | null;
  notas: string | null;
}

export interface InscripcionResultado {
  inscripto: boolean;
  motivo?: 'sin_credito_elegible' | 'cliente_no_encontrado';
  ya_estaba?: boolean;
  monto_cashback?: number;
  importe_cuota?: number;
  porcentaje?: number;
  primer_vencimiento?: string;
  credito_id?: string;
}

// Busca el préstamo elegible para cashback: un crédito activo cuya primera cuota
// todavía no se pagó (cuotasPagadas === 0). Si hay varios, toma el de vencimiento
// más cercano. Devuelve undefined si el cliente no tiene ninguno así.
async function buscarCreditoElegible(dni: string) {
  const ops = await db.getOperacionesPorDni(dni);
  const candidatos = ops
    .filter(op => op.esCredito && op.estado === 'Activa' && op.cuotasPagadas === 0 && !!op.primerVencimiento)
    .sort((a, b) => a.primerVencimiento.localeCompare(b.primerVencimiento));
  return candidatos[0];
}

// Inscribe al socio en el programa. Idempotente: si ya existe un cashback para
// ese crédito, devuelve el existente sin duplicar. El reintegro es el % configurado
// sobre el importeCuota del crédito (la cuota mensual del préstamo del socio).
export async function inscribir(dni: string, telefono: string): Promise<InscripcionResultado> {
  const dniLimpio = String(dni).replace(/\D/g, '');

  const cliente = await db.buscarClientePorDni(dniLimpio);
  if (!cliente) return { inscripto: false, motivo: 'cliente_no_encontrado' };

  const credito = await buscarCreditoElegible(dniLimpio);
  if (!credito) return { inscripto: false, motivo: 'sin_credito_elegible' };

  // ¿Ya inscripto para este crédito?
  const { data: existente, error: queryErr } = await supabase
    .from('cashback')
    .select('*')
    .eq('credito_id', credito.id)
    .maybeSingle();

  if (queryErr) throw new Error(`Error consultando cashback: ${queryErr.message}`);

  if (existente) {
    const row = existente as CashbackRow;
    return {
      inscripto: true,
      ya_estaba: true,
      monto_cashback: row.monto_cashback,
      importe_cuota: row.importe_cuota,
      porcentaje: row.porcentaje,
      primer_vencimiento: row.primer_vencimiento,
      credito_id: row.credito_id,
    };
  }

  const porcentaje = config.cashback.porcentaje;
  const montoCashback = Math.round(credito.importeCuota * porcentaje * 100) / 100;

  const { error: insertErr } = await supabase.from('cashback').insert({
    telefono,
    dni: dniLimpio,
    credito_id: credito.id,
    primer_vencimiento: credito.primerVencimiento,
    importe_cuota: credito.importeCuota,
    monto_cashback: montoCashback,
    porcentaje,
    estado: 'inscripto',
  });

  if (insertErr) throw new Error(`Error inscribiendo cashback: ${insertErr.message}`);

  return {
    inscripto: true,
    ya_estaba: false,
    monto_cashback: montoCashback,
    importe_cuota: credito.importeCuota,
    porcentaje,
    primer_vencimiento: credito.primerVencimiento,
    credito_id: credito.id,
  };
}

// Cashbacks que necesitan aviso: estado 'inscripto' y vencimiento dentro de la
// ventana [hoy, hoy + diasAntes]. No incluye vencimientos ya pasados.
export async function listParaAviso(diasAntes: number): Promise<CashbackRow[]> {
  const hoy = new Date();
  const hoyIso = hoy.toISOString().slice(0, 10);
  const limite = new Date(hoy.getTime() + diasAntes * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('cashback')
    .select('*')
    .eq('estado', 'inscripto')
    .gte('primer_vencimiento', hoyIso)
    .lte('primer_vencimiento', limite)
    .order('primer_vencimiento', { ascending: true });

  if (error) throw new Error(`Error listando cashbacks para aviso: ${error.message}`);
  return (data ?? []) as CashbackRow[];
}

export async function marcarAvisoEnviado(id: number): Promise<void> {
  const { error } = await supabase
    .from('cashback')
    .update({ estado: 'aviso_enviado', fecha_aviso: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Error marcando aviso enviado: ${error.message}`);
}

// Para el dashboard humano: cashbacks abiertos (inscripto o aviso_enviado),
// ordenados por vencimiento. El humano revisa si pagaron a tiempo y cierra.
export async function listPendientesReintegro(opts: { limit?: number } = {}): Promise<CashbackRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const { data, error } = await supabase
    .from('cashback')
    .select('*')
    .in('estado', ['inscripto', 'aviso_enviado'])
    .order('primer_vencimiento', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Error listando pendientes de reintegro: ${error.message}`);
  return (data ?? []) as CashbackRow[];
}

export async function marcarReintegrado(input: {
  id: number;
  reintegradoPor: string;
  notas?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('cashback')
    .update({
      estado: 'reintegrado',
      fecha_reintegro: new Date().toISOString(),
      reintegrado_por: input.reintegradoPor,
      notas: input.notas ?? null,
    })
    .eq('id', input.id);
  if (error) throw new Error(`Error marcando reintegrado: ${error.message}`);
}

export async function descartar(input: { id: number; motivo: string }): Promise<void> {
  const { error } = await supabase
    .from('cashback')
    .update({ estado: 'descartado', notas: input.motivo })
    .eq('id', input.id);
  if (error) throw new Error(`Error descartando cashback: ${error.message}`);
}
