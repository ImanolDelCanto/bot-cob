// Descarga de archivos (imágenes, documentos, audios) desde la Cloud API de WhatsApp.
// El flujo es de 2 pasos:
//   1. GET /<media_id> → devuelve { url, mime_type, sha256 } (la URL es temporal)
//   2. GET <url> con Authorization → devuelve el binario
// La URL temporal expira a los pocos minutos, así que hay que descargarla al toque.

import { config } from '../config.js';

export interface DescargaMedia {
  buffer: Buffer;
  mimeType: string;
  sha256?: string;
  size: number;
}

interface MetaMediaInfo {
  url: string;
  mime_type: string;
  sha256?: string;
  file_size?: number;
}

export async function downloadMediaFromMeta(mediaId: string): Promise<DescargaMedia> {
  const { accessToken, apiVersion } = config.whatsapp;
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN no configurado');

  // Paso 1: pedirle a Meta la URL temporal del archivo.
  const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Meta media metadata ${metaRes.status}: ${await metaRes.text().catch(() => '')}`);
  }
  const meta = (await metaRes.json()) as MetaMediaInfo;
  if (!meta.url) throw new Error('Meta no devolvió URL del media');

  // Paso 2: bajar el binario. Atención: hay que mandar el mismo Bearer header.
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Descarga de media ${fileRes.status}: ${await fileRes.text().catch(() => '')}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    buffer,
    mimeType: meta.mime_type,
    sha256: meta.sha256,
    size: buffer.length,
  };
}

// Mapeo simple de mime type a extensión de archivo. Cubre los tipos que típicamente
// llegan a un bot de cobranza (fotos, capturas, PDFs).
export function mimeToExtension(mime: string): string {
  const m = (mime ?? '').toLowerCase().split(';')[0].trim();
  switch (m) {
    case 'image/jpeg': return 'jpg';
    case 'image/jpg':  return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'application/pdf': return 'pdf';
    case 'audio/ogg':  return 'ogg';
    case 'audio/mpeg': return 'mp3';
    default: return 'bin';
  }
}
