import { Type, type FunctionDeclaration } from '@google/genai';

// Tools en formato Gemini (FunctionDeclaration).
// El modelo NO consulta directo: pide ejecutar una de estas funciones,
// nosotros la ejecutamos en handlers.ts y le devolvemos el resultado.

export const functionDeclarations: FunctionDeclaration[] = [
  {
    name: 'identificar_cliente',
    description:
      'Busca un cliente por número de teléfono. Devuelve nombre y los últimos 4 dígitos del DNI. ' +
      'Usar al inicio para personalizar el saludo. NO devuelve montos ni info financiera.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        telefono: {
          type: Type.STRING,
          description: 'Teléfono completo en formato internacional sin +, ej. 5491155551111',
        },
      },
      required: ['telefono'],
    },
  },
  {
    name: 'verificar_dni',
    description:
      'Verifica si el DNI ingresado por el usuario coincide con el cliente registrado en ese teléfono. ' +
      'OBLIGATORIO usar antes de revelar información financiera (saldos, montos, vencimientos).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        telefono: { type: Type.STRING, description: 'Teléfono del usuario actual' },
        dni: { type: Type.STRING, description: 'DNI ingresado por el usuario, sin puntos ni espacios' },
      },
      required: ['telefono', 'dni'],
    },
  },
  {
    name: 'consultar_creditos',
    description:
      'Devuelve todos los créditos del cliente: estado, saldo pendiente, saldo en mora, próximo vencimiento, etc. ' +
      'SOLO usar después de haber verificado el DNI con verificar_dni.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dni: { type: Type.STRING, description: 'DNI del cliente, ya verificado' },
      },
      required: ['dni'],
    },
  },
  {
    name: 'obtener_medios_de_pago',
    description: 'Devuelve los medios de pago disponibles para cancelar cuotas o saldos en mora.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];
