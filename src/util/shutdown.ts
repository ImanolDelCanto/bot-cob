// Estado de apagado del proceso.
//
// Railway manda SIGTERM en cada deploy y mata con SIGKILL unos segundos después.
// Sin nada que lo escuche, cada deploy costaba tres cosas:
//
//   1. Si el proceso moría entre la reserva en `sent_messages` y el envío real,
//      la marca quedaba puesta para siempre y ese socio NUNCA recibía su aviso,
//      sin ningún log que lo dijera.
//   2. Los mensajes en el buffer de debounce (hasta 10s de conversación) se
//      evaporaban. Meta ya había recibido el 200, así que no reintenta: el socio
//      escribió y el bot nunca contestó.
//   3. Una corrida de vencimiento-aviso a mitad de camino quedaba cortada en un
//      punto arbitrario.
//
// Los jobs consultan `estaCerrando()` entre envíos y cortan prolijo.

let cerrando = false;

export function estaCerrando(): boolean {
  return cerrando;
}

export function marcarCerrando(): void {
  cerrando = true;
}
