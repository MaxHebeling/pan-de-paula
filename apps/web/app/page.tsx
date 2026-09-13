import Link from "next/link";
import type { Metadata } from "next";
import { WEEKDAY_LABELS, formatLocalDate } from "@pdp/domain";
import { CategoryRail } from "@/components/CategoryRail";
import { ClubCard } from "@/components/ClubCard";
import { Hero } from "@/components/Hero";
import { HowToOrder } from "@/components/HowToOrder";
import { Process } from "@/components/Process";
import { ProductCard } from "@/components/ProductCard";
import { Reveal } from "@/components/Reveal";
import { Section } from "@/components/Section";
import { listCategories, listFeatured, listPromos } from "@/lib/catalog";
import { FULFILLMENT_LABELS, capitalize, hour12, hourRange } from "@/lib/format";
import { qrDataUrl } from "@/lib/qr";
import { fulfillmentOptions, fullAddress, getBusiness, openStatus } from "@/lib/site";
import { getStoryPhotos } from "@/lib/storyPhotos";

export const metadata: Metadata = {
  title: "El Pan de Paula · Panadería artesanal",
  description:
    "Croissants de mantequilla, roles de canela, galletas y pan dulce hechos a mano. Pide en línea y recoge en tu fecha.",
  alternates: { canonical: "/" },
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default async function HomePage() {
  const business = await getBusiness();
  const joinUrl = `${SITE_URL}/unete`;
  const [featured, categories, promos, joinQr] = await Promise.all([
    listFeatured(6),
    listCategories(),
    listPromos(4),
    qrDataUrl(joinUrl, 256),
  ]);
  const status = openStatus(business);
  const options = fulfillmentOptions(business);
  const address = fullAddress(business);
  const point = business.pickupPoints[0];
  const openDays = business.hours.filter((h) => h.isOpen && h.opensAt && h.closesAt);
  const storyPhotos = getStoryPhotos();

  return (
    <>
      <Hero status={status} />

      {/* Favoritos de la casa */}
      {featured.length > 0 && (
        <Section
          id="destacados"
          eyebrow="Favoritos de la casa"
          title="Lo que más se pide"
          action={{ href: "/menu", label: "Ver todo el menú" }}
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((p, i) => (
              <Reveal key={p.id} delay={(i % 3) * 90} className="h-full">
                <ProductCard p={p} priority={i < 2} />
              </Reveal>
            ))}
          </div>
        </Section>
      )}

      {/* Categorías */}
      {categories.length > 0 && (
        <Section id="categorias" eyebrow="Explora" title="Nuestro menú por categorías">
          <Reveal variant="fade">
            <CategoryRail categories={categories} />
          </Reveal>
        </Section>
      )}

      {/* Del horno a tu mesa */}
      <Process photos={storyPhotos} />

      {/* Cómo pedir */}
      <HowToOrder />

      {/* Próximas fechas */}
      <Section
        id="fechas"
        eyebrow="Calendario"
        title="Próximas fechas de entrega"
        intro="Pide antes de la hora límite y tu pan sale del horno ese día."
      >
        {options.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-2" data-reveal-group="80">
            {options.map((o, i) => {
              const featuredDate = i === 0;
              return (
                <Reveal
                  as="li"
                  key={`${o.windowId}-${o.date}`}
                  className={`card relative flex flex-col gap-2 p-5 ${featuredDate ? "date-featured" : ""}`}
                  data-testid="fulfillment-option"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="eyebrow">
                      {FULFILLMENT_LABELS[o.fulfillmentType] ?? o.windowName}
                    </p>
                    {featuredDate && (
                      <span className="badge bg-sage text-white">Próxima fecha</span>
                    )}
                  </div>
                  <p className={`font-display text-ink ${featuredDate ? "text-3xl" : "text-2xl"}`}>
                    {capitalize(formatLocalDate(o.date))}
                  </p>
                  {(o.from || o.to) && (
                    <p className="text-sm text-ink-2">
                      Horario de recolección: {hourRange(o.from, o.to)}
                    </p>
                  )}
                  <p className="text-sm text-ink-2">
                    Pide antes del{" "}
                    <strong className="text-ink">{formatLocalDate(o.orderBy.date)}</strong> a las{" "}
                    <strong className="text-ink">{hour12(o.orderBy.time)}</strong>
                  </p>
                  <Link
                    href="/menu"
                    className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-sage hover:underline"
                  >
                    Pedir para esta fecha
                    <svg
                      className="btn-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                </Reveal>
              );
            })}
          </ul>
        ) : (
          <div className="card p-6 text-ink-2">
            Por ahora no tenemos fechas abiertas para pedidos en línea. Escríbenos por Instagram o
            WhatsApp y con gusto te ayudamos.
          </div>
        )}
      </Section>

      {/* Promociones vigentes */}
      {promos.length > 0 && (
        <Section
          id="promos"
          eyebrow="Por tiempo limitado"
          title="Promociones vigentes"
          className="bg-cream-2/50"
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {promos.map((p, i) => (
              <Reveal key={p.id} delay={(i % 4) * 80} className="h-full">
                <ProductCard p={p} />
              </Reveal>
            ))}
          </div>
        </Section>
      )}

      {/* Horarios y ubicación */}
      <Section id="visitanos" eyebrow="Visítanos" title="Horarios y ubicación">
        <div className="grid gap-5 md:grid-cols-2">
          <Reveal className="card p-6">
            <h3 className="font-display text-xl text-ink">Horario de la panadería</h3>
            {openDays.length > 0 ? (
              <ul className="mt-4 space-y-1.5 text-sm">
                {business.hours.map((h) => (
                  <li
                    key={h.weekday}
                    className="flex justify-between gap-4 border-b border-line/60 py-1.5 last:border-0"
                  >
                    <span>{WEEKDAY_LABELS[h.weekday]}</span>
                    <span className={`tabular-nums ${h.isOpen ? "text-ink" : "text-ink-2"}`}>
                      {h.isOpen && h.opensAt && h.closesAt
                        ? hourRange(h.opensAt, h.closesAt)
                        : "Cerrado"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-ink-2">Horarios por confirmar.</p>
            )}
          </Reveal>
          <Reveal delay={90} className="card p-6">
            <h3 className="font-display text-xl text-ink">
              {point?.name ?? "Punto de recolección"}
            </h3>
            <p className="mt-3 text-sm text-ink-2">
              {point?.address && point.address !== "Dirección por configurar"
                ? point.address
                : (address ?? "Te compartimos la dirección exacta al confirmar tu pedido.")}
            </p>
            {point?.notes && <p className="mt-2 text-sm text-ink-2">{point.notes}</p>}
            <div className="mt-4 flex flex-wrap gap-3">
              <Link href="/ubicacion" className="btn btn-secondary">
                Cómo llegar
              </Link>
              {business.instagramHandle && (
                <a
                  href={`https://www.instagram.com/${business.instagramHandle}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost"
                >
                  Instagram @{business.instagramHandle}
                </a>
              )}
            </div>
          </Reveal>
        </div>
      </Section>

      {/* Instagram */}
      {business.instagramHandle && (
        <section className="container-x pb-8" aria-labelledby="ig-title">
          <Reveal className="card flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center sm:p-8">
            <div>
              <p className="eyebrow mb-1">Instagram</p>
              <h2 id="ig-title" className="display text-2xl sm:text-3xl">
                Lo que sale del horno, cada día
              </h2>
              <p className="mt-2 text-sm text-ink-2">
                Temporadas, novedades y el pan del día en @{business.instagramHandle}.
              </p>
            </div>
            <a
              href={`https://www.instagram.com/${business.instagramHandle}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-lg shrink-0"
            >
              Seguir @{business.instagramHandle}
            </a>
          </Reveal>
        </section>
      )}

      {/* Club */}
      <section className="container-x pb-8" aria-labelledby="club-title">
        <Reveal
          variant="fade"
          className="card relative overflow-hidden bg-ink p-8 text-cream sm:p-12"
        >
          <div
            className="absolute -top-10 -right-10 h-48 w-48 rounded-full bg-crust/30 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="eyebrow text-crust-2">Club El Pan de Paula</p>
              <h2 id="club-title" className="display mt-2 text-3xl text-cream sm:text-4xl">
                Únete al club y acumula puntos en cada compra
              </h2>
              <p className="mt-3 max-w-xl text-cream/80">
                Regístrate en 30 segundos, recibe tu tarjeta digital con QR y canjea recompensas en
                la panadería.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/unete" className="btn btn-lg bg-cream text-ink hover:bg-paper">
                  Quiero unirme
                  <svg
                    className="btn-icon"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
                <Link
                  href="/club"
                  className="btn btn-lg border border-cream/40 text-cream hover:bg-cream/10"
                >
                  Conocer el programa
                </Link>
              </div>
            </div>
            <Reveal variant="card" delay={150} className="md:justify-self-end">
              <ClubCard qrDataUrl={joinQr} joinUrl={joinUrl} />
            </Reveal>
          </div>
        </Reveal>
      </section>
    </>
  );
}
