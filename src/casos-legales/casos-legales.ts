// Casos derivados a estudios jurídicos. El bot NO interactúa con socios listados acá:
// no manda welcome, ni cashback aviso, ni recordatorios de vencimiento, y si el socio
// escribe le explica que su caso lo lleva el estudio y le pasa los datos.
//
// Persistencia en la tabla `casos_legales` (ver sql/casos_legales.sql).

import { supabase } from '../db/supabase.js';

export interface CasoLegal {
  id: number;
  dni: string;
  estudio_nombre: string;
  estudio_contacto: string | null;
  fecha_derivacion: string;
  notas: string | null;
  creado_at: string;
  activo: boolean;
}

// Devuelve el caso ACTIVO del socio, o null si no está derivado.
// Es el chequeo que se usa "antes de todo" — jobs y flujo conversacional.
export async function getCasoLegalPorDni(dni: string): Promise<CasoLegal | null> {
  const dniLimpio = String(dni).replace(/\D/g, '');
  if (!dniLimpio) return null;

  const { data, error } = await supabase
    .from('casos_legales')
    .select('*')
    .eq('dni', dniLimpio)
    .eq('activo', true)
    .maybeSingle();

  if (error) throw new Error(`Error consultando casos legales: ${error.message}`);
  return (data ?? null) as CasoLegal | null;
}

// Crea un caso (deriva al socio al estudio). Si ya hay uno activo para ese DNI,
// la unique index lo rechaza — primero hay que dar de baja el existente.
export async function crearCasoLegal(input: {
  dni: string;
  estudio_nombre: string;
  estudio_contacto?: string;
  notas?: string;
}): Promise<CasoLegal> {
  const dniLimpio = String(input.dni).replace(/\D/g, '');
  if (!/^\d{6,12}$/.test(dniLimpio)) {
    throw new Error('DNI inválido');
  }
  if (!input.estudio_nombre.trim()) {
    throw new Error('Falta estudio_nombre');
  }

  const { data, error } = await supabase
    .from('casos_legales')
    .insert({
      dni: dniLimpio,
      estudio_nombre: input.estudio_nombre.trim(),
      estudio_contacto: input.estudio_contacto?.trim() || null,
      notas: input.notas?.trim() || null,
    })
    .select('*')
    .single();

  if (error) throw new Error(`Error creando caso legal: ${error.message}`);
  return data as CasoLegal;
}

// Lista todos los casos activos. Útil para el dashboard humano.
export async function listCasosActivos(opts: { limit?: number } = {}): Promise<CasoLegal[]> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const { data, error } = await supabase
    .from('casos_legales')
    .select('*')
    .eq('activo', true)
    .order('fecha_derivacion', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Error listando casos legales: ${error.message}`);
  return (data ?? []) as CasoLegal[];
}

// Marca un caso como inactivo (el estudio cerró, el socio vuelve al bot).
export async function darDeBajaCasoLegal(id: number, notas?: string): Promise<void> {
  const { error } = await supabase
    .from('casos_legales')
    .update({
      activo: false,
      notas: notas?.trim() || null,
    })
    .eq('id', id);

  if (error) throw new Error(`Error dando de baja caso legal: ${error.message}`);
}
