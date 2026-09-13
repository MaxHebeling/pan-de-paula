import type { ActionState } from "@/lib/action-state";
import type { CouponRow } from "@/lib/coupons";
import { ActionForm } from "./action-form";

/** La fecha se guardó como instante (00:00 / 23:59:59 locales): se muestra en la zona del negocio, no en UTC. */
const toDateInput = (d: Date | null, tz: string) =>
  d
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(d))
    : "";

export function CouponForm({
  action,
  coupon,
  products,
  tiers,
  timeZone = "America/Tijuana",
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  coupon?: CouponRow;
  products: Array<{ id: string; name: string }>;
  tiers: Array<{ key: string; name: string }>;
  timeZone?: string;
}) {
  const ch = coupon?.channels ?? ["all"];
  return (
    <ActionForm action={action} submitLabel={coupon ? "Guardar cambios" : "Crear cupón"}>
      {coupon && <input type="hidden" name="id" value={coupon.id} />}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label" htmlFor="cp_code">
            Código *
          </label>
          <input
            id="cp_code"
            name="code"
            className="input font-mono uppercase"
            required
            pattern="[A-Za-z0-9_\-]{3,40}"
            defaultValue={coupon?.code ?? ""}
            placeholder="BIENVENIDA10"
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_name">
            Nombre interno
          </label>
          <input
            id="cp_name"
            name="name"
            className="input"
            defaultValue={coupon?.name ?? ""}
            placeholder="Campaña de bienvenida"
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_kind">
            Tipo *
          </label>
          <select id="cp_kind" name="kind" className="input" defaultValue={coupon?.kind ?? "pct"}>
            <option value="pct">Porcentaje</option>
            <option value="amount">Monto fijo</option>
            <option value="free_product">Producto gratis</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="cp_pct">
              % (si es porcentaje)
            </label>
            <input
              id="cp_pct"
              name="value_pct"
              inputMode="decimal"
              className="input"
              defaultValue={coupon?.value_bps != null ? coupon.value_bps / 100 : ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="cp_pesos">
              $ (si es monto)
            </label>
            <input
              id="cp_pesos"
              name="value_pesos"
              inputMode="decimal"
              className="input"
              defaultValue={coupon?.value_cents != null ? coupon.value_cents / 100 : ""}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="cp_product">
            Producto (gratis, o restringe el % a ese producto)
          </label>
          <select
            id="cp_product"
            name="product_id"
            className="input"
            defaultValue={coupon?.product_id ?? ""}
          >
            <option value="">—</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="cp_min">
            Compra mínima ($)
          </label>
          <input
            id="cp_min"
            name="min_subtotal_pesos"
            inputMode="decimal"
            className="input"
            defaultValue={coupon ? coupon.min_subtotal_cents / 100 : 0}
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_start">
            Vigente desde
          </label>
          <input
            id="cp_start"
            name="starts_at"
            type="date"
            className="input"
            defaultValue={toDateInput(coupon?.starts_at ?? null, timeZone)}
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_end">
            Vigente hasta (inclusive)
          </label>
          <input
            id="cp_end"
            name="ends_at"
            type="date"
            className="input"
            defaultValue={toDateInput(coupon?.ends_at ?? null, timeZone)}
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_max">
            Usos máximos totales (vacío = ilimitado)
          </label>
          <input
            id="cp_max"
            name="max_uses"
            type="number"
            min={1}
            className="input"
            defaultValue={coupon?.max_uses ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="cp_maxc">
            Usos máximos por cliente
          </label>
          <input
            id="cp_maxc"
            name="max_uses_per_customer"
            type="number"
            min={1}
            className="input"
            defaultValue={coupon?.max_uses_per_customer ?? 1}
            required
          />
        </div>
        <fieldset>
          <legend className="label">Canales</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(["all", "pos", "web"] as const).map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="channels"
                  value={c}
                  defaultChecked={ch.includes(c)}
                  className="h-4 w-4"
                />
                {c === "all" ? "Todos" : c === "pos" ? "Mostrador" : "Web"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label">Segmento (vacío = todos)</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {tiers.map((t) => (
              <label key={t.key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="tiers"
                  value={t.key}
                  defaultChecked={coupon?.segment.tiers?.includes(t.key) ?? false}
                  className="h-4 w-4"
                />
                {t.name}
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="new_customers_only"
                defaultChecked={coupon?.segment.new_customers_only ?? false}
                className="h-4 w-4"
              />
              Solo clientes sin compras
            </label>
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input
            type="checkbox"
            name="is_active"
            defaultChecked={coupon?.is_active ?? true}
            className="h-4 w-4"
          />{" "}
          Activo
        </label>
      </div>
    </ActionForm>
  );
}
