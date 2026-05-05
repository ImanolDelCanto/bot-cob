// Selector de fuente de datos: mock (desarrollo) o API real de la mutual (producción).
// El resto del bot importa SIEMPRE desde acá, así no se entera de cuál se está usando.

import { config } from '../config.js';
import { mockDb } from './mockDb.js';
import { mutualApi, warmUpSnapshot } from './mutualApi.js';
import type { DataSource } from './types.js';

export const db: DataSource = config.useMockDb ? mockDb : mutualApi;

console.log(`📦 Data source: ${config.useMockDb ? 'MOCK' : 'mutualApi (HTTP)'}`);

// Warm-up: si estamos usando el endpoint real, pre-cargamos el snapshot en background
// al arrancar el bot. Así el primer cliente del día no paga los ~8 segundos.
if (!config.useMockDb) {
  warmUpSnapshot();
}
