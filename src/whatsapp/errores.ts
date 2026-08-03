// Clasificación de errores de la API de WhatsApp Cloud.
//
// Por qué existe: los jobs proactivos mandan de a uno en un for. Sin clasificar,
// un error que afecta a TODA la cuenta (número en modo prueba, token vencido,
// falta plantilla) se traduce en un intento fallido por cada destinatario —
// medido en producción: 1368 llamadas inútiles seguidas en una sola corrida.
//
// Tres clases:
//   - 'cuenta'      → le va a fallar a TODOS. Hay que abortar la corrida entera.
//   - 'destinatario'→ le falla solo a ese socio y no va a mejorar reintentando
//                     (número inexistente, formato inválido). Se marca como
//                     enviado para no reintentarlo eternamente.
//   - 'transitorio' → puede andar en la próxima (timeout, 5xx, rate limit).
//                     Se libera la marca para que se reintente.

export type ClaseErrorWhatsApp = 'cuenta' | 'destinatario' | 'transitorio';

// Códigos que indican un problema de configuración/estado de la cuenta:
// mientras no se resuelva, NINGÚN envío va a salir.
const CODIGOS_CUENTA = new Set([
  0,      // AuthException
  3,      // API method / permiso faltante
  10,     // permiso denegado
  190,    // access token vencido o inválido
  131005, // access denied
  131030, // "Recipient phone number not in allowed list" → número en modo prueba
  131031, // cuenta bloqueada
  131042, // problema de método de pago / elegibilidad
  131045, // certificado incorrecto
  131047, // "Re-engagement message": fuera de la ventana de 24hs → falta plantilla
  131048, // spam rate limit alcanzado
  131057, // cuenta en estado restringido
  133000, 133004, 133005, 133006, 133008, 133009, 133010, 133015, // registro del número
]);

// Códigos propios del destinatario: reintentar no cambia nada.
const CODIGOS_DESTINATARIO = new Set([
  100,    // parámetro inválido (típicamente el teléfono mal formado)
  131008, // parámetro requerido faltante
  131009, // valor de parámetro inválido
  131021, // el destinatario no puede ser el remitente
  131026, // mensaje no entregable (el número no está en WhatsApp)
  131049, // Meta decidió no entregarlo (política de ecosistema saludable)
]);

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly codigo: number | null;
  readonly clase: ClaseErrorWhatsApp;

  constructor(status: number, body: string) {
    const codigo = extraerCodigo(body);
    super(`WhatsApp API ${status}${codigo !== null ? ` (#${codigo})` : ''}: ${body}`);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.codigo = codigo;
    this.clase = clasificar(status, codigo);
  }
}

function extraerCodigo(body: string): number | null {
  try {
    const json = JSON.parse(body);
    const code = json?.error?.code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

function clasificar(status: number, codigo: number | null): ClaseErrorWhatsApp {
  if (codigo !== null) {
    if (CODIGOS_CUENTA.has(codigo)) return 'cuenta';
    if (CODIGOS_DESTINATARIO.has(codigo)) return 'destinatario';
  }
  // 401/403 sin código reconocible = casi seguro auth de la cuenta.
  if (status === 401 || status === 403) return 'cuenta';
  // 429 y 5xx son reintentables.
  return 'transitorio';
}

/** Clase de un error cualquiera. Lo que no es de la API de WhatsApp es transitorio. */
export function claseDeError(err: unknown): ClaseErrorWhatsApp {
  return err instanceof WhatsAppApiError ? err.clase : 'transitorio';
}
