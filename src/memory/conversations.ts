import type { Content } from '@google/genai';

// Memoria en RAM. Para MVP alcanza. En producción esto va a Postgres/Redis.
const memoria = new Map<string, Content[]>();

export function getOrCreateHistorial(telefono: string): Content[] {
  let h = memoria.get(telefono);
  if (!h) {
    h = [];
    memoria.set(telefono, h);
  }
  return h;
}

export function resetHistorial(telefono: string): void {
  memoria.delete(telefono);
}
