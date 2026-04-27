import { GoogleGenAI, type Part } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { functionDeclarations } from '../tools/definitions.js';
import { handlers } from '../tools/handlers.js';
import { getOrCreateHistorial } from '../memory/conversations.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// Cuántas rondas de function-calling permitimos por turno (evita loops infinitos)
const MAX_TOOL_ROUNDS = 6;

export async function chat(telefono: string, mensajeUsuario: string): Promise<string> {
  const historial = getOrCreateHistorial(telefono);

  // Inyectamos el teléfono en la system instruction para que el modelo
  // sepa con quién habla sin tener que pedírselo al usuario.
  const systemConContexto =
    `${SYSTEM_PROMPT}\n\n[CONTEXTO INTERNO] Teléfono del usuario actual: ${telefono}`;

  // Agregamos el nuevo mensaje del usuario al historial
  historial.push({ role: 'user', parts: [{ text: mensajeUsuario }] });

  let textoFinal = '';

  for (let ronda = 0; ronda < MAX_TOOL_ROUNDS; ronda++) {
    const response = await ai.models.generateContent({
      model: config.model,
      contents: historial,
      config: {
        systemInstruction: systemConContexto,
        tools: [{ functionDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    const content = candidate?.content;
    if (!content || !content.parts) break;

    // Guardamos la respuesta del modelo TAL CUAL (con todos sus parts)
    historial.push({ role: 'model', parts: content.parts });

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
      historial.push({ role: 'user', parts: responseParts });
      continue;
    }

    // No hay function calls → extraemos el texto final
    for (const part of content.parts) {
      if (part.text) textoFinal += part.text;
    }
    break;
  }

  return textoFinal || '(sin respuesta)';
}
