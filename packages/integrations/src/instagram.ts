/**
 * Meta / Instagram Messaging — webhooks, envío y bot de respuestas.
 *
 * Referencias oficiales consultadas (2026-09):
 * - Webhooks (verificación GET hub.mode/hub.verify_token/hub.challenge; POST con X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret)):
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *   https://developers.facebook.com/docs/instagram-platform/webhooks
 * - Payload de mensajes (object "instagram", entry[].messaging[] con sender.id, recipient.id, message.mid/text/is_echo/attachments):
 *   https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook
 * - Send API: POST https://graph.instagram.com/v25.0/{ig-id}/messages  body {recipient:{id}, message:{text}}  (texto ≤ 1000 bytes UTF-8, ventana de 24 h)
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 *   Con Facebook Login (cuenta IG ligada a una Página) el endpoint es https://graph.facebook.com/v25.0/{page-id}/messages con Page Access Token:
 *   configurable con INSTAGRAM_API_BASE. Verificar en cuenta real cuál aplica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql, type Database, type Transaction, type DB } from "@pdp/db";
import { NotConfiguredError } from "./errors.ts";
import { fetchWithResilience } from "./http.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("instagram");

export const INSTAGRAM_API_BASE_DEFAULT = "https://graph.instagram.com/v25.0";
export const INSTAGRAM_TEXT_MAX_BYTES = 1000;

export function isInstagramConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_PAGE_ACCESS_TOKEN && process.env.META_APP_SECRET);
}

// ── Firma ───────────────────────────────────────────────────────────────────

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con META_APP_SECRET). Tiempo constante. */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const [scheme, hex] = signatureHeader.trim().split("=");
  if (scheme !== "sha256" || !hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hex, "hex");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Solo tests/fixtures. */
export function signMetaPayload(rawBody: string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

/** Verificación del webhook (GET). Devuelve el challenge a responder o null si no coincide. */
export function verifyMetaWebhookChallenge(
  query: { get(name: string): string | null },
  verifyToken: string | undefined,
): string | null {
  if (!verifyToken) return null;
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (mode !== "subscribe" || !token || !challenge) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

// ── Payload ─────────────────────────────────────────────────────────────────

export type IgIncomingMessage = {
  igAccountId: string; // entry.id (nuestra cuenta)
  senderId: string; // IGSID del cliente
  recipientId: string;
  mid: string | null;
  text: string | null;
  attachments: Array<{ type: string; url?: string }>;
  timestamp: number | null;
  isEcho: boolean;
  isDeleted: boolean;
  kind: "message" | "postback" | "read" | "reaction" | "other";
  postbackPayload?: string | null;
};

/** Extrae los eventos de mensajería de un payload de webhook de Instagram. Ignora lo que no es mensaje. */
export function parseInstagramWebhook(body: unknown): IgIncomingMessage[] {
  const out: IgIncomingMessage[] = [];
  if (!body || typeof body !== "object") return out;
  const b = body as { object?: string; entry?: unknown[] };
  if (b.object !== "instagram" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry as Array<Record<string, unknown>>) {
    const igAccountId = String(entry.id ?? "");
    const events = Array.isArray(entry.messaging)
      ? (entry.messaging as Array<Record<string, unknown>>)
      : Array.isArray(entry.standby)
        ? (entry.standby as Array<Record<string, unknown>>)
        : [];
    for (const ev of events) {
      const sender = (ev.sender as { id?: unknown } | undefined)?.id;
      const recipient = (ev.recipient as { id?: unknown } | undefined)?.id;
      if (!sender || !recipient) continue;
      const msg = ev.message as Record<string, unknown> | undefined;
      const postback = ev.postback as Record<string, unknown> | undefined;
      const kind: IgIncomingMessage["kind"] = msg
        ? "message"
        : postback
          ? "postback"
          : ev.read
            ? "read"
            : ev.reaction
              ? "reaction"
              : "other";
      const attachments = Array.isArray(msg?.attachments)
        ? (msg!.attachments as Array<Record<string, unknown>>).map((a) => ({
            type: String(a.type ?? "unknown"),
            url: (a.payload as { url?: string } | undefined)?.url,
          }))
        : [];
      out.push({
        igAccountId,
        senderId: String(sender),
        recipientId: String(recipient),
        mid: (msg?.mid as string | undefined) ?? (postback?.mid as string | undefined) ?? null,
        text:
          typeof msg?.text === "string"
            ? msg.text
            : typeof postback?.title === "string"
              ? postback.title
              : null,
        attachments,
        timestamp: typeof ev.timestamp === "number" ? ev.timestamp : null,
        isEcho: Boolean(msg?.is_echo),
        isDeleted: Boolean(msg?.is_deleted),
        kind,
        postbackPayload: (postback?.payload as string | undefined) ?? null,
      });
    }
  }
  return out;
}

// ── Envío ───────────────────────────────────────────────────────────────────

/** Recorta a ≤ maxBytes UTF-8 sin partir caracteres. */
export function truncateUtf8(text: string, maxBytes = INSTAGRAM_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes - 1) break;
    out += ch;
    bytes += b;
  }
  return out.trimEnd() + "…";
}

export async function sendInstagramMessage(input: {
  recipientId: string;
  text: string;
}): Promise<{ messageId: string }> {
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!token) throw new NotConfiguredError("Instagram", ["INSTAGRAM_PAGE_ACCESS_TOKEN"]);
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID || "me";
  const base = (process.env.INSTAGRAM_API_BASE || INSTAGRAM_API_BASE_DEFAULT).replace(/\/$/, "");
  const url = `${base}/${encodeURIComponent(accountId)}/messages`;
  const res = await fetchWithResilience(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: input.recipientId },
      message: { text: truncateUtf8(input.text) },
    }),
    idempotent: false, // enviar dos veces = dos mensajes
    timeoutMs: 10_000,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        error?: { message?: string; code?: number; error_subcode?: number };
      };
      if (j.error?.message)
        detail = `${j.error.message} (code ${j.error.code ?? "?"}${j.error.error_subcode ? `/${j.error.error_subcode}` : ""})`;
    } catch {
      // cuerpo no JSON: se deja el texto recortado
    }
    log.error("Meta rechazó el envío", {
      status: res.status,
      detail,
      recipientId: input.recipientId,
    });
    throw new Error(`Instagram Send API HTTP ${res.status}: ${detail}`);
  }
  const j = JSON.parse(text) as { message_id?: string; recipient_id?: string };
  return { messageId: String(j.message_id ?? "") };
}

// ── Bot: contexto ───────────────────────────────────────────────────────────

export type BotProduct = {
  id: string;
  name: string;
  slug: string;
  priceCents: number | null;
  categoryName?: string | null;
  shortDescription?: string | null;
  inStock?: boolean | null; // null = no se controla stock / bajo pedido
  requiresPreorder?: boolean;
  allowPreorder?: boolean;
  tags?: string[];
};

export type BotContext = {
  businessName: string;
  siteUrl: string;
  address?: string | null;
  city?: string | null;
  mapUrl?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  timezone: string;
  hours: Array<{
    weekday: number;
    isOpen: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }>;
  products: BotProduct[];
  pickupPoints: Array<{ name: string; address?: string | null; mapUrl?: string | null }>;
  deliveryAvailable: boolean;
  orderLeadHours: number;
  orderingWindows: Array<{
    name: string;
    fulfillmentType: string;
    orderWeekdays: number[];
    cutoffTime: string;
    fulfillmentWeekday: number;
  }>;
};

export function emptyBotContext(siteUrl: string): BotContext {
  return {
    businessName: "El Pan de Paula",
    siteUrl,
    timezone: "America/Tijuana",
    hours: [],
    products: [],
    pickupPoints: [],
    deliveryAvailable: false,
    orderLeadHours: 24,
    orderingWindows: [],
  };
}

/** Carga catálogo (precio web vigente), horarios, dirección y ventanas de pedido desde la base. */
export async function loadBotContext(
  db: Database | Transaction<DB>,
  siteUrl: string,
): Promise<BotContext> {
  const [settings, hours, products, pickup, windows] = await Promise.all([
    sql<{
      name: string;
      address: string | null;
      city: string | null;
      phone: string | null;
      whatsapp: string | null;
      timezone: string;
      order_lead_hours: number;
      policies: Record<string, unknown> | null;
    }>`select name, address, city, phone, whatsapp, timezone, order_lead_hours, policies from business_settings where id = 1`.execute(
      db,
    ),
    sql<{
      weekday: number;
      is_open: boolean;
      opens_at: string | null;
      closes_at: string | null;
    }>`select weekday, is_open, opens_at::text, closes_at::text from business_hours order by weekday`.execute(
      db,
    ),
    sql<{
      id: string;
      name: string;
      slug: string;
      web_price_cents: number | null;
      category_name: string | null;
      short_description: string | null;
      track_stock: boolean;
      on_hand: string | null;
      requires_preorder: boolean;
      allow_preorder: boolean;
      tags: string[];
    }>`select cp.id, cp.name, cp.slug, cp.web_price_cents, cp.category_name, cp.short_description, cp.track_stock,
              l.on_hand::text as on_hand, cp.requires_preorder, cp.allow_preorder, cp.tags
       from catalog_products cp
       left join inventory_levels l on l.product_id = cp.id
       where cp.is_active and cp.show_on_web and cp.parent_id is null
       order by cp.sort_order, cp.name limit 200`.execute(db),
    sql<{
      name: string;
      address: string | null;
      map_url: string | null;
    }>`select name, address, map_url from pickup_points where is_active order by is_default desc, sort_order limit 5`.execute(
      db,
    ),
    sql<{
      name: string;
      fulfillment_type: string;
      order_weekdays: number[];
      cutoff_time: string;
      fulfillment_weekday: number;
    }>`select name, fulfillment_type::text, order_weekdays, cutoff_time::text, fulfillment_weekday from ordering_windows where is_active order by sort_order`.execute(
      db,
    ),
  ]);
  const s = settings.rows[0];
  const policies = (s?.policies ?? {}) as { delivery?: { enabled?: boolean }; map_url?: string };
  const deliveryAvailable =
    Boolean(policies.delivery?.enabled) ||
    windows.rows.some((w) => w.fulfillment_type === "delivery");
  return {
    businessName: s?.name ?? "El Pan de Paula",
    siteUrl,
    address: s?.address ?? null,
    city: s?.city ?? null,
    mapUrl: policies.map_url ?? pickup.rows[0]?.map_url ?? null,
    phone: s?.phone ?? null,
    whatsapp: s?.whatsapp ?? null,
    timezone: s?.timezone ?? "America/Tijuana",
    orderLeadHours: s?.order_lead_hours ?? 24,
    hours: hours.rows.map((h) => ({
      weekday: h.weekday,
      isOpen: h.is_open,
      opensAt: h.opens_at ? h.opens_at.slice(0, 5) : null,
      closesAt: h.closes_at ? h.closes_at.slice(0, 5) : null,
    })),
    products: products.rows.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      priceCents: p.web_price_cents,
      categoryName: p.category_name,
      shortDescription: p.short_description,
      inStock: p.track_stock ? Number(p.on_hand ?? 0) > 0 : null,
      requiresPreorder: p.requires_preorder,
      allowPreorder: p.allow_preorder,
      tags: p.tags ?? [],
    })),
    pickupPoints: pickup.rows.map((r) => ({ name: r.name, address: r.address, mapUrl: r.map_url })),
    deliveryAvailable,
    orderingWindows: windows.rows.map((w) => ({
      name: w.name,
      fulfillmentType: w.fulfillment_type,
      orderWeekdays: w.order_weekdays,
      cutoffTime: w.cutoff_time.slice(0, 5),
      fulfillmentWeekday: w.fulfillment_weekday,
    })),
  };
}

// ── Bot: reglas ─────────────────────────────────────────────────────────────

export type BotIntent =
  | "greeting"
  | "price"
  | "menu"
  | "availability"
  | "hours"
  | "location"
  | "how_to_order"
  | "delivery"
  | "pickup"
  | "order"
  | "thanks"
  | "human"
  | "unknown";

export type BotReply = {
  text: string;
  intent: string;
  leadInterest?: string | null;
  productId?: string | null;
  link?: string | null;
  /** true si la redactó la IA; false si salió del motor de reglas. */
  ai?: boolean;
};

const UTM = "utm_source=instagram&utm_medium=dm&utm_campaign=bot";

export function botLinks(siteUrl: string) {
  const base = siteUrl.replace(/\/$/, "");
  return {
    menu: `${base}/menu?${UTM}`,
    product: (slug: string) => `${base}/producto/${encodeURIComponent(slug)}?${UTM}`,
    checkout: `${base}/checkout?${UTM}`,
  };
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "y",
  "o",
  "a",
  "en",
  "para",
  "por",
  "con",
  "sin",
  "que",
  "cual",
  "cuanto",
  "cuanta",
  "cuantos",
  "cuantas",
  "hola",
  "buenas",
  "buenos",
  "dias",
  "tardes",
  "noches",
  "me",
  "mi",
  "tu",
  "su",
  "quiero",
  "quisiera",
  "tienen",
  "tiene",
  "hay",
  "es",
  "son",
  "esta",
  "estan",
  "cuesta",
  "cuestan",
  "vale",
  "valen",
  "precio",
  "precios",
  "costo",
  "cuanto",
  "sale",
  "pza",
  "pieza",
  "piezas",
  "pzas",
  "porfa",
  "porfavor",
  "favor",
  "gracias",
  "info",
  "informacion",
]);

/** Singulariza tokens comunes en español (conchas→concha, croissants→croissant, roles→rol, panes→pan). */
export function singularize(t: string): string {
  if (t.length <= 3) return t;
  if (/(ces)$/.test(t)) return t.replace(/ces$/, "z");
  if (/[aeiou]s$/.test(t) && !/(is|us|es)$/.test(t)) return t.slice(0, -1);
  if (/[lrndtjz]es$/.test(t) && t.length > 4) return t.slice(0, -2); // roles→rol, panes→pan
  if (/s$/.test(t) && t.length > 4) return t.slice(0, -1);
  return t;
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t && !STOP.has(t))
    .map(singularize);
}

/** Busca el producto que mejor coincide con el texto (por tokens del nombre/slug/tags). */
export function matchProduct(
  text: string,
  products: BotProduct[],
): { product: BotProduct; score: number } | null {
  const tks = tokens(text);
  if (!tks.length) return null;
  let best: { product: BotProduct; score: number } | null = null;
  for (const p of products) {
    const nameTokens = new Set([
      ...tokens(p.name),
      ...tokens(p.slug.replace(/-/g, " ")),
      ...(p.tags ?? []).flatMap(tokens),
    ]);
    if (!nameTokens.size) continue;
    let hits = 0;
    for (const t of tks) {
      if (nameTokens.has(t)) hits++;
      else if (t.length >= 5 && [...nameTokens].some((n) => n.startsWith(t) || t.startsWith(n)))
        hits += 0.7;
    }
    if (!hits) continue;
    const coverage = hits / Math.max(1, tokens(p.name).length); // qué tanto del nombre se mencionó
    const score = hits + coverage;
    if (!best || score > best.score) best = { product: p, score };
  }
  if (best && best.score < 1) return null;
  return best;
}

const RX = {
  greeting: /\b(hola|buen[oa]s?( d[ií]as| tardes| noches)?|hey|qu[eé] tal|saludos)\b/i,
  thanks: /\b(gracias|thank|perfecto|excelente|va(le)?|ok(ay)?|listo)\b/i,
  price:
    /\b(precio|precios|cu[aá]nto (cuesta|vale|sale|es|cobran|cuestan|salen)|costo|cuesta|cuestan|vale|valen|tarifa|\$)\b|cu[aá]nto/i,
  menu: /\b(men[uú]|cat[aá]logo|productos|qu[eé] (tienen|venden|manejan|hay)|opciones|variedad|sabores|lista)\b/i,
  availability:
    /\b(hay|tienen|disponible|disponibles|disponibilidad|queda|quedan|todav[ií]a|a[uú]n|hoy|ahorita|existencia)\b/i,
  hours:
    /\b(horario|horarios|hora|abren|abre|cierran|cierra|abierto|abiertos|cerrado|qu[eé] d[ií]as|d[ií]as (abren|trabajan))\b/i,
  location:
    /\b(ubicaci[oó]n|ubicados|d[oó]nde (est[aá]n|se encuentran|quedan|los encuentro)|direcci[oó]n|sucursal|local|tienda f[ií]sica|mapa|c[oó]mo llego|zona)\b/i,
  how_to_order:
    /\b(c[oó]mo (pido|ordeno|compro|hago (un )?pedido|se pide|puedo pedir)|hacer (un )?pedido|ordenar|pedir|apartar|encargar|reservar)\b/i,
  delivery:
    /\b(env[ií]o|env[ií]os|envian|env[ií]an|entregan|entrega(s)? a domicilio|domicilio|delivery|reparto|mandan|llevan|hasta mi casa|uber|didi|rappi)\b/i,
  pickup: /\b(recoger|recojo|paso por|pasar por|pick ?up|retiro|retirar|en tienda)\b/i,
  order:
    /\b(quiero|quisiera|me (das|pones|apartas|preparas|haces)|necesito|ocupo|encargar|apartar|para el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|para (ma[ñn]ana|hoy|pasado)|\d+\s+\w+)\b/i,
  human:
    /\b(persona|humano|alguien|asesor|encargad[oa]|due[ñn][oa]|hablar con|llamar|tel[eé]fono|whats(app)?)\b/i,
};

const DAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function hoursSummary(ctx: BotContext): string {
  if (!ctx.hours.length) return "";
  // Agrupa días consecutivos con el mismo horario
  const groups: Array<{ from: number; to: number; label: string }> = [];
  for (const h of [...ctx.hours].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))) {
    const label = h.isOpen && h.opensAt && h.closesAt ? `${h.opensAt} a ${h.closesAt}` : "cerrado";
    const last = groups[groups.length - 1];
    if (last && last.label === label && (last.to + 1) % 7 === h.weekday) last.to = h.weekday;
    else groups.push({ from: h.weekday, to: h.weekday, label });
  }
  return groups
    .map((g) => {
      const days = g.from === g.to ? cap(DAY[g.from]!) : `${cap(DAY[g.from]!)} a ${DAY[g.to]}`;
      return `${days}: ${g.label}`;
    })
    .join(" · ");
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function productLine(p: BotProduct): string {
  const price =
    p.priceCents !== null && p.priceCents !== undefined ? ` — ${money(p.priceCents)}` : "";
  return `${p.name}${price}`;
}

function availabilityPhrase(p: BotProduct): string {
  if (p.requiresPreorder) return `${p.name} se prepara bajo pedido (mínimo con anticipación).`;
  if (p.inStock === true) return `Sí, hoy tenemos ${p.name}.`;
  if (p.inStock === false)
    return p.allowPreorder === false
      ? `Por ahora se nos terminó ${p.name}.`
      : `Por ahora se nos terminó ${p.name}, pero puedes apartarlo para la próxima horneada.`;
  return `${p.name} está disponible en el menú.`;
}

function locationPhrase(ctx: BotContext): string {
  const pp = ctx.pickupPoints[0];
  const addr = pp?.address ?? ctx.address;
  const city = ctx.city;
  const map = pp?.mapUrl ?? ctx.mapUrl;
  if (!addr && !city) return "";
  return `Estamos en ${[addr, city].filter(Boolean).join(", ")}${map ? `. Mapa: ${map}` : "."}`;
}

export function detectIntent(text: string): BotIntent {
  const t = text.trim();
  const n = normalizeText(t);
  const words = n.split(" ").filter(Boolean).length;
  if (RX.human.test(t)) return "human";
  if (RX.delivery.test(t)) return "delivery";
  if (RX.hours.test(t) && !RX.order.test(t)) return "hours";
  if (RX.location.test(t)) return "location";
  if (RX.how_to_order.test(t) && !/\d/.test(t)) return "how_to_order";
  if (RX.pickup.test(t) && !/\d/.test(t)) return "pickup";
  if (RX.price.test(t)) return "price";
  if (RX.order.test(t) && (/\d/.test(t) || /\bpara (el |ma[ñn]ana|hoy|pasado)/i.test(t)))
    return "order";
  if (RX.availability.test(t)) return "availability";
  if (RX.menu.test(t)) return "menu";
  if (RX.order.test(t)) return "order";
  if (RX.greeting.test(t) && words <= 4) return "greeting";
  if (RX.thanks.test(t) && words <= 4) return "thanks";
  return "unknown";
}

/** Motor de reglas: siempre responde en español y siempre dirige al sitio. */
export function buildRuleReply(text: string, ctx: BotContext): BotReply {
  const L = botLinks(ctx.siteUrl);
  const intent = detectIntent(text);
  const match = matchProduct(text, ctx.products);
  const p = match?.product ?? null;
  const productLink = p ? L.product(p.slug) : null;
  const base = { intent, productId: p?.id ?? null, leadInterest: p?.name ?? null };

  switch (intent) {
    case "greeting":
      return {
        ...base,
        text: `¡Hola! 🥐 Bienvenid@ a ${ctx.businessName}. Puedes ver el menú con precios y pedir en línea aquí: ${L.menu}\n¿Buscas algo en especial?`,
        link: L.menu,
      };
    case "thanks":
      return {
        ...base,
        text: `¡Gracias a ti! Cuando quieras, tu pedido te espera en ${L.menu} 🤎`,
        link: L.menu,
      };
    case "price": {
      if (p) {
        const price =
          p.priceCents !== null && p.priceCents !== undefined
            ? `${p.name} cuesta ${money(p.priceCents)}.`
            : `${p.name} está en el menú;`;
        return {
          ...base,
          text: `${price} Lo puedes pedir directo aquí: ${productLink}`,
          link: productLink,
        };
      }
      const top = ctx.products.slice(0, 5).map(productLine).join("\n• ");
      return {
        ...base,
        text: top
          ? `Estos son algunos precios:\n• ${top}\nEl menú completo con precios está en ${L.menu} ¿De cuál te paso más info?`
          : `Todos los precios están actualizados en nuestro menú: ${L.menu}`,
        link: L.menu,
      };
    }
    case "menu": {
      const cats = [...new Set(ctx.products.map((x) => x.categoryName).filter(Boolean))].slice(
        0,
        6,
      );
      return {
        ...base,
        text: `Nuestro menú completo con precios está aquí: ${L.menu}${cats.length ? `\nTenemos ${cats.join(", ")}.` : ""} Todo se pide en línea y lo recoges recién horneado.`,
        link: L.menu,
      };
    }
    case "availability": {
      if (p) {
        return {
          ...base,
          text: `${availabilityPhrase(p)} Precio y pedido aquí: ${productLink}`,
          link: productLink,
        };
      }
      return {
        ...base,
        text: `La disponibilidad de cada producto se muestra en tiempo real en el menú: ${L.menu} ¿Cuál te interesa?`,
        link: L.menu,
      };
    }
    case "hours": {
      const h = hoursSummary(ctx);
      return {
        ...base,
        text: `${h ? `Nuestro horario: ${h}.` : "Nuestro horario está publicado en el sitio."} Puedes pedir en línea a cualquier hora en ${L.menu}`,
        link: L.menu,
      };
    }
    case "location": {
      const loc = locationPhrase(ctx);
      return {
        ...base,
        text: `${loc || "La dirección está en nuestro sitio."} Si prefieres, pide en línea y solo pasas a recoger: ${L.menu}`,
        link: L.menu,
      };
    }
    case "how_to_order":
      return {
        ...base,
        text: `Pedir es muy fácil: elige tus productos en ${L.menu}, agrega al carrito y finaliza en ${L.checkout}. Ahí eliges día de entrega y pagas con Mercado Pago o al recoger.`,
        link: L.checkout,
      };
    case "delivery": {
      const pick = ctx.pickupPoints[0]?.name ? ` en ${ctx.pickupPoints[0].name}` : "";
      return {
        ...base,
        text: ctx.deliveryAvailable
          ? `Sí hacemos entregas a domicilio 🚗 Elige "Entrega a domicilio" al finalizar tu pedido en ${L.checkout} y ahí verás zonas y costo.`
          : `Por ahora no hacemos envíos: los pedidos se recogen en tienda${pick}. Puedes pedir en línea y solo pasas por ellos: ${L.menu}`,
        link: ctx.deliveryAvailable ? L.checkout : L.menu,
      };
    }
    case "pickup": {
      const loc = locationPhrase(ctx);
      return {
        ...base,
        text: `Claro, pides en línea y lo recoges en tienda. ${loc ? loc + " " : ""}Haz tu pedido aquí: ${L.menu}`,
        link: L.menu,
      };
    }
    case "order": {
      const qty = text.match(/(\d+)/)?.[1];
      const when = text.match(
        /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|hoy|pasado ma[ñn]ana)\b/i,
      )?.[1];
      const lead =
        ctx.orderLeadHours >= 24
          ? ` Recuerda que los pedidos se hacen con al menos ${Math.round(ctx.orderLeadHours / 24)} día(s) de anticipación.`
          : "";
      if (p) {
        const price =
          p.priceCents !== null && p.priceCents !== undefined
            ? ` (${money(p.priceCents)} c/u)`
            : "";
        return {
          ...base,
          text: `¡Con gusto! ${qty ? `${qty} ` : ""}${p.name}${price}${when ? ` para el ${when.toLowerCase()}` : ""}. Para apartarlo con fecha y pago, agrégalo aquí: ${productLink} y finaliza en ${L.checkout}.${lead}`,
          link: productLink,
        };
      }
      return {
        ...base,
        text: `¡Con gusto! Para apartar tu pedido${when ? ` para el ${when.toLowerCase()}` : ""} elige los productos en ${L.menu} y finaliza en ${L.checkout}; ahí seleccionas la fecha.${lead}`,
        link: L.menu,
      };
    }
    case "human": {
      const contact = ctx.whatsapp
        ? ` También puedes escribirnos por WhatsApp: ${ctx.whatsapp}.`
        : ctx.phone
          ? ` Teléfono: ${ctx.phone}.`
          : "";
      return {
        ...base,
        text: `Claro, en un momento te atiende una persona del equipo.${contact} Mientras tanto puedes ver el menú en ${L.menu}`,
        link: L.menu,
      };
    }
    default: {
      if (p) {
        return {
          ...base,
          intent: "product",
          text: `${productLine(p)}. ${availabilityPhrase(p)} Más info y pedido: ${productLink}`,
          link: productLink,
        };
      }
      return {
        ...base,
        text: `¡Gracias por escribirnos! Todo nuestro menú, precios y pedidos están en ${L.menu}. Si buscas algo en particular, dime el producto y te paso el enlace directo.`,
        link: L.menu,
      };
    }
  }
}

// ── Bot: IA opcional ────────────────────────────────────────────────────────

export const BOT_AI_MODEL = "claude-sonnet-5";

/**
 * Redacta la respuesta con Claude usando SOLO el contexto real (catálogo con precios, horarios, dirección).
 * Prohibido inventar precios/disponibilidad. Si falla o no hay clave → null (se usa la regla).
 */
export async function buildAiReply(
  text: string,
  ctx: BotContext,
  draft: BotReply,
  opts: {
    apiKey?: string;
    timeoutMs?: number;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  } = {},
): Promise<BotReply | null> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const L = botLinks(ctx.siteUrl);
  const catalog = ctx.products.slice(0, 80).map((p) => ({
    nombre: p.name,
    precio_mxn: p.priceCents !== null && p.priceCents !== undefined ? p.priceCents / 100 : null,
    disponible_hoy: p.inStock,
    bajo_pedido: p.requiresPreorder ?? false,
    enlace: L.product(p.slug),
    categoria: p.categoryName ?? null,
  }));
  const system = [
    `Eres el asistente de Instagram de ${ctx.businessName}, una panadería artesanal en México. Respondes en español mexicano, cálido y breve (máximo 3 frases, ≤ 700 caracteres, sin listas largas).`,
    `REGLAS ESTRICTAS: 1) Usa ÚNICAMENTE los datos del CONTEXTO. 2) NUNCA inventes precios, disponibilidad, horarios, direcciones ni promociones; si un dato no está en el contexto, di que lo puede ver en el sitio. 3) SIEMPRE incluye un enlace del sitio (menú ${L.menu}, producto o checkout ${L.checkout}); nunca inventes enlaces. 4) No tomes pedidos por chat: dirige al sitio para apartar con fecha y pago. 5) Si piden hablar con una persona, di que en un momento los atienden. 6) No pidas datos personales ni de tarjeta.`,
    `CONTEXTO (JSON): ${JSON.stringify({
      horario: hoursSummary(ctx) || null,
      direccion: locationPhrase(ctx) || null,
      envio_a_domicilio: ctx.deliveryAvailable,
      anticipacion_horas: ctx.orderLeadHours,
      sucursales: ctx.pickupPoints,
      catalogo: catalog,
    })}`,
    `BORRADOR DEL MOTOR DE REGLAS (úsalo como base factual; puedes mejorar el tono, no los datos): ${draft.text}`,
  ].join("\n\n");
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? 8_000, maxRetries: 1 });
    const res = await client.messages.create({
      model: BOT_AI_MODEL,
      max_tokens: 350,
      temperature: 0.3,
      system,
      messages: [...(opts.history ?? []).slice(-6), { role: "user", content: text.slice(0, 2000) }],
    });
    const out = res.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    if (!out) return null;
    // Garantía: la respuesta debe contener un enlace del sitio; si no, lo agregamos.
    const link = draft.link ?? L.menu;
    const withLink = out.includes(ctx.siteUrl.replace(/\/$/, "")) ? out : `${out}\n${link}`;
    return { ...draft, text: truncateUtf8(withLink), ai: true };
  } catch (e) {
    log.warn("IA no disponible; se usa la respuesta por reglas", { err: e });
    return null;
  }
}

/**
 * Genera la respuesta del bot a partir de una consulta (reglas + catálogo; IA opcional detrás de flag).
 * Compatible con la firma original: `{ text, siteUrl }`. Opcionalmente `db` (carga contexto real),
 * `context` (ya cargado), `aiEnabled` (flag `instagram_ai_replies`) e `history`.
 */
export async function buildBotReply(input: {
  text: string;
  siteUrl: string;
  db?: Database | Transaction<DB>;
  context?: BotContext;
  aiEnabled?: boolean;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<BotReply> {
  let ctx = input.context;
  if (!ctx && input.db) {
    try {
      ctx = await loadBotContext(input.db, input.siteUrl);
    } catch (e) {
      log.error("no se pudo cargar el contexto del bot; se responde con contexto mínimo", {
        err: e,
      });
    }
  }
  ctx ??= emptyBotContext(input.siteUrl);
  const rule = buildRuleReply(input.text, ctx);
  if (input.aiEnabled && process.env.ANTHROPIC_API_KEY) {
    const ai = await buildAiReply(input.text, ctx, rule, { history: input.history });
    if (ai) return ai;
  }
  return { ...rule, text: truncateUtf8(rule.text), ai: false };
}
