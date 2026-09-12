import { NextResponse } from "next/server";
import { z } from "zod";
import { db, sql } from "@/lib/db";
import { apiSession, dbErrorResponse, jsonError, readJson } from "@/lib/pos";
import type { CouponResult } from "@/components/pos/types";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().trim().min(1).max(40),
  customer_id: z.string().uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        qty: z.number().positive().max(999),
        discount_cents: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
});

const REASONS: Record<string, string> = {
  empty: "Escribe un código",
  not_found: "Cupón no encontrado",
  inactive: "Cupón inactivo",
  not_started: "El cupón aún no inicia",
  expired: "El cupón ya venció",
  exhausted: "El cupón agotó sus usos",
  channel: "Este cupón no aplica en tienda",
  min_subtotal: "El cupón requiere un mínimo de compra mayor",
  customer_limit: "El cliente ya usó este cupón",
  segment: "El cliente no califica para este cupón",
  requires_customer: "Este cupón requiere identificar al cliente",
  product_not_in_cart: "El producto del cupón no está en el carrito",
};

/**
 * Valida un cupón contra el carrito con precios del SERVIDOR (current_price_cents) y validate_coupon.
 * La previsualización es informativa: pos_checkout vuelve a validar al cobrar.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return jsonError(400, "Datos inválidos", "VALIDATION");
  const { code, customer_id, items } = parsed.data;
  try {
    const ids = items.map((i) => i.product_id);
    const prices = await sql<{ id: string; price: number | null }>`
      select p.id, current_price_cents(p.id, 'pos') as price from products p where p.id = any(${ids}::uuid[])`.execute(
      db(),
    );
    const priceOf = new Map(prices.rows.map((r) => [r.id, r.price]));
    let subtotal = 0;
    const itemsJson = items.map((i) => {
      const unit = priceOf.get(i.product_id) ?? 0;
      const total = Math.max(Math.round(unit * i.qty) - (i.discount_cents ?? 0), 0);
      subtotal += total;
      return { product_id: i.product_id, qty: i.qty, unit_price_cents: unit, total_cents: total };
    });
    const r = await sql<{
      v: { valid: boolean; reason?: string; code?: string; kind?: string; discount_cents?: number };
    }>`select validate_coupon(${code}, ${customer_id ?? null}::uuid, ${subtotal}, 'pos', ${JSON.stringify(itemsJson)}::jsonb) as v`.execute(
      db(),
    );
    const v = r.rows[0]!.v;
    const out: CouponResult = v.valid
      ? {
          valid: true,
          code: v.code!,
          kind: v.kind as "pct" | "amount" | "free_product",
          discountCents: v.discount_cents ?? 0,
        }
      : {
          valid: false,
          reason: v.reason ?? "invalid",
          message: REASONS[v.reason ?? ""] ?? "Cupón inválido",
        };
    return NextResponse.json(out);
  } catch (e) {
    return dbErrorResponse(e, "validate_coupon");
  }
}
