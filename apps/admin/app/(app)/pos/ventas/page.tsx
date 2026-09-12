import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { todayLocal } from "@/lib/format";
import { PageHeader, Stat, Money } from "@/components/ui";
import { SalesTable, type SaleRow } from "@/components/pos/sales-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ventas del día" };

type Row = {
  sale_id: string;
  order_id: string;
  folio: string;
  sold_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
  customer_name: string | null;
  staff_name: string | null;
  items_count: string | number;
  total_cents: number;
  refunded_cents: number;
  payment_status: string;
  items: SaleRow["items"] | null;
  payments: SaleRow["payments"] | null;
  refunds: Array<{ amountCents: number; reason: string | null; createdAt: string }> | null;
};

export default async function VentasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; fecha?: string }>;
}) {
  const session = await requireSession("pos.sell");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(sp.fecha ?? "") ? sp.fecha! : todayLocal();
  const byFolio = q.length >= 3;
  const rows = await sql<Row>`
    select s.id as sale_id, o.id as order_id, o.folio, s.sold_at, s.voided_at, s.void_reason,
           o.customer_name, su.full_name as staff_name, s.items_count, s.total_cents, o.refunded_cents, o.payment_status,
           (select jsonb_agg(jsonb_build_object('name', oi.product_name, 'variantLabel', oi.variant_label, 'qty', oi.qty, 'totalCents', oi.total_cents, 'notes', oi.notes) order by oi.sort_order)
              from order_items oi where oi.order_id = o.id) as items,
           (select jsonb_agg(jsonb_build_object('id', p.id, 'method', p.method, 'status', p.status, 'amountCents', p.amount_cents, 'reference', p.reference,
                     'refundedCents', coalesce((select sum(r.amount_cents) from refunds r where r.payment_id = p.id and r.status <> 'failed'), 0)) order by p.created_at)
              from payments p where p.order_id = o.id and p.status in ('paid','partially_refunded','refunded','cancelled')) as payments,
           (select jsonb_agg(jsonb_build_object('amountCents', r.amount_cents, 'reason', r.reason, 'createdAt', r.created_at) order by r.created_at)
              from refunds r where r.order_id = o.id and r.status <> 'failed') as refunds
    from sales s
    join orders o on o.id = s.order_id
    left join staff_users su on su.id = s.staff_id
    cross join business_settings bs
    where s.channel = 'pos'
      and case when ${byFolio} then o.folio ilike ${"%" + q + "%"}
               else (s.sold_at at time zone bs.timezone)::date = ${fecha}::date end
    order by s.sold_at desc
    limit 300`.execute(db());
  const sales: SaleRow[] = rows.rows.map((r) => ({
    saleId: r.sale_id,
    orderId: r.order_id,
    folio: r.folio,
    soldAt: r.sold_at.toISOString(),
    voidedAt: r.voided_at ? r.voided_at.toISOString() : null,
    voidReason: r.void_reason,
    customerName: r.customer_name,
    staffName: r.staff_name,
    itemsCount: Number(r.items_count),
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    paymentStatus: r.payment_status,
    items: (r.items ?? []).map((i) => ({ ...i, qty: Number(i.qty) })),
    payments: r.payments ?? [],
    refunds: r.refunds ?? [],
  }));
  const active = sales.filter((s) => !s.voidedAt);
  const total = active.reduce((a, s) => a + s.totalCents, 0);
  const refunded = active.reduce((a, s) => a + s.refundedCents, 0);
  const canRefund = hasPermission(session, "pos.refund");
  return (
    <>
      <PageHeader
        title="Ventas"
        subtitle={byFolio ? `Resultados para “${q}”` : `Ventas en tienda del ${fecha}`}
        actions={
          <Link href="/pos" className="btn btn-primary">
            Volver al POS
          </Link>
        }
      />
      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="Buscar folio (PDP-2026-000123)"
          className="input min-h-11 max-w-xs"
          aria-label="Buscar por folio"
        />
        <input
          name="fecha"
          type="date"
          defaultValue={fecha}
          className="input min-h-11 w-44"
          aria-label="Fecha"
        />
        <button className="btn btn-secondary min-h-11">Buscar</button>
        {(q || sp.fecha) && (
          <Link href="/pos/ventas" className="btn btn-secondary min-h-11">
            Hoy
          </Link>
        )}
      </form>
      {!byFolio && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Ventas"
            value={active.length}
            hint={
              sales.length - active.length ? `${sales.length - active.length} anuladas` : undefined
            }
          />
          <Stat label="Total cobrado" value={<Money cents={total} />} />
          <Stat
            label="Reembolsado"
            value={<Money cents={refunded} />}
            tone={refunded ? "amber" : undefined}
          />
          <Stat
            label="Ticket promedio"
            value={<Money cents={active.length ? Math.round(total / active.length) : 0} />}
          />
        </div>
      )}
      <SalesTable sales={sales} canRefund={canRefund} />
    </>
  );
}
