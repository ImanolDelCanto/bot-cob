import type { Content, Part } from '@google/genai';
import { supabase } from '../db/supabase.js';
import { config } from '../config.js';

// El historial de conversaciones vive en Supabase (tabla `conversations`).
// Cada mensaje (de usuario o de modelo) es una fila, con `parts` guardado como jsonb.

// Gemini exige que el historial empiece con un mensaje "limpio" (texto de usuario)
// y que cada functionCall del modelo sea seguida inmediatamente por su functionResponse.
// Cuando el límite de historial corta en el medio de un par call/response, el mensaje
// huérfano hace que Gemini tire 400 "function response turn must come immediately after".
// Esta función descarta los mensajes problemáticos del comienzo hasta llegar a uno limpio.
function recortarComienzoValido(historial: Content[]): Content[] {
  let i = 0;
  while (i < historial.length) {
    const msg = historial[i];
    const parts: Part[] = (msg.parts ?? []) as Part[];
    const tieneFunctionResponse = parts.some(p => 'functionResponse' in p && p.functionResponse);
    const tieneFunctionCall = parts.some(p => 'functionCall' in p && p.functionCall);
    // Un mensaje válido para arrancar es un texto puro (sin function calls/responses).
    // Idealmente debería ser de role='user' pero aceptamos también 'model' por las dudas.
    if (!tieneFunctionResponse && !tieneFunctionCall) break;
    i++;
  }
  return historial.slice(i);
}

export async function getHistorial(telefono: string): Promise<Content[]> {
  // Traemos los últimos N mensajes en orden cronológico inverso, después los damos vuelta.
  // Si el historial es más corto que el límite, los traemos todos.
  const { data, error } = await supabase
    .from('conversations')
    .select('role, parts')
    .eq('telefono', telefono)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(config.historyLimit);

  if (error) throw new Error(`Error leyendo historial: ${error.message}`);
  if (!data) return [];

  // Devolvemos en orden cronológico (más viejo primero) — es lo que Gemini espera.
  const historial = data.reverse().map(row => ({
    role: row.role,
    parts: row.parts,
  })) as Content[];

  return recortarComienzoValido(historial);
}

export async function appendMessages(telefono: string, mensajes: Content[]): Promise<void> {
  if (mensajes.length === 0) return;

  const rows = mensajes.map(m => ({
    telefono,
    role: m.role,
    parts: m.parts ?? [],
  }));

  const { error } = await supabase.from('conversations').insert(rows);
  if (error) throw new Error(`Error guardando mensajes: ${error.message}`);
}

export async function resetHistorial(telefono: string): Promise<void> {
  const { error: e1 } = await supabase
    .from('conversations')
    .delete()
    .eq('telefono', telefono);
  if (e1) throw new Error(`Error reseteando historial: ${e1.message}`);

  const { error: e2 } = await supabase
    .from('conversation_state')
    .delete()
    .eq('telefono', telefono);
  if (e2) throw new Error(`Error reseteando estado: ${e2.message}`);
}
