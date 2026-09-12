"use client";
import { useMemo, useState, useTransition } from "react";
import { Minus, Plus, Search, Trash2 } from "lucide-react";
import { formatMXN, PAYMENT_METHOD_LABELS, newIdempotencyKey } from "@pdp/domain";
import { ActionForm } from "@/components/ops/action-form";
import { PendingButton } from "@/components/ops/pending-button";
import { Field } from "@/components/ops/field";
import { createOrderAction, searchCustomersAction } from "@/app/(app)/pedidos/actions";

export type OrderProduct = { id: string; name: string; category_name: string | null; price_cents: number | null; on_hand: number; track_stock: boolean };
type Customer = { id: string; full_name: string; phone: string | null; email: string | null; public_code: string };
type CartLine = { product_id: string; qty: number };

const METHODS = (Object.keys(PAYMENT_METHOD_LABELS) as Array<keyof typeof PAYMENT_METHOD_LABELS>).filter((m) => m !== "points" && m !== "mercadopago");

/** Pedido manual (admin / WhatsApp / Instagram): cliente, productos, entrega, cupón y pago inicial opcional. */
export function NewOrderForm({ products, pickupPoints }: { products: OrderProduct[]; pickupPoints: Array<{ id: string; name: string; is_default: boolean }> }) {
  const [idem] = useState(() => newIdempotencyKey("adm"));
  const [cart, setCart] = useState<CartLine[]>([]);
  const [filter, setFilter] = useState("");
  const [customerMode, setCustomerMode] = useState<"none" | "existing" | "new">("none");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [cq, setCq] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, startSearch] = useTransition();
  const [fulfillment, setFulfillment] = useState("scheduled_pickup");
  const [payNow, setPayNow] = useState(false);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const total = cart.reduce((a, l) => a + (byId.get(l.product_id)?.price_cents ?? 0) * l.qty, 0);
  const visible = products.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  const setQty = (product_id: string, qty: number) =>
    setCart((c) => {
      const next = c.filter((l) => l.product_id !== product_id);
      return qty > 0 ? [...next, { product_id, qty }].sort((a, b) => (byId.get(a.product_id)?.name ?? "").localeCompare(byId.get(b.product_id)?.name ?? "")) : next;
    });
  const qtyOf = (id: string) => cart.find((l) => l.product_id === id)?.qty ?? 0;

  const search = () => {
    startSearch(async () => {
      const r = await searchCustomersAction(cq);
      setResults(r.ok ? r.data : []);
    });
  };

  return (
    <ActionForm action={createOrderAction} className="grid gap-4 lg:grid-cols-[1fr_380px]" resetOnSuccess={false}>
      <input type="hidden" name="idempotency_key" value={idem} />
      <input type="hidden" name="items" value={JSON.stringify(cart)} />
      <input type="hidden" name="customer_mode" value={customerMode} />
      {customer && <input type="hidden" name="customer_id" value={customer.id} />}

      <div className="flex flex-col gap-4">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">1 · Productos</h2>
          <div className="relative mb-3">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input className="input min-h-11 pl-9" placeholder="Buscar producto…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Buscar producto" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {visible.map((p) => {
              const q = qtyOf(p.id);
              return (
                <div key={p.id} className={`flex items-center justify-between gap-2 rounded-[var(--r-card)] border p-3 ${q ? "border-teal bg-teal/5" : "border-line"}`} data-testid={`pick-${p.id}`} data-product-name={p.name}>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-xs text-muted">
                      {p.price_cents === null ? "Sin precio" : formatMXN(p.price_cents)}
                      {p.track_stock && ` · stock ${p.on_hand}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {q > 0 && (
                      <>
                        <button type="button" className="btn btn-secondary size-11 !p-0" onClick={() => setQty(p.id, q - 1)} aria-label={`Quitar uno de ${p.name}`}>
                          <Minus size={16} />
                        </button>
                        <span className="w-8 text-center font-semibold tabular-nums" data-testid="line-qty">
                          {q}
                        </span>
                      </>
                    )}
                    <button type="button" className="btn btn-primary size-11 !p-0" onClick={() => setQty(p.id, q + 1)} disabled={p.price_cents === null} aria-label={`Agregar ${p.name}`}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">2 · Cliente</h2>
          <div className="mb-3 flex flex-wrap gap-2">
            {(
              [
                ["none", "Sin registrar"],
                ["existing", "Cliente existente"],
                ["new", "Cliente nuevo"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`btn min-h-11 ${customerMode === k ? "btn-primary" : "btn-secondary"}`}
                onClick={() => {
                  setCustomerMode(k);
                  if (k !== "existing") setCustomer(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {customerMode === "existing" && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className="input min-h-11"
                  placeholder="Nombre, teléfono, código PDP- o QR"
                  value={cq}
                  onChange={(e) => setCq(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      search();
                    }
                  }}
                  aria-label="Buscar cliente"
                />
                <button type="button" className="btn btn-secondary min-h-11" onClick={search} disabled={searching || cq.trim().length < 2}>
                  {searching ? "Buscando…" : "Buscar"}
                </button>
              </div>
              {customer ? (
                <div className="st-green flex items-center justify-between rounded-[var(--r-btn)] px-3 py-2 text-sm">
                  <span>
                    <strong>{customer.full_name}</strong> · {customer.phone ?? customer.email ?? ""} · {customer.public_code}
                  </span>
                  <button type="button" className="underline" onClick={() => setCustomer(null)}>
                    cambiar
                  </button>
                </div>
              ) : (
                results.length > 0 && (
                  <ul className="divide-y divide-line rounded-[var(--r-card)] border border-line">
                    {results.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/5" onClick={() => setCustomer(c)}>
                          <span className="font-medium">{c.full_name}</span>
                          <span className="text-muted">{c.phone ?? c.email ?? ""} · {c.public_code}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          )}
          {(customerMode === "new" || customerMode === "none") && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={customerMode === "new" ? "Nombre *" : "Nombre"} htmlFor="customer_name">
                <input id="customer_name" name="customer_name" className="input min-h-11" maxLength={120} required={customerMode === "new"} />
              </Field>
              <Field label={customerMode === "new" ? "Teléfono *" : "Teléfono"} htmlFor="customer_phone">
                <input id="customer_phone" name="customer_phone" type="tel" inputMode="tel" className="input min-h-11" placeholder="10 dígitos" />
              </Field>
              <Field label="Email" htmlFor="customer_email">
                <input id="customer_email" name="customer_email" type="email" className="input min-h-11" />
              </Field>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">3 · Entrega</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Canal" htmlFor="channel">
              <select id="channel" name="channel" className="input min-h-11" defaultValue="admin">
                <option value="admin">Admin (teléfono / mostrador)</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="instagram">Instagram</option>
              </select>
            </Field>
            <Field label="Tipo" htmlFor="fulfillment_type">
              <select id="fulfillment_type" name="fulfillment_type" className="input min-h-11" value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
                <option value="scheduled_pickup">Retiro programado</option>
                <option value="pickup">Retiro inmediato</option>
                <option value="delivery">Entrega a domicilio</option>
                <option value="preorder">Preventa</option>
              </select>
            </Field>
            <Field label={fulfillment === "pickup" ? "Fecha y hora (opcional)" : "Fecha y hora *"} htmlFor="scheduled_for">
              <input id="scheduled_for" name="scheduled_for" type="datetime-local" className="input min-h-11" required={fulfillment !== "pickup"} />
            </Field>
            {fulfillment !== "delivery" ? (
              <Field label="Punto de retiro" htmlFor="pickup_point_id">
                <select id="pickup_point_id" name="pickup_point_id" className="input min-h-11" defaultValue={pickupPoints.find((p) => p.is_default)?.id ?? ""}>
                  <option value="">—</option>
                  {pickupPoints.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <>
                <Field label="Calle y número *" htmlFor="street" className="sm:col-span-2">
                  <input id="street" name="street" className="input min-h-11" required />
                </Field>
                <Field label="Colonia" htmlFor="neighborhood">
                  <input id="neighborhood" name="neighborhood" className="input min-h-11" />
                </Field>
                <Field label="Referencias" htmlFor="references_note">
                  <input id="references_note" name="references_note" className="input min-h-11" />
                </Field>
              </>
            )}
            <Field label="Referencia externa" htmlFor="source_ref" hint="Ej. usuario de Instagram o número de conversación">
              <input id="source_ref" name="source_ref" className="input min-h-11" maxLength={120} />
            </Field>
            <Field label="Notas del pedido" htmlFor="notes">
              <input id="notes" name="notes" className="input min-h-11" maxLength={500} />
            </Field>
          </div>
        </section>
      </div>

      <aside className="card sticky top-20 flex h-fit flex-col gap-3 p-4">
        <h2 className="font-semibold">Resumen</h2>
        {cart.length === 0 ? (
          <p className="text-sm text-muted">Agrega productos para ver el total.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {cart.map((l) => {
              const p = byId.get(l.product_id)!;
              return (
                <li key={l.product_id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    {l.qty} × {p.name}
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {formatMXN((p.price_cents ?? 0) * l.qty)}
                    <button type="button" className="text-muted hover:text-red-d" onClick={() => setQty(l.product_id, 0)} aria-label={`Quitar ${p.name}`}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold">
          <span>Total estimado</span>
          <span className="tabular-nums" data-testid="cart-total">
            {formatMXN(total)}
          </span>
        </div>
        <p className="text-xs text-muted">El precio final lo calcula el servidor (precio vigente, cupón e IVA según configuración).</p>
        <Field label="Cupón" htmlFor="coupon_code">
          <input id="coupon_code" name="coupon_code" className="input min-h-11 uppercase" maxLength={40} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--teal)]" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} />
          Registrar pago inicial
        </label>
        {payNow && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Método" htmlFor="payment_method">
              <select id="payment_method" name="payment_method" className="input min-h-11" defaultValue="cash">
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Monto (MXN)" htmlFor="payment_amount">
              <input id="payment_amount" name="payment_amount" inputMode="decimal" className="input min-h-11" defaultValue={(total / 100).toFixed(2)} key={total} />
            </Field>
          </div>
        )}
        <PendingButton className="btn btn-primary min-h-12" pendingLabel="Creando pedido…" disabled={cart.length === 0}>
          Crear pedido
        </PendingButton>
      </aside>
    </ActionForm>
  );
}
