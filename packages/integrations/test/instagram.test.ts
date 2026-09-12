import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBotReply,
  buildRuleReply,
  detectIntent,
  matchProduct,
  parseInstagramWebhook,
  sendInstagramMessage,
  signMetaPayload,
  singularize,
  truncateUtf8,
  verifyMetaSignature,
  verifyMetaWebhookChallenge,
  type BotContext,
} from "../src/instagram.ts";
import { _resetBreakers } from "../src/http.ts";

const SITE = "https://elpandepaula.mx";

const ctx: BotContext = {
  businessName: "El Pan de Paula",
  siteUrl: SITE,
  address: "Av. Revolución 123",
  city: "Tijuana",
  mapUrl: "https://maps.app.goo.gl/abc",
  phone: "664 123 4567",
  whatsapp: "+52 664 123 4567",
  timezone: "America/Tijuana",
  hours: [
    { weekday: 0, isOpen: false, opensAt: null, closesAt: null },
    { weekday: 1, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
    { weekday: 2, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
    { weekday: 3, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
    { weekday: 4, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
    { weekday: 5, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
    { weekday: 6, isOpen: true, opensAt: "09:00", closesAt: "14:00" },
  ],
  products: [
    {
      id: "p1",
      name: "Croissant Dubai",
      slug: "croissant-dubai",
      priceCents: 9500,
      categoryName: "Croissants",
      inStock: true,
    },
    {
      id: "p2",
      name: "Concha",
      slug: "concha",
      priceCents: 3000,
      categoryName: "Pan dulce",
      inStock: false,
      allowPreorder: true,
    },
    {
      id: "p3",
      name: "Rol de canela",
      slug: "rol-de-canela",
      priceCents: 5500,
      categoryName: "Roles",
      inStock: true,
    },
    {
      id: "p4",
      name: "Galletas de chispas",
      slug: "galletas-chispas",
      priceCents: 2500,
      categoryName: "Galletas",
      inStock: null,
      requiresPreorder: true,
    },
    {
      id: "p5",
      name: "Croissant de mantequilla",
      slug: "croissant-mantequilla",
      priceCents: 6000,
      categoryName: "Croissants",
      inStock: true,
    },
  ],
  pickupPoints: [
    { name: "Tienda Centro", address: "Av. Revolución 123", mapUrl: "https://maps.app.goo.gl/abc" },
  ],
  deliveryAvailable: false,
  orderLeadHours: 24,
  orderingWindows: [],
};

describe("firma y verificación Meta", () => {
  const secret = "app-secret-123";
  const body = JSON.stringify({ object: "instagram", entry: [{ id: "1", messaging: [] }] });
  it("acepta firma válida y rechaza inválida/ausente", () => {
    const sig = signMetaPayload(body, secret);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, "otro")).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, undefined)).toBe(false);
  });
  it("firma sobre el cuerpo crudo con unicode escapado tal cual llega", () => {
    const raw =
      '{"object":"instagram","entry":[{"messaging":[{"message":{"text":"\\u00bfprecio?"}}]}]}';
    expect(verifyMetaSignature(raw, signMetaPayload(raw, secret), secret)).toBe(true);
  });
  it("challenge: responde solo con token correcto", () => {
    const q = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "tok",
      "hub.challenge": "12345",
    });
    expect(verifyMetaWebhookChallenge(q, "tok")).toBe("12345");
    expect(verifyMetaWebhookChallenge(q, "otro")).toBeNull();
    expect(verifyMetaWebhookChallenge(q, undefined)).toBeNull();
    q.set("hub.mode", "unsubscribe");
    expect(verifyMetaWebhookChallenge(q, "tok")).toBeNull();
  });
});

describe("parseInstagramWebhook", () => {
  it("extrae mensajes de texto, adjuntos, echos y lecturas", () => {
    const events = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000000,
          messaging: [
            {
              sender: { id: "9001" },
              recipient: { id: "17841400000000000" },
              timestamp: 1700000000001,
              message: { mid: "m1", text: "precio del croissant dubai" },
            },
            {
              sender: { id: "17841400000000000" },
              recipient: { id: "9001" },
              timestamp: 1700000000002,
              message: { mid: "m2", text: "respuesta nuestra", is_echo: true },
            },
            {
              sender: { id: "9001" },
              recipient: { id: "17841400000000000" },
              message: {
                mid: "m3",
                attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
              },
            },
            { sender: { id: "9001" }, recipient: { id: "17841400000000000" }, read: { mid: "m2" } },
          ],
        },
      ],
    });
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      senderId: "9001",
      mid: "m1",
      text: "precio del croissant dubai",
      kind: "message",
      isEcho: false,
    });
    expect(events[1]!.isEcho).toBe(true);
    expect(events[2]!.attachments).toEqual([{ type: "image", url: "https://cdn/x.jpg" }]);
    expect(events[3]!.kind).toBe("read");
  });
  it("ignora payloads de otros objetos o malformados", () => {
    expect(parseInstagramWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseInstagramWebhook(null)).toEqual([]);
    expect(
      parseInstagramWebhook({
        object: "instagram",
        entry: [{ id: "1", messaging: [{ sender: {} }] }],
      }),
    ).toEqual([]);
  });
});

describe("truncateUtf8", () => {
  it("respeta el límite de 1000 bytes sin partir emojis", () => {
    const s = "🥐".repeat(400); // 1600 bytes
    const t = truncateUtf8(s);
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(1000);
    expect(t.endsWith("…")).toBe(true);
    expect(truncateUtf8("hola")).toBe("hola");
  });
});

describe("motor de reglas", () => {
  it("singulariza", () => {
    expect(singularize("conchas")).toBe("concha");
    expect(singularize("croissants")).toBe("croissant");
    expect(singularize("roles")).toBe("rol");
    expect(singularize("galletas")).toBe("galleta");
    expect(singularize("pan")).toBe("pan");
  });
  it("encuentra el producto por nombre, plural y parcial", () => {
    expect(matchProduct("precio del croissant dubai", ctx.products)?.product.id).toBe("p1");
    expect(matchProduct("quiero 6 conchas para el viernes", ctx.products)?.product.id).toBe("p2");
    expect(matchProduct("tienen roles de canela?", ctx.products)?.product.id).toBe("p3");
    expect(matchProduct("hola buenas tardes", ctx.products)).toBeNull();
    // "croissant" solo → cualquiera de los dos croissants, no null
    expect(matchProduct("croissant", ctx.products)).not.toBeNull();
  });

  it("intenciones con frases reales", () => {
    expect(detectIntent("precio del croissant dubai")).toBe("price");
    expect(detectIntent("hacen envíos?")).toBe("delivery");
    expect(detectIntent("a qué hora abren")).toBe("hours");
    expect(detectIntent("quiero 6 conchas para el viernes")).toBe("order");
    expect(detectIntent("dónde están ubicados?")).toBe("location");
    expect(detectIntent("cómo hago un pedido")).toBe("how_to_order");
    expect(detectIntent("tienen conchas hoy?")).toBe("availability");
    expect(detectIntent("qué productos manejan")).toBe("menu");
    expect(detectIntent("hola")).toBe("greeting");
    expect(detectIntent("gracias!")).toBe("thanks");
    expect(detectIntent("puedo hablar con una persona?")).toBe("human");
    expect(detectIntent("puedo pasar a recoger?")).toBe("pickup");
    expect(detectIntent("cuánto cuestan las galletas")).toBe("price");
  });

  it("precio: responde con el precio real y enlace al producto con UTM", () => {
    const r = buildRuleReply("precio del croissant dubai", ctx);
    expect(r.intent).toBe("price");
    expect(r.productId).toBe("p1");
    expect(r.text).toContain("$95");
    expect(r.text).toContain(`${SITE}/producto/croissant-dubai?utm_source=instagram`);
    expect(r.link).toContain("/producto/croissant-dubai");
  });
  it("envíos: sin entrega a domicilio dirige a recoger; con entrega dirige al checkout", () => {
    const r = buildRuleReply("hacen envíos?", ctx);
    expect(r.intent).toBe("delivery");
    expect(r.text).toMatch(/no hacemos envíos/i);
    expect(r.text).toContain("Tienda Centro");
    expect(r.text).toContain(`${SITE}/menu?utm_source=instagram`);
    const r2 = buildRuleReply("hacen envíos?", { ...ctx, deliveryAvailable: true });
    expect(r2.text).toMatch(/entregas a domicilio/i);
    expect(r2.link).toContain("/checkout?utm_source=instagram");
  });
  it("horarios: agrupa días y usa datos reales", () => {
    const r = buildRuleReply("a qué hora abren", ctx);
    expect(r.intent).toBe("hours");
    expect(r.text).toContain("Lunes a viernes: 09:00 a 18:00");
    expect(r.text).toContain("Sábado: 09:00 a 14:00");
    expect(r.text).toContain("Domingo: cerrado");
    expect(r.text).toContain(`${SITE}/menu?utm_source=instagram`);
  });
  it("pedido: reconoce cantidad, producto y día; dirige a producto + checkout", () => {
    const r = buildRuleReply("quiero 6 conchas para el viernes", ctx);
    expect(r.intent).toBe("order");
    expect(r.productId).toBe("p2");
    expect(r.leadInterest).toBe("Concha");
    expect(r.text).toContain("6 Concha");
    expect(r.text).toContain("para el viernes");
    expect(r.text).toContain("$30");
    expect(r.text).toContain("/producto/concha?utm_source=instagram");
    expect(r.text).toContain("/checkout?utm_source=instagram");
    expect(r.text).toMatch(/anticipación/);
  });
  it("disponibilidad: usa stock real y bajo pedido", () => {
    expect(buildRuleReply("tienen conchas hoy?", ctx).text).toMatch(/se nos terminó Concha/);
    expect(buildRuleReply("hay croissant dubai?", ctx).text).toMatch(/hoy tenemos Croissant Dubai/);
    expect(buildRuleReply("tienen galletas de chispas?", ctx).text).toMatch(/bajo pedido/);
  });
  it("ubicación, cómo pedir, menú, humano y desconocido siempre incluyen enlace al sitio", () => {
    for (const q of [
      "dónde están?",
      "cómo hago un pedido",
      "qué productos manejan",
      "quiero hablar con alguien",
      "asdfgh qwerty",
      "hola",
      "gracias",
    ]) {
      const r = buildRuleReply(q, ctx);
      expect(r.text, q).toContain(SITE);
      expect(r.text, q).toContain("utm_source=instagram");
      expect(r.link, q).toBeTruthy();
    }
    expect(buildRuleReply("dónde están?", ctx).text).toContain("Av. Revolución 123, Tijuana");
    expect(buildRuleReply("quiero hablar con alguien", ctx).text).toContain("+52 664 123 4567");
    expect(buildRuleReply("cómo hago un pedido", ctx).link).toContain("/checkout");
  });
  it("nunca inventa precios: producto sin precio no muestra $", () => {
    const r = buildRuleReply("precio del rol de canela", {
      ...ctx,
      products: [{ id: "x", name: "Rol de canela", slug: "rol", priceCents: null }],
    });
    expect(r.text).not.toContain("$");
    expect(r.text).toContain("/producto/rol");
  });
  it("buildBotReply sin db ni contexto responde con contexto mínimo y sin IA", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await buildBotReply({ text: "precio del croissant dubai", siteUrl: SITE });
    expect(r.ai).toBe(false);
    expect(r.text).toContain(`${SITE}/menu?utm_source=instagram`);
  });
  it("buildBotReply con aiEnabled pero sin ANTHROPIC_API_KEY usa reglas", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await buildBotReply({
      text: "a qué hora abren",
      siteUrl: SITE,
      context: ctx,
      aiEnabled: true,
    });
    expect(r.ai).toBe(false);
    expect(r.intent).toBe("hours");
  });
});

describe("sendInstagramMessage", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    _resetBreakers();
    process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = "IGQ-token";
    process.env.INSTAGRAM_ACCOUNT_ID = "17841400000000000";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    delete process.env.INSTAGRAM_ACCOUNT_ID;
    delete process.env.INSTAGRAM_API_BASE;
  });
  it("llama al Send API con recipient/message y Bearer", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: "9001", message_id: "mid-1" }), { status: 200 }),
    );
    const r = await sendInstagramMessage({ recipientId: "9001", text: "Hola 🥐" });
    expect(r).toEqual({ messageId: "mid-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.instagram.com/v25.0/17841400000000000/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer IGQ-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      recipient: { id: "9001" },
      message: { text: "Hola 🥐" },
    });
  });
  it("no reintenta (no idempotente) y lanza con el error de Meta", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "(#10) Outside allowed window", code: 10, error_subcode: 2534022 },
        }),
        { status: 400 },
      ),
    );
    await expect(sendInstagramMessage({ recipientId: "9001", text: "x" })).rejects.toThrow(
      /Outside allowed window \(code 10\/2534022\)/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("permite base alterna (Facebook Login / graph.facebook.com)", async () => {
    process.env.INSTAGRAM_API_BASE = "https://graph.facebook.com/v25.0/";
    process.env.INSTAGRAM_ACCOUNT_ID = "PAGE123";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: "m" }), { status: 200 }),
    );
    await sendInstagramMessage({ recipientId: "1", text: "x" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://graph.facebook.com/v25.0/PAGE123/messages");
  });
});
