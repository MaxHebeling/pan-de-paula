import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveTier, tierProgress } from "@pdp/domain";
import { Logo } from "@/components/Logo";
import { CopyLinkButton, SaveQrButton } from "@/components/QrCard";
import { findCustomerByQrToken } from "@/lib/customers";
import { money } from "@/lib/format";
import { getProgram, listActiveRewards, listTiers, loyaltyEnabled } from "@/lib/loyalty";
import { cardUrl, qrDataUrl } from "@/lib/qr";
import { getBusiness } from "@/lib/site";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Mi tarjeta", robots: { index: false, follow: false } };

export default async function CardPage({ params, searchParams }: Props) {
  const { token } = await params;
  const sp = await searchParams;
  const customer = await findCustomerByQrToken(token);
  if (!customer) notFound();
  const [business, program, tiers, rewards] = await Promise.all([
    getBusiness(),
    getProgram(),
    listTiers(),
    listActiveRewards(),
  ]);
  const enabled = loyaltyEnabled(business.flags, program);
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
  const welcome = sp.bienvenida === "1";
  const firstName = customer.fullName.split(/\s+/)[0] ?? customer.fullName;
  const affordable = rewards.filter((r) => r.pointsCost <= customer.pointsBalance);

  return (
    <div className="container-x max-w-3xl py-10 sm:py-14">
      {welcome && (
        <p
          className="mb-6 rounded-card border border-sage/40 bg-sage/10 px-4 py-3 text-sm text-ink"
          role="status"
          data-testid="welcome"
        >
          ¡Bienvenido al club, {firstName}! Guarda esta página o descarga tu QR: es tu tarjeta.
        </p>
      )}
      <div className="card card-enter overflow-hidden">
        <div className="flex items-center justify-between gap-4 bg-ink px-6 py-5 text-cream">
          <div>
            <p className="eyebrow text-crust-2">Club El Pan de Paula</p>
            <p className="font-display text-2xl" data-testid="card-name">
              {customer.fullName}
            </p>
            <p
              className="mt-1 font-mono text-sm tracking-widest text-cream/80"
              data-testid="card-code"
            >
              {customer.publicCode}
            </p>
          </div>
          <Logo size={56} />
        </div>
        <div className="grid gap-6 p-6 sm:grid-cols-[220px_1fr] sm:items-center">
          <div className="mx-auto w-[220px] rounded-card border border-line bg-paper p-3">
            <Image
              src={qr}
              alt={`QR de la tarjeta ${customer.publicCode}`}
              width={200}
              height={200}
              unoptimized
              className="h-auto w-full"
              data-testid="card-qr"
            />
          </div>
          <div>
            {enabled ? (
              <>
                <p className="text-sm text-ink-2">Tus puntos</p>
                <p className="font-display text-5xl text-ink" data-testid="card-points">
                  {customer.pointsBalance}
                </p>
                <p className="mt-2 text-sm text-ink">
                  Nivel <strong>{current?.name ?? "Nuevo"}</strong>
                  {current?.perks ? <span className="text-ink-2"> · {current.perks}</span> : null}
                </p>
                {progress && (
                  <div className="mt-3">
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
                      aria-valuenow={Math.round(progressPct(stats, progress))}
                    >
                      <div
                        className="h-full rounded-pill bg-sage transition-[width]"
                        style={{ width: `${progressPct(stats, progress)}%` }}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-ink-2">
                Muestra este QR en la panadería para identificarte y recibir tus beneficios.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 border-t border-line px-6 py-4">
          <SaveQrButton dataUrl={qr} fileName={`tarjeta-${customer.publicCode}.png`} />
          <CopyLinkButton url={url} />
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-display text-xl text-ink">Cómo usarla</h2>
          <ul className="mt-3 space-y-2 text-sm text-ink-2">
            <li>En la panadería: muestra el QR o di tu código al pagar.</li>
            <li>En línea: en el checkout marca “Ya soy cliente” y escribe tu teléfono o código.</li>
            <li>Guarda este enlace: es personal y no requiere contraseña.</li>
          </ul>
        </section>
        {enabled && rewards.length > 0 && (
          <section className="card p-5">
            <h2 className="font-display text-xl text-ink">Recompensas</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {rewards.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3">
                  <span className={affordable.includes(r) ? "text-ink" : "text-ink-2"}>
                    {r.name}
                  </span>
                  <span className="shrink-0 rounded-pill bg-cream-2 px-2.5 py-0.5 text-xs font-semibold text-ink">
                    {r.pointsCost} pts
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-2">
              Los canjes se hacen en la panadería mostrando tu tarjeta.
            </p>
          </section>
        )}
      </div>
      <p className="mt-8 text-center text-sm text-ink-2">
        <Link href="/portal/entrar" className="text-sage underline">
          Entrar a mi cuenta
        </Link>{" "}
        para ver tus compras y tus movimientos de puntos ·{" "}
        <Link href="/menu" className="text-sage underline">
          Ver menú y pedir
        </Link>
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
