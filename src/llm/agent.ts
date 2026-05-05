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
  let ultimaRonda = -1;
  let ultimaFinishReason: string | undefined;

  for (let ronda = 0; ronda < MAX_TOOL_ROUNDS; ronda++) {
    ultimaRonda = ronda;

    const response = await ai.models.generateContent({
      model: config.model,
      contents: historial,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations }],
      },
    });

    const candidate = response.candidates?.[0];
    ultimaFinishReason = candidate?.finishReason;
    const content = candidate?.content;

    // Acumulamos texto de CADA ronda (no solo la última) — si el modelo manda texto +
    // function call en la misma respuesta, no queremos perder el texto.
    if (content?.parts) {
      for (const part of content.parts) {
        if (part.text) textoFinal += part.text;
      }
    }

    if (!content || !content.parts) {
      console.log(`[chat ${telefono}] ronda ${ronda} sin content. finishReason=${ultimaFinishReason}`);
      break;
    }

    // Guardamos la respuesta del modelo TAL CUAL (con todos sus parts)
    const mensajeModel: Content = { role: 'model', parts: content.parts };
    historial.push(mensajeModel);
    nuevos.push(mensajeModel);

    // ¿Hay function calls que ejecutar?
    const functionCalls = content.parts
      .map(p => p.functionCall)
      .filter((fc): fc is NonNullable<typeof fc> => !!fc);

    const tieneTexto = content.parts.some(p => p.text);
    console.log(
      `[chat ${telefono}] ronda ${ronda} finishReason=${ultimaFinishReason} ` +
      `tools=${functionCalls.map(fc => fc.name).join(',') || '-'} texto=${tieneTexto}`
    );

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

    // No hay function calls → terminamos
    break;
  }

  if (!textoFinal) {
    console.warn(
      `[chat ${telefono}] sin texto de respuesta. ronda=${ultimaRonda} finishReason=${ultimaFinishReason}`
    );
  }

  // Persistimos los mensajes nuevos de este turno en Supabase.
  await appendMessages(telefono, nuevos);

  return textoFinal || '(sin respuesta)';
}
