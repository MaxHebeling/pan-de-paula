import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { whatsappNumber } from "@/lib/ops";
import { PageHeader, Card, Table, Badge, Money, LinkButton, Alert } from "@/components/ui";
import { UnreadBadge } from "@/components/ops/unread-badge";
import { MarkOrderSeen } from "@/components/ops/mark-order-seen";
import { ActionForm } from "@/components/ops/action-form";
import { PendingButton } from "@/components/ops/pending-button";
import { Field } from "@/components/ops/field";
import { isEmailConfigured } from "@pdp/integrations";
import {
  ORDER_TRANSITIONS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  PAYMENT_METHOD_LABELS,
  canTransition,
  formatMXN,
  type OrderStatus,
} from "@pdp/domain";
import { fmtDate, qty } from "@/lib/format";
import {
  cancelOrderAction,
  changeStatusAction,
  notesAction,
  paymentAction,
  refundAction,
  returnAction,
  sendReceiptAction,
  updatePaymentReferenceAction,
} from "../actions";

export const dynamic = "force-dynamic";

const CHANNELS: Record<string, string> = {
  web: "Web",
  pos: "POS",
  admin: "Admin",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};
const FULFILLMENT: Record<string, string> = {
  pickup: "Retiro",
  scheduled_pickup: "Retiro programado",
  delivery: "Entrega a domicilio",
  preorder: "Preventa",
};
const PAYMENT_LABELS: Record<string, string> = {
  pending: "Pendiente",
  authorized: "Autorizado",
  partial: "Parcial",
  paid: "Pagado",
  failed: "Fallido",
  refunded: "Reembolsado",
  partially_refunded: "Reembolso parcial",
  cancelled: "Cancelado",
};
const METHODS = (
  Object.keys(PAYMENT_METHOD_LABELS) as Array<keyof typeof PAYMENT_METHOD_LABELS>
).filter((m) => m !== "points");
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function waMessage(o: {
  folio: string;
  status: OrderStatus;
  customer_name: string | null;
  total_cents: number;
  scheduled_for: Date | null;
  pickup_name: string | null;
  business: string;
}) {
  const name = o.customer_name?.split(" ")[0] ?? "";
  const hi = `Hola${name ? ` ${name}` : ""}, te escribimos de ${o.business}.`;
  const when = o.scheduled_for
    ? ` para el ${fmtDate(o.scheduled_for, "long")} a las ${fmtDate(o.scheduled_for, "time")}`
    : "";
  const total = formatMXN(o.total_cents);
  switch (o.status) {
    case "new":
    case "confirmed":
      return `${hi} Recibimos tu pedido ${o.folio} por ${total}${when}. ¡Gracias!`;
    case "payment_pending":
      return `${hi} Tu pedido ${o.folio} por ${total} está pendiente de pago. En cuanto lo recibamos lo confirmamos${when}.`;
    case "paid":
    case "in_production":
      return `${hi} Tu pedido ${o.folio} ya está en preparación${when}. Te avisamos cuando esté listo.`;
    case "ready":
    case "ready_for_pickup":
      return `${hi} ¡Tu pedido ${o.folio} está listo para recoger${o.pickup_name ? ` en ${o.pickup_name}` : ""}!`;
    case "out_for_delivery":
      return `${hi} Tu pedido ${o.folio} va en camino. ¡Llega pronto!`;
    case "delivered":
    case "completed":
      return `${hi} Gracias por tu compra (${o.folio}). ¡Esperamos que lo disfrutes!`;
    case "cancelled":
      return `${hi} Tu pedido ${o.folio} fue cancelado. Si tienes dudas, respóndenos por aquí.`;
    default:
      return `${hi} Sobre tu pedido ${o.folio}:`;
  }
}

export default async function PedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession("orders.read");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const d = db();
  const orderQ = await sql<{
    id: string;
    folio: string;
    channel: string;
    status: OrderStatus;
    payment_status: string;
    fulfillment_type: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    customer_code: string | null;
    points_balance: number | null;
    pickup_name: string | null;
    delivery_address: Record<string, string> | null;
    scheduled_for: Date | null;
    subtotal_cents: number;
    discount_cents: number;
    delivery_fee_cents: number;
    tax_cents: number;
    tip_cents: number;
    total_cents: number;
    paid_cents: number;
    refunded_cents: number;
    coupon_code: string | null;
    notes: string | null;
    internal_notes: string | null;
    source_ref: string | null;
    created_by_name: string | null;
    placed_at: Date;
    cancel_reason: string | null;
    sale_id: string | null;
    voided_at: Date | null;
    business: string;
  }>`select o.id, o.folio, o.channel::text as channel, o.status::text as status, o.payment_status::text as payment_status, o.fulfillment_type::text as fulfillment_type,
            o.customer_id, o.customer_name, o.customer_phone, o.customer_email, c.public_code as customer_code, c.points_balance,
            pp.name as pickup_name, o.delivery_address, o.scheduled_for,
            o.subtotal_cents, o.discount_cents, o.delivery_fee_cents, o.tax_cents, o.tip_cents, o.total_cents, o.paid_cents, o.refunded_cents,
            o.coupon_code, o.notes, o.internal_notes, o.source_ref, su.full_name as created_by_name, o.placed_at, o.cancel_reason,
            s.id as sale_id, s.voided_at, (select name from business_settings where id = 1) as business
     from orders o
     left join customers c on c.id = o.customer_id
     left join pickup_points pp on pp.id = o.pickup_point_id
     left join staff_users su on su.id = o.created_by
     left join sales s on s.order_id = o.id
     where o.id = ${id}`.execute(d);
  const o = orderQ.rows[0];
  if (!o) notFound();

  const [items, payments, refunds, returns, history, events, receipts, flag] = await Promise.all([
    sql<{
      id: string;
      product_id: string | null;
      product_name: string;
      variant_label: string | null;
      qty: string;
      unit_price_cents: number;
      discount_cents: number;
      total_cents: number;
      notes: string | null;
    }>`
      select id, product_id, product_name, variant_label, qty::text, unit_price_cents, discount_cents, total_cents, notes from order_items where order_id = ${id} order by sort_order`.execute(
      d,
    ),
    sql<{
      id: string;
      method: string;
      status: string;
      amount_cents: number;
      tendered_cents: number | null;
      change_cents: number | null;
      reference: string | null;
      external_id: string | null;
      created_at: Date;
      received_by: string | null;
      refunded_cents: number;
    }>`
      select p.id, p.method::text as method, p.status::text as status, p.amount_cents, p.tendered_cents, p.change_cents, p.reference, p.external_id, p.created_at, su.full_name as received_by,
             coalesce((select sum(r.amount_cents) from refunds r where r.payment_id = p.id and r.status <> 'failed'), 0)::int as refunded_cents
      from payments p left join staff_users su on su.id = p.received_by where p.order_id = ${id} order by p.created_at`.execute(
      d,
    ),
    sql<{
      id: string;
      amount_cents: number;
      reason: string | null;
      status: string;
      created_at: Date;
      staff_name: string | null;
    }>`
      select r.id, r.amount_cents, r.reason, r.status, r.created_at, su.full_name as staff_name from refunds r left join staff_users su on su.id = r.staff_id where r.order_id = ${id} order by r.created_at`.execute(
      d,
    ),
    sql<{
      id: string;
      qty: string;
      restock: boolean;
      reason: string | null;
      created_at: Date;
      product_name: string | null;
      staff_name: string | null;
    }>`
      select r.id, r.qty::text, r.restock, r.reason, r.created_at, p.name as product_name, su.full_name as staff_name
      from returns r left join products p on p.id = r.product_id left join staff_users su on su.id = r.staff_id where r.order_id = ${id} order by r.created_at`.execute(
      d,
    ),
    sql<{
      id: number;
      from_status: OrderStatus | null;
      to_status: OrderStatus;
      note: string | null;
      created_at: Date;
      staff_name: string | null;
    }>`
      select h.id, h.from_status::text as from_status, h.to_status::text as to_status, h.note, h.created_at, su.full_name as staff_name
      from order_status_history h left join staff_users su on su.id = h.staff_id where h.order_id = ${id} order by h.created_at`.execute(
      d,
    ),
    sql<{ id: number; event_type: string; payload: Record<string, unknown>; occurred_at: Date }>`
      select id, event_type, payload, occurred_at from domain_events where aggregate = 'order' and aggregate_id = ${id} order by occurred_at`.execute(
      d,
    ),
    sql<{
      id: string;
      channel: string;
      destination: string | null;
      status: string;
      error: string | null;
      created_at: Date;
    }>`
      select id, channel, destination, status, error, created_at from receipts where order_id = ${id} order by created_at desc limit 5`.execute(
      d,
    ),
    sql<{
      enabled: boolean;
    }>`select enabled from feature_flags where key = 'email_receipts'`.execute(d),
  ]);

  const canWrite = hasPermission(session, "orders.write");
  const canRefund = hasPermission(session, "pos.refund");
  const balance = o.total_cents - o.paid_cents;
  // "Pagado" solo se alcanza registrando el pago (el servidor también lo exige): no se ofrece mientras haya saldo.
  const transitions = (ORDER_TRANSITIONS[o.status] ?? []).filter(
    (s) => s !== "cancelled" && s !== "refunded" && !(s === "paid" && balance > 0),
  );
  const canCancel = canTransition(o.status, "cancelled") && !o.sale_id;
  const canPay = canWrite && balance > 0 && !["cancelled", "refunded"].includes(o.status);
  const wa = whatsappNumber(o.customer_phone);
  const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(waMessage(o))}` : null;
  const emailEnabled = (flag.rows[0]?.enabled ?? false) && isEmailConfigured();

  type TimelineEntry = {
    at: Date;
    title: string;
    detail?: string;
    tone: "green" | "amber" | "red" | "blue" | "gray";
  };
  const timeline: TimelineEntry[] = [
    ...history.rows.map((h) => ({
      at: h.created_at,
      title: h.from_status
        ? `${ORDER_STATUS_LABELS[h.from_status]} → ${ORDER_STATUS_LABELS[h.to_status]}`
        : `Creado (${ORDER_STATUS_LABELS[h.to_status]})`,
      detail: [h.note, h.staff_name].filter(Boolean).join(" · ") || undefined,
      tone: ORDER_STATUS_TONE[h.to_status],
    })),
    ...payments.rows.map((p) => ({
      at: p.created_at,
      title: `Pago ${PAYMENT_LABELS[p.status] ?? p.status}: ${formatMXN(p.amount_cents)} · ${PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method}`,
      detail: [p.reference, p.received_by].filter(Boolean).join(" · ") || undefined,
      tone: p.status === "failed" ? ("red" as const) : ("green" as const),
    })),
    ...refunds.rows.map((r) => ({
      at: r.created_at,
      title: `Reembolso ${formatMXN(r.amount_cents)}`,
      detail: [r.reason, r.staff_name].filter(Boolean).join(" · ") || undefined,
      tone: "red" as const,
    })),
    ...returns.rows.map((r) => ({
      at: r.created_at,
      title: `Devolución ${qty(r.qty)} × ${r.product_name ?? "producto"}${r.restock ? " (reingresó a inventario)" : ""}`,
      detail: [r.reason, r.staff_name].filter(Boolean).join(" · ") || undefined,
      tone: "amber" as const,
    })),
    ...events.rows
      .filter(
        (e) =>
          ![
            "ORDER_CREATED",
            "ORDER_CONFIRMED",
            "ORDER_CANCELLED",
            "ORDER_STATUS_CHANGED",
            "PAYMENT_RECEIVED",
            "PAYMENT_REFUNDED",
            "PAYMENT_FAILED",
          ].includes(e.event_type),
      )
      .map((e) => ({
        at: e.occurred_at,
        title: e.event_type.replaceAll("_", " ").toLowerCase(),
        detail: JSON.stringify(e.payload),
        tone: "gray" as const,
      })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <>
      <MarkOrderSeen orderId={o.id} />
      <PageHeader
        title={o.folio}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_STATUS_TONE[o.status]}>{ORDER_STATUS_LABELS[o.status]}</Badge>
            <Badge
              tone={
                o.payment_status === "paid"
                  ? "green"
                  : o.payment_status.includes("refund") || o.payment_status === "failed"
                    ? "red"
                    : "amber"
              }
            >
              {PAYMENT_LABELS[o.payment_status] ?? o.payment_status}
            </Badge>
            <Badge tone="gray">{CHANNELS[o.channel] ?? o.channel}</Badge>
            <span className="text-muted">
              · {fmtDate(o.placed_at, "datetime")}
              {o.created_by_name ? ` · por ${o.created_by_name}` : ""}
            </span>
          </span>
        }
        actions={
          <>
            <UnreadBadge />
            <LinkButton href="/pedidos" variant="secondary">
              ← Pedidos
            </LinkButton>
            <a
              href={`/pedidos/${o.id}/recibo`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
            >
              Recibo
            </a>
            {waHref && (
              <a
                href={waHref}
                target="_blank"
                rel="noreferrer"
                className="btn btn-wa"
                data-testid="wa-link"
              >
                WhatsApp
              </a>
            )}
          </>
        }
      />
      {o.cancel_reason && (
        <div className="mb-4">
          <Alert tone="red">Cancelado: {o.cancel_reason}</Alert>
        </div>
      )}
      {o.voided_at && (
        <div className="mb-4">
          <Alert tone="red">Venta anulada el {fmtDate(o.voided_at, "datetime")}</Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <Card title="Productos">
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right">Cant.</th>
                  <th className="text-right">Precio</th>
                  <th className="text-right">Desc.</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.rows.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <div className="font-medium">
                        {it.product_name}
                        {it.variant_label ? ` · ${it.variant_label}` : ""}
                      </div>
                      {it.notes && <div className="text-xs text-muted">{it.notes}</div>}
                    </td>
                    <td className="text-right tabular-nums">{qty(it.qty)}</td>
                    <td className="text-right">
                      <Money cents={it.unit_price_cents} />
                    </td>
                    <td className="text-right">
                      {it.discount_cents ? <Money cents={it.discount_cents} /> : "—"}
                    </td>
                    <td className="text-right font-semibold">
                      <Money cents={it.total_cents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <dl className="ml-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted">Subtotal</dt>
              <dd className="text-right">
                <Money cents={o.subtotal_cents} />
              </dd>
              {o.discount_cents > 0 && (
                <>
                  <dt className="text-muted">
                    Descuento{o.coupon_code ? ` (${o.coupon_code})` : ""}
                  </dt>
                  <dd className="text-right text-green-d">
                    −<Money cents={o.discount_cents} />
                  </dd>
                </>
              )}
              {o.delivery_fee_cents > 0 && (
                <>
                  <dt className="text-muted">Envío</dt>
                  <dd className="text-right">
                    <Money cents={o.delivery_fee_cents} />
                  </dd>
                </>
              )}
              {o.tax_cents > 0 && (
                <>
                  <dt className="text-muted">IVA</dt>
                  <dd className="text-right">
                    <Money cents={o.tax_cents} />
                  </dd>
                </>
              )}
              {o.tip_cents > 0 && (
                <>
                  <dt className="text-muted">Propina</dt>
                  <dd className="text-right">
                    <Money cents={o.tip_cents} />
                  </dd>
                </>
              )}
              <dt className="border-t border-line pt-1 font-semibold">Total</dt>
              <dd className="border-t border-line pt-1 text-right text-base font-semibold">
                <Money cents={o.total_cents} />
              </dd>
              <dt className="text-muted">Pagado</dt>
              <dd className="text-right">
                <Money cents={o.paid_cents} />
              </dd>
              {o.refunded_cents > 0 && (
                <>
                  <dt className="text-muted">Reembolsado</dt>
                  <dd className="text-right text-red-d">
                    <Money cents={o.refunded_cents} />
                  </dd>
                </>
              )}
              {balance > 0 && !["cancelled", "refunded"].includes(o.status) && (
                <>
                  <dt className="font-semibold text-amber-d">Por cobrar</dt>
                  <dd className="text-right font-semibold text-amber-d" data-testid="balance">
                    <Money cents={balance} />
                  </dd>
                </>
              )}
            </dl>
          </Card>

          <Card title="Pagos">
            {payments.rows.length === 0 ? (
              <p className="text-sm text-muted">Sin pagos registrados.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {payments.rows.map((p) => (
                  <li key={p.id} className="flex flex-col gap-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong>
                          <Money cents={p.amount_cents} />
                        </strong>{" "}
                        ·{" "}
                        {PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ??
                          p.method}
                        <span className="text-muted"> · ref. </span>
                        <span
                          className={p.reference ? "font-mono text-xs" : "text-muted"}
                          data-testid="payment-reference"
                        >
                          {p.reference ?? "—"}
                        </span>
                        {p.external_id && (
                          <span className="text-muted"> · ID Mercado Pago {p.external_id}</span>
                        )}
                        {p.change_cents ? (
                          <span className="text-muted"> · cambio {formatMXN(p.change_cents)}</span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 text-muted">
                        {fmtDate(p.created_at, "datetime")}
                        <Badge
                          tone={
                            p.status === "paid"
                              ? "green"
                              : p.status === "failed" || p.status.includes("refund")
                                ? "red"
                                : "amber"
                          }
                        >
                          {PAYMENT_LABELS[p.status] ?? p.status}
                        </Badge>
                      </span>
                    </div>
                    {canWrite && (
                      <details data-testid="edit-reference">
                        <summary className="btn btn-secondary btn-sm min-h-9 w-fit cursor-pointer list-none">
                          {p.reference ? "Editar referencia" : "Agregar referencia"}
                        </summary>
                        <ActionForm
                          action={updatePaymentReferenceAction}
                          resetOnSuccess={false}
                          className="mt-2 grid grid-cols-1 gap-2 rounded-[var(--r-card)] bg-bg p-3 sm:grid-cols-[1fr_auto]"
                        >
                          <input type="hidden" name="payment_id" value={p.id} />
                          <Field
                            label="Referencia contable"
                            htmlFor={`ref-${p.id}`}
                            hint="Clave de rastreo, folio de la terminal o id del depósito. Vacío la borra."
                          >
                            <input
                              id={`ref-${p.id}`}
                              name="reference"
                              className="input min-h-11 font-mono"
                              defaultValue={p.reference ?? ""}
                              maxLength={80}
                              autoComplete="off"
                            />
                          </Field>
                          <div className="flex items-end">
                            <PendingButton
                              className="btn btn-primary min-h-11"
                              pendingLabel="Guardando…"
                            >
                              Guardar
                            </PendingButton>
                          </div>
                        </ActionForm>
                      </details>
                    )}
                    {canRefund &&
                      ["paid", "partially_refunded"].includes(p.status) &&
                      p.amount_cents - p.refunded_cents > 0 && (
                        <details>
                          <summary className="btn btn-secondary btn-sm min-h-9 w-fit cursor-pointer list-none">
                            Reembolsar
                          </summary>
                          <ActionForm
                            action={refundAction}
                            className="mt-2 grid grid-cols-1 gap-2 rounded-[var(--r-card)] bg-bg p-3 sm:grid-cols-[140px_1fr_auto]"
                          >
                            <input type="hidden" name="payment_id" value={p.id} />
                            <input
                              type="hidden"
                              name="idempotency_key"
                              value={`rf-${randomUUID()}`}
                            />
                            <Field label="Monto (MXN)" htmlFor={`rf-amt-${p.id}`}>
                              <input
                                id={`rf-amt-${p.id}`}
                                name="amount"
                                inputMode="decimal"
                                className="input min-h-11"
                                defaultValue={((p.amount_cents - p.refunded_cents) / 100).toFixed(
                                  2,
                                )}
                                required
                              />
                            </Field>
                            <Field label="Motivo" htmlFor={`rf-reason-${p.id}`}>
                              <input
                                id={`rf-reason-${p.id}`}
                                name="reason"
                                className="input min-h-11"
                                required
                                minLength={3}
                                maxLength={300}
                              />
                            </Field>
                            <div className="flex items-end">
                              <PendingButton
                                className="btn btn-danger min-h-11"
                                confirm="¿Registrar el reembolso? Revierte puntos proporcionalmente y actualiza el estado de pago."
                              >
                                Reembolsar
                              </PendingButton>
                            </div>
                          </ActionForm>
                        </details>
                      )}
                  </li>
                ))}
              </ul>
            )}
            {canPay && (
              <div className="mt-4 rounded-[var(--r-card)] border border-line p-3">
                <h3 className="mb-2 text-sm font-semibold">Registrar pago manual</h3>
                <ActionForm
                  action={paymentAction}
                  className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                >
                  <input type="hidden" name="order_id" value={o.id} />
                  <input type="hidden" name="idempotency_key" value={`pay-${randomUUID()}`} />
                  <Field label="Método" htmlFor="pay-method">
                    <select
                      id="pay-method"
                      name="method"
                      className="input min-h-11"
                      defaultValue="cash"
                    >
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {PAYMENT_METHOD_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Monto (MXN)" htmlFor="pay-amount">
                    <input
                      id="pay-amount"
                      name="amount"
                      inputMode="decimal"
                      className="input min-h-11"
                      defaultValue={(balance / 100).toFixed(2)}
                      required
                    />
                  </Field>
                  <Field label="Recibido (efectivo)" htmlFor="pay-tendered">
                    <input
                      id="pay-tendered"
                      name="tendered"
                      inputMode="decimal"
                      className="input min-h-11"
                      placeholder="opcional"
                    />
                  </Field>
                  <Field label="Referencia contable" htmlFor="pay-ref">
                    <input
                      id="pay-ref"
                      name="reference"
                      className="input min-h-11 font-mono"
                      placeholder="clave de rastreo / folio"
                      maxLength={80}
                      autoComplete="off"
                    />
                  </Field>
                  <div className="col-span-2 sm:col-span-4">
                    <PendingButton className="btn btn-confirm min-h-11" pendingLabel="Registrando…">
                      Registrar pago
                    </PendingButton>
                  </div>
                </ActionForm>
              </div>
            )}
          </Card>

          {(refunds.rows.length > 0 || returns.rows.length > 0 || (canRefund && o.sale_id)) && (
            <Card title="Reembolsos y devoluciones">
              {refunds.rows.length > 0 && (
                <ul className="mb-3 divide-y divide-line text-sm">
                  {refunds.rows.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2">
                      <span>
                        Reembolso{" "}
                        <strong>
                          <Money cents={r.amount_cents} />
                        </strong>
                        {r.reason ? ` · ${r.reason}` : ""}
                      </span>
                      <span className="text-muted">
                        {fmtDate(r.created_at, "datetime")}
                        {r.staff_name ? ` · ${r.staff_name}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {returns.rows.length > 0 && (
                <ul className="mb-3 divide-y divide-line text-sm">
                  {returns.rows.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2">
                      <span>
                        Devolución {qty(r.qty)} × {r.product_name ?? "producto"}{" "}
                        {r.restock && <Badge tone="green">reingresado</Badge>}
                        {r.reason ? ` · ${r.reason}` : ""}
                      </span>
                      <span className="text-muted">
                        {fmtDate(r.created_at, "datetime")}
                        {r.staff_name ? ` · ${r.staff_name}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canRefund && o.sale_id && !o.voided_at && (
                <details>
                  <summary className="btn btn-secondary btn-sm min-h-9 w-fit cursor-pointer list-none">
                    Registrar devolución física
                  </summary>
                  <ActionForm
                    action={returnAction}
                    className="mt-2 grid grid-cols-2 gap-2 rounded-[var(--r-card)] bg-bg p-3 sm:grid-cols-4"
                  >
                    <input type="hidden" name="order_id" value={o.id} />
                    <Field label="Producto" htmlFor="ret-item" className="col-span-2">
                      <select
                        id="ret-item"
                        name="order_item_id"
                        className="input min-h-11"
                        required
                      >
                        {items.rows.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.product_name} ({qty(it.qty)})
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Cantidad" htmlFor="ret-qty">
                      <input
                        id="ret-qty"
                        name="qty"
                        type="number"
                        step="0.001"
                        min="0.001"
                        className="input min-h-11"
                        defaultValue={1}
                        required
                      />
                    </Field>
                    <label className="flex min-h-11 items-end gap-2 pb-2 text-sm">
                      <input
                        type="checkbox"
                        name="restock"
                        className="size-5 accent-[var(--teal)]"
                      />{" "}
                      Reingresar a inventario
                    </label>
                    <Field label="Motivo" htmlFor="ret-reason" className="col-span-2 sm:col-span-3">
                      <input
                        id="ret-reason"
                        name="reason"
                        className="input min-h-11"
                        maxLength={300}
                      />
                    </Field>
                    <div className="flex items-end">
                      <PendingButton className="btn btn-primary min-h-11">Registrar</PendingButton>
                    </div>
                  </ActionForm>
                </details>
              )}
            </Card>
          )}

          <Card title="Línea de tiempo">
            <ol className="relative ml-2 border-l border-line pl-5 text-sm">
              {timeline.map((t, i) => (
                <li key={i} className="relative pb-3 last:pb-0">
                  <span
                    className={`st-${t.tone} absolute -left-[27px] top-1 size-3 rounded-full ring-4 ring-card`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{t.title}</span>
                    <span className="text-xs text-muted">{fmtDate(t.at, "datetime")}</span>
                  </div>
                  {t.detail && <div className="break-all text-xs text-muted">{t.detail}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card title="Cliente y entrega">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted">Cliente</dt>
              <dd>
                {o.customer_id ? (
                  <Link href={`/clientes/${o.customer_id}`} className="font-medium underline">
                    {o.customer_name ?? "Ver cliente"}
                  </Link>
                ) : (
                  <span className="font-medium">{o.customer_name ?? "Sin nombre"}</span>
                )}
                {o.customer_code && <span className="text-muted"> · {o.customer_code}</span>}
                {o.points_balance !== null && o.customer_id && (
                  <div className="text-xs text-muted">{o.points_balance} puntos</div>
                )}
              </dd>
              <dt className="text-muted">Teléfono</dt>
              <dd>{o.customer_phone ?? "—"}</dd>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{o.customer_email ?? "—"}</dd>
              <dt className="text-muted">Tipo</dt>
              <dd>{FULFILLMENT[o.fulfillment_type] ?? o.fulfillment_type}</dd>
              <dt className="text-muted">Fecha</dt>
              <dd>{o.scheduled_for ? fmtDate(o.scheduled_for, "datetime") : "—"}</dd>
              {o.fulfillment_type === "delivery" ? (
                <>
                  <dt className="text-muted">Dirección</dt>
                  <dd>
                    {[
                      o.delivery_address?.street,
                      o.delivery_address?.neighborhood,
                      o.delivery_address?.references_note,
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-muted">Retiro en</dt>
                  <dd>{o.pickup_name ?? "—"}</dd>
                </>
              )}
              {o.source_ref && (
                <>
                  <dt className="text-muted">Referencia</dt>
                  <dd className="break-all">{o.source_ref}</dd>
                </>
              )}
              {o.notes && (
                <>
                  <dt className="text-muted">Notas</dt>
                  <dd>{o.notes}</dd>
                </>
              )}
            </dl>
          </Card>

          {canWrite && (transitions.length > 0 || canCancel) && (
            <Card title="Avanzar estado">
              <div className="flex flex-col gap-2" data-testid="transitions">
                {transitions.map((s) => (
                  <ActionForm
                    key={s}
                    action={changeStatusAction}
                    resetOnSuccess={false}
                    className="contents"
                  >
                    <input type="hidden" name="order_id" value={o.id} />
                    <input type="hidden" name="to_status" value={s} />
                    <PendingButton
                      className={`btn min-h-12 w-full ${["paid", "ready", "ready_for_pickup", "delivered", "completed"].includes(s) ? "btn-confirm" : "btn-primary"}`}
                      pendingLabel="Actualizando…"
                    >
                      {ORDER_STATUS_LABELS[s]}
                    </PendingButton>
                  </ActionForm>
                ))}
                {canTransition(o.status, "paid") && balance > 0 && (
                  <p className="text-xs text-muted">
                    Para marcarlo como pagado usa “Registrar pago manual”: así se cobra, se registra
                    la venta y se descuenta inventario.
                  </p>
                )}
              </div>
              {canCancel && (
                <details className="mt-3">
                  <summary className="btn btn-danger btn-sm min-h-9 w-fit cursor-pointer list-none">
                    Cancelar pedido
                  </summary>
                  <ActionForm
                    action={cancelOrderAction}
                    className="mt-2 flex flex-col gap-2"
                    resetOnSuccess={false}
                  >
                    <input type="hidden" name="order_id" value={o.id} />
                    <Field label="Motivo" htmlFor="cancel-reason">
                      <input
                        id="cancel-reason"
                        name="reason"
                        className="input min-h-11"
                        required
                        minLength={3}
                        maxLength={300}
                      />
                    </Field>
                    <PendingButton
                      className="btn btn-danger min-h-11"
                      confirm="¿Cancelar este pedido?"
                    >
                      Confirmar cancelación
                    </PendingButton>
                  </ActionForm>
                </details>
              )}
            </Card>
          )}

          {canWrite && (
            <Card title="Notas internas">
              <ActionForm action={notesAction} resetOnSuccess={false}>
                <input type="hidden" name="order_id" value={o.id} />
                <textarea
                  name="internal_notes"
                  className="input min-h-24"
                  defaultValue={o.internal_notes ?? ""}
                  maxLength={2000}
                  placeholder="Solo visible para el equipo"
                />
                <PendingButton className="btn btn-secondary min-h-11">Guardar notas</PendingButton>
              </ActionForm>
            </Card>
          )}

          {canWrite && emailEnabled && (
            <Card title="Enviar comprobante por email">
              <ActionForm action={sendReceiptAction} className="flex gap-2">
                <input type="hidden" name="order_id" value={o.id} />
                <input
                  name="to"
                  type="email"
                  className="input min-h-11"
                  defaultValue={o.customer_email ?? ""}
                  required
                  aria-label="Email destino"
                />
                <PendingButton className="btn btn-primary min-h-11" pendingLabel="Enviando…">
                  Enviar
                </PendingButton>
              </ActionForm>
              {receipts.rows.length > 0 && (
                <ul className="mt-2 text-xs text-muted">
                  {receipts.rows.map((r) => (
                    <li key={r.id}>
                      {fmtDate(r.created_at, "datetime")} · {r.channel} · {r.destination} ·{" "}
                      {r.status}
                      {r.error ? ` (${r.error})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
