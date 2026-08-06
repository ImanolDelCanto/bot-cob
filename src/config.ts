import dotenv from 'dotenv';
dotenv.config({ override: true });

// ─── Lectores de env ────────────────────────────────────────────────────────
//
// Todos los lectores acumulan sus problemas en `errores` en vez de tirar de a
// uno. Así un deploy al que le faltan 6 variables las ve TODAS en el primer
// arranque, en vez de descubrirlas de a una en seis deploys fallidos.

const errores: string[] = [];

function requerido(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    errores.push(`${name} es obligatoria y no está seteada.`);
    return '';
  }
  return v.trim();
}

// Lee una variable numérica con default.
//
// Variable ausente o vacía → default. (Railway deja setear variables vacías;
// antes `Number('')` daba 0 y eso apagaba en silencio la ventana horaria de los
// jobs, el tope de envíos o los punitorios de toda la cartera.)
//
// Variable presente pero impersable → ERROR de arranque, no default. Si alguien
// escribió `0,005` con coma decimal (el error típico acá) queriendo 0.5%, caer
// al default sería peor que fallar: el bot arranca sano y factura con un número
// que nadie eligió. Y un NaN es peor todavía — no explota, se propaga hasta que
// `saldoEnMora` es NaN, `NaN > 0` es false y el bot le dice "estás al día" a un
// socio en mora.
function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errores.push(`${name}="${raw}" no es un número válido (¿coma decimal en vez de punto?).`);
    return def;
  }
  return n;
}

// Booleano explícito. Solo 'true'/'1' prenden; cualquier otra cosa apaga.
// Nunca uses `!== 'false'` para algo peligroso: 'FALSE ', '0' o un typo
// terminan prendiendo el modo que querías apagar.
function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'si', 'sí', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  errores.push(`${name}="${raw}" no es booleano (usá true o false).`);
  return def;
}

function enRango(name: string, valor: number, min: number, max: number): void {
  if (!(valor >= min && valor <= max)) {
    errores.push(`${name}=${valor} está fuera de rango (esperado entre ${min} y ${max}).`);
  }
}

// ─── Modo ───────────────────────────────────────────────────────────────────
//
// USE_MOCK_DB define contra qué datos corre el bot. Antes defaulteaba a `true`,
// o sea que un deploy sin la variable atendía a la cartera real con los 4
// socios ficticios de mockDb.ts: `verificar_dni` fallaba para el 100% de los
// socios. El default seguro es el contrario — el modo peligroso se pide
// explícito.
const useMockDb = boolEnv('USE_MOCK_DB', false);

// "Producción" acá = estamos pegándole al endpoint real de la mutual, o sea
// que del otro lado hay socios de verdad. Es mejor señal que NODE_ENV, que en
// Railway/Nixpacks puede venir seteado por el builder sin que nadie lo decida.
const modoProduccion = !useMockDb;

// Igual que `requerido`, pero solo exige la variable cuando estamos apuntando a
// datos reales. En modo mock devuelve el default para no romper el dev local.
function requeridoEnProd(name: string, def: string, motivo: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (modoProduccion) {
    errores.push(`${name} es obligatoria cuando USE_MOCK_DB=false (${motivo}).`);
    return '';
  }
  return def;
}

export const config = {
  geminiApiKey: requerido('GEMINI_API_KEY'),
  model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  port: numEnv('PORT', 3000),
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
    // App Secret de la app de Meta. Se usa para verificar el HMAC-SHA256 de cada
    // webhook entrante (header X-Hub-Signature-256). Conseguir en
    // developers.facebook.com → tu app → Configuración → Básica → App Secret.
    //
    // Antes era opcional: si faltaba, el webhook logueaba un warning y procesaba
    // igual cualquier POST sin firma. Eso permite a cualquiera que conozca la URL
    // escribir en el historial de conversación de cualquier teléfono (inyección
    // persistente en el contexto del LLM) y quemar Gemini a una llamada por
    // request. Ahora se exige — ver `validarConfig`.
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
    // Escotilla de emergencia para debug local contra un túnel sin firma.
    // NUNCA en producción: la validación de abajo la rechaza si USE_MOCK_DB=false.
    permitirSinFirma: boolEnv('ALLOW_UNSIGNED_WEBHOOK', false),
  },
  supabase: {
    url: requerido('SUPABASE_URL'),
    serviceRoleKey: requerido('SUPABASE_SERVICE_ROLE_KEY'),
    // Nombre del bucket privado donde guardamos comprobantes recibidos por WhatsApp.
    bucketComprobantes: process.env.SUPABASE_BUCKET_COMPROBANTES ?? 'comprobantes',
  },
  // Cuántos mensajes del historial le mandamos a Gemini en cada turno.
  // Si la conversación crece más, se envían solo los últimos N.
  historyLimit: numEnv('CONVERSATION_HISTORY_LIMIT', 60),
  // Ventana de "silencio" para agrupar mensajes consecutivos del mismo teléfono
  // antes de invocar al LLM. Si el cliente manda 2-3 mensajes seguidos (típico
  // en WhatsApp donde la gente piensa en voz alta), los juntamos y respondemos
  // una sola vez. En 0 se desactiva el debounce.
  // 10s probó ser suficiente para capturar tandas típicas de 3-4 mensajes
  // sin sentirse lento en mensajes únicos.
  messageDebounceMs: numEnv('MESSAGE_DEBOUNCE_MS', 10000),
  // Token para proteger /admin/*, /chat y /reset. Si está vacío, esos endpoints
  // devuelven 503 (deshabilitados). En producción se exige.
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Ventana horaria (zona horaria Argentina, UTC-3) en la que los jobs proactivos
  // pueden enviar mensajes. start es inclusivo, end es exclusivo.
  // Default: 10-21 = entre las 10:00 y las 20:59.
  jobs: {
    hourStart: numEnv('JOBS_HOUR_START', 10),
    hourEnd: numEnv('JOBS_HOUR_END', 21),
    // Si true, el server corre los jobs proactivos (welcome, cashback-aviso) solo,
    // con un scheduler en proceso. Si false, hay que dispararlos a mano por /admin/jobs/*.
    // Igual NO corre si WhatsApp no está configurado (no tiene sentido mandar mensajes).
    schedulerEnabled: boolEnv('JOBS_SCHEDULER_ENABLED', true),
    // Cada cuántas horas corre cada job. El horario (hourStart/hourEnd) igual los frena fuera de ventana.
    welcomeEveryHours: numEnv('JOBS_WELCOME_EVERY_HOURS', 2),
    cashbackAvisoEveryHours: numEnv('JOBS_CASHBACK_EVERY_HOURS', 6),
    // Recordatorio de vencimiento: lo corremos cada 6h (idempotente, así un solo
    // disparo del día efectivamente manda). Pensado para que la primera corrida
    // del día caiga dentro de la ventana matinal.
    vencimientoAvisoEveryHours: numEnv('JOBS_VENCIMIENTO_EVERY_HOURS', 6),

    // ─── Control de volumen de mensajes proactivos ───────────────────────────
    // Meta limita cuántos socios DISTINTOS podés contactar vos primero cada 24hs
    // (tier de mensajería: 250 → 1.000 → 10.000 → 100.000). Un número nuevo
    // arranca en 250, y pasarse castiga la calidad del número.
    //
    // Tope de envíos por CORRIDA de cada job. Lo que queda afuera NO se pierde:
    // se loguea y se reintenta en la corrida siguiente (la idempotencia por
    // sent_messages evita duplicar lo ya enviado).
    //
    // OJO: este tope NO acota el límite de 24hs de Meta por sí solo — se
    // resetea en cada corrida. El que sí lo acota es `maxEnvios24h`.
    maxEnviosPorCorrida: numEnv('JOBS_MAX_ENVIOS_POR_CORRIDA', 60),
    // Tope de socios distintos contactados por iniciativa propia en las últimas
    // 24hs, COMPARTIDO entre los tres jobs y contado contra sent_messages (o
    // sea que sobrevive a un reinicio y a los disparos manuales de /admin/jobs/*).
    // Default 200: deja margen abajo del tier inicial de 250 de Meta.
    // Subilo recién cuando Meta te suba de tier.
    maxEnvios24h: numEnv('JOBS_MAX_ENVIOS_24H', 200),
    // Pausa entre envíos consecutivos, para no ráfagar la API de WhatsApp.
    delayEntreEnviosMs: numEnv('JOBS_DELAY_ENTRE_ENVIOS_MS', 1000),
  },
  // Programa de cashback: reintegro de un % de la primera cuota del crédito
  // si el socio paga en tiempo y forma. Ver src/cashback/cashback.ts.
  cashback: {
    // Porcentaje de la cuota que se reintegra. 0.10 = 10%.
    porcentaje: numEnv('CASHBACK_PORCENTAJE', 0.1),
    // Cuántos días antes del primer vencimiento se manda el aviso recordatorio.
    avisoDiasAntes: numEnv('CASHBACK_AVISO_DIAS_ANTES', 2),
  },
  // Cargos por atraso (punitorios). Defaults validados contra el sistema de la
  // mutual. Vivían en data/cargosAtraso.ts leyendo process.env en el top-level
  // del módulo: si ese archivo se importaba antes que config.ts, dotenv todavía
  // no había corrido y se usaban los defaults sin aviso.
  cargos: {
    tasaDiaria: numEnv('CARGOS_TASA_DIARIA', 0.005),
    cargoAdministrativo: numEnv('CARGOS_CARGO_ADMINISTRATIVO', 0.1),
    topeMaximo: numEnv('CARGOS_TOPE_MAXIMO', 1.1),
    umbralDiasCargoFijo: numEnv('CARGOS_UMBRAL_DIAS', 1),
  },
  // Datos de contacto y de pago que el bot le dicta a los socios. Estaban
  // hardcodeados en prompts.ts y tools/handlers.ts — incluido un teléfono de
  // asesor que era un placeholder (+54 9 11 1234-5678) y que se le pasó como
  // dato real a todo socio que preguntó por renovar.
  contacto: {
    // Cobranza / soporte del bot. Es el número por el que atiende la mutual.
    cobranza: requeridoEnProd('CONTACTO_COBRANZA_TELEFONO', '+54 9 11 2621-4000', 'el bot lo dicta al derivar a un humano'),
    // Ventas: OTRO número, para renovaciones y créditos nuevos. No tiene default
    // válido — el que estaba en el prompt era un placeholder.
    ventas: requeridoEnProd('CONTACTO_VENTAS_TELEFONO', '+54 9 11 1234-5678', 'el bot la dicta al derivar una renovación'),
    horarioHumano: process.env.CONTACTO_HORARIO ?? 'Lunes a Viernes de 9 a 17hs',
  },
  portal: {
    // Portal de pago autogestionable. `mockpagos.vercel.app` es el dominio de
    // desarrollo: un dominio gratuito de terceros, con la palabra "mock"
    // adentro, dictado en el mensaje donde le pedís plata al socio.
    baseUrl: requeridoEnProd('PORTAL_PAGOS_URL', 'https://mockpagos.vercel.app', 'el bot la dicta como medio de pago principal'),
  },
  // Datos bancarios para transferencias. Antes hardcodeados en handlers.ts.
  // En producción se exigen explícitos para que alguien los confirme contra la
  // cuenta de cobranza vigente de la mutual antes de cada deploy.
  pago: {
    empresa: process.env.PAGO_EMPRESA ?? 'PROTECAP',
    cuit: requeridoEnProd('PAGO_CUIT', '30-70954656-9', 'el socio transfiere a esta cuenta'),
    banco: requeridoEnProd('PAGO_BANCO', 'Banco Patagonia', 'el socio transfiere a esta cuenta'),
    cuentaCorriente: requeridoEnProd('PAGO_CUENTA_CORRIENTE', '145-145005454-000', 'el socio transfiere a esta cuenta'),
    alias: requeridoEnProd('PAGO_ALIAS', 'ESPEJO.ASTRO.LITIO', 'el socio transfiere a esta cuenta'),
    cbu: requeridoEnProd('PAGO_CBU', '0340145900145005454004', 'el socio transfiere a esta cuenta'),
  },
  // Toggle para alternar entre mock y endpoint real de la mutual.
  // false → endpoint real (default; requiere ENDPOINT_* configurados)
  // true  → mock embebido en src/data/mockDb.ts (dev/testing, hay que pedirlo)
  useMockDb,
  modoProduccion,
  endpoint: {
    baseUrl: requeridoEnProd('ENDPOINT_BASE_URL', '', 'sin esto no hay datos del socio'),
    ticket: requeridoEnProd('ENDPOINT_TICKET', '', 'sin esto no hay datos del socio'),
    empresaId: numEnv('ENDPOINT_EMPRESA_ID', 0),
    timeoutMs: numEnv('ENDPOINT_TIMEOUT_MS', 30_000),
    // TTL del cache en memoria del snapshot completo. Default 5 min.
    // Subirlo si los datos cambian poco; bajarlo si necesitás info más fresca.
    cacheTtlMs: numEnv('ENDPOINT_CACHE_TTL_MS', 300_000),
    // Cuánto tiempo MÁS allá del TTL seguimos sirviendo el snapshot viejo
    // mientras se refresca en background. El endpoint tarda ~30-50s en
    // responder: sin esto, el socio que escribe justo cuando vence el TTL
    // espera todo eso para recibir su saldo. Default 30 min.
    staleMaxMs: numEnv('ENDPOINT_STALE_MAX_MS', 1_800_000),
  },
};

export function isWhatsAppConfigured(): boolean {
  const w = config.whatsapp;
  return !!(w.verifyToken && w.accessToken && w.phoneNumberId);
}

// ─── Validación de arranque ─────────────────────────────────────────────────
//
// Corre al importar el módulo. Si algo no cierra, el proceso NO arranca: es
// preferible un deploy que falla ruidoso a uno que levanta sano, devuelve 200
// en /health y recién le miente al primer socio que escribe.

function validarConfig(): void {
  // Rangos. Una variable mal tipeada acá no explota sola: produce números
  // coherentes pero equivocados, que es mucho peor.
  enRango('CARGOS_TASA_DIARIA', config.cargos.tasaDiaria, 0, 0.05);
  enRango('CARGOS_CARGO_ADMINISTRATIVO', config.cargos.cargoAdministrativo, 0, 1);
  enRango('CARGOS_UMBRAL_DIAS', config.cargos.umbralDiasCargoFijo, 0, 365);
  if (!(config.cargos.topeMaximo > 0)) {
    errores.push(`CARGOS_TOPE_MAXIMO=${config.cargos.topeMaximo} debe ser mayor a 0 (en 0 se anulan los punitorios de toda la cartera sin que se note).`);
  }
  if (!(config.cashback.porcentaje > 0 && config.cashback.porcentaje < 1)) {
    errores.push(`CASHBACK_PORCENTAJE=${config.cashback.porcentaje} debe estar entre 0 y 1 (0.1 = 10%). En 0 el bot promete "$0 de reintegro".`);
  }
  enRango('CASHBACK_AVISO_DIAS_ANTES', config.cashback.avisoDiasAntes, 0, 30);

  const { hourStart, hourEnd } = config.jobs;
  if (!(hourStart >= 0 && hourStart < hourEnd && hourEnd <= 24)) {
    errores.push(`Ventana horaria inválida: JOBS_HOUR_START=${hourStart}, JOBS_HOUR_END=${hourEnd} (se espera 0 ≤ start < end ≤ 24). Fuera de rango los jobs no mandan nunca.`);
  }
  enRango('JOBS_MAX_ENVIOS_POR_CORRIDA', config.jobs.maxEnviosPorCorrida, 1, 100_000);
  enRango('JOBS_MAX_ENVIOS_24H', config.jobs.maxEnvios24h, 1, 1_000_000);
  enRango('JOBS_DELAY_ENTRE_ENVIOS_MS', config.jobs.delayEntreEnviosMs, 0, 60_000);
  enRango('CONVERSATION_HISTORY_LIMIT', config.historyLimit, 2, 1000);
  enRango('MESSAGE_DEBOUNCE_MS', config.messageDebounceMs, 0, 120_000);
  enRango('PORT', config.port, 1, 65_535);
  for (const h of ['welcomeEveryHours', 'cashbackAvisoEveryHours', 'vencimientoAvisoEveryHours'] as const) {
    if (!(config.jobs[h] > 0)) {
      errores.push(`La frecuencia de jobs "${h}" es ${config.jobs[h]} y debe ser mayor a 0 (en 0 o negativo, setInterval se vuelve un loop cerrado).`);
    }
  }

  if (modoProduccion) {
    if (!config.endpoint.empresaId) {
      errores.push('ENDPOINT_EMPRESA_ID es obligatoria cuando USE_MOCK_DB=false.');
    }
    if (!config.adminToken) {
      errores.push('ADMIN_TOKEN es obligatoria cuando USE_MOCK_DB=false (sin él, /admin/*, /chat y /reset quedan deshabilitados).');
    }
    if (isWhatsAppConfigured() && !config.whatsapp.appSecret && !config.whatsapp.permitirSinFirma) {
      errores.push('WHATSAPP_APP_SECRET es obligatoria cuando WhatsApp está configurado: sin ella el webhook acepta cualquier POST sin verificar la firma de Meta.');
    }
    if (config.whatsapp.permitirSinFirma) {
      errores.push('ALLOW_UNSIGNED_WEBHOOK=true no se admite con USE_MOCK_DB=false. Es solo para debug local.');
    }
    // OJO: `mockpagos` NO es un mock. Es el portal Next.js real de la mutual —
    // el nombre de la carpeta es un accidente histórico. Este check nació de esa
    // confusión y bloqueaba el arranque con el dominio correcto, así que queda
    // como advertencia: el punto que sí sigue en pie es que es un dominio
    // gratuito de terceros, con "mock" en el nombre, dictado en el mensaje donde
    // se le pide plata al socio. Cuando haya dominio propio, cambiar la env.
    if (config.portal.baseUrl.includes('mockpagos')) {
      console.warn(
        '⚠️  PORTAL_PAGOS_URL apunta a mockpagos.vercel.app. Es el portal real, ' +
        'pero es un dominio gratuito de terceros y el nombre confunde: el bot se lo ' +
        'dicta a los socios como medio de pago principal. Conviene un dominio propio.'
      );
    }
  }

  if (errores.length > 0) {
    const detalle = errores.map((e) => `  • ${e}`).join('\n');
    throw new Error(
      `\n\n❌ Configuración inválida — el bot no arranca.\n\n${detalle}\n\n` +
      `Modo actual: USE_MOCK_DB=${useMockDb} (${modoProduccion ? 'PRODUCCIÓN: datos reales de la mutual' : 'mock: datos de prueba'}).\n` +
      `Para desarrollo local poné USE_MOCK_DB=true en tu .env.\n`
    );
  }
}

validarConfig();
