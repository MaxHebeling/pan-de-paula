/** Meta / Instagram Messaging — contrato del adaptador (webhooks + envío + bot). */
export function isInstagramConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_PAGE_ACCESS_TOKEN && process.env.META_APP_SECRET);
}

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con META_APP_SECRET). */
export function verifyMetaSignature(
  _rawBody: string,
  _signatureHeader: string | null,
  _appSecret: string | undefined,
): boolean {
  return false;
}

export async function sendInstagramMessage(_input: {
  recipientId: string;
  text: string;
}): Promise<{ messageId: string }> {
  throw new Error("sendInstagramMessage: pendiente de implementación");
}

export type BotReply = {
  text: string;
  intent: string;
  leadInterest?: string | null;
  productId?: string | null;
  link?: string | null;
};

/** Genera la respuesta del bot a partir de una consulta (reglas + catálogo; IA opcional detrás de flag). */
export async function buildBotReply(_input: { text: string; siteUrl: string }): Promise<BotReply> {
  throw new Error("buildBotReply: pendiente de implementación");
}
