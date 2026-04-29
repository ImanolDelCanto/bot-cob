import { GoogleGenAI, type Content, type Part } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { functionDeclarations } from '../tools/definitions.js';
import { handlers } from '../tools/handlers.js';
import { getHistorial, appendMessages } from '../memory/conversations.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// Cuántas rondas de function-calling permitimos por turno (evita loops infinitos)
const MAX_TOOL_ROUNDS = 6;

export async function chat(telefono: string, mensajeUsuario: string): Promise<string> {
  // Cargamos lo persistido en Supabase y trabajamos con una copia en memoria.
  const historialPrevio = await getHistorial(telefono);
  const historial: Content[] = [...historialPrevio];

  // Trackeamos los mensajes nuevos de este turno para guardarlos al final en una sola llamada.
  const nuevos: Content[] = [];

  const mensajeUser: Content = { role: 'user', parts: [{ text: mensajeUsuario }] };
  historial.push(mensajeUser);
  nuevos.push(mensajeUser);

  let textoFinal = '';

  for (let ronda = 0; ronda < MAX_TOOL_ROUNDS; ronda++) {
    const response = await ai.models.generateContent({
      model: config.model,
      contents: historial,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    const content = candidate?.content;
    if (!content || !content.parts) break;

    // Guardamos la respuesta del modelo TAL CUAL (con todos sus parts)
    const mensajeModel: Content = { role: 'model', parts: content.parts };
    historial.push(mensajeModel);
    nuevos.push(mensajeModel);

    // ¿Hay function calls que ejecutar?
    const functionCalls = content.parts
      .map(p => p.functionCall)
      .filter((fc): fc is NonNullable<typeof fc> => !!fc);

    if (functionCalls.length > 0) {
      const responseParts: Part[] = [];
      for (const fc of functionCalls) {
        const handler = fc.name ? handlers[fc.name] : undefined;
        let resultado: any;
        try {
          resultado = handler
            ? await handler((fc.args ?? {}) as Record<string, any>)
            : { error: `Tool desconocida: ${fc.name}` };
        } catch (err: any) {
          resultado = { error: String(err?.message ?? err) };
        }
        responseParts.push({
          functionResponse: {
            name: fc.name!,
            response: resultado,
          },
        });
      }
      // En Gemini, los function responses se mandan con role 'user'
      const mensajeTool: Content = { role: 'user', parts: responseParts };
      historial.push(mensajeTool);
      nuevos.push(mensajeTool);
      continue;
    }

    // No hay function calls → extraemos el texto final
    for (const part of content.parts) {
      if (part.text) textoFinal += part.text;
    }
    break;
  }

  // Persistimos los mensajes nuevos de este turno en Supabase.
  await appendMessages(telefono, nuevos);

  return textoFinal || '(sin respuesta)';
}
