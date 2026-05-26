import { db } from '../data/index.js';
import { inscribir as inscribirCashback } from '../cashback/cashback.js';

// Contexto del turno que el agente inyecta a cada handler (además de los args del LLM).
// Sirve para datos que NO vienen del modelo, como el teléfono de WhatsApp del cliente.
export interface ToolContext {
  telefono: string;
}

type ToolHandler = (input: Record<string, any>, ctx: ToolContext) => Promise<unknown> | unknown;

export const handlers: Record<string, ToolHandler> = {
  verificar_dni: async ({ dni }) => {
    const dniLimpio = String(dni).replace(/\D/g, '');
    const cliente = await db.buscarClientePorDni(dniLimpio);
    if (!cliente) return { verificado: false };
    return { verificado: true, nombre: cliente.nombre };
  },

  consultar_creditos: async ({ dni }) => {
    const dniLimpio = String(dni).replace(/\D/g, '');
    const resumen = await db.getResumenPorDni(dniLimpio);
    if (!resumen) return { encontrado: false };

    const opsActivas = resumen.operaciones.filter(op => op.estado === 'Activa');
    const tieneMora = resumen.saldoEnMora > 0;
    const hoy = new Date();

    // Para cada operación activa calculamos la fecha de la PRÓXIMA cuota a vencer
    // (o la cuota más vieja sin pagar si ya está vencida). Es: primerVto + cuotasPagadas meses.
    const proximasFechas = opsActivas
      .map(op => {
        if (!op.primerVencimiento) return null;
        const fecha = new Date(op.primerVencimiento);
        if (Number.isNaN(fecha.getTime())) return null;
        fecha.setMonth(fecha.getMonth() + op.cuotasPagadas);
        return fecha;
      })
      .filter((d): d is Date => d !== null);

    // La más temprana entre todas las operaciones activas — es la cuota más urgente.
    const fechaRelevante = proximasFechas.length > 0
      ? new Date(Math.min(...proximasFechas.map(d => d.getTime())))
      : null;

    const diasAtraso = fechaRelevante
      ? Math.floor((hoy.getTime() - fechaRelevante.getTime()) / 86_400_000)
      : 0;

    const fechaIso = fechaRelevante ? fechaRelevante.toISOString().slice(0, 10) : null;

    // El consolidador (src/data/consolidador.ts) ya devuelve saldoEnMora y
    // saldoTotal INCLUYENDO los cargos por atraso al día de hoy — misma lógica
    // que el portal de pagos, así bot y portal coinciden al peso.
    const cargoPorAtraso = resumen.cargoPorAtrasoAcumulado;
    const saldoARegularizarHoy = resumen.saldoEnMora;
    const saldoACancelarHoy = resumen.saldoTotal;

    // Datos para evaluar elegibilidad de renovación / nuevo crédito.
    // Tomamos solo PRÉSTAMOS (esCredito=true), no cuota social/asistencia.
    const creditosActivos = opsActivas.filter(op => op.esCredito);
    const creditosCancelados = resumen.operaciones.filter(
      op => op.esCredito && op.estado.toLowerCase() === 'cancelada'
    );
    const porcentajesCredito = creditosActivos
      .filter(op => op.totalCuotas > 0)
      .map(op => Math.round((op.cuotasPagadas / op.totalCuotas) * 100));
    const porcentajeCreditoMaxPagado = porcentajesCredito.length > 0
      ? Math.max(...porcentajesCredito)
      : null;

    return {
      encontrado: true,
      cliente: { nombre: resumen.cliente.nombre },
      // ⭐ DATO PRIMARIO: usar SIEMPRE este resumen agregado.
      // NO descomponer la respuesta por operación — para el cliente la deuda es UNA SOLA.
      resumen: {
        // ⭐ Saldos al día de HOY, ya con cargos por atraso incluidos.
        // Mismos números que ve el cliente en su cuenta corriente online (portal),
        // así no aparece inconsistencia entre canales.
        saldo_total: resumen.saldoTotal,
        saldo_en_mora: resumen.saldoEnMora,
        // Cargos por atraso (punitorios) acumulados al día de hoy. Informativo —
        // ya están sumados en saldo_total y saldo_en_mora.
        cargo_por_atraso: cargoPorAtraso,
        // Alias retrocompat: saldo_a_regularizar_hoy = saldo_en_mora,
        // saldo_a_cancelar_hoy = saldo_total. El prompt referencia estos nombres.
        saldo_a_regularizar_hoy: saldoARegularizarHoy,
        saldo_a_cancelar_hoy: saldoACancelarHoy,

        // Cuota mensual PURA: lo que el cliente paga POR MES si está al día,
        // sin punitorios ni mora. Cuota social al monto vigente HOY (no histórico).
        cuota_mensual_pura: resumen.cuotaMensualTotal,
        estado: tieneMora ? 'en_mora' : 'al_dia',
        hay_prestamo_activo: resumen.hayPrestamoActivo,
        // SI estado === 'en_mora' usá ESTE bloque. NO menciones "próxima cuota" ni "cuándo vence".
        // saldo_vencido_con_cargos es el monto que tiene que pagar HOY para regularizar.
        mora: tieneMora ? {
          saldo_vencido_con_cargos: saldoARegularizarHoy,      // ← usá ESTE
          cargo_por_atraso: cargoPorAtraso,
          dias_atraso_aprox: Math.max(0, diasAtraso),
          fecha_cuota_mas_vieja_vencida: fechaIso,
        } : null,
        // SI estado === 'al_dia' usá ESTE bloque. Decile cuándo vence la próxima.
        al_dia: tieneMora ? null : {
          proxima_cuota_fecha: fechaIso,
        },
        // ⭐ Datos para evaluar renovación / nuevo crédito (ver sección
        // "Renovaciones y nuevos créditos" del system prompt).
        renovacion: {
          tiene_mora_activa: tieneMora,
          // % de cuotas pagadas del crédito activo MÁS avanzado (null si no hay crédito activo).
          porcentaje_credito_pagado: porcentajeCreditoMaxPagado,
          tiene_credito_cancelado: creditosCancelados.length > 0,
          tiene_credito_activo: creditosActivos.length > 0,
        },
      },
      // 🚫 SOLO usar este detalle si el cliente PREGUNTA EXPLÍCITAMENTE por sus productos.
      // NO lo uses para responder "cuánto debo" ni "cuándo vence" — para eso usá `resumen`.
      _detalle_por_producto_solo_si_lo_piden: resumen.operaciones.map(op => ({
        producto: op.producto,
        plan: op.plan,
        es_credito: op.esCredito,
        estado: op.estado,
      })),
    };
  },

  inscribir_cashback: async ({ dni }, ctx) => {
    return await inscribirCashback(String(dni), ctx.telefono);
  },

  obtener_medios_de_pago: () => ({
    medios: [
      // OPCIÓN PREFERIDA: portal autogestionable. Mostrar primero al cliente.
      {
        tipo: 'cuenta_corriente_online',
        url: 'https://mockpagos.vercel.app/login',
        autogestionable: true,
        instrucciones:
          'Desde tu cuenta corriente online podés ver tu saldo en tiempo real, pagar la cuota ' +
          'o el saldo en mora, y revisar tus movimientos. Es la forma más cómoda y rápida — sin ' +
          'esperar a nadie. Ingresá con tu DNI en https://mockpagos.vercel.app/login',
      },
      {
        tipo: 'transferencia',
        autogestionable: true,
        empresa: 'PROTECAP',
        cuit: '30-70954656-9',
        banco: 'Banco Patagonia',
        cuenta_corriente_pesos: '145-145005454-000',
        alias: 'ESPEJO.ASTRO.LITIO',
        cbu: '0340145900145005454004',
      },
      {
        tipo: 'rapipago',
        requiere_asesor_humano: true,
        instrucciones:
          'Para pagar por Rapipago, contactá por WhatsApp a un asesor humano que te genera la boleta. ' +
          'Escribile al +54 9 11 2621-4000 (Lun-Vie 9-17hs). La mutual atiende solo por chat, no recibe llamadas.',
      },
      {
        tipo: 'tarjeta_credito_mercadopago',
        requiere_asesor_humano: true,
        instrucciones:
          'Aceptamos tarjeta de crédito por Mercado Pago. Esta opción se gestiona con un asesor humano: ' +
          'escribile por WhatsApp al +54 9 11 2621-4000 (Lun-Vie 9-17hs). La mutual atiende solo por chat, no recibe llamadas.',
      },
    ],
    contacto_humano: '+54 9 11 2621-4000',
    horario_humano: 'Lunes a Viernes de 9 a 17hs',
    nota:
      'La cuenta corriente online y la transferencia son autogestionables — el cliente puede pagar solo. ' +
      'Rapipago y tarjeta requieren intervención humana. Después de pagar por transferencia, pedir comprobante por el mismo chat.',
  }),
};
