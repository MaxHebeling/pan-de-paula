"use server";

import { callFn, db, dbErrorMessage } from "@/lib/db";
import { listProductsByIds } from "@/lib/catalog";
import { findCustomer } from "@/lib/customers";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

export type CouponResult =
  | { ok: true; code: string; kind: "pct" | "amount" | "free_product"; discountCents: number }
  | { ok: false; error: string };

const REASONS: Record<string, string> = {
  empty: "Escribe un código.",
  not_found: "Ese cupón no existe.",
  inactive: "Ese cupón ya no está activo.",
  not_started: "Ese cupón aún no empieza.",
  expired: "Ese cupón ya venció.",
  exhausted: "Ese cupón ya se agotó.",
  channel: "Ese cupón no aplica para pedidos en línea.",
  min_subtotal: "Tu pedido no alcanza el mínimo para este cupón.",
  customer_limit: "Ya usaste este cupón.",
  segment: "Este cupón no aplica para tu cuenta.",
  requires_customer: "Este cupón es personal: vincula tu cuenta de cliente en el checkout.",
  product_not_in_cart: "Agrega el producto del cupón a tu carrito.",
};

/**
 * Valida un cupón contra precios del servidor (canal web). Solo previsualiza:
 * create_order vuelve a validarlo al confirmar el pedido.
 */
export async function validateCouponAction(input: {
  code: string;
  items: Array<{ productId: string; qty: number }>;
  customerLookup?: string | null;
}): Promise<CouponResult> {
  const code = (input.code ?? "").trim().slice(0, 40);
  if (!code) return { ok: false, error: REASONS.empty! };
  const items = (input.items ?? [])
    .filter((i) => typeof i.productId === "string" && Number.isInteger(i.qty) && i.qty > 0)
    .slice(0, 50);
  if (items.length === 0) return { ok: false, error: "Tu carrito está vacío." };
  try {
    const rl = await rateLimit("coupon", { max: 40 });
    if (!rl.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };
    const products = await listProductsByIds(items.map((i) => i.productId));
    const priced = items.flatMap((i) => {
      const p = products.find((x) => x.id === i.productId);
      if (!p || p.priceCents === null) return [];
      return [{ product_id: p.id, qty: i.qty, unit_price_cents: p.priceCents, total_cents: p.priceCents * i.qty }];
    });
    const subtotal = priced.reduce((s, l) => s + l.total_cents, 0);
    let customerId: string | null = null;
    const lookup = input.customerLookup?.trim();
    if (lookup) customerId = (await findCustomer(lookup))?.id ?? null;
    const r = await callFn<{
      valid: boolean;
      reason?: string;
      code?: string;
      kind?: "pct" | "amount" | "free_product";
      discount_cents?: number;
    }>(db(), "validate_coupon", [code, customerId, subtotal, "web", JSON.stringify(priced)]);
    if (!r.valid) return { ok: false, error: REASONS[r.reason ?? ""] ?? "Ese cupón no se puede aplicar." };
    return { ok: true, code: r.code ?? code, kind: r.kind ?? "amount", discountCents: r.discount_cents ?? 0 };
  } catch (e) {
    console.error("[validateCouponAction]", e);
    return { ok: false, error: dbErrorMessage(e).message };
  }
}
