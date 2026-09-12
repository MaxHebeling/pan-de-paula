import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, Stat, Card, Table, Badge, Money, LinkButton } from "@/components/ui";
import { qty } from "@/lib/format";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await requireSession("dashboard.read");
  const d = db();
  const [today, month, open, stock, top, lowStock] = await Promise.all([
    sql<{ total: number; n: number; ticket: number; cost: number | null }>`
      select coalesce(sum(total_cents),0)::int as total, count(*)::int as n, coalesce(avg(total_cents),0)::int as ticket, sum(cost_cents)::int as cost
      from sales where voided_at is null and (sold_at at time zone (select timezone from business_settings where id=1))::date = (now() at time zone (select timezone from business_settings where id=1))::date`.execute(
      d,
    ),
    sql<{ total: number; n: number; cost: number | null; refunded: number }>`
      select coalesce(sum(s.total_cents),0)::int as total, count(*)::int as n, sum(s.cost_cents)::int as cost,
             coalesce((select sum(amount_cents) from refunds r where r.status='completed' and date_trunc('month', r.created_at at time zone bs.timezone) = date_trunc('month', now() at time zone bs.timezone)),0)::int as refunded
      from sales s cross join business_settings bs
      where s.voided_at is null and date_trunc('month', s.sold_at at time zone bs.timezone) = date_trunc('month', now() at time zone bs.timezone)
      group by bs.timezone`.execute(d),
    sql<{ n: number; pending_payment: number; scheduled_today: number }>`
      select count(*) filter (where status in ('new','confirmed','paid','in_production','ready','ready_for_pickup','out_for_delivery'))::int as n,
             count(*) filter (where payment_status in ('pending','partial') and status not in ('cancelled','refunded','completed'))::int as pending_payment,
             count(*) filter (where (scheduled_for at time zone (select timezone from business_settings where id=1))::date = (now() at time zone (select timezone from business_settings where id=1))::date and status not in ('cancelled','refunded','completed','delivered'))::int as scheduled_today
      from orders`.execute(d),
    sql<{ products: number; out: number; low: number; units: number }>`
      select count(*)::int as products, count(*) filter (where level='out')::int as out, count(*) filter (where level='low')::int as low, coalesce(sum(on_hand),0)::numeric as units
      from stock_status where track_stock`.execute(d),
    sql<{ name: string; units: number; revenue: number }>`
      select oi.product_name as name, sum(oi.qty)::numeric as units, sum(oi.total_cents)::int as revenue
      from sales s join order_items oi on oi.order_id = s.order_id
      where s.voided_at is null and s.sold_at > now() - interval '30 days'
      group by oi.product_name order by revenue desc limit 6`.execute(d),
    sql<{
      name: string;
      on_hand: number;
      level: string;
    }>`select name, on_hand, level from stock_status where track_stock and level <> 'ok' order by on_hand asc limit 6`.execute(
      d,
    ),
  ]);
  const t = today.rows[0]!;
  const m = month.rows[0] ?? { total: 0, n: 0, cost: null, refunded: 0 };
  const o = open.rows[0]!;
  const s = stock.rows[0]!;
  const profit = m.cost === null ? null : m.total - m.refunded - m.cost;
  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Lo que está pasando hoy en El Pan de Paula"
        actions={<LinkButton href="/pos">Abrir POS</LinkButton>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Ventas hoy"
          value={<Money cents={t.total} />}
          hint={`${t.n} ventas · ticket ${t.n ? new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(t.ticket / 100) : "—"}`}
        />
        <Stat
          label="Ventas del mes"
          value={<Money cents={m.total} />}
          hint={`${m.n} ventas${m.refunded ? ` · reembolsos ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(m.refunded / 100)}` : ""}`}
        />
        <Stat
          label="Utilidad del mes"
          value={profit === null ? "—" : <Money cents={profit} />}
          hint={
            profit === null
              ? "Faltan costos en algunas recetas"
              : m.total
                ? `margen ${Math.round((profit / m.total) * 100)}%`
                : ""
          }
          tone={profit !== null && profit < 0 ? "red" : undefined}
        />
        <Stat
          label="Pedidos abiertos"
          value={o.n}
          hint={`${o.scheduled_today} para hoy · ${o.pending_payment} sin pagar`}
          tone={o.pending_payment ? "amber" : undefined}
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Productos más vendidos (30 días)"
          action={
            <LinkButton href="/reportes" variant="secondary" size="sm">
              Reportes
            </LinkButton>
          }
        >
          {top.rows.length === 0 ? (
            <p className="text-sm text-muted">Aún no hay ventas registradas.</p>
          ) : (
            <Table className="!shadow-none !border-0">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right">Unidades</th>
                  <th className="text-right">Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {top.rows.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td className="text-right tabular-nums">{qty(r.units)}</td>
                    <td className="text-right">
                      <Money cents={r.revenue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card
          title="Alertas de stock"
          action={
            <LinkButton href="/inventario" variant="secondary" size="sm">
              Inventario
            </LinkButton>
          }
        >
          <p className="mb-2 text-sm text-muted">
            {qty(s.units)} unidades en {s.products} productos · {s.out} agotados · {s.low} bajos
          </p>
          {lowStock.rows.length === 0 ? (
            <p className="text-sm text-muted">Todo en orden.</p>
          ) : (
            <ul className="divide-y divide-line">
              {lowStock.rows.map((r) => (
                <li key={r.name} className="flex items-center justify-between py-2 text-sm">
                  <span>{r.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{qty(r.on_hand)}</span>
                    <Badge tone={r.level === "out" ? "red" : "amber"}>
                      {r.level === "out" ? "Agotado" : "Bajo"}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
