import { db } from '../data/index.js';
import { config } from '../config.js';
import { inscribir as inscribirCashback } from '../cashback/cashback.js';
import { getCasoLegalPorDni } from '../casos-legales/casos-legales.js';
import {
  getDniVerificado,
  setDniVerificado,
  registrarIntentoFallido,
  MAX_INTENTOS_DNI,
} from '../memory/estado.js';

// El portal se configura por env (PORTAL_PAGOS_URL). Normalizamos la barra final
// para no armar URLs con doble slash cuando alguien la setea con "/" al final.
const urlLogin = `${config.portal.baseUrl.replace(/\/+$/, '')}/login`;

// Contexto del turno que el agente inyecta a cada handler (además de los args del LLM).
// Sirve para datos que NO vienen del modelo, como el teléfono de WhatsApp del cliente.
export interface ToolContext {
  telefono: string;
}

type ToolHandler = (input: Record<string, any>, ctx: ToolContext) => Promise<unknown> | unknown;

export const handlers: Record<string, ToolHandler> = {
  verificar_dni: async ({ dni }, ctx) => {
    const dniLimpio = String(dni).replace(/\D/g, '');
    const cliente = await db.buscarClientePorDni(dniLimpio);

    if (!cliente) {
      // Contamos los fallos server-side. Sin esto (y sin rate limiting en el
      // webhook) se puede barrer el padrón probando DNIs secuenciales.
      const intentos = await registrarIntentoFallido(ctx.telefono);
      return {
        verificado: false,
        intentos_fallidos: intentos,
        ofrecer_humano: intentos >= MAX_INTENTOS_DNI,
      };
    }

    // Verificado: queda registrado el binding teléfono↔DNI. A partir de acá las
    // tools que exponen plata usan ESTE dni, no el que diga el modelo.
    await setDniVerificado(ctx.telefono, dniLimpio);

    // Si el socio está derivado a un estudio jurídico, lo marcamos. El bot
    // tiene la regla de NO seguir el flujo normal en esos casos — explica que
    // su caso lo gestiona el estudio y pasa el contacto.
    const casoLegal = await getCasoLegalPorDni(dniLimpio);
    if (casoLegal) {
      return {
        verificado: true,
        nombre: cliente.nombre,
        en_estudio_legal: true,
        estudio_nombre: casoLegal.estudio_nombre,
        estudio_contacto: casoLegal.estudio_contacto,
      };
    }

    return { verificado: true, nombre: cliente.nombre };
  },

  consultar_creditos: async (_input, ctx) => {
    // El DNI sale del estado del servidor, NO de los argumentos del modelo.
    // Antes el modelo elegía el DNI desde el texto del socio: escribiendo un DNI
    // ajeno se obtenían nombre, saldo, mora y vencimientos de otra persona.
    const dniLimpio = await getDniVerificado(ctx.telefono);
    if (!dniLimpio) {
      return {
        autorizado: false,
        motivo: 'dni_no_verificado',
        instruccion: 'Pedile el DNI al socio y verificalo con verificar_dni antes de consultar nada.',
      };
    }

    // Chequeo de caso legal server-side. Antes vivía solo en el system prompt,
    // así que dependía de que el modelo se acordara de respetarlo.
    const casoLegal = await getCasoLegalPorDni(dniLimpio);
    if (casoLegal) {
      return {
        autorizado: false,
        motivo: 'en_estudio_legal',
        estudio_nombre: casoLegal.estudio_nombre,
        estudio_contacto: casoLegal.estudio_contacto,
        instruccion: 'El caso lo lleva el estudio jurídico. No des saldos ni propongas acuerdos: pasale el contacto del estudio.',
      };
    }

    const resumen = await db.getResumenPorDni(dniLimpio);
    if (!resumen) return { encontrado: false };

    const opsActivas = resumen.operaciones.filter(op => op.estado === 'Activa');

    // Red de seguridad de mesesVisibles: si hay cuotas vencidas fuera de la
    // ventana visible, `saldoEnMora` está corto — y puede dar 0 con el socio
    // teniendo 15 cuotas impagas. En ese caso NO decimos "al día", y marcamos el
    // monto como incompleto para que el bot no lo cante como si fuera exacto.
    const saldoIncompleto = resumen.vencidasOcultas > 0;
    const tieneMora = resumen.saldoEnMora > 0 || saldoIncompleto;
    const hoy = new Date();

    // Para cada operación activa calculamos la fecha de la PRÓXIMA cuota a vencer
    // (o la cuota más vieja sin pagar si ya está vencida). Es: primerVto + cuotasPagadas meses.
    const proximasFechas = opsActivas
      .map(op => {
        if (!op.primerVencimiento) return null;
        const [y, m, d] = op.primerVencimiento.split('-').map(Number);
        if (!y || !m || !d) return null;
        // Suma de meses con clamp al último día del mes destino. `setMonth` sin
        // clamp desborda (31 de enero + 1 mes → 3 de marzo) y le informaba al
        // socio una fecha de vencimiento que no existe en su plan.
        const ultimoDia = new Date(Date.UTC(y, m - 1 + op.cuotasPagadas + 1, 0)).getUTCDate();
        const fecha = new Date(Date.UTC(y, m - 1 + op.cuotasPagadas, Math.min(d, ultimoDia)));
        if (Number.isNaN(fecha.getTime())) return null;
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

    // "¿Cuántas cuotas me quedan?" es de las preguntas más frecuentes y hasta
    // ahora el bot no la podía contestar: el dato existe en la operación pero
    // no llegaba en el resumen, así que el modelo derivaba al portal.
    // Solo lo exponemos si hay UN préstamo activo; con varios, el número
    // agregado no significa nada y es mejor que el bot no invente.
    const cuotasCredito = creditosActivos.length === 1 && creditosActivos[0].totalCuotas > 0
      ? {
          total_cuotas: creditosActivos[0].totalCuotas,
          cuotas_pagadas: creditosActivos[0].cuotasPagadas,
          cuotas_restantes: Math.max(0, creditosActivos[0].totalCuotas - creditosActivos[0].cuotasPagadas),
        }
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
        // Cuotas del préstamo. null si el socio tiene más de un préstamo activo
        // (ahí no hay un número único que tenga sentido) o si no tiene ninguno.
        // Usalo cuando pregunten "cuántas cuotas me quedan" / "cuánto me falta".
        cuotas_credito: cuotasCredito,
        // ⚠️ Si es true, los montos de mora de abajo están INCOMPLETOS (hay cuotas
        // vencidas que el sistema no puede totalizar). Ver regla 12 bis del prompt:
        // el bot NO debe cantar el número, tiene que mandarlo al portal / asesor.
        saldo_incompleto: saldoIncompleto,
        // SI estado === 'en_mora' usá ESTE bloque. NO menciones "próxima cuota" ni "cuándo vence".
        // saldo_vencido_con_cargos es el monto que tiene que pagar HOY para regularizar.
        mora: tieneMora ? {
          saldo_vencido_con_cargos: saldoARegularizarHoy,      // ← usá ESTE
          cargo_por_atraso: cargoPorAtraso,
          dias_atraso_aprox: Math.max(0, diasAtraso),
          fecha_cuota_mas_vieja_vencida: fechaIso,
          // Solo presente cuando saldo_incompleto es true.
          advertencia: saldoIncompleto
            ? 'MONTO INCOMPLETO: hay cuotas vencidas que no están sumadas en este total. NO le des este número al socio como si fuera el saldo real.'
            : undefined,
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

  inscribir_cashback: async (_input, ctx) => {
    // Mismo criterio que consultar_creditos: el DNI lo pone el servidor.
    // Con el DNI viniendo del modelo, un socio podía inscribir el crédito de
    // OTRA persona a su propio teléfono — el titular real quedaba bloqueado
    // (el unique es por credito_id) y el reintegro se transfería al equivocado.
    const dniLimpio = await getDniVerificado(ctx.telefono);
    if (!dniLimpio) {
      return {
        inscripto: false,
        motivo: 'dni_no_verificado',
        instruccion: 'Pedile el DNI al socio y verificalo con verificar_dni antes de inscribirlo.',
      };
    }

    const casoLegal = await getCasoLegalPorDni(dniLimpio);
    if (casoLegal) {
      return { inscripto: false, motivo: 'en_estudio_legal' };
    }

    return await inscribirCashback(dniLimpio, ctx.telefono);
  },

  obtener_medios_de_pago: () => ({
    medios: [
      // OPCIÓN PREFERIDA: portal autogestionable. Mostrar primero al cliente.
      {
        tipo: 'cuenta_corriente_online',
        url: urlLogin,
        autogestionable: true,
        instrucciones:
          'Desde tu cuenta corriente online podés ver tu saldo en tiempo real, pagar la cuota ' +
          'o el saldo en mora, y revisar tus movimientos. Es la forma más cómoda y rápida — sin ' +
          `esperar a nadie. Ingresá con tu DNI en ${urlLogin}`,
      },
      {
        tipo: 'transferencia',
        autogestionable: true,
        empresa: config.pago.empresa,
        cuit: config.pago.cuit,
        banco: config.pago.banco,
        cuenta_corriente_pesos: config.pago.cuentaCorriente,
        alias: config.pago.alias,
        cbu: config.pago.cbu,
      },
      {
        tipo: 'rapipago',
        requiere_asesor_humano: true,
        instrucciones:
          'Para pagar por Rapipago, contactá por WhatsApp a un asesor humano que te genera la boleta. ' +
          `Escribile al ${config.contacto.cobranza} (${config.contacto.horarioHumano}). La mutual atiende solo por chat, no recibe llamadas.`,
      },
      {
        tipo: 'tarjeta_credito_mercadopago',
        requiere_asesor_humano: true,
        instrucciones:
          'Aceptamos tarjeta de crédito por Mercado Pago. Esta opción se gestiona con un asesor humano: ' +
          `escribile por WhatsApp al ${config.contacto.cobranza} (${config.contacto.horarioHumano}). La mutual atiende solo por chat, no recibe llamadas.`,
      },
    ],
    contacto_humano: config.contacto.cobranza,
    horario_humano: config.contacto.horarioHumano,
    nota:
      'La cuenta corriente online y la transferencia son autogestionables — el cliente puede pagar solo. ' +
      'Rapipago y tarjeta requieren intervención humana. Después de pagar por transferencia, pedir comprobante por el mismo chat.',
  }),
};
