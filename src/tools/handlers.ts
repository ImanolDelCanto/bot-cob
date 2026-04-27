import {
  buscarClientePorTelefono,
  getCreditosPorDni,
} from '../data/mockDb.js';

type ToolHandler = (input: Record<string, any>) => Promise<unknown> | unknown;

export const handlers: Record<string, ToolHandler> = {
  identificar_cliente: ({ telefono }) => {
    const cliente = buscarClientePorTelefono(String(telefono));
    if (!cliente) return { encontrado: false };
    return {
      encontrado: true,
      nombre: cliente.nombre,
      dni_ultimos_4: cliente.dni.slice(-4),
    };
  },

  verificar_dni: ({ telefono, dni }) => {
    const cliente = buscarClientePorTelefono(String(telefono));
    const dniLimpio = String(dni).replace(/\D/g, '');
    const verificado = !!cliente && cliente.dni === dniLimpio;
    return { verificado };
  },

  consultar_creditos: ({ dni }) => {
    const creditos = getCreditosPorDni(String(dni));
    if (creditos.length === 0) return { creditos: [] };
    return {
      creditos: creditos.map(c => ({
        id: c.id,
        estado: c.estado,
        monto_original: c.monto,
        cuotas_total: c.cuotas,
        cuotas_pagadas: c.cuotasPagadas,
        saldo_pendiente: c.saldoPendiente,
        saldo_en_mora: c.saldoEnMora,
        dias_mora: c.diasMora,
        proximo_vencimiento: c.proximoVencimiento,
      })),
    };
  },

  obtener_medios_de_pago: () => ({
    medios: [
      {
        tipo: 'transferencia',
        alias: 'MUTUAL.PAGOS',
        cbu: '0000003100012345678901',
        titular: 'Mutual XYZ',
      },
      {
        tipo: 'pago_mis_cuentas',
        codigo: '12345',
        concepto: 'Mutual XYZ',
      },
      {
        tipo: 'rapipago_pagofacil',
        instrucciones: 'Solicitar boleta a la mutual o generar desde la web.',
      },
    ],
    nota: 'Después de pagar, enviar comprobante por este mismo canal.',
  }),
};
