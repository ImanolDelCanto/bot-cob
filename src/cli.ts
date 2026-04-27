import readline from 'node:readline';
import { chat } from './llm/agent.js';
import { resetHistorial } from './memory/conversations.js';

// Permite pasar el teléfono como argumento: npm run chat -- 5491155551111
// Si no se pasa, usa Juan Pérez (el que tiene crédito en mora) por defecto.
const telefono = process.argv[2] ?? '5491155551111';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`💬 Chat con el bot. Teléfono simulado: ${telefono}`);
console.log(`   Comandos: "salir" termina, "reset" limpia el historial.\n`);

const ask = (): void => {
  rl.question('Vos: ', async (line) => {
    const msg = line.trim();
    if (!msg) return ask();
    if (msg === 'salir') { rl.close(); return; }
    if (msg === 'reset') {
      resetHistorial(telefono);
      console.log('(historial limpio)\n');
      return ask();
    }
    try {
      const r = await chat(telefono, msg);
      console.log(`Bot: ${r}\n`);
    } catch (err: any) {
      console.error(`Error: ${err?.message ?? err}\n`);
    }
    ask();
  });
};

ask();
