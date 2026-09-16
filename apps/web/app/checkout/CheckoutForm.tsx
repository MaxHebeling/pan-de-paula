"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DEFAULT_PHONE_COUNTRY, formatLocalDate, parsePhone } from "@pdp/domain";
import { CartNotice } from "@/components/CartNotice";
import { PhoneField } from "@/components/PhoneField";
import { ProductArt } from "@/components/ProductArt";
import { useCart } from "@/lib/cart/CartProvider";
import { useCartRevalidation } from "@/lib/cart/useCartRevalidation";
import {
  cartSignature,
  clearIdempotencyKey,
  getOrCreateIdempotencyKey,
} from "@/lib/checkout/idempotency";
import { FULFILLMENT_LABELS, capitalize, hour12, hourRange, money } from "@/lib/format";
import { lookupCustomerAction, placeOrderAction, type CheckoutPayload } from "./actions";

type Option = {
  windowId: string;
  windowName: string;
  fulfillmentType: string;
  date: string;
  from: string | null;
  to: string | null;
  orderByDate: string;
  orderByTime: string;
};
type PickupPoint = { id: string; name: string; address: string | null; isDefault: boolean };
type PaymentAvailability = { mercadopago: boolean; transfer: boolean; cash: boolean };

export function CheckoutForm({
  options,
  pickupPoints,
  payment,
  deliveryFeeCents,
  deliveryZone,
  whatsapp,
}: {
  options: Option[];
  pickupPoints: PickupPoint[];
  payment: PaymentAvailability;
  deliveryFeeCents: number;
  deliveryZone: string | null;
  whatsapp: string | null;
}) {
  const cart = useCart();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Revalidación de precios: una al cargar y otra justo antes de enviar el pedido.
  const { changes, checking, check } = useCartRevalidation();
  const [needsConfirm, setNeedsConfirm] = useState(false);
  // Clave de idempotencia ligada al contenido del carrito y persistida en sessionStorage: un refresh o un
  // "atrás" a mitad del envío reutiliza la misma clave y el servidor devuelve el pedido ya creado.
  const signature = cartSignature(cart.lines);

  const [optionKey, setOptionKey] = useState(
    options[0] ? `${options[0].windowId}|${options[0].date}` : "",
  );
  const option = options.find((o) => `${o.windowId}|${o.date}` === optionKey) ?? null;
  const isDelivery = option?.fulfillmentType === "delivery";
  const [pickupPointId, setPickupPointId] = useState(
    pickupPoints.find((p) => p.isDefault)?.id ?? pickupPoints[0]?.id ?? "",
  );
  const [street, setStreet] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [references, setReferences] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState(DEFAULT_PHONE_COUNTRY);
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [isMember, setIsMember] = useState(Boolean(cart.customerLookup));
  const [lookup, setLookup] = useState(cart.customerLookup ?? "");
  const [lookupHint, setLookupHint] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const defaultMethod: CheckoutPayload["payment_method"] = payment.mercadopago
    ? "mercadopago"
    : "cash";
  const [method, setMethod] = useState<CheckoutPayload["payment_method"]>(defaultMethod);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const fee = isDelivery ? deliveryFeeCents : 0;
  const total = cart.totals.totalCents + fee;

  if (!cart.hydrated) return <p className="mt-8 text-ink-2">Cargando tu carrito…</p>;

  if (cart.lines.length === 0) {
    return (
      <>
        <CartNotice changes={changes} className="mt-6" />
        <div className="card mt-8 p-10 text-center">
          <p className="font-display text-2xl text-ink">Tu carrito está vacío</p>
          <Link href="/menu" className="btn btn-primary mt-6">
            Ver menú
          </Link>
        </div>
      </>
    );
  }

  if (options.length === 0) {
    return (
      <div className="card mt-8 p-8">
        <p className="font-display text-2xl text-ink">Por ahora no hay fechas abiertas</p>
        <p className="mt-2 text-ink-2">
          No tenemos ventanas de pedido activas en este momento. Escríbenos y lo resolvemos por
          mensaje.
        </p>
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary mt-5"
          >
            Escribir por WhatsApp
          </a>
        )}
      </div>
    );
  }

  const doLookup = async () => {
    setLookupBusy(true);
    setLookupError(null);
    setLookupHint(null);
    const r = await lookupCustomerAction(lookup);
    setLookupBusy(false);
    if (r.found) {
      setLookupHint(r.hint);
      cart.setCustomerLookup(lookup.trim());
    } else {
      setLookupError(r.error);
      cart.setCustomerLookup(null);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNeedsConfirm(false);
    if (!option) return setError({ field: "date", message: "Elige una fecha de recolección." });
    if (name.trim().length < 2)
      return setError({ field: "customer_name", message: "Escribe tu nombre completo." });
    // Adelanto del mismo criterio del servidor (que vuelve a validar y normalizar con parsePhone).
    const parsedPhone = parsePhone(phoneCountry, phone);
    if (!parsedPhone.ok) return setError({ field: "customer_phone", message: parsedPhone.error });
    if (isDelivery && street.trim().length < 3)
      return setError({
        field: "delivery_address",
        message: "Escribe la calle y número de entrega.",
      });
    const payload: CheckoutPayload = {
      items: cart.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
      window_id: option.windowId,
      date: option.date,
      pickup_point_id: isDelivery ? undefined : pickupPointId || undefined,
      delivery_address: isDelivery
        ? {
            street: street.trim(),
            neighborhood: neighborhood.trim() || undefined,
            references_note: references.trim() || undefined,
          }
        : undefined,
      customer_name: name.trim(),
      customer_phone: phone.trim(),
      customer_phone_country: phoneCountry,
      customer_email: email.trim() || undefined,
      customer_lookup: isMember && lookupHint ? lookup.trim() : null,
      coupon_code: cart.coupon?.code,
      notes: cart.notes.trim() || undefined,
      payment_method: method,
      marketing_consent: consent,
      idempotency_key: getOrCreateIdempotencyKey(safeSessionStorage(), signature),
    };
    startTransition(async () => {
      // Último vistazo a los precios: si algo cambió no se crea el pedido en silencio.
      if (await check()) {
        setNeedsConfirm(true);
        return;
      }
      const r = await placeOrderAction(payload);
      if (!r.ok) {
        setError({ message: r.error, field: r.field });
        return;
      }
      clearIdempotencyKey(safeSessionStorage());
      cart.clear();
      if (/^https?:\/\//.test(r.redirect) && !r.redirect.startsWith(window.location.origin)) {
        window.location.assign(r.redirect);
      } else {
        router.push(r.redirect.replace(window.location.origin, ""));
      }
    });
  };

  const err = (field: string) => (error?.field === field ? error.message : null);
  // Campos con mensaje propio junto al control; cualquier otro error (o sin campo) se muestra en el resumen.
  const INLINE_FIELDS = ["customer_name", "customer_phone", "customer_email", "delivery_address"];
  const summaryError = error && !INLINE_FIELDS.includes(error.field ?? "") ? error.message : null;

  return (
    <form onSubmit={submit} className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]" noValidate>
      <div className="space-y-6">
        {/* Paso 1 */}
        <section className="card p-5 sm:p-6" aria-labelledby="paso-1">
          <h2 id="paso-1" className="flex items-center gap-3 font-display text-2xl text-ink">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sage text-base text-white">
              1
            </span>
            ¿Cuándo lo recoges?
          </h2>
          <fieldset className="mt-4">
            <legend className="sr-only">Fecha de recolección</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {options.map((o) => {
                const key = `${o.windowId}|${o.date}`;
                const checked = key === optionKey;
                return (
                  <label
                    key={key}
                    className={`cursor-pointer rounded-card border-2 p-4 transition ${checked ? "border-sage bg-sage/5" : "border-line bg-paper hover:border-ink/30"}`}
                  >
                    <input
                      type="radio"
                      name="option"
                      value={key}
                      checked={checked}
                      onChange={() => setOptionKey(key)}
                      className="sr-only"
                      data-testid="fulfillment-radio"
                    />
                    <span className="eyebrow block">
                      {FULFILLMENT_LABELS[o.fulfillmentType] ?? o.windowName}
                    </span>
                    <span className="mt-1 block font-display text-xl text-ink">
                      {capitalize(formatLocalDate(o.date))}
                    </span>
                    {(o.from || o.to) && (
                      <span className="block text-sm text-ink-2">{hourRange(o.from, o.to)}</span>
                    )}
                    <span className="mt-1 block text-xs text-ink-2">
                      Pide antes del {formatLocalDate(o.orderByDate, { weekday: false })} a las{" "}
                      {hour12(o.orderByTime)}
                    </span>
                  </label>
                );
              })}
            </div>
            {err("date") && (
              <p className="error" role="alert">
                {err("date")}
              </p>
            )}
          </fieldset>

          {!isDelivery && pickupPoints.length > 1 && (
            <div className="mt-5">
              <label htmlFor="pickup" className="label">
                Punto de recolección
              </label>
              <select
                id="pickup"
                className="input"
                value={pickupPointId}
                onChange={(e) => setPickupPointId(e.target.value)}
              >
                {pickupPoints.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.address && p.address !== "Dirección por configurar" ? ` · ${p.address}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!isDelivery && pickupPoints.length === 1 && pickupPoints[0] && (
            <p className="mt-4 text-sm text-ink-2">
              Recoges en <strong className="text-ink">{pickupPoints[0].name}</strong>
              {pickupPoints[0].address && pickupPoints[0].address !== "Dirección por configurar"
                ? ` · ${pickupPoints[0].address}`
                : ""}
              .
            </p>
          )}

          {isDelivery && (
            <div className="mt-5 grid gap-4">
              {deliveryZone && (
                <p className="text-sm text-ink-2">Zona de entrega: {deliveryZone}</p>
              )}
              <div>
                <label htmlFor="street" className="label">
                  Calle y número
                </label>
                <input
                  id="street"
                  className="input"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  autoComplete="street-address"
                  required
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="neighborhood" className="label">
                    Colonia
                  </label>
                  <input
                    id="neighborhood"
                    className="input"
                    value={neighborhood}
                    onChange={(e) => setNeighborhood(e.target.value)}
                    autoComplete="address-level3"
                  />
                </div>
                <div>
                  <label htmlFor="references" className="label">
                    Referencias
                  </label>
                  <input
                    id="references"
                    className="input"
                    value={references}
                    onChange={(e) => setReferences(e.target.value)}
                  />
                </div>
              </div>
              {err("delivery_address") && (
                <p className="error" role="alert">
                  {err("delivery_address")}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Paso 2 */}
        <section className="card p-5 sm:p-6" aria-labelledby="paso-2">
          <h2 id="paso-2" className="flex items-center gap-3 font-display text-2xl text-ink">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sage text-base text-white">
              2
            </span>
            Tus datos
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="name" className="label">
                Nombre completo
              </label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
                aria-invalid={Boolean(err("customer_name"))}
                data-testid="name"
              />
              {err("customer_name") && (
                <p className="error" role="alert">
                  {err("customer_name")}
                </p>
              )}
            </div>
            <PhoneField
              name="customer_phone"
              label="Teléfono (WhatsApp)"
              required
              help="Te avisamos por aquí cuando tu pedido esté listo."
              error={err("customer_phone")}
              testId="phone"
              onChange={(v) => {
                setPhoneCountry(v.country);
                setPhone(v.national);
              }}
            />
            <div>
              <label htmlFor="email" className="label">
                Correo (opcional)
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                aria-invalid={Boolean(err("customer_email"))}
                data-testid="email"
              />
              <p className="help">Para enviarte la confirmación.</p>
              {err("customer_email") && (
                <p className="error" role="alert">
                  {err("customer_email")}
                </p>
              )}
            </div>
          </div>

          <div className="mt-5 rounded-card border border-line bg-cream/60 p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 accent-sage"
                checked={isMember}
                onChange={(e) => setIsMember(e.target.checked)}
              />
              <span>
                <span className="block font-medium text-ink">Ya soy cliente del club</span>
                <span className="block text-sm text-ink-2">
                  Vincula tu pedido para sumar puntos.
                </span>
              </span>
            </label>
            {isMember && (
              <div className="mt-3">
                <label htmlFor="lookup" className="label">
                  Teléfono registrado o código PDP
                </label>
                <div className="flex gap-2">
                  <input
                    id="lookup"
                    className="input"
                    value={lookup}
                    onChange={(e) => {
                      setLookup(e.target.value);
                      // Al editar el dato, la confirmación anterior deja de valer.
                      setLookupHint(null);
                      setLookupError(null);
                    }}
                    placeholder="PDP-000123 o 6641234567"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary shrink-0"
                    onClick={doLookup}
                    disabled={lookupBusy || lookup.trim().length < 6}
                  >
                    {lookupBusy ? "Buscando…" : "Buscar"}
                  </button>
                </div>
                {lookupHint && (
                  <p className="mt-2 text-sm text-sage" role="status">
                    ¡Hola, {lookupHint}! Sumaremos los puntos de este pedido a tu cuenta.
                  </p>
                )}
                {lookupError && (
                  <p className="error" role="alert">
                    {lookupError}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="mt-5">
            <label htmlFor="order-notes" className="label">
              Notas para la panadería (opcional)
            </label>
            <textarea
              id="order-notes"
              className="input min-h-20 py-3"
              value={cart.notes}
              onChange={(e) => cart.setNotes(e.target.value)}
              maxLength={500}
            />
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-sage"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span className="text-sm text-ink-2">
              Quiero recibir novedades, temporadas y promociones por WhatsApp o correo. Puedes darte
              de baja cuando quieras.
            </span>
          </label>
        </section>

        {/* Paso 3 */}
        <section className="card p-5 sm:p-6" aria-labelledby="paso-3">
          <h2 id="paso-3" className="flex items-center gap-3 font-display text-2xl text-ink">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-sage text-base text-white">
              3
            </span>
            ¿Cómo pagas?
          </h2>
          <fieldset className="mt-4 grid gap-3">
            <legend className="sr-only">Método de pago</legend>
            {payment.mercadopago && (
              <PayOption
                checked={method === "mercadopago"}
                onChange={() => setMethod("mercadopago")}
                title="Pagar en línea"
                body="Tarjeta, débito o saldo con Mercado Pago. Te redirigimos para pagar de forma segura."
                testId="pay-mercadopago"
              />
            )}
            {payment.cash && (
              <PayOption
                checked={method === "cash"}
                onChange={() => setMethod("cash")}
                title="Pagar al recoger"
                body="En efectivo o con tarjeta en el mostrador cuando pases por tu pedido."
                testId="pay-cash"
              />
            )}
            {payment.transfer && (
              <PayOption
                checked={method === "transfer"}
                onChange={() => setMethod("transfer")}
                title="Transferencia"
                body="Te mostramos los datos bancarios al confirmar. Tu pedido queda apartado."
                testId="pay-transfer"
              />
            )}
          </fieldset>
          {err("payment_method") && (
            <p className="error" role="alert">
              {err("payment_method")}
            </p>
          )}
        </section>
      </div>

      {/* Resumen */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="card p-5">
          <h2 className="font-display text-xl text-ink">Tu pedido</h2>
          <ul className="mt-4 divide-y divide-line">
            {cart.lines.map((l) => (
              <li key={l.productId} className="flex items-center gap-3 py-3">
                <span className="h-12 w-12 shrink-0 overflow-hidden rounded-[10px] bg-cream-2">
                  {l.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ProductArt name={l.name} seed={l.slug} className="h-full w-full" />
                  )}
                </span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate text-ink">{l.name}</span>
                  <span className="text-ink-2">× {l.qty}</span>
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {money(l.unitPriceCents * l.qty)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-2">Subtotal</dt>
              <dd className="tabular-nums">{money(cart.totals.subtotalCents)}</dd>
            </div>
            {cart.coupon && (
              <div className="flex justify-between text-sage">
                <dt>Cupón {cart.coupon.code}</dt>
                <dd className="tabular-nums">−{money(cart.totals.discountCents)}</dd>
              </div>
            )}
            {isDelivery && (
              <div className="flex justify-between">
                <dt className="text-ink-2">Envío</dt>
                <dd className="tabular-nums">{fee ? money(fee) : "Sin costo"}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums" data-testid="checkout-total">
                {money(total)}
              </dd>
            </div>
          </dl>
          {option && (
            <p className="mt-3 rounded-[12px] bg-cream px-3 py-2 text-xs text-ink-2">
              Recolección:{" "}
              <strong className="text-ink">{capitalize(formatLocalDate(option.date))}</strong>
              {(option.from || option.to) && ` · ${hourRange(option.from, option.to)}`}
            </p>
          )}
          {summaryError && (
            <p className="error" role="alert" data-testid="checkout-error">
              {summaryError}
            </p>
          )}
          <CartNotice
            changes={changes}
            tone={needsConfirm ? "alert" : "status"}
            footer={
              needsConfirm
                ? "Revisa el total y vuelve a confirmar tu pedido."
                : "Estos son los precios con los que se registrará tu pedido."
            }
            testId="checkout-cart-changes"
            className="mt-4"
          />
          <button
            type="submit"
            className="btn btn-primary btn-lg mt-5 w-full"
            disabled={pending || checking}
            data-testid="place-order"
          >
            {pending
              ? "Registrando tu pedido…"
              : checking
                ? "Revisando precios…"
                : needsConfirm
                  ? "Confirmar con el precio vigente"
                  : method === "mercadopago"
                    ? "Continuar al pago"
                    : "Confirmar pedido"}
          </button>
          <p className="mt-3 text-center text-xs text-ink-2">
            Al confirmar aceptas nuestros{" "}
            <Link href="/terminos" className="underline">
              términos
            </Link>{" "}
            y el{" "}
            <Link href="/privacidad" className="underline">
              aviso de privacidad
            </Link>
            .
          </p>
          <Link href="/carrito" className="btn btn-ghost mt-2 w-full">
            Editar carrito
          </Link>
        </div>
      </aside>
    </form>
  );
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // modo privado / almacenamiento bloqueado
  }
}

function PayOption({
  checked,
  onChange,
  title,
  body,
  testId,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
  testId: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-card border-2 p-4 transition ${checked ? "border-sage bg-sage/5" : "border-line bg-paper hover:border-ink/30"}`}
    >
      <input
        type="radio"
        name="payment"
        checked={checked}
        onChange={onChange}
        className="mt-1 h-5 w-5 accent-sage"
        data-testid={testId}
      />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-sm text-ink-2">{body}</span>
      </span>
    </label>
  );
}
