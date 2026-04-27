// Mock de la base interna de la mutual.
// Cuando esté el endpoint real, este archivo se reemplaza por un cliente HTTP
// que llame al endpoint, manteniendo la misma firma de funciones.

export type EstadoCredito = 'pendiente' | 'liquidado' | 'cancelado' | 'en_mora';

export interface Cliente {
  dni: string;
  telefono: string; // formato internacional sin +, ej. 5491155551111
  nombre: string;
  fechaNacimiento: string; // ISO yyyy-mm-dd
}

export interface Credito {
  id: string;
  dni: string;
  estado: EstadoCredito;
  monto: number;
  cuotas: number;
  cuotasPagadas: number;
  proximoVencimiento: string; // ISO yyyy-mm-dd
  saldoPendiente: number;
  saldoEnMora: number;
  diasMora: number;
  fechaLiquidacion?: string;
}

const clientes: Cliente[] = [
  { dni: '30123456', telefono: '5491155551111', nombre: 'Juan Pérez',       fechaNacimiento: '1985-03-15' },
  { dni: '28987654', telefono: '5491155552222', nombre: 'María González',   fechaNacimiento: '1980-07-22' },
  { dni: '35111222', telefono: '5491155553333', nombre: 'Carlos Rodríguez', fechaNacimiento: '1990-11-10' },
  { dni: '40555666', telefono: '5491155554444', nombre: 'Lucía Fernández',  fechaNacimiento: '1995-02-28' },
];

const creditos: Credito[] = [
  // Cliente con un crédito en mora
  { id: 'CR-001', dni: '30123456', estado: 'en_mora',   monto: 500000, cuotas: 12, cuotasPagadas: 3,
    proximoVencimiento: '2026-05-10', saldoPendiente: 380000, saldoEnMora: 45000, diasMora: 17 },

  // Cliente con un crédito recién liquidado (debería disparar bienvenida)
  { id: 'CR-002', dni: '28987654', estado: 'liquidado', monto: 800000, cuotas: 18, cuotasPagadas: 0,
    proximoVencimiento: '2026-05-15', saldoPendiente: 800000, saldoEnMora: 0, diasMora: 0,
    fechaLiquidacion: '2026-04-25' },

  // Cliente con un crédito al día
  { id: 'CR-003', dni: '35111222', estado: 'pendiente', monto: 300000, cuotas: 6,  cuotasPagadas: 5,
    proximoVencimiento: '2026-05-05', saldoPendiente: 55000,  saldoEnMora: 0, diasMora: 0 },

  // Otro recién liquidado para probar el job de bienvenidas
  { id: 'CR-004', dni: '40555666', estado: 'liquidado', monto: 250000, cuotas: 9,  cuotasPagadas: 0,
    proximoVencimiento: '2026-05-20', saldoPendiente: 250000, saldoEnMora: 0, diasMora: 0,
    fechaLiquidacion: '2026-04-26' },
];

export function buscarClientePorTelefono(telefono: string): Cliente | undefined {
  return clientes.find(c => c.telefono === telefono);
}

export function buscarClientePorDni(dni: string): Cliente | undefined {
  return clientes.find(c => c.dni === dni);
}

export function getCreditosPorDni(dni: string): Credito[] {
  return creditos.filter(c => c.dni === dni);
}

export function getCreditosLiquidados(): Credito[] {
  return creditos.filter(c => c.estado === 'liquidado');
}
