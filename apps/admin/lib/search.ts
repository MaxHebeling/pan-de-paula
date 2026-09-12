import "server-only";
import { normalizePhone } from "@pdp/domain";
import { db, sql } from "./db";
import { customerSearchCondition } from "./customers";

export type SearchResults = {
  q: string;
  customers: Array<{
    id: string;
    public_code: string;
    full_name: string;
    phone: string | null;
    tier_key: string | null;
    points_balance: number;
  }>;
  orders: Array<{
    id: string;
    folio: string;
    channel: string;
    status: string;
    total_cents: number;
    placed_at: Date;
    customer_name: string | null;
    customer_phone: string | null;
  }>;
  products: Array<{
    id: string;
    name: string;
    category_name: string | null;
    price_cents: number | null;
    on_hand: string | null;
    is_active: boolean;
  }>;
};

/** Búsqueda global: clientes (nombre/teléfono/email/código), pedidos (folio/teléfono/cliente) y productos (nombre). */
export async function globalSearch(q: string, limit = 6): Promise<SearchResults> {
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return { q: term, customers: [], orders: [], products: [] };
  const like = `%${term}%`;
  const digits = normalizePhone(term).replace(/\D/g, "");
  const d = db();
  const [customers, orders, products] = await Promise.all([
    sql<SearchResults["customers"][number]>`
      select c.id, c.public_code, c.full_name, c.phone::text as phone, c.tier_key, c.points_balance
      from customers c where c.deleted_at is null and c.merged_into_id is null and ${customerSearchCondition(term)}
      order by c.last_purchase_at desc nulls last limit ${limit}`.execute(d),
    sql<SearchResults["orders"][number]>`
      select o.id, o.folio, o.channel::text as channel, o.status::text as status, o.total_cents, o.placed_at, o.customer_name, o.customer_phone
      from orders o
      where o.folio ilike ${like} or o.customer_name ilike ${like}
         ${digits.length >= 4 ? sql`or regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g') like ${"%" + digits + "%"}` : sql``}
      order by o.placed_at desc limit ${limit}`.execute(d),
    sql<SearchResults["products"][number]>`
      select p.id, p.name, c.name as category_name, current_price_cents(p.id, 'pos') as price_cents, l.on_hand::text as on_hand, p.is_active
      from products p left join categories c on c.id = p.category_id left join inventory_levels l on l.product_id = p.id
      where p.deleted_at is null and (p.name ilike ${like} or p.sku ilike ${like} or c.name ilike ${like})
      order by p.is_active desc, similarity(p.name, ${term}) desc, p.name limit ${limit}`.execute(
      d,
    ),
  ]);
  return { q: term, customers: customers.rows, orders: orders.rows, products: products.rows };
}
