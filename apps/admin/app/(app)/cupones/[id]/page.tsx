import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Stat, Table, Badge, Money, LinkButton, Alert } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { getCoupon, couponRedemptions, COUPON_KIND_LABELS, COUPON_STATUS } from "@/lib/coupons";
import { activeProducts } from "@/lib/loyalty";
import { loyaltyTiers, CHANNEL_LABELS } from "@/lib/customers";
import { ActionForm } from "@/components/customers/action-form";
import { CouponForm } from "@/components/customers/coupon-form";
import { CodesGenerator } from "@/components/customers/codes-generator";
import { upsertCouponAction, setCouponActiveAction, generateCodesAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCoupon(id);
  return { title: c ? `Cupón ${c.code}` : "Cupón" };
}

export default async function CouponPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession("customers.read");
  const canWrite = hasPermission(session, "loyalty.write");
  const { id } = await params;
  const sp = await searchParams;
  const c = await getCoupon(id);
  if (!c) notFound();
  const [uses, products, tiers] = await Promise.all([
    couponRedemptions(id),
    activeProducts(),
    loyaltyTiers(),
  ]);
  const st = COUPON_STATUS[c.status]!;
  return (
    <>
      <PageHeader
        title={c.code}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span>{c.name ?? COUPON_KIND_LABELS[c.kind]}</span>
            <span>· creado {fmtDate(c.created_at)}</span>
          </span>
        }
        actions={
          <>
            <LinkButton href="/cupones" variant="secondary">
              Volver
            </LinkButton>
            {canWrite && (
              <ActionForm
                action={setCouponActiveAction}
                inline
                submitLabel={c.is_active ? "Desactivar" : "Activar"}
                variant={c.is_active ? "danger" : "confirm"}
                confirm={
                  c.is_active
                    ? "¿Desactivar el cupón? Dejará de aceptarse de inmediato."
                    : undefined
                }
              >
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="active" value={c.is_active ? "0" : "1"} />
              </ActionForm>
            )}
          </>
        }
      />
      {sp.guardado && (
        <div className="mb-4">
          <Alert tone="green">Cupón guardado.</Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Usos"
          value={`${c.uses_count}${c.max_uses !== null ? ` / ${c.max_uses}` : ""}`}
          hint={`máx. ${c.max_uses_per_customer} por cliente`}
        />
        <Stat label="Descuento otorgado" value={<Money cents={c.discount_total_cents} compact />} />
        <Stat
          label="Valor"
          value={
            c.kind === "pct" ? (
              `${(c.value_bps ?? 0) / 100}%`
            ) : c.kind === "amount" ? (
              <Money cents={c.value_cents ?? 0} compact />
            ) : (
              "Gratis"
            )
          }
          hint={c.product_name ?? undefined}
        />
        <Stat
          label="Vigencia"
          value={c.ends_at ? fmtDate(c.ends_at) : "Sin límite"}
          hint={c.starts_at ? `desde ${fmtDate(c.starts_at)}` : undefined}
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          {canWrite ? (
            <Card title="Editar cupón">
              <CouponForm
                action={upsertCouponAction}
                coupon={c}
                products={products}
                tiers={tiers}
              />
            </Card>
          ) : (
            <Card title="Configuración">
              <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
                <dt className="text-muted">Tipo</dt>
                <dd>{COUPON_KIND_LABELS[c.kind]}</dd>
                <dt className="text-muted">Compra mínima</dt>
                <dd>
                  <Money cents={c.min_subtotal_cents} compact />
                </dd>
                <dt className="text-muted">Canales</dt>
                <dd>{c.channels.includes("all") ? "todos" : c.channels.join(", ")}</dd>
                <dt className="text-muted">Segmento</dt>
                <dd>
                  {c.segment.tiers?.length ? `niveles ${c.segment.tiers.join(", ")}` : "todos"}
                  {c.segment.new_customers_only && " · solo clientes nuevos"}
                </dd>
              </dl>
            </Card>
          )}
          {canWrite && (
            <Card title="Generar códigos únicos">
              <p className="mb-3 text-sm text-muted">
                Crea un lote de cupones con la misma configuración que este (uno por persona, para
                volantes o Instagram).
              </p>
              <CodesGenerator
                action={generateCodesAction}
                couponId={c.id}
                defaultPrefix={
                  c.code
                    .replace(/[^A-Z0-9]/gi, "")
                    .slice(0, 6)
                    .toUpperCase() || "PDP"
                }
              />
            </Card>
          )}
        </div>
        <Card title={`Uso (${uses.length})`}>
          {uses.length === 0 ? (
            <p className="text-sm text-muted">Nadie ha usado este cupón todavía.</p>
          ) : (
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Pedido</th>
                  <th className="text-right">Descuento</th>
                </tr>
              </thead>
              <tbody>
                {uses.map((u) => (
                  <tr key={u.id}>
                    <td className="whitespace-nowrap text-muted">
                      {fmtDate(u.created_at, "datetime")}
                    </td>
                    <td>
                      {u.customer_id ? (
                        <Link href={`/clientes/${u.customer_id}`} className="hover:underline">
                          {u.customer_name}
                        </Link>
                      ) : (
                        <span className="text-muted">anónimo</span>
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {u.folio ?? "—"}
                      {u.channel && (
                        <span className="ml-1 text-muted">
                          {CHANNEL_LABELS[u.channel] ?? u.channel}
                        </span>
                      )}
                    </td>
                    <td className="text-right">
                      −<Money cents={u.discount_cents} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
