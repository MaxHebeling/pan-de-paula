import Link from "next/link";
import { notFound } from "next/navigation";
import { marginBps } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { loadBreakdown } from "@/lib/costing";
import { fmtDate, pct } from "@/lib/format";
import { PageHeader, Card, Badge, Money, Stat, Table, LinkButton } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/catalog/action-form";
import { FormGrid, MoneyInput, Select, TextInput } from "@/components/catalog/fields";
import { RegularPriceForm } from "@/components/catalog/price-live-form";
import { FormulaList } from "@/components/catalog/formula";
import { formulaLines } from "@/components/catalog/formula-lines";
import { marginTone } from "@/components/catalog/costing-types";
import { utcToZonedInput } from "@/lib/tz";
import { createPromotion, endPromotion, setRegularPrice } from "../actions";

export const dynamic = "force-dynamic";

const CHANNEL: Record<string, string> = { all: "Todos", web: "Tienda web", pos: "POS" };

type PriceRow = {
  id: string;
  channel: string;
  kind: string;
  price_cents: number;
  valid_from: Date;
  valid_to: Date | null;
  label: string | null;
  created_at: Date;
  created_by_name: string | null;
  status: "vigente" | "programado" | "cerrado";
};

export default async function ProductPricesPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const session = await requireSession("catalog.read");
  const canWrite = hasPermission(session, "catalog.write");
  const { productId } = await params;
  const product = await db()
    .selectFrom("products")
    .select(["id", "name", "variant_label", "parent_id", "is_active"])
    .where("id", "=", productId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!product) notFound();

  const [cur, history, tzRow, breakdown] = await Promise.all([
    sql<{ pos: number | null; web: number | null; cost: number | null }>`
      select current_price_cents(${productId}, 'pos') as pos, current_price_cents(${productId}, 'web') as web, product_cost_cents(${productId}) as cost`.execute(
      db(),
    ),
    sql<PriceRow>`
      select p.id, p.channel::text as channel, p.kind::text as kind, p.price_cents, p.valid_from, p.valid_to, p.label, p.created_at, u.full_name as created_by_name,
             case when p.valid_from > now() then 'programado' when p.valid_to is not null and p.valid_to <= now() then 'cerrado' else 'vigente' end as status
      from product_prices p left join staff_users u on u.id = p.created_by
      where p.product_id = ${productId} order by p.valid_from desc, p.created_at desc limit 200`.execute(
      db(),
    ),
    sql<{ timezone: string }>`select timezone from business_settings where id = 1`.execute(db()),
    loadBreakdown(productId),
  ]);
  const target = breakdown?.target_margin_bps ?? 6000;
  const tz = tzRow.rows[0]?.timezone ?? "America/Tijuana";
  const c = cur.rows[0]!;
  const rows = history.rows;
  const active = rows.filter((r) => r.status !== "cerrado");
  const promosOpen = active.filter((r) => r.kind === "promo");
  const marginPos = c.pos !== null && c.cost !== null ? marginBps(c.pos, c.cost) : null;
  const marginWeb = c.web !== null && c.cost !== null ? marginBps(c.web, c.cost) : null;
  const title = product.parent_id ? `${product.name}` : product.name;

  return (
    <>
      <PageHeader
        title={`Precios · ${title}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/precios" className="hover:underline">
              ← Precios
            </Link>
            {!product.is_active && <Badge tone="gray">Producto inactivo</Badge>}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/productos/${product.id}`} variant="secondary">
              Producto
            </LinkButton>
            <LinkButton href={`/recetas/${product.id}`} variant="secondary">
              Receta
            </LinkButton>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Vigente POS"
          value={<Money cents={c.pos} />}
          hint={
            marginPos === null ? "sin costo" : `margen ${pct(marginPos)} · objetivo ${pct(target)}`
          }
          tone={
            marginTone(marginPos, target) === "gray" ? undefined : marginTone(marginPos, target)
          }
        />
        <Stat
          label="Vigente web"
          value={<Money cents={c.web} />}
          hint={
            marginWeb === null ? "sin costo" : `margen ${pct(marginWeb)} · objetivo ${pct(target)}`
          }
          tone={
            marginTone(marginWeb, target) === "gray" ? undefined : marginTone(marginWeb, target)
          }
        />
        <Stat
          label="Costo por pieza"
          value={<Money cents={c.cost} />}
          hint={
            breakdown?.suggested_price_cents !== null &&
            breakdown?.suggested_price_cents !== undefined ? (
              <>
                sugerido <Money cents={breakdown.suggested_price_cents} />
              </>
            ) : (
              "según receta"
            )
          }
        />
        <Stat
          label="Promos activas"
          value={promosOpen.filter((r) => r.status === "vigente").length}
          hint={`${promosOpen.filter((r) => r.status === "programado").length} programadas`}
        />
      </div>

      {breakdown?.has_recipe && (
        <Card title="Fórmulas (costo, margen y precio sugerido)" className="mb-4">
          <FormulaList lines={formulaLines(breakdown, { channel: "both" })} />
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Vigentes y programados">
            {active.length === 0 ? (
              <p className="text-sm text-muted">
                Este producto no tiene precio. No se puede vender hasta fijar uno.
              </p>
            ) : (
              <Table className="!shadow-none">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Canal</th>
                    <th className="text-right">Precio</th>
                    <th>Vigencia</th>
                    <th>Estado</th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {active.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.kind === "promo" ? (
                          <Badge tone="blue">Promo</Badge>
                        ) : (
                          <Badge tone="gray">Regular</Badge>
                        )}
                        {r.label && <div className="text-xs text-muted">{r.label}</div>}
                      </td>
                      <td>{CHANNEL[r.channel] ?? r.channel}</td>
                      <td className="text-right font-medium">
                        <Money cents={r.price_cents} />
                      </td>
                      <td className="text-xs text-muted">
                        desde {fmtDate(r.valid_from, "datetime")}
                        <br />
                        {r.valid_to
                          ? `hasta ${fmtDate(r.valid_to, "datetime")}`
                          : "sin fecha de fin"}
                      </td>
                      <td>
                        <Badge tone={r.status === "vigente" ? "green" : "amber"}>{r.status}</Badge>
                      </td>
                      {canWrite && (
                        <td className="text-right">
                          {r.kind === "promo" && (
                            <form action={endPromotion.bind(null, product.id, r.id)}>
                              <ConfirmButton
                                variant="danger"
                                confirm={
                                  r.status === "programado"
                                    ? "¿Cancelar esta promoción programada?"
                                    : "¿Terminar la promoción ahora?"
                                }
                              >
                                {r.status === "programado" ? "Cancelar" : "Terminar"}
                              </ConfirmButton>
                            </form>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Historial completo">
            <Table className="!shadow-none">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Canal</th>
                  <th className="text-right">Precio</th>
                  <th>Desde</th>
                  <th>Hasta</th>
                  <th>Estado</th>
                  <th>Por</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.status === "cerrado" ? "text-muted" : ""}>
                    <td>
                      {r.kind === "promo" ? "Promo" : "Regular"}
                      {r.label ? ` · ${r.label}` : ""}
                    </td>
                    <td>{CHANNEL[r.channel] ?? r.channel}</td>
                    <td className="text-right">
                      <Money cents={r.price_cents} />
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {fmtDate(r.valid_from, "datetime")}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {r.valid_to ? fmtDate(r.valid_to, "datetime") : "—"}
                    </td>
                    <td>
                      <Badge
                        tone={
                          r.status === "vigente"
                            ? "green"
                            : r.status === "programado"
                              ? "amber"
                              : "gray"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="text-xs">{r.created_by_name ?? "sistema"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>

        {canWrite && (
          <div className="flex min-w-0 flex-col gap-4">
            <Card title="Nuevo precio regular">
              <RegularPriceForm
                action={setRegularPrice.bind(null, product.id)}
                costCents={c.cost}
                suggestedCents={breakdown?.suggested_price_cents ?? null}
                suggestedRawCents={breakdown?.suggested_raw_cents ?? null}
                targetMarginBps={target}
                roundingCents={breakdown?.settings.price_rounding_cents ?? 100}
              />
            </Card>
            <Card title="Crear promoción">
              <ActionForm
                action={createPromotion.bind(null, product.id)}
                resetOnSuccess
                className="flex flex-col gap-3"
              >
                <TextInput
                  label="Nombre"
                  name="label"
                  id="promo-label"
                  required
                  maxLength={80}
                  placeholder="Promo San Valentín"
                />
                <FormGrid>
                  <Select label="Canal" name="channel" id="promo-channel" defaultValue="all">
                    <option value="all">Todos los canales</option>
                    <option value="pos">Solo POS</option>
                    <option value="web">Solo tienda web</option>
                  </Select>
                  <MoneyInput
                    label="Precio promo (MXN)"
                    name="price"
                    id="promo-price"
                    required
                    hint="Debe ser menor al regular."
                  />
                  <TextInput
                    label="Inicio"
                    name="valid_from"
                    id="promo-from"
                    type="datetime-local"
                    required
                    defaultValue={utcToZonedInput(new Date(), tz)}
                  />
                  <TextInput
                    label="Fin (opcional)"
                    name="valid_to"
                    id="promo-to"
                    type="datetime-local"
                    hint={`Vacío = hasta que la termines. Horas en ${tz}.`}
                  />
                </FormGrid>
                <div>
                  <SubmitButton variant="secondary">Crear promoción</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
