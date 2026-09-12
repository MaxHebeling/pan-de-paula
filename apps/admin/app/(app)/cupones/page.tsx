import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Stat, Table, Badge, Money, LinkButton, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { listCoupons, couponStats, COUPON_KIND_LABELS, COUPON_STATUS } from "@/lib/coupons";
import { activeProducts } from "@/lib/loyalty";
import { ActionForm } from "@/components/customers/action-form";
import { testCouponAction } from "./actions";

export const metadata = { title: "Cupones" };
export const dynamic = "force-dynamic";

export default async function CouponsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession("customers.read");
  const canWrite = hasPermission(session, "loyalty.write");
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const status = (Array.isArray(sp.estado) ? sp.estado[0] : sp.estado) ?? "";
  const [coupons, stats, products] = await Promise.all([listCoupons({ q, status: COUPON_STATUS[status] ? status : undefined }), couponStats(), activeProducts()]);
  return (
    <>
      <PageHeader
        title="Cupones"
        subtitle={`${stats.active} activos de ${stats.total}`}
        actions={canWrite ? <LinkButton href="/cupones/nuevo">Nuevo cupón</LinkButton> : undefined}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cupones activos" value={stats.active} />
        <Stat label="Usos (30 días)" value={stats.uses_30d} />
        <Stat label="Descuento otorgado (30 días)" value={<Money cents={stats.discount_30d} compact />} />
        <Stat label="Total de cupones" value={stats.total} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <form className="card mb-3 flex flex-wrap items-end gap-2 p-3" action="/cupones" method="get">
            <div className="min-w-[200px] flex-1">
              <label className="label" htmlFor="q">
                Buscar
              </label>
              <input id="q" name="q" className="input" defaultValue={q} placeholder="Código o nombre" />
            </div>
            <div>
              <label className="label" htmlFor="estado">
                Estado
              </label>
              <select id="estado" name="estado" className="input" defaultValue={status}>
                <option value="">Todos</option>
                {Object.entries(COUPON_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary">Filtrar</button>
          </form>
          {coupons.length === 0 ? (
            <EmptyState title="Sin cupones" body="Crea el primero para usarlo en mostrador o en la tienda en línea." action={canWrite ? <LinkButton href="/cupones/nuevo">Nuevo cupón</LinkButton> : undefined} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Tipo / valor</th>
                  <th>Vigencia</th>
                  <th className="text-right">Usos</th>
                  <th className="text-right">Descuento</th>
                  <th>Canales</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/cupones/${c.id}`} className="font-mono font-semibold text-teal-d hover:underline">
                        {c.code}
                      </Link>
                      {c.name && <div className="text-xs text-muted">{c.name}</div>}
                    </td>
                    <td>
                      {COUPON_KIND_LABELS[c.kind]} ·{" "}
                      {c.kind === "pct" && c.value_bps !== null && `${c.value_bps / 100}%`}
                      {c.kind === "amount" && c.value_cents !== null && <Money cents={c.value_cents} compact />}
                      {c.kind === "free_product" && (c.product_name ?? "—")}
                      {c.min_subtotal_cents > 0 && (
                        <div className="text-xs text-muted">
                          mín. <Money cents={c.min_subtotal_cents} compact />
                        </div>
                      )}
                    </td>
                    <td className="text-xs text-muted">
                      {c.starts_at || c.ends_at ? `${c.starts_at ? fmtDate(c.starts_at) : "…"} – ${c.ends_at ? fmtDate(c.ends_at) : "…"}` : "sin límite"}
                    </td>
                    <td className="text-right tabular-nums">
                      {c.uses_count}
                      {c.max_uses !== null && ` / ${c.max_uses}`}
                    </td>
                    <td className="text-right">
                      <Money cents={c.discount_total_cents} compact />
                    </td>
                    <td className="text-xs">{c.channels.includes("all") ? "todos" : c.channels.join(", ")}</td>
                    <td>
                      <Badge tone={COUPON_STATUS[c.status]!.tone}>{COUPON_STATUS[c.status]!.label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <Card title="Probador de cupones">
          <p className="mb-3 text-sm text-muted">Simula la validación exactamente como la hace el POS y la tienda (validate_coupon).</p>
          <ActionForm action={testCouponAction} submitLabel="Probar" variant="secondary">
            <div>
              <label className="label" htmlFor="t_code">
                Código *
              </label>
              <input id="t_code" name="code" className="input font-mono uppercase" required />
            </div>
            <div>
              <label className="label" htmlFor="t_customer">
                Cliente (código PDP, teléfono o email; opcional)
              </label>
              <input id="t_customer" name="customer" className="input" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="t_subtotal">
                  Subtotal ($)
                </label>
                <input id="t_subtotal" name="subtotal_pesos" inputMode="decimal" className="input" defaultValue="200" />
              </div>
              <div>
                <label className="label" htmlFor="t_channel">
                  Canal
                </label>
                <select id="t_channel" name="channel" className="input" defaultValue="pos">
                  <option value="pos">Mostrador</option>
                  <option value="web">Web</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="t_product">
                  Producto en carrito (opcional)
                </label>
                <select id="t_product" name="product_id" className="input" defaultValue="">
                  <option value="">—</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="t_qty">
                  Cantidad
                </label>
                <input id="t_qty" name="qty" type="number" min={1} className="input" defaultValue={1} />
              </div>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
