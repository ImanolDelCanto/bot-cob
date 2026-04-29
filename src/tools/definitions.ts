import { Type, type FunctionDeclaration } from '@google/genai';

// Tools en formato Gemini (FunctionDeclaration).
// El modelo NO consulta directo: pide ejecutar una de estas funciones,
// nosotros la ejecutamos en handlers.ts y le devolvemos el resultado.

export const functionDeclarations: FunctionDeclaration[] = [
  {
    name: 'verificar_dni',
    description:
      'Busca al asociado por DNI en la base de la mutual. Si existe, devuelve verificado=true junto con su nombre. ' +
      'OBLIGATORIO usar antes de revelar información financiera (saldos, montos, vencimientos).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dni: { type: Type.STRING, description: 'DNI ingresado por el usuario, sin puntos ni espacios' },
      },
      required: ['dni'],
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
