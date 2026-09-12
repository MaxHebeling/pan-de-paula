import "server-only";
import { NextResponse } from "next/server";
import { isEmailConfigured, isMercadoPagoConfigured } from "@pdp/integrations";
import type { StaffSession } from "@pdp/auth";
import { getSession, hasPermission } from "./auth";
import { db, sql, dbErrorMessage } from "./db";
import { todayLocal } from "./format";
import type {
  ApiError,
  PosCatalog,
  PosConfig,
  PosCustomer,
  PosProduct,
  StockLevel,
} from "@/components/pos/types";

// ── Sesión en route handlers ────────────────────────────────────────────────
export type ApiSessionResult =
  { ok: true; session: StaffSession } | { ok: false; response: NextResponse<ApiError> };

/** Sesión para route handlers: 401 sin sesión, 403 sin permiso (JSON, no redirect). */
export async function apiSession(permission: string): Promise<ApiSessionResult> {
  const session = await getSession();
  if (!session)
    return { ok: false, response: jsonError(401, "Sesión expirada", "UNAUTHENTICATED") };
  if (!hasPermission(session, permission))
    return {
      ok: false,
      response: jsonError(403, "No tienes permiso para esta acción", "FORBIDDEN"),
    };
  return { ok: true, session };
}

export function jsonError(status: number, error: string, code?: string) {
  return NextResponse.json<ApiError>(code ? { error, code } : { error }, { status });
}

/** Convierte un error de base de datos en respuesta JSON segura (400 para reglas de negocio). */
export function dbErrorResponse(e: unknown, context: string) {
  const { message, code } = dbErrorMessage(e);
  console.error(`[pos] ${context}`, { code, message });
  const status = code === "23514" || code === "P0001" || code === "23505" ? 409 : code ? 400 : 500;
  return jsonError(status, message, code);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (e) {
    console.error("[pos] cuerpo JSON inválido", (e as Error).message);
    return null;
  }
}

// ── Flags y caja ────────────────────────────────────────────────────────────
export async function getFlags<K extends string>(keys: readonly K[]): Promise<Record<K, boolean>> {
  const r = await sql<{ key: K; enabled: boolean }>`
    select key, enabled from feature_flags where key = any(${keys as unknown as string[]}::text[])`.execute(
    db(),
  );
  const out = Object.fromEntries(keys.map((k) => [k, false])) as Record<K, boolean>;
  for (const row of r.rows) out[row.key] = row.enabled;
  return out;
}

export type OpenRegister = {
  id: string;
  openedAt: Date;
  openingCashCents: number;
  openedByName: string;
  notes: string | null;
};

export async function getOpenRegister(): Promise<OpenRegister | null> {
  const r = await sql<{
    id: string;
    opened_at: Date;
    opening_cash_cents: number;
    opened_by_name: string;
    notes: string | null;
  }>`select rs.id, rs.opened_at, rs.opening_cash_cents, su.full_name as opened_by_name, rs.notes
     from register_sessions rs join staff_users su on su.id = rs.opened_by
     where rs.status = 'open' limit 1`.execute(db());
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    openedAt: row.opened_at,
    openingCashCents: row.opening_cash_cents,
    openedByName: row.opened_by_name,
    notes: row.notes,
  };
}

export type RegisterSummary = {
  session_id: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  opening_cash_cents: number;
  sales_count: number;
  voided_count: number;
  sales_total_cents: number;
  items_count: number | string;
  cash_cents: number;
  card_cents: number;
  transfer_cents: number;
  mercadopago_cents: number;
  other_cents: number;
  refunds_cash_cents: number;
  refunds_other_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number | null;
  difference_cents: number | null;
};

export async function getRegisterSummary(sessionId: string): Promise<RegisterSummary | null> {
  const r = await sql<{
    s: RegisterSummary | null;
  }>`select register_session_summary(${sessionId}::uuid) as s`.execute(db());
  return r.rows[0]?.s ?? null;
}

// ── Configuración del POS para el cliente ───────────────────────────────────
export async function loadPosConfig(session: StaffSession): Promise<PosConfig> {
  const [flags, register, bs] = await Promise.all([
    getFlags([
      "mercadopago_point",
      "mercadopago_qr",
      "email_receipts",
      "pos_offline_queue",
      "loyalty",
    ] as const),
    getOpenRegister(),
    sql<{
      name: string;
      whatsapp: string | null;
      tax_rate_bps: number;
      prices_include_tax: boolean;
      allow_negative_stock: boolean;
    }>`select name, whatsapp, tax_rate_bps, prices_include_tax, allow_negative_stock from business_settings where id = 1`.execute(
      db(),
    ),
  ]);
  const b = bs.rows[0]!;
  return {
    flags,
    mpConfigured: isMercadoPagoConfigured(),
    mpPointDeviceConfigured: Boolean(process.env.MERCADOPAGO_POINT_DEVICE_ID),
    emailConfigured: isEmailConfigured(),
    canDiscount: hasPermission(session, "pos.refund"),
    canRefund: hasPermission(session, "pos.refund"),
    canRegister: hasPermission(session, "pos.register"),
    register: register
      ? {
          id: register.id,
          openedAt: register.openedAt.toISOString(),
          openingCashCents: register.openingCashCents,
        }
      : null,
    business: {
      name: b.name,
      whatsapp: b.whatsapp,
      taxRateBps: b.tax_rate_bps,
      pricesIncludeTax: b.prices_include_tax,
      allowNegativeStock: b.allow_negative_stock,
    },
    staffName: session.staff.fullName,
  };
}

// ── Catálogo ────────────────────────────────────────────────────────────────
export async function loadPosCatalog(): Promise<PosCatalog> {
  const d = db();
  const [cats, prods] = await Promise.all([
    sql<{ id: string; name: string; slug: string }>`
      select c.id, c.name, c.slug from categories c
      where c.deleted_at is null and c.is_active
        and exists (select 1 from products p where p.category_id = c.id and p.deleted_at is null and p.is_active and p.show_on_pos)
      order by c.sort_order, c.name`.execute(d),
    sql<{
      id: string;
      name: string;
      sku: string | null;
      parent_id: string | null;
      variant_label: string | null;
      category_id: string | null;
      category_name: string | null;
      pos_price_cents: number | null;
      primary_image_url: string | null;
      pos_favorite: boolean;
      track_stock: boolean;
      on_hand: string | number | null;
      level: StockLevel | null;
    }>`
      select cp.id, cp.name, cp.sku, cp.parent_id, cp.variant_label, cp.category_id, cp.category_name,
             cp.pos_price_cents, cp.primary_image_url, cp.pos_favorite, cp.track_stock,
             ss.on_hand, ss.level
      from catalog_products cp
      left join stock_status ss on ss.product_id = cp.id
      where cp.is_active and cp.show_on_pos
      order by cp.sort_order, cp.name`.execute(d),
  ]);
  const products: PosProduct[] = prods.rows.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    parentId: p.parent_id,
    variantLabel: p.variant_label,
    categoryId: p.category_id,
    categoryName: p.category_name,
    priceCents: p.pos_price_cents,
    imageUrl: p.primary_image_url,
    favorite: p.pos_favorite,
    trackStock: p.track_stock,
    onHand: Number(p.on_hand ?? 0),
    level: p.track_stock ? (p.level ?? "ok") : "ok",
  }));
  return { categories: cats.rows, products };
}

// ── Clientes ────────────────────────────────────────────────────────────────
type CustomerRow = {
  id: string;
  full_name: string;
  public_code: string;
  phone: string | null;
  email: string | null;
  points_balance: number;
  tier_key: string | null;
  tier_name: string | null;
  total_orders: number;
  birthday: string | Date | null;
};

const CUSTOMER_COLS = sql`c.id, c.full_name, c.public_code, c.phone::text as phone, c.email::text as email, c.points_balance,
  c.tier_key, t.name as tier_name, c.total_orders, to_char(c.birthday, 'YYYY-MM-DD') as birthday`;

function toCustomer(r: CustomerRow): PosCustomer {
  const today = todayLocal();
  const bday = r.birthday ? String(r.birthday) : null;
  return {
    id: r.id,
    fullName: r.full_name,
    publicCode: r.public_code,
    phone: r.phone,
    email: r.email,
    pointsBalance: r.points_balance,
    tierKey: r.tier_key,
    tierName: r.tier_name,
    totalOrders: r.total_orders,
    birthdayToday: Boolean(bday && bday.slice(5, 10) === today.slice(5, 10)),
  };
}

/** Exacto (QR / código / teléfono / email) primero; si no, búsqueda por nombre o prefijo de teléfono. */
export async function searchCustomers(query: string, limit = 8): Promise<PosCustomer[]> {
  const q = query.trim();
  if (!q) return [];
  const d = db();
  const exact = await sql<CustomerRow>`
    select ${CUSTOMER_COLS} from find_customer(${q}) c left join loyalty_tiers t on t.key = c.tier_key`.execute(
    d,
  );
  if (exact.rows.length) return exact.rows.map(toCustomer);
  const digits = q.replace(/[^0-9]/g, "");
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const fuzzy = await sql<CustomerRow>`
    select ${CUSTOMER_COLS} from customers c left join loyalty_tiers t on t.key = c.tier_key
    where c.deleted_at is null and c.merged_into_id is null
      and (c.full_name ilike ${like}
           or (${digits.length >= 4} and c.phone::text like ${"%" + digits + "%"})
           or c.email::text ilike ${like}
           or c.public_code ilike ${like})
    order by c.last_purchase_at desc nulls last, c.full_name
    limit ${limit}`.execute(d);
  return fuzzy.rows.map(toCustomer);
}

export async function getCustomer(id: string): Promise<PosCustomer | null> {
  const r = await sql<CustomerRow>`
    select ${CUSTOMER_COLS} from customers c left join loyalty_tiers t on t.key = c.tier_key
    where c.id = ${id}::uuid and c.deleted_at is null`.execute(db());
  return r.rows[0] ? toCustomer(r.rows[0]) : null;
}

// ── Recibo ──────────────────────────────────────────────────────────────────
export type ReceiptView = {
  orderId: string;
  folio: string;
  soldAt: Date;
  status: string;
  voided: boolean;
  business: {
    name: string;
    legalName: string | null;
    address: string | null;
    phone: string | null;
    whatsapp: string | null;
    instagram: string | null;
    tagline: string | null;
  };
  staffName: string | null;
  customer: { name: string; code: string | null } | null;
  items: Array<{
    name: string;
    variantLabel: string | null;
    qty: number;
    unitPriceCents: number;
    discountCents: number;
    totalCents: number;
    notes: string | null;
  }>;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  couponCode: string | null;
  payments: Array<{
    method: string;
    amountCents: number;
    tenderedCents: number | null;
    changeCents: number | null;
    reference: string | null;
  }>;
  refundedCents: number;
  pointsEarned: number;
  pointsBalance: number | null;
  customerPhone: string | null;
  customerEmail: string | null;
};

export async function loadReceipt(orderId: string): Promise<ReceiptView | null> {
  const d = db();
  const o = await sql<{
    id: string;
    folio: string;
    status: string;
    placed_at: Date;
    sold_at: Date | null;
    voided_at: Date | null;
    subtotal_cents: number;
    discount_cents: number;
    tax_cents: number;
    tip_cents: number;
    total_cents: number;
    refunded_cents: number;
    coupon_code: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    public_code: string | null;
    points_balance: number | null;
    staff_name: string | null;
    points_earned: number;
    b_name: string;
    b_legal: string | null;
    b_address: string | null;
    b_phone: string | null;
    b_whatsapp: string | null;
    b_instagram: string | null;
    b_tagline: string | null;
  }>`
    select o.id, o.folio, o.status, o.placed_at, s.sold_at, s.voided_at,
           o.subtotal_cents, o.discount_cents, o.tax_cents, o.tip_cents, o.total_cents, o.refunded_cents, o.coupon_code,
           o.customer_id, o.customer_name, o.customer_phone, o.customer_email::text as customer_email,
           c.public_code, c.points_balance,
           coalesce(su.full_name, cb.full_name) as staff_name,
           coalesce((select sum(points) from loyalty_transactions lt where lt.sale_id = s.id and lt.kind = 'earn'), 0)::int as points_earned,
           bs.name as b_name, bs.legal_name as b_legal, bs.address as b_address, bs.phone as b_phone, bs.whatsapp as b_whatsapp,
           bs.instagram_handle as b_instagram, bs.tagline as b_tagline
    from orders o
    cross join business_settings bs
    left join sales s on s.order_id = o.id
    left join customers c on c.id = o.customer_id
    left join staff_users su on su.id = s.staff_id
    left join staff_users cb on cb.id = o.created_by
    where o.id = ${orderId}::uuid`.execute(d);
  const row = o.rows[0];
  if (!row) return null;
  const [items, pays] = await Promise.all([
    sql<{
      product_name: string;
      variant_label: string | null;
      qty: string | number;
      unit_price_cents: number;
      discount_cents: number;
      total_cents: number;
      notes: string | null;
    }>`select product_name, variant_label, qty, unit_price_cents, discount_cents, total_cents, notes
       from order_items where order_id = ${orderId}::uuid order by sort_order`.execute(d),
    sql<{
      method: string;
      amount_cents: number;
      tendered_cents: number | null;
      change_cents: number | null;
      reference: string | null;
    }>`select method, amount_cents, tendered_cents, change_cents, reference
       from payments where order_id = ${orderId}::uuid and status in ('paid','partially_refunded','refunded') order by created_at`.execute(
      d,
    ),
  ]);
  return {
    orderId: row.id,
    folio: row.folio,
    soldAt: row.sold_at ?? row.placed_at,
    status: row.status,
    voided: Boolean(row.voided_at),
    business: {
      name: row.b_name,
      legalName: row.b_legal,
      address: row.b_address,
      phone: row.b_phone,
      whatsapp: row.b_whatsapp,
      instagram: row.b_instagram,
      tagline: row.b_tagline,
    },
    staffName: row.staff_name,
    customer: row.customer_name ? { name: row.customer_name, code: row.public_code } : null,
    items: items.rows.map((i) => ({
      name: i.product_name,
      variantLabel: i.variant_label,
      qty: Number(i.qty),
      unitPriceCents: i.unit_price_cents,
      discountCents: i.discount_cents,
      totalCents: i.total_cents,
      notes: i.notes,
    })),
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    tipCents: row.tip_cents,
    totalCents: row.total_cents,
    couponCode: row.coupon_code,
    payments: pays.rows.map((p) => ({
      method: p.method,
      amountCents: p.amount_cents,
      tenderedCents: p.tendered_cents,
      changeCents: p.change_cents,
      reference: p.reference,
    })),
    refundedCents: row.refunded_cents,
    pointsEarned: row.points_earned,
    pointsBalance: row.customer_id ? row.points_balance : null,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
  };
}

/** Mensaje de texto del comprobante para WhatsApp (sin HTML). */
export function receiptText(r: ReceiptView): string {
  const lines = [
    `*${r.business.name}*`,
    `Ticket ${r.folio}`,
    "",
    ...r.items.map(
      (i) =>
        `${i.qty} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""} — $${(i.totalCents / 100).toFixed(2)}`,
    ),
    "",
  ];
  if (r.discountCents > 0) lines.push(`Descuento: -$${(r.discountCents / 100).toFixed(2)}`);
  lines.push(`*Total: $${(r.totalCents / 100).toFixed(2)}*`);
  if (r.pointsEarned > 0) lines.push(`Puntos ganados: ${r.pointsEarned}`);
  if (r.pointsBalance !== null) lines.push(`Saldo de puntos: ${r.pointsBalance}`);
  lines.push("", "¡Gracias por tu compra!");
  return lines.join("\n");
}
