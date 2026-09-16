import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveTier, tierProgress } from "@pdp/domain";
import { CopyLinkButton, SaveQrButton } from "@/components/QrCard";
import { TierBadge, tierPalette } from "@/components/portal/TierBadge";
import { dateMX, money } from "@/lib/format";
import { getProgram, listTiers, loyaltyEnabled } from "@/lib/loyalty";
import { getPortalCustomer, listPortalPurchases } from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { cardUrl, qrDataUrl } from "@/lib/qr";
import { getBusiness } from "@/lib/site";

export default async function PortalHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCustomerSession();
  const sp = await searchParams;
  const customer = await getPortalCustomer(session.customer.id);
  if (!customer) notFound();

  const [business, program, tiers, purchases] = await Promise.all([
    getBusiness(),
    getProgram(),
    listTiers(),
    listPortalPurchases(customer.id, 3),
  ]);
  const enabled = loyaltyEnabled(business.flags, program);

  // El QR es EXACTAMENTE el mismo de /mi-tarjeta: mismo qr_token, misma URL, mismo generador.
  const url = cardUrl(customer.qrToken);
  const qr = await qrDataUrl(url);

  const stats = {
    totalOrders: customer.totalOrders,
    totalSpentCents: customer.totalSpentCents,
    lifetimePoints: customer.lifetimePoints,
  };
  const resolved = resolveTier(tiers, stats);
  const current = tiers.find((t) => t.key === (customer.tierKey ?? resolved?.key)) ?? null;
  const progress = tierProgress(tiers, current, stats);
  const pct = progress ? progressPct(stats, progress) : 100;
  // tierProgress devuelve el nivel puro de @pdp/domain (sin color): el color real vive en loyalty_tiers.
  const nextColor = progress
    ? (tiers.find((t) => t.key === progress.next.key)?.color ?? null)
    : null;
  const welcome = sp.bienvenida === "1";

  return (
    <div className="space-y-6">
      {welcome && (
        <p
          className="rounded-card border border-sage/40 bg-sage/10 px-4 py-3 text-sm text-ink"
          role="status"
          data-testid="portal-bienvenida"
        >
          Entraste a tu cuenta. Aquí vive tu QR, tus puntos y todas tus compras.
        </p>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:p-7">
          <div className="mx-auto w-[200px] shrink-0 rounded-card border border-line bg-paper p-3 sm:mx-0">
            <Image
              src={qr}
              alt={`Código QR de la tarjeta ${customer.publicCode}`}
              width={200}
              height={200}
              unoptimized
              className="h-auto w-full"
              data-testid="portal-qr"
            />
            <p
              className="mt-2 text-center font-mono text-sm tracking-widest text-ink-2"
              data-testid="portal-code"
            >
              {customer.publicCode}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            {current && <TierBadge name={current.name} color={current.color} />}
            {enabled ? (
              <>
                <p className="mt-3 text-sm text-ink-2">Tus puntos</p>
                <p
                  className="font-display text-5xl leading-none text-ink"
                  data-testid="portal-points"
                >
                  {customer.pointsBalance}
                </p>
                {current?.perks && <p className="mt-2 text-sm text-ink-2">{current.perks}</p>}
                {progress && (
                  <div className="mt-4">
                    <p className="text-xs text-ink-2">
                      Para llegar a <strong className="text-ink">{progress.next.name}</strong>:{" "}
                      {progress.ordersLeft > 0
                        ? `${progress.ordersLeft} ${progress.ordersLeft === 1 ? "compra" : "compras"} más`
                        : ""}
                      {progress.ordersLeft > 0 && progress.spendLeftCents > 0 ? " y " : ""}
                      {progress.spendLeftCents > 0
                        ? `${money(progress.spendLeftCents, true)} más en compras`
                        : ""}
                      {progress.ordersLeft === 0 && progress.spendLeftCents === 0
                        ? "¡ya casi!"
                        : ""}
                    </p>
                    <div
                      className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-cream-2"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(pct)}
                      aria-label={`Progreso hacia el nivel ${progress.next.name}`}
                    >
                      <div
                        className="h-full rounded-pill transition-[width]"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: tierPalette(nextColor).ink,
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-3 text-sm text-ink-2">
                Muestra este QR en la panadería para identificarte y recibir tus beneficios.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 border-t border-line px-6 py-4">
          <SaveQrButton dataUrl={qr} fileName={`tarjeta-${customer.publicCode}.png`} />
          <CopyLinkButton url={url} />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Summary label="Compras" value={String(customer.totalOrders)} />
        <Summary label="Total gastado" value={money(customer.totalSpentCents, true)} />
        <Summary
          label="Última compra"
          value={
            customer.lastPurchaseAt
              ? dateMX(customer.lastPurchaseAt, business.timezone)
              : "Todavía ninguna"
          }
          small
        />
      </div>

      <section className="card p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl text-ink">Tus últimas compras</h2>
          {purchases.length > 0 && (
            <Link href="/portal/compras" className="text-sm text-sage underline">
              Ver todas
            </Link>
          )}
        </div>
        {purchases.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">
            Todavía no tienes compras registradas con tu tarjeta. Muestra tu QR al pagar y
            aparecerán aquí.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {purchases.map((p) => (
              <li key={p.folio}>
                <Link
                  href={`/portal/compras/${p.folio}`}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block text-ink">{dateMX(p.soldAt, business.timezone)}</span>
                    <span className="block truncate text-xs text-ink-2">
                      {p.summary || `${p.itemsCount} artículos`}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink">{money(p.totalCents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-center text-sm text-ink-2">
        <Link href="/menu" className="text-sage underline">
          Ver el menú y pedir
        </Link>
      </p>
    </div>
  );
}

function Summary({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs tracking-wide text-ink-2 uppercase">{label}</p>
      <p className={`mt-1 font-display text-ink ${small ? "text-base leading-snug" : "text-2xl"}`}>
        {value}
      </p>
    </div>
  );
}

function progressPct(
  stats: { totalOrders: number; totalSpentCents: number },
  progress: { next: { minOrders: number; minSpentCents: number } },
): number {
  const byOrders = progress.next.minOrders > 0 ? stats.totalOrders / progress.next.minOrders : 1;
  const bySpend =
    progress.next.minSpentCents > 0 ? stats.totalSpentCents / progress.next.minSpentCents : 1;
  return Math.max(0, Math.min(100, Math.min(byOrders, bySpend) * 100));
}
