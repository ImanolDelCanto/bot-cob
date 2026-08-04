// Tipos compartidos entre mockDb y realDb. Cualquier fuente de datos (mock o real)
// debe respetar esta interfaz, así el resto del bot no se entera de cuál se está usando.

export interface Cliente {
  dni: string;
  nombre: string;        // Formato display: "Mario Daniel Gonzalez"
  primerNombre: string;  // Para saludos: "Mario"
  telefono: string;      // Formato WhatsApp: "5493413979584"
  cuil?: string;
}

export interface Operacion {
  id: string;            // "Operación" del endpoint, como string
  dni: string;
  producto: string;      // "TARJETA DE DEBITO", "CUOTA SOCIAL PTC", etc.
  plan: string;
  estado: string;        // "Activa", "Cancelada", etc. (lo que devuelve el endpoint, sin normalizar)
  esCredito: boolean;    // true si Producto es préstamo, false si es addon (cuota social, asistencia)

  fechaLiquidacion: string;  // ISO yyyy-mm-dd
  primerVencimiento: string; // ISO yyyy-mm-dd

  totalCuotas: number;
  cuotasPagadas: number;
  cuotasImpagas: number;
  cuotasImpagasVencidas: number;

  importeCuota: number;     // Monto de cuota mensual en pesos
  capitalOriginal: number;  // Lo que se prestó (0 para addons)
  saldoTotal: number;       // Saldo pendiente total
  saldoEnMora: number;      // Saldo vencido (subset de saldoTotal)
  punitorios: number;
}

// Vista agregada del cliente (para responder consultas tipo "cuánto debo").
// Cuando el cliente tiene varias operaciones (préstamo + cuota social + asist),
// estas funciones suman los relevantes para una respuesta única.
//
// IMPORTANTE: saldoTotal y saldoEnMora YA incluyen los cargos por atraso al día
// de hoy (calculados por el consolidador, igual que el portal de pagos). Para
// ver solo los cargos sin el saldo base, mirar cargoPorAtrasoAcumulado.
export interface ResumenCliente {
  cliente: Cliente;
  operaciones: Operacion[];
  saldoTotal: number;
  saldoEnMora: number;
  cuotaMensualTotal: number;
  cuotasImpagas: number;
  cuotasImpagasVencidas: number;
  hayPrestamoActivo: boolean;
  cargoPorAtrasoAcumulado: number;
  // Cuotas vencidas que quedaron fuera de la ventana de "meses visibles" y por
  // lo tanto NO están sumadas en saldoEnMora. Si es > 0, saldoEnMora está corto
  // y el bot no puede afirmar ni "al día" ni un monto de mora exacto.
  // Ver la explicación larga en consolidador.ts (ResumenConsolidado).
  vencidasOcultas: number;
  saldoVencidoOculto: number;
}

export interface DataSource {
  // Devuelve datos del cliente o undefined si el DNI no existe.
  buscarClientePorDni(dni: string): Promise<Cliente | undefined>;

  // Todas las operaciones (préstamos + addons) de un DNI.
  getOperacionesPorDni(dni: string): Promise<Operacion[]>;

  // Resumen agregado del cliente (cliente + operaciones + totales calculados).
  getResumenPorDni(dni: string): Promise<ResumenCliente | undefined>;

  // Operaciones de tipo PRÉSTAMO liquidadas en las últimas N horas (input para job de bienvenida).
  getPrestamosRecienLiquidados(horasAtras: number): Promise<Operacion[]>;

  // Todas las operaciones con estado 'Activa' (input para jobs proactivos que
  // tienen que recorrer todo el padrón, ej: recordatorio de vencimiento de cuota).
  getOperacionesActivas(): Promise<Operacion[]>;
}
