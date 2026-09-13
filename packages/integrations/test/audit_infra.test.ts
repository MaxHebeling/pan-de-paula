// secret-scan: fixtures (tokens con formato real pero inventados, para probar la redacción del logger)
/**
 * Auditoría de infraestructura (docs/audit/infra.md): casos límite de los adaptadores sin tocar la red.
 * - fetchWithResilience: timeout, reintentos solo idempotentes, circuit breaker (abre con 5xx/red, NO con 4xx, cierra tras cooldown)
 * - Mercado Pago: shapes y errores 4xx/5xx, presupuesto de tiempo de la consulta de pago
 * - Resend: nunca lanza; XSS en nombres de producto/cliente y URLs javascript:
 * - Storage local: traversal, tipo inválido, > 5 MB, claves fuera de formato
 * - Logger: política de redacción (claves sensibles, Bearer, tarjetas Luhn, tokens incrustados)
 * - Instagram: payloads sin texto / vacíos / larguísimos / emoji; IA fuera de formato cae a reglas
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBreakers,
  _setLogSink,
  buildAiReply,
  buildBotReply,
  buildRuleReply,
  createLogger,
  createMercadoPagoPreference,
  deleteImage,
  detectIntent,
  emptyBotContext,
  fetchMercadoPagoPayment,
  fetchWithResilience,
  keyFromUrl,
  MercadoPagoApiError,
  MP_PAYMENT_FETCH_RETRIES,
  parseInstagramWebhook,
  redact,
  refundMercadoPagoPayment,
  renderOrderConfirmationHtml,
  renderReceiptHtml,
  sendEmail,
  truncateUtf8,
  uploadImage,
  type BotContext,
  type StorageConfig,
} from "../src/index.ts";

const aiCreate = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: aiCreate };
  },
}));

const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

function res(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  fetchMock.mockReset();
  aiCreate.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  _resetBreakers();
  _setLogSink(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  _setLogSink(null);
});

// ── fetchWithResilience ─────────────────────────────────────────────────────
describe("fetchWithResilience", () => {
  it("reintenta GET idempotente ante 5xx y devuelve la respuesta buena", async () => {
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, "ok"));
    const r = await fetchWithResilience("https://api.example.test/x", { retries: 2 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("NO reintenta operaciones no idempotentes (POST sin clave): una sola llamada aunque falle", async () => {
    fetchMock.mockResolvedValue(res(502));
    const r = await fetchWithResilience("https://api.example.test/send", {
      method: "POST",
      idempotent: false,
    });
    expect(r.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no reintenta 4xx (respuesta definitiva) y NO abre el circuito con ellos", async () => {
    fetchMock.mockResolvedValue(res(404, '{"message":"not found"}'));
    for (let i = 0; i < 8; i++) {
      const r = await fetchWithResilience("https://api.mercadopago.test/v1/payments/1", {
        retries: 2,
      });
      expect(r.status).toBe(404);
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("abre el circuito tras 5 fallos transitorios y lo cierra al pasar el cooldown", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchMock.mockResolvedValue(res(500));
    for (let i = 0; i < 5; i++) {
      await fetchWithResilience("https://down.example.test/a", { retries: 0 });
    }
    await expect(
      fetchWithResilience("https://down.example.test/b", { retries: 0 }),
    ).rejects.toThrow(/Circuito abierto/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // otro host no se ve afectado
    fetchMock.mockResolvedValueOnce(res(200));
    expect((await fetchWithResilience("https://other.example.test/", { retries: 0 })).status).toBe(
      200,
    );
    // pasa el cooldown → vuelve a intentar; un éxito limpia el estado
    now += 31_000;
    fetchMock.mockResolvedValueOnce(res(200, "back"));
    const r = await fetchWithResilience("https://down.example.test/c", { retries: 0 });
    expect(r.status).toBe(200);
  });

  it("los errores de red cuentan para el breaker y se reintentan si es idempotente", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(res(200));
    const r = await fetchWithResilience("https://flaky.example.test/", { retries: 1 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborta por timeout y lanza (sin reintentos si retries=0)", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    await expect(
      fetchWithResilience("https://slow.example.test/", { timeoutMs: 20, retries: 0 }),
    ).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── Mercado Pago ────────────────────────────────────────────────────────────
describe("Mercado Pago: errores y presupuesto", () => {
  beforeEach(() => {
    process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token-de-prueba";
  });
  afterEach(() => {
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  });

  it("404 en GET /v1/payments → MercadoPagoApiError con status y mensaje, sin reintentos", async () => {
    fetchMock.mockResolvedValue(
      res(404, JSON.stringify({ message: "Payment not found", cause: [{ code: 2000 }] })),
    );
    const err = await fetchMercadoPagoPayment("123").catch((e) => e);
    expect(err).toBeInstanceOf(MercadoPagoApiError);
    expect(err.status).toBe(404);
    expect(err.mpMessage).toBe("Payment not found");
    expect(err.mpCauses).toEqual([{ code: 2000 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx persistente en la consulta de pago: 1 reintento (presupuesto del webhook) y error", async () => {
    fetchMock.mockResolvedValue(res(502, "bad gateway"));
    await expect(fetchMercadoPagoPayment("123")).rejects.toThrow(/HTTP 502/);
    expect(fetchMock).toHaveBeenCalledTimes(1 + MP_PAYMENT_FETCH_RETRIES);
  });

  it("respuesta 200 no JSON → error claro", async () => {
    fetchMock.mockResolvedValue(res(200, "<html>mantenimiento</html>"));
    await expect(fetchMercadoPagoPayment("123")).rejects.toThrow(/Respuesta no JSON/);
  });

  it("montos raros de la API se mapean sin flotantes: '1234.5' → 123450, null → 0", async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, JSON.stringify({ id: 1, status: "approved", transaction_amount: "1234.5" })),
    );
    expect((await fetchMercadoPagoPayment("1")).transactionAmountCents).toBe(123450);
    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ id: 2, status: "approved" })));
    expect((await fetchMercadoPagoPayment("2")).transactionAmountCents).toBe(0);
  });

  it("preferencia: 400 de MP se propaga con detalle; cantidad inválida no llama a la red", async () => {
    fetchMock.mockResolvedValue(res(400, JSON.stringify({ message: "invalid back_urls" })));
    await expect(
      createMercadoPagoPreference({
        orderId: "o1",
        folio: "F1",
        items: [{ title: "Concha", quantity: 1, unitPriceCents: 3000 }],
        backUrls: { success: "x", failure: "x", pending: "x" },
        notificationUrl: "https://e/x",
      }),
    ).rejects.toThrow(/400.*invalid back_urls/);
    fetchMock.mockClear();
    await expect(
      createMercadoPagoPreference({
        orderId: "o1",
        folio: "F1",
        items: [{ title: "Concha", quantity: 0, unitPriceCents: 3000 }],
        backUrls: { success: "x", failure: "x", pending: "x" },
        notificationUrl: "https://e/x",
      }),
    ).rejects.toThrow(/Cantidad inválida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reembolso: monto 0/negativo o id no numérico no llegan a la red; 5xx reintenta por X-Idempotency-Key", async () => {
    await expect(refundMercadoPagoPayment("1", 0)).rejects.toThrow(/mayor a 0/);
    await expect(refundMercadoPagoPayment("abc")).rejects.toThrow(/inválido/);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(201, JSON.stringify({ id: 77, status: "approved" })));
    const r = await refundMercadoPagoPayment("1", 500, "refund:abc");
    expect(r).toEqual({ refundId: "77", status: "approved" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string>)["X-Idempotency-Key"],
    );
    expect(keys).toEqual(["refund:abc", "refund:abc"]);
  });
});

// ── Email ───────────────────────────────────────────────────────────────────
describe("Email: XSS y robustez", () => {
  const XSS = `<img src=x onerror="alert('x')">"'&`;
  const base = {
    folio: `F-${XSS}`,
    businessName: `Pan ${XSS}`,
    items: [{ name: `Concha ${XSS}`, qty: 1, unitPriceCents: 3000, totalCents: 3000 }],
    subtotalCents: 3000,
    discountCents: 0,
    totalCents: 3000,
  };

  it("comprobante: nada del usuario llega sin escapar; URLs javascript: se descartan", () => {
    const html = renderReceiptHtml({
      ...base,
      soldAt: new Date("2026-09-12T18:00:00Z"),
      payments: [{ method: `cash${XSS}`, amountCents: 3000 }],
      customerName: `Ana ${XSS}`,
      // eslint-disable-next-line no-script-url
      logoUrl: "javascript:alert(1)",
      siteUrl: "data:text/html,evil",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="'); // solo aparece escapado (onerror=&quot;)
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  });

  it("confirmación: statusUrl/payUrl maliciosos no generan botones ni href peligrosos", () => {
    const html = renderOrderConfirmationHtml({
      ...base,
      fulfillmentType: "delivery",
      deliveryAddress: `Calle ${XSS}`,
      // eslint-disable-next-line no-script-url
      statusUrl: "javascript:alert(2)",
      payUrl: "vbscript:msgbox",
      paymentStatus: "pending",
      pickupPoint: { name: XSS, mapUrl: "ftp://x" },
      notes: XSS,
    });
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("Completar pago"); // botón omitido porque la URL no es http(s)
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('href="#"'); // fallback del enlace de estado
  });

  it("sendEmail nunca lanza: proveedor 200 con cuerpo no JSON, red caída, 429 tras reintentos", async () => {
    process.env.RESEND_API_KEY = "re_x";
    process.env.EMAIL_FROM = "a@b.mx";
    try {
      fetchMock.mockResolvedValueOnce(res(200, "not-json"));
      let r = await sendEmail({ to: "c@d.mx", subject: "s", html: "<p>x</p>" });
      expect(r.sent).toBe(false);
      fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
      r = await sendEmail({ to: "c@d.mx", subject: "s", html: "<p>x</p>" });
      expect(r).toMatchObject({ sent: false, error: "ECONNRESET" });
      fetchMock.mockResolvedValue(
        res(429, JSON.stringify({ name: "rate_limit", message: "slow" })),
      );
      r = await sendEmail({ to: "c@d.mx", subject: "s", html: "<p>x</p>", idempotencyKey: "k" });
      expect(r).toMatchObject({ sent: false, error: "rate_limit: slow" });
      expect(fetchMock).toHaveBeenCalledTimes(1 + 1 + 3);
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
    }
  });
});

// ── Storage ─────────────────────────────────────────────────────────────────
describe("Storage local: límites y traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "pdp-audit-storage-"));
  const cfg: StorageConfig = {
    driver: "local",
    localRoot: root,
    publicBaseUrl: "http://localhost:3001",
    bucket: "b",
  };
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]); // firma PNG completa (validateImage inspecciona el contenido)

  it("carpetas con traversal, absolutas o con caracteres raros se rechazan", async () => {
    for (const folder of ["../etc", "a/../../b", "/abs", "prod ucts", "ñ", "x".repeat(70), "a/"]) {
      await expect(
        uploadImage({ bytes: png, contentType: "image/png", fileName: "a.png", folder }, cfg),
      ).rejects.toThrow(/inválida/);
    }
  });

  it("el nombre original del archivo no influye en la ruta (uuid + extensión por tipo)", async () => {
    const r = await uploadImage(
      { bytes: png, contentType: "image/png", fileName: "../../../etc/passwd.exe", folder: "x" },
      cfg,
    );
    expect(r.key).toMatch(/^x\/[0-9a-f-]{36}\.png$/);
    expect(r.url).toBe(`http://localhost:3001/uploads/${r.key}`);
  });

  it("tipo inválido y tamaño > 5 MB se rechazan antes de escribir", async () => {
    await expect(
      uploadImage({ bytes: png, contentType: "image/svg+xml", fileName: "a.svg" }, cfg),
    ).rejects.toThrow(/no permitido/);
    await expect(
      uploadImage({ bytes: png, contentType: "text/html", fileName: "a.png" }, cfg),
    ).rejects.toThrow(/no permitido/);
    await expect(
      uploadImage(
        { bytes: new Uint8Array(5 * 1024 * 1024 + 1), contentType: "image/png", fileName: "a" },
        cfg,
      ),
    ).rejects.toThrow(/5 MB/);
  });

  it("borrar con claves fuera de formato (traversal, sin uuid) se rechaza; keyFromUrl devuelve null", async () => {
    for (const key of ["../x.png", "products/../../a.png", "products/a.png", "products/x.sh"]) {
      await expect(deleteImage(key, cfg)).rejects.toThrow(/inválida/);
    }
    expect(keyFromUrl("http://localhost:3001/uploads/../../etc/passwd", cfg)).toBeNull();
    expect(keyFromUrl("http://evil.test/uploads/products/x.png", cfg)).toBeNull();
  });
});

// ── Logger ──────────────────────────────────────────────────────────────────
describe("Logger: política de redacción", () => {
  it("redacta claves sensibles a cualquier profundidad, en arrays y en errores", () => {
    const err = Object.assign(new Error("boom"), {
      config: { headers: { Authorization: "Bearer abc.def.ghi-jkl" } },
    });
    const out = redact({
      user: { email: "ana@example.com", password: "hunter2", card: { number: "4111" } },
      list: [{ token: "t" }, { "x-signature": "ts=1,v1=abc" }, { cookie: "s=1" }],
      nested: { a: { b: { c: { api_key: "k", set_cookie: "z" } } } },
      err,
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("4111");
    expect(s).not.toContain("ts=1,v1=abc");
    expect(s).not.toContain("s=1");
    expect(s).not.toContain("abc.def.ghi");
    expect(s).toContain("[REDACTED]");
    // política actual: el correo NO se redacta automáticamente (se enmascara explícitamente con maskEmail)
    expect(s).toContain("ana@example.com");
  });

  it("redacta tokens y tarjetas incrustados en texto libre, no números cualesquiera", () => {
    const log = createLogger("t");
    const lines: string[] = [];
    _setLogSink((l) => lines.push(l));
    log.info("pago", {
      msg: "Authorization: Bearer APP_USR-1234567890-abcdef-XYZ tarjeta 4242424242424242 folio 1234567890123",
      raw: "sk-ant-api03-0123456789abcdefghijklmnop",
    });
    const line = lines[0]!;
    expect(line).not.toContain("APP_USR-1234567890");
    expect(line).not.toContain("4242424242424242");
    expect(line).not.toContain("sk-ant-api03");
    expect(line).toContain("1234567890123"); // 13 dígitos sin Luhn válido: no es tarjeta
  });
});

// ── Instagram ───────────────────────────────────────────────────────────────
describe("Instagram: payloads límite", () => {
  const entry = (messaging: unknown[]) => ({
    object: "instagram",
    entry: [{ id: "178", time: 1, messaging }],
  });

  it("mensaje solo con adjunto → text null y attachments; texto vacío se conserva como ''", () => {
    const [img, empty] = parseInstagramWebhook(
      entry([
        {
          sender: { id: "1" },
          recipient: { id: "178" },
          timestamp: 1,
          message: {
            mid: "m1",
            attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
          },
        },
        { sender: { id: "1" }, recipient: { id: "178" }, message: { mid: "m2", text: "" } },
      ]),
    );
    expect(img).toMatchObject({ kind: "message", text: null, attachments: [{ type: "image" }] });
    expect(empty).toMatchObject({ kind: "message", text: "", mid: "m2" });
  });

  it("eventos sin sender/recipient, entry sin messaging y objetos ajenos no rompen", () => {
    expect(parseInstagramWebhook(entry([{ message: { mid: "x" } }, null, 5]))).toEqual([]);
    expect(parseInstagramWebhook({ object: "instagram", entry: [{ id: "1" }] })).toEqual([]);
    expect(parseInstagramWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseInstagramWebhook("string")).toEqual([]);
    expect(parseInstagramWebhook(null)).toEqual([]);
  });

  it("reglas: entrada vacía, solo emoji o larguísima responden con enlace y ≤ 1000 bytes", () => {
    const ctx = emptyBotContext("https://elpandepaula.mx");
    for (const text of ["", "   ", "🥐🥐🥐", "¿?", "a".repeat(5000), "hola ".repeat(400)]) {
      const r = buildRuleReply(text, ctx);
      expect(r.text).toContain("https://elpandepaula.mx/");
      expect(Buffer.byteLength(truncateUtf8(r.text), "utf8")).toBeLessThanOrEqual(1000);
      expect(typeof detectIntent(text)).toBe("string");
    }
  });

  it("truncateUtf8 no parte emojis compuestos y agrega elipsis", () => {
    const t = truncateUtf8("👩‍👩‍👧‍👦".repeat(100), 100);
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(100);
    expect(t.endsWith("…")).toBe(true);
    expect(() => new TextEncoder().encode(t)).not.toThrow();
  });

  describe("IA", () => {
    const ctx: BotContext = {
      ...emptyBotContext("https://elpandepaula.mx"),
      products: [{ id: "p1", name: "Concha", slug: "concha", priceCents: 3000 }],
    };
    const draft = buildRuleReply("precio de la concha", ctx);

    it("respuesta fuera de formato (sin bloques de texto) → null y se usa la regla", async () => {
      aiCreate.mockResolvedValue({
        content: [{ type: "tool_use", id: "x", name: "n", input: {} }],
      });
      expect(await buildAiReply("precio", ctx, draft, { apiKey: "k" })).toBeNull();
      const full = await buildBotReply({ text: "precio", context: ctx, siteUrl: ctx.siteUrl });
      expect(full.ai).toBe(false);
      expect(full.text).toContain("$30");
    });

    it("texto sin enlace → se agrega el enlace del borrador; texto larguísimo se recorta", async () => {
      aiCreate.mockResolvedValue({
        content: [{ type: "text", text: "¡Claro! " + "x".repeat(3000) }],
      });
      const r = await buildAiReply("precio", ctx, draft, { apiKey: "k" });
      expect(r?.ai).toBe(true);
      expect(Buffer.byteLength(r!.text, "utf8")).toBeLessThanOrEqual(1000);
    });

    it("SDK lanza (timeout/401) → null; flag activo sin ANTHROPIC_API_KEY ni siquiera llama al SDK", async () => {
      aiCreate.mockRejectedValue(new Error("401 invalid x-api-key"));
      expect(await buildAiReply("precio", ctx, draft, { apiKey: "k" })).toBeNull();
      aiCreate.mockClear();
      delete process.env.ANTHROPIC_API_KEY;
      const r = await buildBotReply({
        text: "precio de la concha",
        context: ctx,
        siteUrl: ctx.siteUrl,
        aiEnabled: true,
      });
      expect(r.ai).toBe(false);
      expect(aiCreate).not.toHaveBeenCalled();
    });

    it("la IA nunca recibe más de 6 mensajes de historial ni entradas > 2000 chars", async () => {
      aiCreate.mockResolvedValue({
        content: [{ type: "text", text: "ok https://elpandepaula.mx/menu" }],
      });
      const history = Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
        content: `m${i}`,
      }));
      await buildAiReply("y".repeat(5000), ctx, draft, { apiKey: "k", history });
      const call = aiCreate.mock.calls[0]![0] as { messages: Array<{ content: string }> };
      expect(call.messages).toHaveLength(7);
      expect(call.messages.at(-1)!.content).toHaveLength(2000);
    });
  });
});
