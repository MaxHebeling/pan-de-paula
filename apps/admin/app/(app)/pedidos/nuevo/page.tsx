import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, LinkButton } from "@/components/ui";
import { NewOrderForm, type OrderProduct } from "@/components/ops/new-order-form";

export const metadata = { title: "Nuevo pedido" };
export const dynamic = "force-dynamic";

export default async function NuevoPedidoPage() {
  await requireSession("orders.write");
  const d = db();
  const [products, points] = await Promise.all([
    sql<{ id: string; name: string; category_name: string | null; price_cents: number | null; on_hand: string; track_stock: boolean }>`
      select p.id, p.name, c.name as category_name, current_price_cents(p.id, 'web') as price_cents, coalesce(l.on_hand, 0)::text as on_hand, p.track_stock
      from products p left join categories c on c.id = p.category_id left join inventory_levels l on l.product_id = p.id
      where p.deleted_at is null and p.is_active
      order by c.sort_order nulls last, p.sort_order, p.name`.execute(d),
    sql<{ id: string; name: string; is_default: boolean }>`select id, name, is_default from pickup_points where is_active order by sort_order, name`.execute(d),
  ]);
  const list: OrderProduct[] = products.rows.map((p) => ({ ...p, on_hand: Number(p.on_hand) }));
  return (
    <>
      <PageHeader
        title="Nuevo pedido"
        subtitle="Captura manual para pedidos por teléfono, WhatsApp o Instagram."
        actions={
          <LinkButton href="/pedidos" variant="secondary">
            ← Pedidos
          </LinkButton>
        }
      />
      <NewOrderForm products={list} pickupPoints={points.rows} />
    </>
  );
}
