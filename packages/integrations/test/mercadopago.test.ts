import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  amountToCents,
  buildMercadoPagoManifest,
  centsToAmount,
  centsToAmountString,
  createMercadoPagoPreference,
  createPointOrder,
  createQrOrder,
  fetchMercadoPagoOrder,
  fetchMercadoPagoPayment,
  MercadoPagoApiError,
  mpOrderStatusToPaymentStatus,
  parseMercadoPagoSignatureHeader,
  parseMercadoPagoWebhook,
  refundMercadoPagoPayment,
  signMercadoPagoWebhook,
  toMpDate,
  verifyMercadoPagoSignature,
} from "../src/mercadopago.ts";
import { NotConfiguredError } from "../src/errors.ts";
import { _resetBreakers } from "../src/http.ts";

const SECRET = "clave-secreta-de-prueba-1234567890";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("dinero", () => {
  it("convierte centavos a pesos y viceversa sin errores de flotante", () => {
    expect(centsToAmount(3050)).toBe(30.5);
    expect(centsToAmount(1)).toBe(0.01);
    expect(centsToAmountString(3050)).toBe("30.50");
    expect(centsToAmountString(5)).toBe("0.05");
    expect(centsToAmountString(120000)).toBe("1200.00");
    expect(amountToCents(30.5)).toBe(3050);
    expect(amountToCents("30.50")).toBe(3050);
    expect(amountToCents(1.005)).toBe(101);
    expect(amountToCents(0.1 + 0.2)).toBe(30);
    expect(amountToCents(4.35)).toBe(435);
    expect(amountToCents(null)).toBe(0);
  });
  it("rechaza montos inválidos", () => {
    expect(() => centsToAmount(10.5)).toThrow();
    expect(() => centsToAmount(-1)).toThrow();
    expect(() => amountToCents("abc")).toThrow();
  });
  it("formatea fechas con offset explícito", () => {
    expect(toMpDate(new Date("2026-09-12T18:00:00.000Z"))).toBe("2026-09-12T18:00:00.000+00:00");
  });
});

describe("firma x-signature", () => {
  const ts = "1704908010";
  const requestId = "bb56a2f1-2d3e-4f5a-9b6c-7d8e9f0a1b2c";
  const dataId = "123456789";

  function sign(manifest: string, secret = SECRET) {
    return createHmac("sha256", secret).update(manifest).digest("hex");
  }

  it("construye el manifest oficial y valida una firma correcta", () => {
    const manifest = buildMercadoPagoManifest({ dataId, xRequestId: requestId, ts });
    expect(manifest).toBe(`id:${dataId};request-id:${requestId};ts:${ts};`);
    const header = `ts=${ts},v1=${sign(manifest)}`;
    expect(
      verifyMercadoPagoSignature({
        xSignature: header,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("pasa data.id alfanumérico a minúsculas y omite valores ausentes", () => {
    expect(buildMercadoPagoManifest({ dataId: "ABC123DEF", xRequestId: requestId, ts })).toBe(
      `id:abc123def;request-id:${requestId};ts:${ts};`,
    );
    expect(buildMercadoPagoManifest({ dataId: null, xRequestId: requestId, ts })).toBe(
      `request-id:${requestId};ts:${ts};`,
    );
    expect(buildMercadoPagoManifest({ dataId, xRequestId: null, ts })).toBe(
      `id:${dataId};ts:${ts};`,
    );
  });

  it("acepta la cabecera con espacios y orden distinto", () => {
    const manifest = buildMercadoPagoManifest({ dataId, xRequestId: requestId, ts });
    const header = ` v1=${sign(manifest)} , ts=${ts} `;
    expect(parseMercadoPagoSignatureHeader(header)).toEqual({ ts, v1: sign(manifest) });
    expect(
      verifyMercadoPagoSignature({
        xSignature: header,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rechaza firma inválida", () => {
    const header = `ts=${ts},v1=${"0".repeat(64)}`;
    expect(
      verifyMercadoPagoSignature({
        xSignature: header,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rechaza secreto distinto", () => {
    const header = signMercadoPagoWebhook({
      dataId,
      xRequestId: requestId,
      ts,
      secret: "otra-clave-larga-xxxxxxxx",
    });
    expect(
      verifyMercadoPagoSignature({
        xSignature: header,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rechaza cabecera ausente, malformada o secreto ausente", () => {
    expect(
      verifyMercadoPagoSignature({
        xSignature: null,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({ xSignature: "", xRequestId: requestId, dataId, secret: SECRET }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({
        xSignature: "ts=1",
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({
        xSignature: "v1=abc",
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({
        xSignature: `ts=${ts},v1=zz`,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
    const ok = signMercadoPagoWebhook({ dataId, xRequestId: requestId, ts, secret: SECRET });
    expect(
      verifyMercadoPagoSignature({
        xSignature: ok,
        xRequestId: requestId,
        dataId,
        secret: undefined,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({ xSignature: ok, xRequestId: requestId, dataId, secret: "" }),
    ).toBe(false);
  });

  it("rechaza ts manipulado (la firma deja de coincidir)", () => {
    const ok = signMercadoPagoWebhook({ dataId, xRequestId: requestId, ts, secret: SECRET });
    const tampered = ok.replace(`ts=${ts}`, `ts=${Number(ts) + 1}`);
    expect(
      verifyMercadoPagoSignature({
        xSignature: tampered,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rechaza data.id o x-request-id distintos a los firmados", () => {
    const ok = signMercadoPagoWebhook({ dataId, xRequestId: requestId, ts, secret: SECRET });
    expect(
      verifyMercadoPagoSignature({
        xSignature: ok,
        xRequestId: requestId,
        dataId: "987",
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature({ xSignature: ok, xRequestId: "otro", dataId, secret: SECRET }),
    ).toBe(false);
  });

  it("aplica ventana de antigüedad solo si se pide", () => {
    const now = Number(ts) * 1000 + 10 * 60 * 60_000; // 10 h después
    const ok = signMercadoPagoWebhook({ dataId, xRequestId: requestId, ts, secret: SECRET });
    expect(
      verifyMercadoPagoSignature({
        xSignature: ok,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
    expect(
      verifyMercadoPagoSignature({
        xSignature: ok,
        xRequestId: requestId,
        dataId,
        secret: SECRET,
        now,
        maxAgeMs: 60 * 60_000,
      }),
    ).toBe(false);
  });
});

describe("parseMercadoPagoWebhook", () => {
  it("extrae data.id de la query, type/action del body y cabeceras", () => {
    const headers = new Headers({ "x-request-id": "req-1", "x-signature": "ts=1,v1=a" });
    const n = parseMercadoPagoWebhook({
      url: "https://elpandepaula.mx/api/webhooks/mercadopago?data.id=555&type=payment",
      rawBody: JSON.stringify({
        id: 99,
        type: "payment",
        action: "payment.updated",
        live_mode: true,
        data: { id: "555" },
      }),
      headers,
    });
    expect(n).toMatchObject({
      dataId: "555",
      type: "payment",
      action: "payment.updated",
      notificationId: "99",
      liveMode: true,
      xRequestId: "req-1",
      xSignature: "ts=1,v1=a",
    });
  });
  it("soporta formato IPN (topic + id en query) y body vacío/no JSON", () => {
    const n = parseMercadoPagoWebhook({
      url: "https://x.mx/api/webhooks/mercadopago?topic=merchant_order&id=777",
      rawBody: "",
      headers: new Headers(),
    });
    expect(n.type).toBe("merchant_order");
    expect(n.dataId).toBe("777");
    expect(n.body).toBeNull();
    const m = parseMercadoPagoWebhook({
      url: "https://x.mx/w",
      rawBody: "{no json",
      headers: new Headers(),
    });
    expect(m.body).toBeNull();
    expect(m.dataId).toBeNull();
  });
  it("usa data.id del body si la query no lo trae", () => {
    const n = parseMercadoPagoWebhook({
      url: "https://x.mx/w",
      rawBody: JSON.stringify({ type: "payment", data: { id: 42 } }),
      headers: new Headers(),
    });
    expect(n.dataId).toBe("42");
  });
});

describe("REST con fetch mockeado", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    _resetBreakers();
    process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token-de-prueba";
    process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID = "CAJA01";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    delete process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID;
  });

  it("falla con NotConfiguredError sin access token", async () => {
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    await expect(fetchMercadoPagoPayment("1")).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("crea preferencia con items en pesos, external_reference, back_urls, metadata y expiración", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "123-abc",
        init_point: "https://mp/init",
        sandbox_init_point: "https://mp/sandbox",
      }),
    );
    const expiresAt = new Date("2026-09-13T01:00:00.000Z");
    const r = await createMercadoPagoPreference({
      orderId: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      folio: "PDP-2026-000010",
      items: [
        { title: "Croissant Dubai", quantity: 2, unitPriceCents: 9500, id: "prod-1" },
        { title: "Concha", quantity: 6, unitPriceCents: 3000 },
      ],
      payer: { name: "Ana", email: "ana@example.com", phone: "6641234567" },
      backUrls: { success: "https://s/ok", failure: "https://s/fail", pending: "https://s/pend" },
      notificationUrl: "https://s/api/webhooks/mercadopago",
      expiresAt,
      statementDescriptor: "EL PAN DE PAULA MX ABCDEFG",
    });
    expect(r).toEqual({
      preferenceId: "123-abc",
      initPoint: "https://mp/init",
      sandboxInitPoint: "https://mp/sandbox",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mercadopago.com/checkout/preferences");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer TEST-token-de-prueba");
    expect(headers["X-Idempotency-Key"]).toBe("pref:0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d");
    const body = JSON.parse(String(init?.body));
    expect(body.items).toEqual([
      { id: "prod-1", title: "Croissant Dubai", quantity: 2, unit_price: 95, currency_id: "MXN" },
      { id: "item-2", title: "Concha", quantity: 6, unit_price: 30, currency_id: "MXN" },
    ]);
    expect(body.external_reference).toBe("0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d");
    expect(body.notification_url).toBe("https://s/api/webhooks/mercadopago");
    expect(body.back_urls).toEqual({
      success: "https://s/ok",
      failure: "https://s/fail",
      pending: "https://s/pend",
    });
    expect(body.auto_return).toBe("approved");
    expect(body.statement_descriptor).toBe("EL PAN DE PAULA MX ABC");
    expect(body.metadata).toEqual({
      order_id: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      folio: "PDP-2026-000010",
    });
    expect(body.expires).toBe(true);
    expect(body.expiration_date_to).toBe("2026-09-13T01:00:00.000+00:00");
    expect(body.expiration_date_from).toMatch(/\+00:00$/);
    expect(body.payer).toEqual({
      name: "Ana",
      email: "ana@example.com",
      phone: { number: "6641234567" },
    });
  });

  it("no manda expiración ni payer si no se dan", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, init_point: "https://mp/init" }));
    await createMercadoPagoPreference({
      orderId: "o1",
      folio: "F",
      items: [{ title: "x", quantity: 1, unitPriceCents: 100 }],
      backUrls: { success: "a", failure: "b", pending: "c" },
      notificationUrl: "n",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.expires).toBeUndefined();
    expect(body.payer).toBeUndefined();
    expect(body.statement_descriptor).toBe("EL PAN DE PAULA");
  });

  it("consulta un pago y mapea montos a centavos", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 123456789,
        status: "approved",
        status_detail: "accredited",
        transaction_amount: 250.1,
        external_reference: "order-uuid",
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        date_approved: "2026-09-12T10:00:00.000-06:00",
      }),
    );
    const p = await fetchMercadoPagoPayment("123456789");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.mercadopago.com/v1/payments/123456789");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
    expect(p).toMatchObject({
      id: "123456789",
      status: "approved",
      statusDetail: "accredited",
      transactionAmountCents: 25010,
      externalReference: "order-uuid",
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      dateApproved: "2026-09-12T10:00:00.000-06:00",
    });
  });

  it("rechaza ids de pago no numéricos sin llamar a la red", async () => {
    await expect(fetchMercadoPagoPayment("../oops")).rejects.toThrow(/inválido/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lanza MercadoPagoApiError con el mensaje de la API", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          message: "Payment not found",
          error: "not_found",
          status: 404,
          cause: [{ code: 2000, description: "Payment not found" }],
        },
        404,
      ),
    );
    const err = await fetchMercadoPagoPayment("1").catch((e) => e);
    expect(err).toBeInstanceOf(MercadoPagoApiError);
    expect(err.status).toBe(404);
    expect(err.mpMessage).toBe("Payment not found");
    expect(err.mpCauses[0].code).toBe(2000);
  });

  it("reintenta GET ante 5xx (idempotente)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("upstream", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ id: 5, status: "pending", transaction_amount: 10 }));
    const p = await fetchMercadoPagoPayment("5");
    expect(p.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("reembolsa parcial y total con X-Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 999, payment_id: 1, amount: 50.5, status: "approved" }),
    );
    const r = await refundMercadoPagoPayment("1", 5050, "refund:abc");
    expect(r).toEqual({ refundId: "999", status: "approved" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mercadopago.com/v1/payments/1/refunds");
    expect((init?.headers as Record<string, string>)["X-Idempotency-Key"]).toBe("refund:abc");
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 50.5 });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1000, status: "approved" }));
    await refundMercadoPagoPayment("1");
    const init2 = fetchMock.mock.calls[1]![1];
    expect(JSON.parse(String(init2?.body))).toEqual({});
    expect((init2?.headers as Record<string, string>)["X-Idempotency-Key"]).toMatch(
      /[0-9a-f-]{36}/,
    );
  });

  it("crea orden Point con montos en string decimal", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "ORD01", status: "created", type: "point" }, 201),
    );
    const r = await createPointOrder({
      deviceId: "NEWLAND_N950__N950NCC303060616",
      amountCents: 12000,
      externalReference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      description: "Pedido PDP-2026-000010",
      idempotencyKey: "point:1",
    });
    expect(r).toEqual({ orderId: "ORD01", status: "created" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mercadopago.com/v1/orders");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      type: "point",
      external_reference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      transactions: { payments: [{ amount: "120.00" }] },
      config: {
        // Por defecto imprime AMBOS comprobantes: el cliente espera el suyo y el negocio necesita la
        // copia firmada. Con `no_ticket` el mostrador se quedaba sin ningún papel.
        point: { terminal_id: "NEWLAND_N950__N950NCC303060616", print_on_terminal: "both" },
      },
    });
    expect((init?.headers as Record<string, string>)["X-Idempotency-Key"]).toBe("point:1");
  });

  it("un cobro por debajo del mínimo de Mercado Pago se rechaza aquí, con un mensaje claro", async () => {
    await expect(
      createPointOrder({
        deviceId: "NEWLAND_N950__N950NCC303060616",
        amountCents: 100,
        externalReference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
        description: "Pan chico",
      }),
    ).rejects.toThrow(/al menos \$5\.00/);
    // Y no se llamó a la API: el error se da antes, no a medio cobro con el cliente enfrente.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respeta el tipo de comprobante cuando se pide explícitamente", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "ORD02", status: "created" }, 201));
    await createPointOrder({
      deviceId: "NEWLAND_N950__N950NCC303060616",
      amountCents: 12000,
      externalReference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      description: "Pedido",
      printOnTerminal: "buyer_ticket",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.config.point.print_on_terminal).toBe("buyer_ticket");
  });

  it("crea orden QR dinámica y devuelve qr_data", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: "ORDQR",
          status: "created",
          type_response: { qr_data: "00020101021243650016COM.MERCADOLIBRE..." },
        },
        201,
      ),
    );
    const r = await createQrOrder({
      amountCents: 4550,
      externalReference: "venta-1",
      description: "Venta mostrador",
      items: [{ title: "Concha", quantity: 1, unitPriceCents: 4550 }],
    });
    expect(r.qrData).toContain("COM.MERCADOLIBRE");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({
      type: "qr",
      total_amount: "45.50",
      config: { qr: { external_pos_id: "CAJA01", mode: "dynamic" } },
      transactions: { payments: [{ amount: "45.50" }] },
      items: [{ title: "Concha", unit_price: "45.50", quantity: 1, unit_measure: "unit" }],
    });
  });

  it("consulta una orden (Point/QR) y mapea external_reference, montos y pagos", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ORD01JYH1Z1YJN4HZ8J3Q0RB3YP6D",
        type: "point",
        external_reference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
        status: "processed",
        status_detail: "accredited",
        total_amount: "120.50",
        total_paid_amount: "120.50",
        transactions: {
          payments: [
            {
              id: "PAY01K22Y503EJ8JHGF64KGY1PZ2B",
              amount: "120.50",
              paid_amount: "120.50",
              status: "processed",
              status_detail: "accredited",
            },
          ],
        },
      }),
    );
    const o = await fetchMercadoPagoOrder("ORD01JYH1Z1YJN4HZ8J3Q0RB3YP6D");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.mercadopago.com/v1/orders/ORD01JYH1Z1YJN4HZ8J3Q0RB3YP6D",
    );
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
    expect(o).toMatchObject({
      orderId: "ORD01JYH1Z1YJN4HZ8J3Q0RB3YP6D",
      type: "point",
      status: "processed",
      statusDetail: "accredited",
      externalReference: "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
      totalAmountCents: 12050,
      totalPaidAmountCents: 12050,
      paymentIds: ["PAY01K22Y503EJ8JHGF64KGY1PZ2B"],
    });
  });

  it("orden sin total_paid_amount suma paid_amount de sus pagos", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "ORD01X",
        status: "processed",
        total_amount: "50.00",
        transactions: {
          payments: [
            { id: "PAY1", paid_amount: "20.00" },
            { id: "PAY2", paid_amount: "30.00" },
          ],
        },
      }),
    );
    const o = await fetchMercadoPagoOrder("ORD01X");
    expect(o.totalPaidAmountCents).toBe(5000);
    expect(o.paymentIds).toEqual(["PAY1", "PAY2"]);
  });

  it("rechaza ids de orden inválidos sin llamar a la red", async () => {
    await expect(fetchMercadoPagoOrder("../v1/payments/1")).rejects.toThrow(/inválido/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("QR sin external_pos_id configurado falla claro", async () => {
    delete process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID;
    await expect(
      createQrOrder({ amountCents: 100, externalReference: "x", description: "y" }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("mpOrderStatusToPaymentStatus", () => {
  it("traduce estados de la API de Órdenes al vocabulario de apply_mercadopago_payment", () => {
    expect(mpOrderStatusToPaymentStatus("processed")).toBe("approved");
    expect(mpOrderStatusToPaymentStatus("failed")).toBe("rejected");
    expect(mpOrderStatusToPaymentStatus("canceled")).toBe("cancelled");
    expect(mpOrderStatusToPaymentStatus("expired")).toBe("cancelled");
    expect(mpOrderStatusToPaymentStatus("refunded")).toBe("refunded");
    for (const s of ["created", "at_terminal", "action_required", "algo_nuevo"])
      expect(mpOrderStatusToPaymentStatus(s)).toBe("pending");
  });
});
