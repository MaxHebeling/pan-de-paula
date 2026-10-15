import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { PAYMENT_METHOD_LABELS } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Table, Badge, Money, LinkButton, Alert } from "@/components/ui";
import { ActionForm } from "@/components/ops/action-form";
import { PendingButton } from "@/components/ops/pending-button";
import { Field } from "@/components/ops/field";
import { fmtDate, qty } from "@/lib/format";
import { balanceCents, collectState, loadOrderForCollect } from "@/lib/orderCollect";
import { paymentAction } from "../../../pedidos/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cobrar pedido" };

const METHODS = Object.keys(PAYMENT_METHOD_LABELS).filter((m) => m !== "points");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODALIDAD: Record<string, string> = {
  pickup: "Recolección en tienda",
  scheduled_pickup: "Recolección programada",
  delivery: "Entrega a domicilio",
  preorder: "Pedido anticipado",
};

/**
 * Cobro de un pedido guardado, desde el punto de venta.
 *
 * Es una pantalla APARTE del carrito, a propósito. El punto de venta construye una venta nueva en
 * memoria (`PosScreen`); si este cobro viviera ahí dentro habría que acordarse de no pisar esa
 * venta en curso. Siendo otra ruta, no se pisa nada: el operador puede venir aquí, cobrar y volver,
 * y su carrito sigue intacto porque nunca se tocó.
 *
 * El cobro lo ejecuta `paymentAction` —la MISMA acción que usa el detalle del pedido, que a su vez
 * llama a `record_payment`—, así que no hay un segundo motor de cobros ni una segunda ruta por la
 * que el dinero pueda entrar. Los anticipos, la idempotencia, el tope del total, la asociación a la
 * caja abierta y el cierre de la venta al cubrirse el saldo ya viven ahí.
 */
export default async function CobrarPedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession("pos.sell");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const o = await loadOrderForCollect(id);
  if (!o) notFound();

  const saldo = balanceCents(o);
  const estado = collectState(o);
  // Cobrar escribe en el pedido, así que exige `orders.write` igual que en el detalle. Un vendedor
  // sin ese permiso puede consultar el pedido aquí pero no registrar el pago.
  const puedeCobrar = estado === "cobrable" && hasPermission(session, "orders.write");
  const pagosConfirmados = o.payments.filter((p) => p.status === "paid");
  const pagosEnVuelo = o.payments.filter(
    (p) => p.status === "pending" || p.status === "authorized",
  );

  return (
    <>
      <PageHeader
        title={`Cobrar ${o.folio}`}
        subtitle={`${MODALIDAD[o.fulfillment_type] ?? o.fulfillment_type} · ${o.customer_name ?? "Sin cliente"}`}
        actions={
          <>
            <LinkButton href={`/pedidos/${o.id}`} variant="secondary">
              Ver pedido completo
            </LinkButton>
            <LinkButton href="/pos/pendientes" variant="secondary">
              Pendientes de cobro
            </LinkButton>
          </>
        }
      />

      {estado === "pagado" && (
        <Alert tone="green">
          Este pedido ya está pagado.{" "}
          {o.sale_id ? (
            <>
              El cobro quedó registrado como venta.{" "}
              <a className="underline" href={`/pedidos/${o.id}`}>
                Consultar el comprobante
              </a>
              .
            </>
          ) : (
            "No hay saldo por cobrar."
          )}
        </Alert>
      )}
      {estado === "no_elegible" && (
        <Alert tone="red">
          El pedido está {o.status === "cancelled" ? "cancelado" : "reembolsado"}, así que no se
          puede cobrar.
        </Alert>
      )}
      {estado === "cobrable" && !hasPermission(session, "orders.write") && (
        <Alert tone="amber">
          No tienes permiso para registrar pagos. Puedes consultar el pedido, pero el cobro lo tiene
          que hacer alguien con permiso de escritura en pedidos.
        </Alert>
      )}
      {pagosEnVuelo.length > 0 && (
        <Alert tone="amber">
          Hay {pagosEnVuelo.length === 1 ? "un pago" : `${pagosEnVuelo.length} pagos`} sin confirmar
          por {pagosEnVuelo.length === 1 ? "el proveedor" : "los proveedores"}. No es dinero
          recibido: resuélvelo antes de cobrar aparte, o cobrarás dos veces el mismo saldo.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Productos del pedido">
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right">Cant.</th>
                  <th className="text-right">Unitario</th>
                  <th className="text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {o.items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <div className="font-medium">{it.product_name}</div>
                      {it.variant_label && (
                        <div className="text-xs text-muted">{it.variant_label}</div>
                      )}
                      {it.notes && <div className="text-xs text-muted">{it.notes}</div>}
                    </td>
                    <td className="text-right tabular-nums">{qty(it.qty)}</td>
                    <td className="text-right">
                      <Money cents={it.unit_price_cents} />
                    </td>
                    <td className="text-right">
                      <Money cents={it.total_cents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {o.notes && (
              <p className="mt-3 text-sm">
                <span className="font-semibold">Observaciones del cliente: </span>
                {o.notes}
              </p>
            )}
            {o.internal_notes && (
              <p className="mt-1 text-sm text-muted">
                <span className="font-semibold">Nota interna: </span>
                {o.internal_notes}
              </p>
            )}
          </Card>

          {puedeCobrar && (
            <Card title="Registrar el cobro">
              <ActionForm action={paymentAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input type="hidden" name="order_id" value={o.id} />
                {/*
                 * Clave de idempotencia nueva por render. Un doble clic sobre ESTE formulario manda
                 * la misma clave y `record_payment` devuelve el pago ya registrado en lugar de
                 * cobrar dos veces; recargar la pantalla genera otra clave, que es lo correcto
                 * porque entonces sí se trata de un pago distinto (un abono posterior).
                 */}
                <input type="hidden" name="idempotency_key" value={`pos-cobro-${randomUUID()}`} />
                <Field label="Método" htmlFor="cobro-metodo">
                  <select
                    id="cobro-metodo"
                    name="method"
                    className="input min-h-11"
                    defaultValue="cash"
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Monto a cobrar (MXN)" htmlFor="cobro-monto">
                  <input
                    id="cobro-monto"
                    name="amount"
                    inputMode="decimal"
                    className="input min-h-11"
                    defaultValue={(saldo / 100).toFixed(2)}
                    required
                  />
                </Field>
                <Field label="Recibido (efectivo)" htmlFor="cobro-recibido">
                  <input
                    id="cobro-recibido"
                    name="tendered"
                    inputMode="decimal"
                    className="input min-h-11"
                    placeholder="opcional"
                  />
                </Field>
                <Field label="Referencia contable" htmlFor="cobro-ref">
                  <input
                    id="cobro-ref"
                    name="reference"
                    className="input min-h-11 font-mono"
                    placeholder="clave de rastreo / folio"
                    maxLength={80}
                    autoComplete="off"
                  />
                </Field>
                <div className="col-span-2 sm:col-span-4">
                  <PendingButton className="btn btn-confirm min-h-11" pendingLabel="Cobrando…">
                    Confirmar cobro de {(saldo / 100).toFixed(2)} MXN
                  </PendingButton>
                </div>
              </ActionForm>
            </Card>
          )}
        </div>

        <div>
          <Card title="Importes">
            <dl className="space-y-1.5 text-sm">
              <Linea etiqueta="Subtotal" cents={o.subtotal_cents} />
              {o.discount_cents > 0 && (
                <Linea
                  etiqueta={o.coupon_code ? `Descuento (${o.coupon_code})` : "Descuento"}
                  cents={-o.discount_cents}
                />
              )}
              {o.delivery_fee_cents > 0 && <Linea etiqueta="Envío" cents={o.delivery_fee_cents} />}
              {o.tax_cents > 0 && <Linea etiqueta="Impuestos" cents={o.tax_cents} />}
              {o.tip_cents > 0 && <Linea etiqueta="Propina" cents={o.tip_cents} />}
              <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
                <dt>Total</dt>
                <dd>
                  <Money cents={o.total_cents} />
                </dd>
              </div>
              {o.paid_cents > 0 && <Linea etiqueta="Ya pagado (anticipos)" cents={-o.paid_cents} />}
              {o.refunded_cents > 0 && <Linea etiqueta="Reembolsado" cents={o.refunded_cents} />}
              <div className="flex justify-between border-t border-line pt-1.5 text-base font-bold">
                <dt>Saldo por cobrar</dt>
                <dd>
                  <Money cents={saldo} />
                </dd>
              </div>
            </dl>
          </Card>

          <Card title="Entrega">
            <dl className="space-y-1 text-sm">
              <Dato
                etiqueta="Modalidad"
                valor={MODALIDAD[o.fulfillment_type] ?? o.fulfillment_type}
              />
              {o.pickup_name && <Dato etiqueta="Punto de retiro" valor={o.pickup_name} />}
              {o.scheduled_for && (
                <Dato etiqueta="Fecha comprometida" valor={fmtDate(o.scheduled_for)} />
              )}
              {o.customer_phone && <Dato etiqueta="Teléfono" valor={o.customer_phone} />}
              {o.delivery_address && (
                <Dato
                  etiqueta="Dirección"
                  valor={Object.values(o.delivery_address).filter(Boolean).join(", ")}
                />
              )}
            </dl>
          </Card>

          {pagosConfirmados.length > 0 && (
            <Card title="Pagos ya aplicados">
              <ul className="space-y-1.5 text-sm">
                {pagosConfirmados.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span>
                      {PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ??
                        p.method}
                      <span className="text-muted">
                        {" "}
                        · {fmtDate(p.confirmed_at ?? p.created_at)}
                      </span>
                    </span>
                    <Money cents={p.amount_cents} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {o.pos_queued_at && (
            <p className="mt-2 text-xs text-muted">
              Enviado al punto de venta el {fmtDate(o.pos_queued_at)}
              {o.pos_queued_by_name ? ` por ${o.pos_queued_by_name}` : ""}. Enviarlo no lo cobra.
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            Estado del pedido: <Badge tone="gray">{o.status}</Badge> · Pago:{" "}
            <Badge tone={estado === "pagado" ? "green" : "amber"}>{o.payment_status}</Badge>
          </p>
        </div>
      </div>
    </>
  );
}

function Linea({ etiqueta, cents }: { etiqueta: string; cents: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{etiqueta}</dt>
      <dd>
        <Money cents={cents} />
      </dd>
    </div>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{etiqueta}</dt>
      <dd className="text-right">{valor}</dd>
    </div>
  );
}
