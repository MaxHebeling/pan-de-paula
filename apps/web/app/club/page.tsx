import type { Metadata } from "next";
import Link from "next/link";
import { money } from "@/lib/format";
import { getProgram, listActiveRewards, listTiers, loyaltyEnabled } from "@/lib/loyalty";
import { getBusiness } from "@/lib/site";

export const metadata: Metadata = {
  title: "Club de clientes",
  description:
    "Niveles, puntos y recompensas del Club El Pan de Paula. Acumula en cada compra y canjea por pan recién horneado.",
  alternates: { canonical: "/club" },
};

const TIER_TONE: Record<string, string> = {
  gray: "bg-cream-2 text-ink",
  blue: "bg-ink text-cream",
  amber: "bg-crust text-ink",
  green: "bg-sage text-white",
};

export default async function ClubPage() {
  const [business, program, tiers, rewards] = await Promise.all([
    getBusiness(),
    getProgram(),
    listTiers(),
    listActiveRewards(),
  ]);
  const enabled = loyaltyEnabled(business.flags, program);
  return (
    <div className="container-x py-10 sm:py-14">
      <header className="max-w-2xl">
        <p className="eyebrow mb-2">Club El Pan de Paula</p>
        <h1 className="display text-4xl sm:text-5xl">Cada compra suma</h1>
        <p className="mt-4 text-lg text-ink-2">
          Nuestro programa de clientes frecuentes es sencillo: te registras una vez, acumulas puntos
          con cada compra y los canjeas por pan.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/unete" className="btn btn-primary btn-lg">
            Quiero mi tarjeta
          </Link>
          <Link href="/menu" className="btn btn-secondary btn-lg">
            Ver menú
          </Link>
        </div>
      </header>

      {enabled ? (
        <>
          <section className="mt-12" aria-labelledby="puntos">
            <h2 id="puntos" className="display text-3xl">
              Cómo ganas puntos
            </h2>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div className="card p-5">
                <p className="font-display text-4xl text-sage">{program.pointsPerUnit}</p>
                <p className="mt-1 text-sm text-ink">
                  {program.pointsPerUnit === 1 ? "punto" : "puntos"} por cada{" "}
                  {money(program.unitCents, true)} de compra
                </p>
                {program.minPurchaseCents > 0 && (
                  <p className="text-xs text-ink-2">
                    Compras desde {money(program.minPurchaseCents, true)}.
                  </p>
                )}
              </div>
              <div className="card p-5">
                <p className="font-display text-4xl text-crust">×{program.birthdayMultiplier}</p>
                <p className="mt-1 text-sm text-ink">en tu cumpleaños (si nos lo compartes)</p>
              </div>
              <div className="card p-5">
                <p className="font-display text-4xl text-wine">
                  {program.pointsExpireDays ? `${program.pointsExpireDays} días` : "Nunca"}
                </p>
                <p className="mt-1 text-sm text-ink">
                  {program.pointsExpireDays ? "de vigencia de tus puntos" : "caducan tus puntos"}
                </p>
              </div>
            </div>
          </section>

          <section className="mt-12" aria-labelledby="niveles">
            <h2 id="niveles" className="display text-3xl">
              Niveles
            </h2>
            <ol className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {tiers.map((t) => (
                <li key={t.key} className="card flex flex-col p-5">
                  <span
                    className={`badge self-start ${TIER_TONE[t.color ?? "gray"] ?? TIER_TONE.gray}`}
                  >
                    Nivel {t.rank}
                  </span>
                  <h3 className="mt-3 font-display text-2xl text-ink">{t.name}</h3>
                  <p className="mt-1 text-sm text-ink-2">
                    {t.minOrders === 0 && t.minSpentCents === 0
                      ? "Desde tu registro."
                      : `Desde ${t.minOrders} ${t.minOrders === 1 ? "compra" : "compras"}${t.minSpentCents > 0 ? ` y ${money(t.minSpentCents, true)} acumulados` : ""}.`}
                  </p>
                  {t.perks && <p className="mt-3 text-sm text-ink">{t.perks}</p>}
                </li>
              ))}
            </ol>
          </section>

          {rewards.length > 0 && (
            <section className="mt-12" aria-labelledby="recompensas">
              <h2 id="recompensas" className="display text-3xl">
                Recompensas vigentes
              </h2>
              <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {rewards.map((r) => (
                  <li key={r.id} className="card flex items-start justify-between gap-4 p-5">
                    <div>
                      <h3 className="font-display text-xl text-ink">{r.name}</h3>
                      {r.description && <p className="mt-1 text-sm text-ink-2">{r.description}</p>}
                      {r.minTierKey && (
                        <p className="mt-2 text-xs text-ink-2">
                          Disponible desde el nivel{" "}
                          {tiers.find((t) => t.key === r.minTierKey)?.name ?? r.minTierKey}.
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-pill bg-ink px-3 py-1 text-sm font-semibold text-cream">
                      {r.pointsCost} pts
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-ink-2">
                Los canjes se realizan en la panadería mostrando tu tarjeta o código.
              </p>
            </section>
          )}
        </>
      ) : (
        <section className="card mt-12 p-8">
          <h2 className="font-display text-2xl text-ink">El programa de puntos está en pausa</h2>
          <p className="mt-2 text-ink-2">
            Puedes registrarte desde ahora para recibir tu tarjeta; te avisaremos cuando activemos
            las recompensas.
          </p>
        </section>
      )}
    </div>
  );
}
