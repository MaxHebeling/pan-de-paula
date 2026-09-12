import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeHtml,
  formatMoney,
  renderOrderConfirmationHtml,
  renderOrderStatusHtml,
  renderReceiptHtml,
  renderReceiptText,
  safeUrl,
  sendEmail,
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
  sendReceiptEmail,
  type OrderConfirmationData,
  type ReceiptData,
} from "../src/email.ts";
import { _resetBreakers } from "../src/http.ts";

const receipt: ReceiptData = {
  folio: "PDP-2026-000123",
  businessName: "El Pan de Paula",
  soldAt: new Date("2026-09-12T17:30:00.000Z"),
  items: [
    {
      name: "Croissant Dubai <script>alert(1)</script>",
      qty: 2,
      unitPriceCents: 9500,
      totalCents: 19000,
    },
    { name: "Concha", qty: 0.5, unitPriceCents: 3000, totalCents: 1500 },
  ],
  subtotalCents: 20500,
  discountCents: 500,
  totalCents: 20000,
  payments: [
    { method: "cash", amountCents: 10000 },
    { method: "mercadopago", amountCents: 10000 },
  ],
  customerName: 'Ana "la" López & Cía',
  pointsEarned: 20,
  pointsBalance: 140,
  logoUrl: "https://elpandepaula.mx/brand/logo.png",
  siteUrl: "https://elpandepaula.mx",
};

describe("render", () => {
  it("escapa HTML y URLs", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("https://ok.mx/a?b=1&c=2")).toBe("https://ok.mx/a?b=1&amp;c=2");
    expect(safeUrl("no-url")).toBeNull();
  });
  it("formatea dinero MXN", () => {
    expect(formatMoney(20000)).toMatch(/200\.00/);
    expect(formatMoney(1)).toMatch(/0\.01/);
  });
  it("comprobante: ítems, totales, pagos, puntos, logo, escapado", () => {
    const html = renderReceiptHtml(receipt);
    expect(html).toContain("PDP-2026-000123");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ana &quot;la&quot; López &amp; Cía");
    expect(html).toContain('src="https://elpandepaula.mx/brand/logo.png"');
    expect(html).toContain("Efectivo");
    expect(html).toContain("Mercado Pago");
    expect(html).toContain("Descuento");
    expect(html).toContain("Puntos ganados en esta compra: <strong>20</strong>");
    expect(html).toContain("Saldo de puntos: <strong>140</strong>");
    expect(html).toContain("0.5 × ");
    const text = renderReceiptText(receipt);
    expect(text).toContain("Total: ");
    expect(text).toContain("Puntos ganados: 20");
  });
  it("comprobante sin logo ni puntos no rompe", () => {
    const html = renderReceiptHtml({
      ...receipt,
      logoUrl: null,
      pointsEarned: undefined,
      pointsBalance: undefined,
      customerName: null,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Puntos");
    expect(html).toContain("Gracias por tu compra.");
  });

  const order: OrderConfirmationData = {
    folio: "PDP-2026-000200",
    businessName: "El Pan de Paula",
    customerName: "Luis",
    items: [{ name: "Concha", qty: 6, unitPriceCents: 3000, totalCents: 18000 }],
    subtotalCents: 18000,
    discountCents: 0,
    totalCents: 18000,
    paidCents: 0,
    paymentStatus: "pending",
    fulfillmentType: "scheduled_pickup",
    scheduledFor: new Date("2026-09-18T17:00:00.000Z"),
    pickupPoint: {
      name: "Tienda Centro",
      address: "Av. Revolución 123",
      mapUrl: "https://maps.app.goo.gl/x",
    },
    statusUrl: "https://elpandepaula.mx/pedido/PDP-2026-000200?t=abc",
    payUrl: "https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=1",
    notes: "Sin <b>nuez</b>",
  };
  it("confirmación de pedido: enlace de estado, botón de pago si está pendiente, escapado", () => {
    const html = renderOrderConfirmationHtml(order);
    expect(html).toContain('href="https://elpandepaula.mx/pedido/PDP-2026-000200?t=abc"');
    expect(html).toContain("Completar pago");
    expect(html).toContain("Recoger en tienda (con cita)");
    expect(html).toContain("Tienda Centro");
    expect(html).toContain("Cómo llegar");
    expect(html).toContain("Sin &lt;b&gt;nuez&lt;/b&gt;");
    expect(html).not.toContain("<b>nuez</b>");
    const paid = renderOrderConfirmationHtml({ ...order, paymentStatus: "paid", paidCents: 18000 });
    expect(paid).not.toContain("Completar pago");
    expect(paid).toContain("Ya estamos preparando todo");
  });
  it("cambio de estado: etiqueta y mensaje en español", () => {
    const html = renderOrderStatusHtml({
      folio: "PDP-1",
      businessName: "El Pan de Paula",
      status: "ready_for_pickup",
      statusUrl: "https://elpandepaula.mx/pedido/PDP-1",
      customerName: "Ana",
    });
    expect(html).toContain("Listo para recoger");
    expect(html).toContain("listo para recoger");
    expect(html).toContain("Ver mi pedido");
  });
});

describe("sendEmail (Resend mockeado)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    _resetBreakers();
    process.env.RESEND_API_KEY = "re_test_123";
    process.env.EMAIL_FROM = "El Pan de Paula <pedidos@elpandepaula.mx>";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("sin configuración: skipped, sin llamar a la red", async () => {
    delete process.env.RESEND_API_KEY;
    const r = await sendEmail({ to: "a@b.mx", subject: "x", html: "<p>x</p>" });
    expect(r).toEqual({ sent: false, skipped: "not_configured" });
    expect(await sendReceiptEmail("a@b.mx", receipt)).toEqual({
      sent: false,
      skipped: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envía con Authorization, Idempotency-Key y cuerpo Resend", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const r = await sendEmail({
      to: "ana@example.com",
      subject: "Hola",
      html: "<p>Hola</p>",
      text: "Hola",
      replyTo: "hola@elpandepaula.mx",
      idempotencyKey: "k-1",
    });
    expect(r).toEqual({ sent: true, id: "email-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const h = init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_test_123");
    expect(h["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "El Pan de Paula <pedidos@elpandepaula.mx>",
      to: ["ana@example.com"],
      subject: "Hola",
      html: "<p>Hola</p>",
      text: "Hola",
      reply_to: "hola@elpandepaula.mx",
    });
  });

  it("error del proveedor no lanza: devuelve sent=false con mensaje", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to`" }), {
        status: 422,
      }),
    );
    const r = await sendEmail({ to: "ana@example.com", subject: "x", html: "x" });
    expect(r.sent).toBe(false);
    expect(r.error).toContain("Invalid `to`");
  });

  it("fallo de red no lanza", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const r = await sendEmail({ to: "ana@example.com", subject: "x", html: "x" });
    expect(r.sent).toBe(false);
    expect(r.error).toBe("ECONNRESET");
  }, 10_000);

  it("destinatario inválido no llama a la red", async () => {
    const r = await sendEmail({ to: "no-es-correo", subject: "x", html: "x" });
    expect(r).toEqual({ sent: false, error: "Destinatario inválido" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("comprobante, confirmación y estado usan claves de idempotencia deterministas", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "e" }), { status: 200 }));
    await sendReceiptEmail("Ana@Example.com", receipt);
    await sendOrderConfirmationEmail("ana@example.com", {
      folio: "PDP-2026-000200",
      businessName: "El Pan de Paula",
      items: [],
      subtotalCents: 0,
      discountCents: 0,
      totalCents: 0,
      fulfillmentType: "pickup",
      statusUrl: "https://elpandepaula.mx/pedido/PDP-2026-000200",
    });
    await sendOrderStatusEmail("ana@example.com", {
      folio: "PDP-2026-000200",
      businessName: "El Pan de Paula",
      status: "ready",
      statusUrl: "https://elpandepaula.mx/pedido/PDP-2026-000200",
    });
    const keys = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toEqual([
      "receipt:PDP-2026-000123:ana@example.com",
      "order-confirmation:PDP-2026-000200:ana@example.com",
      "order-status:PDP-2026-000200:ready:ana@example.com",
    ]);
    const subjects = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).subject);
    expect(subjects[0]).toBe("Tu comprobante PDP-2026-000123 · El Pan de Paula");
    expect(subjects[2]).toBe("Pedido PDP-2026-000200: Listo · El Pan de Paula");
  });
});
