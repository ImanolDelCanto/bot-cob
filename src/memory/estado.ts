// Estado de sesión por teléfono (tabla `conversation_state`).
//
// POR QUÉ EXISTE
//
// Hasta acá, el DNI que autorizaba el acceso a los datos financieros lo elegía
// el LLM: `consultar_creditos({ dni })` tomaba el DNI de los argumentos del
// modelo, que salen del texto que escribe el socio. No había ningún chequeo
// server-side de que ese DNI fuera el de quien está escribiendo — la única
// barrera era una regla del system prompt ("no reveles info sin verificar_dni").
//
// Un system prompt no es un control de acceso. Escribiendo un DNI ajeno se
// obtenía nombre completo, saldo, mora, cargos y fechas de vencimiento de otra
// persona. Y `inscribir_cashback` ataba el crédito de ese DNI al teléfono del
// que preguntaba, con lo cual el reintegro terminaba en la cuenta equivocada.
//
// Ahora el binding teléfono↔DNI vive en la base: `verificar_dni` lo escribe, y
// las tools que exponen plata lo LEEN de acá, ignorando lo que diga el modelo.

import { supabase } from '../db/supabase.js';

export interface EstadoConversacion {
  telefono: string;
  dni_verificado: string | null;
  dni_verificado_at: string | null;
  failed_dni_attempts: number;
}

// Cuánto dura una verificación antes de pedir el DNI de nuevo. Un teléfono es
// un dispositivo, no una identidad: se presta, se vende, se recicla. 12hs cubre
// una conversación larga sin volverse un pase permanente.
const VIGENCIA_MS = 12 * 60 * 60 * 1000;

// Después de este número de DNIs distintos fallidos, el bot deja de responder
// consultas de identificación y ofrece humano. Sin esto, y sin rate limiting,
// se puede barrer el padrón probando DNIs secuenciales.
export const MAX_INTENTOS_DNI = 5;

export async function getEstado(telefono: string): Promise<EstadoConversacion | null> {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('telefono, dni_verificado, dni_verificado_at, failed_dni_attempts')
    .eq('telefono', telefono)
    .maybeSingle();

  if (error) throw new Error(`Error leyendo estado de conversación: ${error.message}`);
  return (data as EstadoConversacion) ?? null;
}

/**
 * DNI verificado y VIGENTE para este teléfono, o null.
 *
 * Esta es la única fuente de verdad para autorizar el acceso a datos
 * financieros. No aceptar nunca un DNI que venga de los argumentos del modelo.
 */
export async function getDniVerificado(telefono: string): Promise<string | null> {
  const estado = await getEstado(telefono);
  if (!estado?.dni_verificado || !estado.dni_verificado_at) return null;

  const verificadoEn = Date.parse(estado.dni_verificado_at);
  if (Number.isNaN(verificadoEn)) return null;
  if (Date.now() - verificadoEn > VIGENCIA_MS) return null;

  return estado.dni_verificado;
}

/** Registra que este teléfono verificó este DNI. Resetea el contador de intentos. */
export async function setDniVerificado(telefono: string, dni: string): Promise<void> {
  const { error } = await supabase
    .from('conversation_state')
    .upsert(
      {
        telefono,
        dni_verificado: dni,
        dni_verificado_at: new Date().toISOString(),
        failed_dni_attempts: 0,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telefono' },
    );
  if (error) throw new Error(`Error guardando DNI verificado: ${error.message}`);
}

/** Suma un intento fallido y devuelve el total acumulado. */
export async function registrarIntentoFallido(telefono: string): Promise<number> {
  const estado = await getEstado(telefono);
  const intentos = (estado?.failed_dni_attempts ?? 0) + 1;

  const { error } = await supabase
    .from('conversation_state')
    .upsert(
      {
        telefono,
        failed_dni_attempts: intentos,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telefono' },
    );
  if (error) throw new Error(`Error registrando intento fallido: ${error.message}`);

  return intentos;
}
