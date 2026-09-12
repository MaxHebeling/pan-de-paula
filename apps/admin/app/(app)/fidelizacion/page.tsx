import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Stat, Table, Badge, Money } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { loyaltyTiers, tierTone } from "@/lib/customers";
import { loyaltyProgram, rewardsList, productBonuses, activeProducts, redemptionsList, loyaltyDashboard, REWARD_KIND_LABELS } from "@/lib/loyalty";
import { ActionForm } from "@/components/customers/action-form";
import { PointsSimulator } from "@/components/customers/points-simulator";
import { Bars } from "@/components/reports/bars";
import {
  updateProgramAction,
  upsertTierAction,
  deleteTierAction,
  upsertRewardAction,
  toggleRewardAction,
  upsertBonusAction,
  deleteBonusAction,
  cancelRedemptionAction,
} from "./actions";

export const metadata = { title: "Fidelización" };
export const dynamic = "force-dynamic";

const TABS = [
  ["tablero", "Tablero"],
  ["programa", "Programa"],
  ["niveles", "Niveles"],
  ["recompensas", "Recompensas"],
  ["bonos", "Bonos por producto"],
  ["canjes", "Historial de canjes"],
] as const;
type Tab = (typeof TABS)[number][0];

export default async function LoyaltyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession("customers.read");
  const canWrite = hasPermission(session, "loyalty.write");
  const sp = await searchParams;
  const raw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = TABS.some(([k]) => k === raw) ? (raw as Tab) : "tablero";
  const program = await loyaltyProgram();
  const domainProgram = {
    isActive: program.is_active,
    pointsPerUnit: program.points_per_unit,
    unitCents: program.unit_cents,
    minPurchaseCents: program.min_purchase_cents,
    birthdayMultiplier: Number(program.birthday_multiplier),
    rounding: program.rounding,
  };
  return (
    <>
      <PageHeader
        title="Fidelización"
        subtitle={
          program.feature_enabled && program.is_active
            ? `Programa activo · ${program.points_per_unit} pt por cada $${(program.unit_cents / 100).toLocaleString("es-MX")}`
            : "Programa de puntos pausado"
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Secciones">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/fidelizacion?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`pill px-3 py-1.5 text-sm font-medium ${tab === k ? "bg-teal text-white" : "st-gray"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "tablero" && <Dashboard />}
      {tab === "programa" && <ProgramTab program={program} domainProgram={domainProgram} canWrite={canWrite} />}
      {tab === "niveles" && <TiersTab canWrite={canWrite} editKey={Array.isArray(sp.editar) ? sp.editar[0] : sp.editar} />}
      {tab === "recompensas" && <RewardsTab canWrite={canWrite} />}
      {tab === "bonos" && <BonusesTab canWrite={canWrite} />}
      {tab === "canjes" && <RedemptionsTab canWrite={canWrite} />}
    </>
  );
}

async function Dashboard() {
  const d = await loyaltyDashboard();
  const monthLabel = (m: string) => new Intl.DateTimeFormat("es-MX", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(m + "-01T00:00:00Z"));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Puntos en circulación" value={d.totals.outstanding.toLocaleString("es-MX")} hint={`${d.totals.customers_with_points} clientes con saldo`} />
        <Stat label="Emitidos (30 días)" value={d.totals.issued_30d.toLocaleString("es-MX")} />
        <Stat label="Canjes (30 días)" value={d.totals.redemptions_30d} />
        <Stat label="Cumpleaños próximos" value={d.birthdays.length} hint="siguientes 30 días" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Puntos emitidos vs canjeados por mes">
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Mes</th>
                <th className="text-right">Emitidos</th>
                <th className="text-right">Canjeados</th>
                <th className="text-right">Ajustes</th>
                <th className="text-right">Clientes</th>
              </tr>
            </thead>
            <tbody>
              {d.months.map((m) => (
                <tr key={m.month}>
                  <td className="capitalize">{monthLabel(m.month)}</td>
                  <td className="text-right tabular-nums">{m.issued.toLocaleString("es-MX")}</td>
                  <td className="text-right tabular-nums">{m.redeemed.toLocaleString("es-MX")}</td>
                  <td className="text-right tabular-nums">{m.adjusted.toLocaleString("es-MX")}</td>
                  <td className="text-right tabular-nums">{m.customers}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3">
            <Bars items={d.months.map((m) => ({ label: monthLabel(m.month), value: m.issued }))} />
          </div>
        </Card>
        <Card title="Clientes por nivel">
          <Bars items={d.tiers.map((t) => ({ label: t.name, value: t.customers, hint: `${t.points.toLocaleString("es-MX")} pts en saldo` }))} />
          <ul className="mt-3 divide-y divide-line text-sm">
            {d.tiers.map((t) => (
              <li key={t.key} className="flex items-center justify-between py-1.5">
                <Link href={`/clientes?nivel=${t.key}`} className="flex items-center gap-2 hover:underline">
                  <Badge tone={tierTone(t.color)}>{t.name}</Badge>
                </Link>
                <span className="tabular-nums text-muted">
                  {t.customers} clientes · {t.points.toLocaleString("es-MX")} pts
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Próximos cumpleaños (30 días)">
          {d.birthdays.length === 0 ? (
            <p className="text-sm text-muted">Sin cumpleaños en los próximos 30 días.</p>
          ) : (
            <ul className="max-h-[420px] divide-y divide-line overflow-y-auto text-sm">
              {d.birthdays.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link href={`/clientes/${b.id}`} className="hover:underline">
                    {b.full_name} <span className="font-mono text-xs text-muted">{b.public_code}</span>
                  </Link>
                  <span className="whitespace-nowrap text-xs text-muted">
                    {b.days === 0 ? <Badge tone="green">hoy</Badge> : b.days === 1 ? "mañana" : `en ${b.days} días`}
                    {b.marketing_consent && <span className="ml-1 text-[10px] uppercase">mkt</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function ProgramTab({
  program,
  domainProgram,
  canWrite,
}: {
  program: Awaited<ReturnType<typeof loyaltyProgram>>;
  domainProgram: Parameters<typeof PointsSimulator>[0]["program"];
  canWrite: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Reglas del programa">
        <ActionForm action={updateProgramAction} submitLabel="Guardar programa">
          <fieldset disabled={!canWrite} className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="feature_enabled" defaultChecked={program.feature_enabled} className="h-4 w-4" /> Motor de puntos habilitado (feature flag)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="is_active" defaultChecked={program.is_active} className="h-4 w-4" /> Programa activo (otorga puntos en ventas)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="points_per_unit">
                  Puntos otorgados
                </label>
                <input id="points_per_unit" name="points_per_unit" type="number" min={0} className="input" defaultValue={program.points_per_unit} required />
              </div>
              <div>
                <label className="label" htmlFor="unit_pesos">
                  por cada ($)
                </label>
                <input id="unit_pesos" name="unit_pesos" inputMode="decimal" className="input" defaultValue={(program.unit_cents / 100).toString()} required />
              </div>
              <div>
                <label className="label" htmlFor="min_purchase_pesos">
                  Compra mínima ($)
                </label>
                <input id="min_purchase_pesos" name="min_purchase_pesos" inputMode="decimal" className="input" defaultValue={(program.min_purchase_cents / 100).toString()} />
              </div>
              <div>
                <label className="label" htmlFor="birthday_multiplier">
                  Multiplicador de cumpleaños
                </label>
                <input id="birthday_multiplier" name="birthday_multiplier" inputMode="decimal" className="input" defaultValue={program.birthday_multiplier} required />
              </div>
              <div>
                <label className="label" htmlFor="signup_bonus_points">
                  Bono de bienvenida (pts)
                </label>
                <input id="signup_bonus_points" name="signup_bonus_points" type="number" min={0} className="input" defaultValue={program.signup_bonus_points} />
              </div>
              <div>
                <label className="label" htmlFor="points_expire_days">
                  Vencen a los (días, vacío = no vencen)
                </label>
                <input id="points_expire_days" name="points_expire_days" type="number" min={1} className="input" defaultValue={program.points_expire_days ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="rounding">
                  Redondeo
                </label>
                <select id="rounding" name="rounding" className="input" defaultValue={program.rounding}>
                  <option value="floor">Hacia abajo (floor)</option>
                  <option value="round">Normal (round)</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted">Última actualización {fmtDate(program.updated_at, "datetime")}. Los cambios aplican a ventas futuras; no recalculan puntos ya otorgados.</p>
          </fieldset>
        </ActionForm>
      </Card>
      <Card title="Simulador">
        <PointsSimulator program={domainProgram} featureEnabled={program.feature_enabled} />
      </Card>
    </div>
  );
}

async function TiersTab({ canWrite, editKey }: { canWrite: boolean; editKey?: string }) {
  const tiers = await loyaltyTiers();
  const initial = tiers.find((t) => t.key === editKey);
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card title="Niveles">
        <Table className="!border-0 !shadow-none">
          <thead>
            <tr>
              <th>Nivel</th>
              <th className="text-right">Rango</th>
              <th className="text-right">Mín. compras</th>
              <th className="text-right">Mín. gasto</th>
              <th className="text-right">Mín. puntos</th>
              <th>Beneficio</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.key}>
                <td>
                  <Badge tone={tierTone(t.color)}>{t.name}</Badge> <span className="ml-1 font-mono text-xs text-muted">{t.key}</span>
                </td>
                <td className="text-right tabular-nums">{t.rank}</td>
                <td className="text-right tabular-nums">{t.min_orders}</td>
                <td className="text-right">
                  <Money cents={t.min_spent_cents} compact />
                </td>
                <td className="text-right tabular-nums">{t.min_lifetime_points}</td>
                <td className="text-muted">{t.perks ?? "—"}</td>
                {canWrite && (
                  <td>
                    <div className="flex gap-1">
                      <Link href={`/fidelizacion?tab=niveles&editar=${t.key}#nivel-form`} className="btn btn-secondary btn-sm">
                        Editar
                      </Link>
                      <ActionForm action={deleteTierAction} inline submitLabel="Borrar" variant="danger" size="sm" confirm={`¿Eliminar el nivel "${t.name}"? Los clientes se reclasificarán.`}>
                        <input type="hidden" name="key" value={t.key} />
                      </ActionForm>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {canWrite && <TierForm tiers={tiers} initial={initial} />}
    </div>
  );
}

function TierForm({ tiers, initial }: { tiers: Awaited<ReturnType<typeof loyaltyTiers>>; initial?: Awaited<ReturnType<typeof loyaltyTiers>>[number] }) {
  return (
    <Card title={initial ? `Editar nivel · ${initial.name}` : "Crear nivel"} key={initial?.key ?? "new"}>
      <p className="mb-2 text-xs text-muted">Usa la misma clave para editar un nivel existente. Al guardar se reclasifican todos los clientes.</p>
      <ActionForm action={upsertTierAction} submitLabel="Guardar nivel" id="nivel-form" resetOnOk={!initial}>
        <div>
          <label className="label" htmlFor="tier_key">
            Clave *
          </label>
          <input id="tier_key" name="key" className="input" list="tier-keys" placeholder="frequent" required pattern="[a-z0-9_-]{2,30}" defaultValue={initial?.key ?? ""} readOnly={Boolean(initial)} />
          <datalist id="tier-keys">
            {tiers.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="tier_name">
            Nombre *
          </label>
          <input id="tier_name" name="name" className="input" required defaultValue={initial?.name ?? ""} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="tier_rank">
              Rango (mayor = mejor) *
            </label>
            <input id="tier_rank" name="rank" type="number" min={1} className="input" required defaultValue={initial?.rank ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="tier_color">
              Color
            </label>
            <select id="tier_color" name="color" className="input" defaultValue={initial?.color ?? "gray"}>
              <option value="gray">Gris</option>
              <option value="blue">Azul</option>
              <option value="amber">Ámbar</option>
              <option value="green">Verde</option>
              <option value="red">Rojo</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tier_orders">
              Mín. compras
            </label>
            <input id="tier_orders" name="min_orders" type="number" min={0} className="input" defaultValue={initial?.min_orders ?? 0} />
          </div>
          <div>
            <label className="label" htmlFor="tier_spent">
              Mín. gasto ($)
            </label>
            <input id="tier_spent" name="min_spent_pesos" inputMode="decimal" className="input" defaultValue={initial ? initial.min_spent_cents / 100 : 0} />
          </div>
          <div>
            <label className="label" htmlFor="tier_points">
              Mín. puntos históricos
            </label>
            <input id="tier_points" name="min_lifetime_points" type="number" min={0} className="input" defaultValue={initial?.min_lifetime_points ?? 0} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="tier_perks">
            Beneficio
          </label>
          <input id="tier_perks" name="perks" className="input" placeholder="Puntos dobles en cumpleaños" defaultValue={initial?.perks ?? ""} />
        </div>
      </ActionForm>
    </Card>
  );
}

async function RewardsTab({ canWrite }: { canWrite: boolean }) {
  const [rewards, products, tiers] = await Promise.all([rewardsList(), activeProducts(), loyaltyTiers()]);
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card title="Recompensas">
        {rewards.length === 0 ? (
          <p className="text-sm text-muted">Aún no hay recompensas.</p>
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Recompensa</th>
                <th>Tipo</th>
                <th className="text-right">Puntos</th>
                <th>Valor</th>
                <th className="text-right">Canjes</th>
                <th>Estado</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {rewards.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    {r.description && <div className="text-xs text-muted">{r.description}</div>}
                    {r.min_tier_key && <div className="text-xs text-muted">Desde nivel {tiers.find((t) => t.key === r.min_tier_key)?.name ?? r.min_tier_key}</div>}
                  </td>
                  <td>{REWARD_KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td className="text-right tabular-nums">{r.points_cost}</td>
                  <td>
                    {r.kind === "discount_pct" && r.value_bps !== null && `${r.value_bps / 100}%`}
                    {r.kind === "discount_amount" && r.value_cents !== null && <Money cents={r.value_cents} compact />}
                    {r.kind === "free_product" && (r.product_name ?? "—")}
                    {r.kind === "gift" && "—"}
                  </td>
                  <td className="text-right tabular-nums">{r.redemptions}</td>
                  <td>
                    <Badge tone={r.is_active ? "green" : "gray"}>{r.is_active ? "activa" : "inactiva"}</Badge>
                    {(r.starts_at || r.ends_at) && (
                      <div className="text-xs text-muted">
                        {r.starts_at ? fmtDate(r.starts_at) : "…"} – {r.ends_at ? fmtDate(r.ends_at) : "…"}
                      </div>
                    )}
                  </td>
                  {canWrite && (
                    <td>
                      <ActionForm action={toggleRewardAction} inline submitLabel={r.is_active ? "Desactivar" : "Activar"} variant="secondary" size="sm">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="active" value={r.is_active ? "0" : "1"} />
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {canWrite && (
        <Card title="Nueva recompensa">
          <ActionForm action={upsertRewardAction} submitLabel="Crear recompensa" resetOnOk>
            <div>
              <label className="label" htmlFor="rw_name">
                Nombre *
              </label>
              <input id="rw_name" name="name" className="input" required placeholder="Croissant de regalo" />
            </div>
            <div>
              <label className="label" htmlFor="rw_desc">
                Descripción
              </label>
              <input id="rw_desc" name="description" className="input" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="rw_kind">
                  Tipo *
                </label>
                <select id="rw_kind" name="kind" className="input" defaultValue="discount_amount">
                  <option value="discount_amount">Descuento $</option>
                  <option value="discount_pct">Descuento %</option>
                  <option value="free_product">Producto gratis</option>
                  <option value="gift">Regalo (sin descuento)</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="rw_points">
                  Costo en puntos *
                </label>
                <input id="rw_points" name="points_cost" type="number" min={0} className="input" required />
              </div>
              <div>
                <label className="label" htmlFor="rw_pesos">
                  Monto ($) — si es descuento $
                </label>
                <input id="rw_pesos" name="value_pesos" inputMode="decimal" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="rw_pct">
                  Porcentaje — si es descuento %
                </label>
                <input id="rw_pct" name="value_pct" inputMode="decimal" className="input" />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="rw_product">
                  Producto — si es producto gratis
                </label>
                <select id="rw_product" name="product_id" className="input" defaultValue="">
                  <option value="">—</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="rw_tier">
                  Nivel mínimo
                </label>
                <select id="rw_tier" name="min_tier_key" className="input" defaultValue="">
                  <option value="">Cualquiera</option>
                  {tiers.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" name="is_active" defaultChecked className="h-4 w-4" /> Activa
              </label>
              <div>
                <label className="label" htmlFor="rw_start">
                  Vigente desde
                </label>
                <input id="rw_start" name="starts_at" type="date" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="rw_end">
                  Vigente hasta
                </label>
                <input id="rw_end" name="ends_at" type="date" className="input" />
              </div>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}

async function BonusesTab({ canWrite }: { canWrite: boolean }) {
  const [bonuses, products] = await Promise.all([productBonuses(), activeProducts()]);
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card title="Bonos por producto">
        <p className="mb-3 text-sm text-muted">Puntos extra por cada unidad vendida del producto (se suman a los puntos por monto).</p>
        {bonuses.length === 0 ? (
          <p className="text-sm text-muted">Sin bonos configurados.</p>
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-right">Puntos extra / unidad</th>
                <th>Estado</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {bonuses.map((b) => (
                <tr key={b.product_id}>
                  <td>{b.name}</td>
                  <td className="text-right tabular-nums">+{b.bonus_points}</td>
                  <td>
                    <Badge tone={b.is_active ? "green" : "gray"}>{b.is_active ? "activo" : "inactivo"}</Badge>
                  </td>
                  {canWrite && (
                    <td>
                      <ActionForm action={deleteBonusAction} inline submitLabel="Quitar" variant="danger" size="sm" confirm="¿Quitar este bono?">
                        <input type="hidden" name="product_id" value={b.product_id} />
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {canWrite && (
        <Card title="Agregar o actualizar bono">
          <ActionForm action={upsertBonusAction} submitLabel="Guardar bono" resetOnOk>
            <div>
              <label className="label" htmlFor="bn_product">
                Producto *
              </label>
              <select id="bn_product" name="product_id" className="input" required defaultValue="">
                <option value="" disabled>
                  Selecciona…
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="bn_points">
                Puntos extra por unidad *
              </label>
              <input id="bn_points" name="bonus_points" type="number" min={0} className="input" required />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="is_active" defaultChecked className="h-4 w-4" /> Activo
            </label>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}

async function RedemptionsTab({ canWrite }: { canWrite: boolean }) {
  const rows = await redemptionsList();
  const STATUS: Record<string, { label: string; tone: "green" | "blue" | "gray" | "red" }> = {
    issued: { label: "emitido", tone: "blue" },
    applied: { label: "aplicado", tone: "green" },
    cancelled: { label: "cancelado", tone: "red" },
    expired: { label: "vencido", tone: "gray" },
  };
  return (
    <Card title="Historial de canjes">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Aún no hay canjes.</p>
      ) : (
        <Table className="!border-0 !shadow-none">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Recompensa</th>
              <th>Código</th>
              <th className="text-right">Puntos</th>
              <th>Estado</th>
              <th>Pedido</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-muted">{fmtDate(r.issued_at, "datetime")}</td>
                <td>
                  <Link href={`/clientes/${r.customer_id}`} className="hover:underline">
                    {r.customer_name}
                  </Link>{" "}
                  <span className="font-mono text-xs text-muted">{r.public_code}</span>
                </td>
                <td>{r.reward_name}</td>
                <td className="font-mono text-xs">{r.code}</td>
                <td className="text-right tabular-nums">−{r.points_spent}</td>
                <td>
                  <Badge tone={STATUS[r.status]?.tone ?? "gray"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                  {r.status === "issued" && r.expires_at && <div className="text-xs text-muted">vence {fmtDate(r.expires_at)}</div>}
                </td>
                <td className="font-mono text-xs">{r.folio ?? "—"}</td>
                {canWrite && (
                  <td>
                    {r.status === "issued" && (
                      <ActionForm action={cancelRedemptionAction} inline submitLabel="Cancelar" variant="danger" size="sm" confirm="¿Cancelar el canje y devolver los puntos?">
                        <input type="hidden" name="id" value={r.id} />
                      </ActionForm>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
