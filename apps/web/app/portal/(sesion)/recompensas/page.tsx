import Link from "next/link";
import { notFound } from "next/navigation";
import { dateTimeMX } from "@/lib/format";
import { getProgram, listActiveRewards, listTiers, loyaltyEnabled } from "@/lib/loyalty";
import {
  getPortalCustomer,
  listPortalRedemptions,
  REDEMPTION_STATUS_LABELS,
} from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";
import { money } from "@/lib/format";

export const metadata = { title: "Mis recompensas", robots: { index: false, follow: false } };

/**
 * Recompensas del socio.
 *
 * El canje NO se hace aquí: `reward_redemptions` las emite y aplica el punto de venta
 * (`pos_checkout` consume `reward_redemption_id`). No hay flujo de canje online, así que esta
 * página no lleva un botón que descuente puntos — diría una mentira y dejaría al socio sin nada
 * que recoger. Lo que ofrece es "cómo canjear": mostrar el QR en la panadería.
 *
 * Tampoco hay imágenes: `rewards` no tiene columna de imagen. No se inventa ninguna.
 *
 * Las tres situaciones se distinguen de forma explícita, con los puntos que faltan calculados:
 * alcanzable ahora · le faltan N puntos · exige un nivel que todavía no tiene.
 */
export default async function PortalRewardsPage() {
  const session = await requireCustomerSession();
  const [customer, business, program, rewards, tiers] = await Promise.all([
    getPortalCustomer(session.customer.id),
    getBusiness(),
    getProgram(),
    listActiveRewards(),
    listTiers(),
  ]);
  if (!customer) notFound();
  const redemptions = await listPortalRedemptions(customer.id);
  const enabled = loyaltyEnabled(business.flags, program);

  const rank = (key: string | null) => (key ? tiers.findIndex((t) => t.key === key) : -1);
  const miRango = rank(customer.tierKey);

  /** Qué le pasa a este socio con esta recompensa. El orden de las causas importa: el nivel manda. */
  const estado = (r: (typeof rewards)[number]) => {
    const faltan = r.pointsCost - customer.pointsBalance;
    const exigeNivel = r.minTierKey !== null && rank(r.minTierKey) > miRango;
    if (exigeNivel) {
      const n = tiers.find((t) => t.key === r.minTierKey);
      return { clave: "nivel" as const, texto: `Necesitas el nivel ${n?.name ?? r.minTierKey}` };
    }
    if (faltan > 0)
      return {
        clave: "faltan" as const,
        texto: `Te faltan ${faltan} ${faltan === 1 ? "punto" : "puntos"} para esta recompensa`,
      };
    return { clave: "lista" as const, texto: "Puedes pedirla en tu próxima visita" };
  };

  /** El valor del beneficio, dicho con los datos que existen y sin redondear de más. */
  const beneficio = (r: (typeof rewards)[number]) => {
    if (r.kind === "discount_pct" && r.valueBps !== null)
      return `${r.valueBps / 100}% de descuento`;
    if (r.kind === "discount_amount" && r.valueCents !== null)
      return `${money(r.valueCents)} de descuento`;
    if (r.kind === "free_product")
      return r.productName ? `${r.productName} gratis` : "Producto de regalo";
    return "Regalo";
  };

  const alcanzables = rewards.filter((r) => estado(r).clave === "lista");

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6">
        <h1 className="font-display text-2xl text-ink">Mis recompensas</h1>
        {!enabled ? (
          <p className="mt-3 text-sm text-ink-2">
            El programa de puntos está en pausa. Tus puntos se conservan.
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm text-ink-2">Tu saldo</p>
            <p
              className="font-display text-5xl leading-none text-ink"
              data-testid="recompensas-saldo"
            >
              {customer.pointsBalance}
              <span className="ml-2 font-body text-base text-ink-2">
                {customer.pointsBalance === 1 ? "punto" : "puntos"}
              </span>
            </p>
            <p className="mt-3 text-sm text-ink-2">
              {alcanzables.length > 0
                ? `Ya puedes pedir ${alcanzables.length === 1 ? "1 recompensa" : `${alcanzables.length} recompensas`}.`
                : "Sigue sumando puntos con cada compra."}{" "}
              <Link href="/portal/puntos" className="underline">
                Ver mis movimientos
              </Link>
            </p>
          </>
        )}
      </section>

      {enabled && (
        <section className="card p-5 sm:p-6">
          <h2 className="font-display text-xl text-ink">Cómo canjear</h2>
          <p className="mt-2 text-sm text-ink-2">
            Los canjes se hacen en la panadería: muestra tu QR en el mostrador y dile al equipo qué
            recompensa quieres. Ellos la aplican a tu compra y los puntos se descuentan ahí mismo.
          </p>
          <Link href="/portal" className="mt-3 inline-block text-sm font-medium underline">
            Mostrar mi QR
          </Link>
        </section>
      )}

      {enabled && (
        <section className="space-y-3">
          <h2 className="font-display text-xl text-ink">Catálogo</h2>
          {rewards.length === 0 ? (
            <p className="card p-5 text-sm text-ink-2">
              Todavía no hay recompensas publicadas. En cuanto el equipo agregue alguna, aparecerá
              aquí.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {rewards.map((r) => {
                const e = estado(r);
                return (
                  <li
                    key={r.id}
                    className="card flex flex-col gap-2 p-4"
                    data-testid="recompensa"
                    data-estado={e.clave}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-display text-lg text-ink">{r.name}</h3>
                      <span className="shrink-0 rounded-full bg-cream-2 px-2.5 py-1 text-xs font-semibold text-ink">
                        {r.pointsCost} {r.pointsCost === 1 ? "punto" : "puntos"}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-ink">{beneficio(r)}</p>
                    {r.description && <p className="text-sm text-ink-2">{r.description}</p>}
                    <p
                      className={`mt-auto text-sm ${e.clave === "lista" ? "font-semibold text-sage" : "text-ink-2"}`}
                    >
                      {e.texto}
                    </p>
                    {r.endsAt && (
                      <p className="text-xs text-ink-2">
                        Vigente hasta el {dateTimeMX(r.endsAt, business.timezone)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Lo que ya obtuviste</h2>
        {redemptions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">Todavía no has canjeado ninguna recompensa.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {redemptions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium text-ink">{d.rewardName}</p>
                  <p className="text-xs text-ink-2">
                    {REDEMPTION_STATUS_LABELS[d.status] ?? d.status} ·{" "}
                    {dateTimeMX(d.appliedAt ?? d.issuedAt, business.timezone)}
                    {d.orderFolio ? ` · ${d.orderFolio}` : ""}
                  </p>
                </div>
                <span className="text-sm tabular-nums text-ink-2">
                  −{d.pointsSpent} {d.pointsSpent === 1 ? "punto" : "puntos"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
