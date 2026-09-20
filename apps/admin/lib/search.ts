import "server-only";
import { canonicalPhone, containsPattern } from "@pdp/domain";
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
    /** Referencia contable del pago que hizo coincidir el pedido (null si coincidió por folio/nombre/teléfono). */
    payment_reference: string | null;
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

export type SearchScope = { customers: boolean; orders: boolean; products: boolean };

/** Alcance de la búsqueda según permisos del rol (regresión auditoría 360°: la búsqueda ignoraba permisos). */
export function searchScope(can: (permission: string) => boolean): SearchScope {
  return {
    customers: can("customers.read"),
    orders: can("orders.read"),
    products: can("catalog.read"),
  };
}

const EMPTY = { rows: [] as never[] };

/**
 * Búsqueda global: clientes (nombre/teléfono/email/código), pedidos (folio/teléfono/cliente/REFERENCIA CONTABLE
 * de sus pagos) y productos (nombre).
 *
 * Los pagos NO son una categoría aparte: pegar "BANORTE-839201" devuelve el PEDIDO donde se cobró con esa
 * referencia, que es a donde quiere llegar quien concilia. Por eso viaja dentro del ámbito `orders`: un rol
 * sin `orders.read` no recibe nada de pagos, igual que no recibe pedidos.
 */
export async function globalSearch(
  q: string,
  limit: number,
  scope: SearchScope,
): Promise<SearchResults> {
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return { q: term, customers: [], orders: [], products: [] };
  const like = containsPattern(term);
  const digits = canonicalPhone(term).replace(/\D/g, "");
  const d = db();
  const [customers, orders, products] = await Promise.all([
    !scope.customers
      ? EMPTY
      : sql<SearchResults["customers"][number]>`
      select c.id, c.public_code, c.full_name, c.phone::text as phone, c.tier_key, c.points_balance
      from customers c where c.deleted_at is null and c.merged_into_id is null and ${customerSearchCondition(term)}
      order by c.last_purchase_at desc nulls last limit ${limit}`.execute(d),
    !scope.orders
      ? EMPTY
      : sql<SearchResults["orders"][number]>`
      select o.id, o.folio, o.channel::text as channel, o.status::text as status, o.total_cents, o.placed_at, o.customer_name, o.customer_phone,
             (select p.reference from payments p where p.order_id = o.id and p.reference ilike ${like} order by p.created_at limit 1) as payment_reference
      from orders o
      where o.folio ilike ${like} or o.customer_name ilike ${like}
         or exists (select 1 from payments p where p.order_id = o.id and p.reference ilike ${like})
         ${digits.length >= 4 ? sql`or regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g') like ${"%" + digits + "%"}` : sql``}
      order by o.placed_at desc limit ${limit}`.execute(d),
    !scope.products
      ? EMPTY
      : sql<SearchResults["products"][number]>`
      select p.id, p.name, c.name as category_name, current_price_cents(p.id, 'pos') as price_cents, l.on_hand::text as on_hand, p.is_active
      from products p left join categories c on c.id = p.category_id left join inventory_levels l on l.product_id = p.id
      where p.deleted_at is null and (p.name ilike ${like} or p.sku ilike ${like} or c.name ilike ${like})
      order by p.is_active desc, similarity(p.name, ${term}) desc, p.name limit ${limit}`.execute(
          d,
        ),
  ]);
  return { q: term, customers: customers.rows, orders: orders.rows, products: products.rows };
}
