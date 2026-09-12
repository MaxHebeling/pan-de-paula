import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, Table, Badge, EmptyState, Money, LinkButton } from "@/components/ui";
import { UnreadBadge } from "@/components/ops/unread-badge";
import { Field } from "@/components/ops/field";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  OPEN_ORDER_STATUSES,
  type OrderStatus,
} from "@pdp/domain";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Pedidos" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;
const CHANNELS = {
  web: "Web",
  pos: "POS",
  admin: "Admin",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
} as const;
const PAYMENT_LABELS: Record<string, string> = {
  pending: "Pendiente",
  authorized: "Autorizado",
  partial: "Parcial",
  paid: "Pagado",
  failed: "Fallido",
  refunded: "Reembolsado",
  partially_refunded: "Reemb. parcial",
  cancelled: "Cancelado",
};
const PAYMENT_TONE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = {
  pending: "amber",
  authorized: "blue",
  partial: "amber",
  paid: "green",
  failed: "red",
  refunded: "red",
  partially_refunded: "red",
  cancelled: "gray",
};
const FULFILLMENT: Record<string, string> = {
  pickup: "Retiro",
  scheduled_pickup: "Retiro programado",
  delivery: "Entrega",
  preorder: "Preventa",
};
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function PedidosPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession("orders.read");
  const sp = await searchParams;
  const vista =
    sp.vista === "hoy" || sp.vista === "proximos" || sp.vista === "todos" ? sp.vista : "abiertos";
  const estado = ORDER_STATUSES.includes(sp.estado as OrderStatus)
    ? (sp.estado as OrderStatus)
    : null;
  const canal = sp.canal && sp.canal in CHANNELS ? sp.canal : null;
  const entrega = isDate(sp.entrega) ? sp.entrega : null;
  const pago = sp.pago && sp.pago in PAYMENT_LABELS ? sp.pago : null;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.pagina ?? 1) || 1);
  const limit = 50;
  const openStatuses = OPEN_ORDER_STATUSES.map((s) => s as string);

  const rows = await sql<{
    id: string;
    folio: string;
    channel: keyof typeof CHANNELS;
    status: OrderStatus;
    payment_status: string;
    fulfillment_type: string;
    customer_name: string | null;
    customer_phone: string | null;
    scheduled_for: Date | null;
    placed_at: Date;
    total_cents: number;
    paid_cents: number;
    items: number;
  }>`select o.id, o.folio, o.channel::text as channel, o.status::text as status, o.payment_status::text as payment_status, o.fulfillment_type::text as fulfillment_type,
            o.customer_name, o.customer_phone, o.scheduled_for, o.placed_at, o.total_cents, o.paid_cents,
            (select count(*)::int from order_items i where i.order_id = o.id) as items
     from orders o
     where (${vista} <> 'abiertos' or o.status = any(${openStatuses}::order_status[]))
       and (${vista} <> 'hoy' or ((o.scheduled_for at time zone (select timezone from business_settings where id = 1))::date = (now() at time zone (select timezone from business_settings where id = 1))::date
                                   and o.status not in ('cancelled','refunded')))
       and (${vista} <> 'proximos' or (o.scheduled_for > now() and o.status = any(${openStatuses}::order_status[])))
       and (${estado}::text is null or o.status::text = ${estado}::text)
       and (${canal}::text is null or o.channel::text = ${canal}::text)
       and (${pago}::text is null or o.payment_status::text = ${pago}::text)
       and (${entrega}::date is null or (o.scheduled_for at time zone (select timezone from business_settings where id = 1))::date = ${entrega}::date)
       and (${q} = '' or o.folio ilike '%' || ${q} || '%' or o.customer_name ilike '%' || ${q} || '%'
            or regexp_replace(coalesce(o.customer_phone,''), '[^0-9]', '', 'g') like '%' || regexp_replace(${q}, '[^0-9]', '', 'g') || '%' and regexp_replace(${q}, '[^0-9]', '', 'g') <> '')
     order by case when ${vista} in ('hoy','proximos') then o.scheduled_for end asc nulls last, o.placed_at desc
     limit ${limit + 1} offset ${(page - 1) * limit}`.execute(db());
  const hasMore = rows.rows.length > limit;
  const list = rows.rows.slice(0, limit);
  const keep: Record<string, string> = {
    vista,
    estado: estado ?? "",
    canal: canal ?? "",
    entrega: entrega ?? "",
    pago: pago ?? "",
    q,
  };
  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...keep, ...extra });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/pedidos?${p.toString()}`;
  };
  const views = [
    { key: "abiertos", label: "Abiertos" },
    { key: "hoy", label: "Hoy" },
    { key: "proximos", label: "Próximos" },
    { key: "todos", label: "Todos" },
  ];
  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle="Web, WhatsApp, Instagram y mostrador en una sola cola."
        actions={
          <>
            <UnreadBadge />
            {hasPermission(session, "orders.write") && (
              <LinkButton href="/pedidos/nuevo">+ Nuevo pedido</LinkButton>
            )}
          </>
        }
      />
      <div className="mb-3 flex gap-1 overflow-x-auto rounded-[var(--r-card)] bg-black/5 p-1">
        {views.map((v) => (
          <Link
            key={v.key}
            href={href({ vista: v.key, pagina: "" })}
            aria-current={vista === v.key ? "page" : undefined}
            className={`min-h-11 shrink-0 rounded-[var(--r-btn-sm)] px-4 py-2.5 text-sm font-semibold ${vista === v.key ? "bg-card shadow-[var(--shadow)]" : "text-muted"}`}
          >
            {v.label}
          </Link>
        ))}
      </div>
      <form className="card mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-6" method="get">
        <input type="hidden" name="vista" value={vista} />
        <Field label="Buscar" htmlFor="q" className="col-span-2">
          <input
            id="q"
            name="q"
            type="search"
            className="input min-h-11"
            defaultValue={q}
            placeholder="Folio, teléfono o nombre"
          />
        </Field>
        <Field label="Estado" htmlFor="estado">
          <select id="estado" name="estado" className="input min-h-11" defaultValue={estado ?? ""}>
            <option value="">Todos</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Canal" htmlFor="canal">
          <select id="canal" name="canal" className="input min-h-11" defaultValue={canal ?? ""}>
            <option value="">Todos</option>
            {Object.entries(CHANNELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pago" htmlFor="pago">
          <select id="pago" name="pago" className="input min-h-11" defaultValue={pago ?? ""}>
            <option value="">Todos</option>
            {Object.entries(PAYMENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Entrega" htmlFor="entrega">
          <input
            id="entrega"
            name="entrega"
            type="date"
            className="input min-h-11"
            defaultValue={entrega ?? ""}
          />
        </Field>
        <div className="col-span-2 flex items-end gap-2 md:col-span-6">
          <button className="btn btn-secondary min-h-11">Filtrar</button>
          <Link href={`/pedidos?vista=${vista}`} className="btn btn-secondary min-h-11">
            Limpiar
          </Link>
        </div>
      </form>
      {list.length === 0 ? (
        <EmptyState
          title="Sin pedidos"
          body={
            vista === "abiertos"
              ? "No hay pedidos abiertos con estos filtros."
              : "Ajusta los filtros o crea un pedido manual."
          }
          action={
            hasPermission(session, "orders.write") ? (
              <LinkButton href="/pedidos/nuevo">Nuevo pedido</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Folio</th>
              <th>Cliente</th>
              <th>Canal</th>
              <th>Entrega</th>
              <th>Estado</th>
              <th>Pago</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} data-testid={`order-row-${o.folio}`}>
                <td>
                  <Link
                    href={`/pedidos/${o.id}`}
                    className="font-mono text-xs font-semibold underline"
                  >
                    {o.folio}
                  </Link>
                  <div className="text-xs text-muted">{fmtDate(o.placed_at, "datetime")}</div>
                </td>
                <td>
                  <div className="font-medium">{o.customer_name ?? "Sin nombre"}</div>
                  <div className="text-xs text-muted">{o.customer_phone ?? ""}</div>
                </td>
                <td>
                  <Badge tone="gray">{CHANNELS[o.channel] ?? o.channel}</Badge>
                </td>
                <td>
                  <div>{FULFILLMENT[o.fulfillment_type] ?? o.fulfillment_type}</div>
                  <div className="text-xs text-muted">
                    {o.scheduled_for ? fmtDate(o.scheduled_for, "datetime") : "—"}
                  </div>
                </td>
                <td>
                  <Badge tone={ORDER_STATUS_TONE[o.status]}>{ORDER_STATUS_LABELS[o.status]}</Badge>
                </td>
                <td>
                  <Badge tone={PAYMENT_TONE[o.payment_status] ?? "gray"}>
                    {PAYMENT_LABELS[o.payment_status] ?? o.payment_status}
                  </Badge>
                  {o.payment_status === "partial" && (
                    <div className="text-xs text-muted">
                      <Money cents={o.paid_cents} /> de <Money cents={o.total_cents} />
                    </div>
                  )}
                </td>
                <td className="text-right">
                  <Money cents={o.total_cents} className="font-semibold" />
                  <div className="text-xs text-muted">{o.items} art.</div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {(page > 1 || hasMore) && (
        <div className="mt-3 flex justify-between">
          {page > 1 ? (
            <Link href={href({ pagina: String(page - 1) })} className="btn btn-secondary">
              ← Anteriores
            </Link>
          ) : (
            <span />
          )}
          {hasMore && (
            <Link href={href({ pagina: String(page + 1) })} className="btn btn-secondary">
              Siguientes →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
