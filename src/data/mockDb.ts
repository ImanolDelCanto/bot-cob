// Mock para desarrollo y testing — implementa el mismo contrato (DataSource) que realDb.
// Cuando se desactiva el mock (USE_MOCK_DB=false), el bot pasa a usar el endpoint real.

import { esProductoPrestamo } from './products.js';
import { calcularResumenConsolidado } from './consolidador.js';
import type { Cliente, DataSource, Operacion } from './types.js';

interface MockClienteRow {
  dni: string;
  nombre: string;
  primerNombre: string;
  telefono: string;
  cuil?: string;
}

interface MockOperacionRow {
  id: string;
  dni: string;
  producto: string;
  plan: string;
  estado: string;
  fechaLiquidacion: string;
  primerVencimiento: string;
  totalCuotas: number;
  cuotasPagadas: number;
  cuotasImpagas: number;
  cuotasImpagasVencidas: number;
  importeCuota: number;
  capitalOriginal: number;
  saldoTotal: number;
  saldoEnMora: number;
  punitorios: number;
}

const clientes: MockClienteRow[] = [
  { dni: '30123456', nombre: 'Juan Pérez',       primerNombre: 'Juan',   telefono: '5491126763301', cuil: '20301234561' },
  { dni: '28987654', nombre: 'María González',   primerNombre: 'María',  telefono: '5491126763301', cuil: '27289876541' },
  { dni: '35111222', nombre: 'Carlos Rodríguez', primerNombre: 'Carlos', telefono: '5491155553333', cuil: '20351112221' },
  { dni: '40555666', nombre: 'Lucía Fernández',  primerNombre: 'Lucía',  telefono: '5491155554444', cuil: '27405556661' },
];

const operaciones: MockOperacionRow[] = [
  // Juan Pérez - préstamo en mora
  {
    id: 'CR-001', dni: '30123456', producto: 'TARJETA DE DEBITO', plan: 'TARJETA Nov 25',
    estado: 'Activa', fechaLiquidacion: '2025-11-15', primerVencimiento: '2025-12-10',
    totalCuotas: 12, cuotasPagadas: 3, cuotasImpagas: 9, cuotasImpagasVencidas: 1,
    importeCuota: 45000, capitalOriginal: 500000, saldoTotal: 380000, saldoEnMora: 45000,
    punitorios: 2300,
  },

  // María González - préstamo recién liquidado (test welcome)
  {
    id: 'CR-002', dni: '28987654', producto: 'TARJETA DE DEBITO', plan: 'TARJETA Abril 26',
    estado: 'Activa', fechaLiquidacion: new Date().toISOString().slice(0, 10), // hoy
    primerVencimiento: '2026-05-15',
    totalCuotas: 18, cuotasPagadas: 0, cuotasImpagas: 18, cuotasImpagasVencidas: 0,
    importeCuota: 50000, capitalOriginal: 800000, saldoTotal: 800000, saldoEnMora: 0,
    punitorios: 0,
  },

  // Carlos Rodríguez - préstamo al día
  {
    id: 'CR-003', dni: '35111222', producto: 'TARJETA DE DEBITO', plan: 'TARJETA Oct 25',
    estado: 'Activa', fechaLiquidacion: '2025-10-01', primerVencimiento: '2025-11-05',
    totalCuotas: 6, cuotasPagadas: 5, cuotasImpagas: 1, cuotasImpagasVencidas: 0,
    importeCuota: 55000, capitalOriginal: 300000, saldoTotal: 55000, saldoEnMora: 0,
    punitorios: 0,
  },

  // Lucía Fernández - préstamo recién liquidado
  {
    id: 'CR-004', dni: '40555666', producto: 'TARJETA DE DEBITO', plan: 'TARJETA Abril 26',
    estado: 'Activa', fechaLiquidacion: new Date().toISOString().slice(0, 10),
    primerVencimiento: '2026-05-20',
    totalCuotas: 9, cuotasPagadas: 0, cuotasImpagas: 9, cuotasImpagasVencidas: 0,
    importeCuota: 32000, capitalOriginal: 250000, saldoTotal: 250000, saldoEnMora: 0,
    punitorios: 0,
  },
];

function rowToCliente(row: MockClienteRow): Cliente {
  return { ...row };
}

function rowToOperacion(row: MockOperacionRow): Operacion {
  return {
    ...row,
    esCredito: esProductoPrestamo(row.producto),
  };
}

export const mockDb: DataSource = {
  async buscarClientePorDni(dni: string) {
    const row = clientes.find(c => c.dni === dni);
    return row ? rowToCliente(row) : undefined;
  },

  async getOperacionesPorDni(dni: string) {
    return operaciones.filter(op => op.dni === dni).map(rowToOperacion);
  },

  async getResumenPorDni(dni: string) {
    const clienteRow = clientes.find(c => c.dni === dni);
    if (!clienteRow) return undefined;
    const ops = operaciones.filter(op => op.dni === dni).map(rowToOperacion);
    return calcularResumenConsolidado(rowToCliente(clienteRow), ops);
  },

  async getPrestamosRecienLiquidados(horasAtras: number) {
    const cutoff = Date.now() - horasAtras * 3_600_000;
    return operaciones
      .map(rowToOperacion)
      .filter(op => {
        if (!op.esCredito) return false;
        if (op.estado !== 'Activa') return false;
        const t = new Date(op.fechaLiquidacion).getTime();
        return !Number.isNaN(t) && t >= cutoff;
      });
  },

  async getOperacionesActivas() {
    return operaciones.map(rowToOperacion).filter(op => op.estado === 'Activa');
  },
};
