import Link from "next/link";
import type { Metadata } from "next";
import { WEEKDAY_LABELS, formatLocalDate } from "@pdp/domain";
import { Logo } from "@/components/Logo";
import { ProductCard } from "@/components/ProductCard";
import { ProductArt } from "@/components/ProductArt";
import { Section } from "@/components/Section";
import { listCategories, listFeatured, listPromos } from "@/lib/catalog";
import { FULFILLMENT_LABELS, capitalize, hour12, hourRange } from "@/lib/format";
import { fulfillmentOptions, fullAddress, getBusiness, openStatus } from "@/lib/site";

export const metadata: Metadata = {
  title: "El Pan de Paula · Panadería artesanal",
  description:
    "Croissants de mantequilla, roles de canela, galletas y pan dulce hechos a mano. Pide en línea y recoge en tu fecha.",
  alternates: { canonical: "/" },
};

export default async function HomePage() {
  const business = await getBusiness();
  const [featured, categories, promos] = await Promise.all([listFeatured(6), listCategories(), listPromos(4)]);
  const status = openStatus(business);
  const options = fulfillmentOptions(business);
  const address = fullAddress(business);
  const point = business.pickupPoints[0];
  const openDays = business.hours.filter((h) => h.isOpen && h.opensAt && h.closesAt);

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="container-x grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="reveal">
            <p className="eyebrow mb-4">Boulangerie · Made with love</p>
            <h1 className="display text-4xl leading-[1.05] sm:text-5xl lg:text-6xl">
              Pan recién horneado,
              <br />
              <span className="text-sage">hecho a mano</span> para tu mesa.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">
              Croissants de mantequilla, roles de canela y galletas que salen del horno el mismo día que los
              recoges. Pide en línea; nosotros horneamos para tu fecha.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/menu" className="btn btn-primary btn-lg" data-testid="cta-menu">
                Ver menú
              </Link>
              <Link href="/menu" className="btn btn-secondary btn-lg">
                Pedir ahora
              </Link>
            </div>
            <p className="mt-6 inline-flex items-center gap-2 rounded-pill border border-line bg-paper/80 px-4 py-2 text-sm" data-testid="open-status">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${status.open ? "bg-sage" : "bg-crust"}`}
                aria-hidden="true"
              />
              {status.open ? (
                <span>
                  <strong className="font-semibold">Abierto ahora</strong>
                  {status.closesAt && <span className="text-ink-2"> · cerramos a las {hour12(status.closesAt)}</span>}
                </span>
              ) : (
                <span>
                  <strong className="font-semibold">Cerrado</strong>
                  <span className="text-ink-2">
                    {" "}
                    · {status.opensAt && status.reason?.startsWith("Abrimos") ? `abrimos a las ${hour12(status.opensAt)}` : status.reason?.toLowerCase()}
                  </span>
                </span>
              )}
            </p>
          </div>
          <div className="reveal reveal-2 relative mx-auto w-full max-w-sm lg:max-w-md">
            <div className="absolute -inset-6 rounded-full bg-crust/15 blur-2xl" aria-hidden="true" />
            <div className="card relative aspect-square overflow-hidden rounded-full p-6">
              <Logo size={480} priority className="h-full w-full" />
            </div>
          </div>
        </div>
      </section>

      {/* Destacados */}
      {featured.length > 0 && (
        <Section id="destacados" eyebrow="Favoritos de la casa" title="Lo que más se pide" action={{ href: "/menu", label: "Ver todo el menú" }}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((p, i) => (
              <ProductCard key={p.id} p={p} priority={i < 2} />
            ))}
          </div>
        </Section>
      )}

      {/* Categorías */}
      {categories.length > 0 && (
        <Section id="categorias" eyebrow="Explora" title="Nuestro menú por categorías">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/menu/${c.slug}`}
                  className="card lift flex min-h-24 items-center gap-3 p-4 transition hover:border-sage/40"
                >
                  <span className="h-12 w-12 shrink-0 overflow-hidden rounded-full">
                    <ProductArt name={c.name} seed={c.slug} className="h-full w-full" />
                  </span>
                  <span>
                    <span className="block font-display text-lg text-ink">{c.name}</span>
                    <span className="text-xs text-ink-2">
                      {c.productCount} {c.productCount === 1 ? "producto" : "productos"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Cómo pedir */}
      <Section id="como-pedir" eyebrow="Así de fácil" title="Cómo pedir" className="bg-cream-2/50">
        <ol className="grid gap-5 md:grid-cols-3">
          {[
            ["Elige tu pan", "Arma tu pedido desde el menú: croissants, roles, galletas y más."],
            ["Escoge tu fecha", "Te mostramos las próximas fechas disponibles para recoger. Horneamos ese día."],
            ["Recoge y disfruta", "Paga en línea, al recoger o por transferencia. Te avisamos cuando esté listo."],
          ].map(([title, body], i) => (
            <li key={title} className="card p-6">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-sage font-display text-lg text-white">
                {i + 1}
              </span>
              <h3 className="mt-4 font-display text-xl text-ink">{title}</h3>
              <p className="mt-2 text-sm text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* Próximas fechas */}
      <Section id="fechas" eyebrow="Calendario" title="Próximas fechas de entrega" intro="Pide antes de la hora límite y tu pan sale del horno ese día.">
        {options.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {options.map((o) => (
              <li key={`${o.windowId}-${o.date}`} className="card flex flex-col gap-2 p-5" data-testid="fulfillment-option">
                <p className="eyebrow">{FULFILLMENT_LABELS[o.fulfillmentType] ?? o.windowName}</p>
                <p className="font-display text-2xl text-ink">{capitalize(formatLocalDate(o.date))}</p>
                {(o.from || o.to) && <p className="text-sm text-ink-2">Horario de recolección: {hourRange(o.from, o.to)}</p>}
                <p className="text-sm text-ink-2">
                  Pide antes del <strong className="text-ink">{formatLocalDate(o.orderBy.date)}</strong> a las{" "}
                  <strong className="text-ink">{hour12(o.orderBy.time)}</strong>.
                </p>
                <Link href="/menu" className="mt-2 text-sm font-medium text-sage hover:underline">
                  Pedir para esta fecha →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card p-6 text-ink-2">
            Por ahora no tenemos fechas abiertas para pedidos en línea. Escríbenos por Instagram o WhatsApp y con gusto te
            ayudamos.
          </div>
        )}
      </Section>

      {/* Promociones vigentes */}
      {promos.length > 0 && (
        <Section id="promos" eyebrow="Por tiempo limitado" title="Promociones vigentes" className="bg-cream-2/50">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {promos.map((p) => (
              <ProductCard key={p.id} p={p} />
            ))}
          </div>
        </Section>
      )}

      {/* Horarios y ubicación */}
      <Section id="visitanos" eyebrow="Visítanos" title="Horarios y ubicación">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="card p-6">
            <h3 className="font-display text-xl text-ink">Horario de la panadería</h3>
            {openDays.length > 0 ? (
              <ul className="mt-4 space-y-1.5 text-sm">
                {business.hours.map((h) => (
                  <li key={h.weekday} className="flex justify-between gap-4 border-b border-line/60 py-1.5 last:border-0">
                    <span>{WEEKDAY_LABELS[h.weekday]}</span>
                    <span className={`tabular-nums ${h.isOpen ? "text-ink" : "text-ink-2"}`}>
                      {h.isOpen && h.opensAt && h.closesAt ? hourRange(h.opensAt, h.closesAt) : "Cerrado"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-ink-2">Horarios por confirmar.</p>
            )}
          </div>
          <div className="card p-6">
            <h3 className="font-display text-xl text-ink">{point?.name ?? "Punto de recolección"}</h3>
            <p className="mt-3 text-sm text-ink-2">
              {point?.address && point.address !== "Dirección por configurar" ? point.address : (address ?? "Te compartimos la dirección exacta al confirmar tu pedido.")}
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
          </div>
        </div>
      </Section>

      {/* Club */}
      <section className="container-x pb-8">
        <div className="card relative overflow-hidden bg-ink p-8 text-cream sm:p-12">
          <div className="absolute -top-10 -right-10 h-48 w-48 rounded-full bg-crust/30 blur-3xl" aria-hidden="true" />
          <div className="relative grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="eyebrow text-crust-2">Club El Pan de Paula</p>
              <h2 className="display mt-2 text-3xl text-cream sm:text-4xl">Únete al club y acumula puntos en cada compra</h2>
              <p className="mt-3 max-w-xl text-cream/80">
                Regístrate en 30 segundos, recibe tu tarjeta digital con QR y canjea recompensas en la panadería.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/unete" className="btn btn-lg bg-cream text-ink hover:bg-paper">
                Quiero unirme
              </Link>
              <Link href="/club" className="btn btn-lg border border-cream/40 text-cream hover:bg-cream/10">
                Conocer el programa
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
