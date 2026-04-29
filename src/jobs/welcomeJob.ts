import { fileURLToPath } from 'node:url';
import {
  getCreditosLiquidados,
  buscarClientePorDni,
} from '../data/mockDb.js';

// MVP en memoria: registro de a quién ya saludamos.
// Cuando esto sea producción va a una tabla de la base del bot.
const yaSaludados = new Set<string>();

function plantillaBienvenida(nombre: string, monto: number, creditoId: string): string {
  const montoFmt = monto.toLocaleString('es-AR');
  return (
    `Hola ${nombre}! 👋\n\n` +
    `Te damos la bienvenida a Mutual Protecap. Tu préstamo ${creditoId} por $${montoFmt} fue acreditado correctamente.\n\n` +
    `Cualquier consulta sobre cuotas, vencimientos o medios de pago, escribime por acá. ¡Estamos para ayudarte!`
  );
}

export function correrJobBienvenidas(): void {
  const liquidados = getCreditosLiquidados();
  let enviados = 0;

  for (const c of liquidados) {
    if (yaSaludados.has(c.id)) continue;
    const cliente = buscarClientePorDni(c.dni);
    if (!cliente) continue;

    const mensaje = plantillaBienvenida(cliente.nombre, c.monto, c.id);

    // En el MVP simulamos el envío imprimiendo en consola.
    // Cuando esté WhatsApp habilitado, acá se llama al cliente del BSP/Cloud API.
    console.log('\n=== ENVIO BIENVENIDA ===');
    console.log(`Para:    ${cliente.nombre} (+${cliente.telefono})`);
    console.log(`Crédito: ${c.id} | Monto: $${c.monto.toLocaleString('es-AR')}`);
    console.log('Mensaje:');
    console.log(mensaje);
    console.log('========================\n');

    yaSaludados.add(c.id);
    enviados++;
  }

  console.log(`Bienvenidas enviadas en esta corrida: ${enviados}`);
}

// Si se ejecuta este archivo directamente (npm run welcome-job), corre una vez.
const esEjecucionDirecta =
  import.meta.url === `file://${fileURLToPath(import.meta.url)}` ||
  process.argv[1]?.endsWith('welcomeJob.ts') ||
  process.argv[1]?.endsWith('welcomeJob.js');

if (esEjecucionDirecta) {
  correrJobBienvenidas();
}
