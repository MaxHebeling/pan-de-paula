"use server";

import { webCheckoutSchema } from "@pdp/domain";
import { callFn, db, dbErrorMessage, sql } from "@/lib/db";
import { listProductsByIds } from "@/lib/catalog";
import { availability } from "@/lib/availability";
import { findCustomer, partialName } from "@/lib/customers";
import {
  getOrderByFolio,
  mercadoPagoAvailable,
  orderUrl,
  sendOrderConfirmationEmail,
  startMercadoPago,
} from "@/lib/orders";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { fulfillmentOptions, getBusiness } from "@/lib/site";
import { zonedToUtc } from "@/lib/tz";

export type LookupResult = { found: true; hint: string } | { found: false; error: string };

/** "Ya soy cliente": confirma solo un nombre parcial; el vínculo real se hace en el servidor al crear el pedido. */
export async function lookupCustomerAction(query: string): Promise<LookupResult> {
  // find_customer normaliza el teléfono (+52 / 52 / 521 / 01 → 10 dígitos) en SQL; códigos PDP y correos pasan tal cual.
  const q = (query ?? "").trim().slice(0, 120);
  if (q.length < 6) return { found: false, error: "Escribe tu teléfono o tu código PDP." };
  try {
    const rl = await rateLimit("lookup", { max: 20 });
    if (!rl.allowed) return { found: false, error: RATE_LIMIT_MESSAGE };
    const c = await findCustomer(q);
    if (!c)
      return {
        found: false,
        error: "No encontramos esa cuenta. Revisa el dato o continúa sin vincular.",
      };
    return { found: true, hint: partialName(c.fullName) };
  } catch (e) {
    console.error("[lookupCustomerAction]", e);
    return { found: false, error: "No pudimos buscar tu cuenta en este momento." };
  }
}

export type CheckoutPayload = {
  items: Array<{ product_id: string; qty: number; notes?: string }>;
  window_id: string;
  date: string;
  pickup_point_id?: string;
  delivery_address?: { street: string; neighborhood?: string; references_note?: string };
  customer_name: string;
  customer_phone: string;
  customer_email?: string;
  customer_lookup?: string | null;
  coupon_code?: string;
  notes?: string;
  payment_method: "mercadopago" | "cash" | "transfer";
  marketing_consent: boolean;
  idempotency_key: string;
};

export type CheckoutResult =
  { ok: true; redirect: string } | { ok: false; error: string; field?: string };

/**
 * create_order es idempotente por `idempotency_key`, pero dos envíos simultáneos con la misma clave
 * (doble clic con red lenta, dos pestañas) pueden pasar ambos la comprobación previa: el segundo choca con
 * el índice único. Aquí se resuelve devolviendo el pedido que ya existe en vez de un error genérico.
 */
async function createWebOrder(payload: Record<string, unknown> & { idempotency_key: string }) {
  try {
    return await callFn<string>(db(), "create_order", [JSON.stringify(payload)]);
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === "23505" && err.constraint === "orders_idempotency_key_key") {
      const row = await db()
        .selectFrom("orders")
        .select("id")
        .where("idempotency_key", "=", payload.idempotency_key)
        .executeTakeFirst();
      if (row) return row.id;
    }
    throw e;
  }
}

export async function placeOrderAction(payload: CheckoutPayload): Promise<CheckoutResult> {
  try {
    const rl = await rateLimit("checkout");
    if (!rl.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

    const business = await getBusiness();
    if (!business.flags.web_checkout) {
      return {
        ok: false,
        error:
          "Los pedidos en línea están pausados por el momento. Escríbenos por WhatsApp o Instagram.",
      };
    }

    // 1) Fecha/ventana: se revalida en el servidor con el calendario real.
    const options = fulfillmentOptions(business);
    const option = options.find((o) => o.windowId === payload.window_id && o.date === payload.date);
    if (!option) {
      return {
        ok: false,
        field: "date",
        error: "Esa fecha ya no está disponible. Elige otra de la lista.",
      };
    }
    const window = business.windows.find((w) => w.id === option.windowId)!;
    const isDelivery = window.fulfillmentType === "delivery";

    // 2) Validación del payload con el esquema compartido.
    const parsed = webCheckoutSchema.safeParse({
      items: payload.items,
      fulfillment_type: window.fulfillmentType,
      ordering_window_id: window.id,
      scheduled_date: option.date,
      pickup_point_id: isDelivery ? undefined : payload.pickup_point_id,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone, // phoneMX lo deja canónico (canonicalPhone)
      customer_email: payload.customer_email ?? "",
      delivery_address: isDelivery ? payload.delivery_address : undefined,
      coupon_code: payload.coupon_code ?? "",
      notes: payload.notes,
      payment_method: payload.payment_method,
      marketing_consent: Boolean(payload.marketing_consent),
      idempotency_key: payload.idempotency_key,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0]?.toString();
      const msg =
        field === "customer_phone"
          ? "Escribe un teléfono válido de 10 dígitos."
          : field === "customer_name"
            ? "Escribe tu nombre completo."
            : field === "customer_email"
              ? "Ese correo no parece válido."
              : field === "items"
                ? "Tu carrito está vacío."
                : field === "delivery_address"
                  ? "Completa la dirección de entrega."
                  : (issue?.message ?? "Revisa los datos del formulario.");
      return { ok: false, field, error: msg };
    }
    const data = parsed.data;
    if (isDelivery && !data.delivery_address) {
      return { ok: false, field: "delivery_address", error: "Completa la dirección de entrega." };
    }

    // 3) Productos: existen, se venden en web y están disponibles.
    const products = await listProductsByIds(data.items.map((i) => i.product_id));
    for (const item of data.items) {
      const p = products.find((x) => x.id === item.product_id);
      if (!p)
        return {
          ok: false,
          field: "items",
          error: "Uno de los productos ya no está disponible. Revisa tu carrito.",
        };
      if (!availability(p).canAdd)
        return {
          ok: false,
          field: "items",
          error: `"${p.name}" ya no está disponible. Quítalo del carrito para continuar.`,
        };
    }

    // 4) Método de pago permitido según flags/configuración.
    const mpOk = mercadoPagoAvailable(business.flags);
    const transferOk = Boolean(business.policies.transfer_instructions);
    if (data.payment_method === "mercadopago" && !mpOk)
      return {
        ok: false,
        field: "payment_method",
        error: "El pago en línea no está disponible ahora. Elige otro método.",
      };
    if (data.payment_method === "transfer" && !transferOk)
      return {
        ok: false,
        field: "payment_method",
        error: "La transferencia no está disponible ahora. Elige otro método.",
      };

    // 5) Punto de retiro (si aplica).
    let pickupPointId: string | undefined;
    if (!isDelivery) {
      const point =
        business.pickupPoints.find((p) => p.id === data.pickup_point_id) ??
        business.pickupPoints.find((p) => p.isDefault) ??
        business.pickupPoints[0];
      pickupPointId = point?.id;
    }

    // 6) Cliente: vínculo explícito ("ya soy cliente") o por teléfono. Nunca se revela nada al cliente aquí.
    let customerId: string | null = null;
    const lookup = payload.customer_lookup?.trim();
    if (lookup) customerId = (await findCustomer(lookup))?.id ?? null;
    if (!customerId) customerId = (await findCustomer(data.customer_phone))?.id ?? null;
    if (!customerId && data.marketing_consent) {
      // Aceptó comunicaciones: lo damos de alta en el club (fuente web) para poder sumarle puntos.
      const reg = await callFn<{ customer_id: string }>(db(), "register_customer", [
        JSON.stringify({
          full_name: data.customer_name,
          phone: data.customer_phone,
          email: data.customer_email,
          marketing_consent: true,
          source: "web",
        }),
      ]);
      customerId = reg.customer_id;
    }

    // 7) Crear pedido (precios del servidor, canal web).
    const scheduledFor = zonedToUtc(option.date, option.from ?? "00:00", business.timezone);
    const deliveryFee = isDelivery ? (business.policies.delivery_fee_cents ?? 0) : 0;
    const orderId = await createWebOrder({
      channel: "web",
      price_channel: "web",
      fulfillment_type: window.fulfillmentType,
      customer_id: customerId,
      customer_name: data.customer_name,
      customer_phone: data.customer_phone,
      customer_email: data.customer_email,
      pickup_point_id: pickupPointId,
      delivery_address: isDelivery ? data.delivery_address : undefined,
      scheduled_for: scheduledFor.toISOString(),
      ordering_window_id: window.id,
      notes: data.notes,
      items: data.items.map((i) => ({ product_id: i.product_id, qty: i.qty, notes: i.notes })),
      coupon_code: data.coupon_code,
      delivery_fee_cents: deliveryFee,
      idempotency_key: data.idempotency_key,
    });

    const row = await db()
      .selectFrom("orders")
      .select(["folio", "public_token", "status", "total_cents"])
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();

    // Reintento idempotente: si el pedido ya avanzó, solo devolvemos su página.
    if (row.status !== "new") return { ok: true, redirect: orderUrl(row.folio, row.public_token) };

    const methodLabel = {
      cash: "efectivo al recoger",
      transfer: "transferencia",
      mercadopago: "Mercado Pago",
    }[data.payment_method];
    await sql`update orders set internal_notes = concat_ws(E'\n', internal_notes, ${"Web: pago elegido = " + methodLabel}::text) where id = ${orderId}`.execute(
      db(),
    );

    if (data.payment_method === "cash" || data.payment_method === "transfer") {
      await callFn(db(), "change_order_status", [orderId, "confirmed", "Pedido web confirmado"]);
      if (data.payment_method === "transfer") {
        await callFn(db(), "record_payment", [
          JSON.stringify({
            order_id: orderId,
            provider: "manual",
            method: "transfer",
            status: "pending",
            amount_cents: row.total_cents,
            reference: row.folio,
            idempotency_key: `web-transfer-${orderId}`,
          }),
        ]);
      }
      const order = await getOrderByFolio(row.folio, row.public_token);
      if (order) await sendOrderConfirmationEmail(order, business);
      return { ok: true, redirect: orderUrl(row.folio, row.public_token, { nuevo: "1" }) };
    }

    // Mercado Pago
    const order = await getOrderByFolio(row.folio, row.public_token);
    if (!order) return { ok: false, error: "No pudimos recuperar el pedido recién creado." };
    try {
      const initPoint = await startMercadoPago(order, business);
      await sendOrderConfirmationEmail(order, business);
      return { ok: true, redirect: initPoint };
    } catch (e) {
      console.error(`[checkout] Mercado Pago falló para ${row.folio}`, e);
      return { ok: true, redirect: orderUrl(row.folio, row.public_token, { mp: "error" }) };
    }
  } catch (e) {
    console.error("[placeOrderAction]", e);
    const { message } = dbErrorMessage(e);
    if (/Cupón inválido/.test(message))
      return {
        ok: false,
        field: "coupon_code",
        error: "El cupón ya no aplica. Quítalo del carrito e inténtalo de nuevo.",
      };
    if (/no está disponible|no se vende en línea|no tiene precio/.test(message))
      return { ok: false, field: "items", error: message };
    return {
      ok: false,
      error: "No pudimos registrar tu pedido. Inténtalo de nuevo en un momento.",
    };
  }
}
