// Persistencia de comprobantes de pago en Supabase Storage + tabla `comprobantes`.
//
// Flujo:
//   1. saveComprobante(): sube el binario al bucket privado y registra en la tabla.
//   2. listPendientes(): lista los pendientes con URLs firmadas (1 hora) para que
//      un humano pueda mirarlos.
//   3. marcarProcesado() / marcarRechazado(): cierran el ciclo cuando el humano
//      registra el pago en el sistema interno.

import { supabase } from '../db/supabase.js';
import { config } from '../config.js';
import { mimeToExtension } from '../whatsapp/media.js';

export interface ComprobantePersistido {
  id: number;
  archivoPath: string;
}

// Sube el archivo al bucket de Supabase y registra una fila en `comprobantes`.
export async function saveComprobante(input: {
  telefono: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<ComprobantePersistido> {
  const ext = mimeToExtension(input.mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivoPath = `${input.telefono}/${stamp}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(config.supabase.bucketComprobantes)
    .upload(archivoPath, input.buffer, {
      contentType: input.mimeType,
      upsert: false,
    });

  if (uploadErr) throw new Error(`Error subiendo a Storage: ${uploadErr.message}`);

  const { data, error: insertErr } = await supabase
    .from('comprobantes')
    .insert({
      telefono: input.telefono,
      archivo_path: archivoPath,
      tipo_archivo: input.mimeType,
      tamano_bytes: input.buffer.length,
    })
    .select('id')
    .single();

  if (insertErr) {
    // Rollback del upload para no dejar archivos huérfanos sin fila.
    await supabase.storage.from(config.supabase.bucketComprobantes).remove([archivoPath]);
    throw new Error(`Error insertando en comprobantes: ${insertErr.message}`);
  }

  return { id: data!.id as number, archivoPath };
}

export interface ComprobantePendiente {
  id: number;
  telefono: string;
  tipo_archivo: string;
  tamano_bytes: number | null;
  fecha_recibido: string;
  url_firmada: string | null;
}

// Lista los comprobantes en estado 'pendiente' con una URL firmada para verlos.
// La URL firmada expira en 1 hora — quien la reciba debería abrirla rápido.
export async function listPendientes(opts: { limit?: number } = {}): Promise<ComprobantePendiente[]> {
  const limit = Math.min(opts.limit ?? 50, 200);

  const { data, error } = await supabase
    .from('comprobantes')
    .select('id, telefono, tipo_archivo, tamano_bytes, fecha_recibido, archivo_path')
    .eq('estado', 'pendiente')
    .order('fecha_recibido', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Error listando pendientes: ${error.message}`);
  if (!data) return [];

  // Generamos URLs firmadas en batch.
  const paths = data.map(c => c.archivo_path as string);
  const { data: signed, error: signErr } = await supabase.storage
    .from(config.supabase.bucketComprobantes)
    .createSignedUrls(paths, 3600);

  if (signErr) {
    console.error('Error generando URLs firmadas:', signErr.message);
  }

  return data.map((c, i) => ({
    id: c.id as number,
    telefono: c.telefono as string,
    tipo_archivo: c.tipo_archivo as string,
    tamano_bytes: (c.tamano_bytes as number | null) ?? null,
    fecha_recibido: c.fecha_recibido as string,
    url_firmada: signed?.[i]?.signedUrl ?? null,
  }));
}

// Marca un comprobante como procesado (registrado en el sistema interno por un humano).
export async function marcarProcesado(input: {
  id: number;
  procesadoPor: string;
  notas?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('comprobantes')
    .update({
      estado: 'procesado',
      procesado_por: input.procesadoPor,
      procesado_at: new Date().toISOString(),
      notas: input.notas ?? null,
    })
    .eq('id', input.id);

  if (error) throw new Error(`Error marcando procesado: ${error.message}`);
}

// Marca un comprobante como rechazado (el humano no lo pudo validar).
export async function marcarRechazado(input: {
  id: number;
  procesadoPor: string;
  notas: string;
}): Promise<void> {
  const { error } = await supabase
    .from('comprobantes')
    .update({
      estado: 'rechazado',
      procesado_por: input.procesadoPor,
      procesado_at: new Date().toISOString(),
      notas: input.notas,
    })
    .eq('id', input.id);

  if (error) throw new Error(`Error marcando rechazado: ${error.message}`);
}
