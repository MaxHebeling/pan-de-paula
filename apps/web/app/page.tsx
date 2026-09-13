import type { Metadata } from "next";
import { CategoryExperience } from "@/components/cinematic/CategoryExperience";
import { CinematicCTA } from "@/components/cinematic/CinematicCTA";
import { CinematicHero } from "@/components/cinematic/CinematicHero";
import { ClubSection } from "@/components/cinematic/ClubSection";
import { EditorialStatement } from "@/components/cinematic/EditorialStatement";
import { Marquee } from "@/components/cinematic/Marquee";
import { NextDate } from "@/components/cinematic/NextDate";
import { productPhoto } from "@/components/cinematic/photos";
import { ProductShowcase } from "@/components/cinematic/ProductShowcase";
import { ScrollProgress } from "@/components/cinematic/ScrollProgress";
import { SectionHeading } from "@/components/cinematic/SectionHeading";
import { StickyStory } from "@/components/cinematic/StickyStory";
import { Timeline } from "@/components/cinematic/Timeline";
import { VisitUs } from "@/components/cinematic/VisitUs";
import { CinLink } from "@/components/cinematic/Button";
import { ProductCard } from "@/components/ProductCard";
import { Reveal } from "@/components/Reveal";
import { listCategories, listFeatured, listProducts, listPromos } from "@/lib/catalog";
import { getProgram, listActiveRewards, listTiers, loyaltyEnabled } from "@/lib/loyalty";
import { mercadoPagoAvailable } from "@/lib/orders";
import { qrDataUrl } from "@/lib/qr";
import { fulfillmentOptions, fullAddress, getBusiness, nowFor, openStatus } from "@/lib/site";
import { getStoryPhotos } from "@/lib/storyPhotos";

export const metadata: Metadata = {
  title: "El Pan de Paula · Panadería artesanal",
  description:
    "Croissants de mantequilla, roles de canela, galletas y pan dulce hechos a mano. Pide en línea y recoge en tu fecha.",
  alternates: { canonical: "/" },
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const CATALOG_LIMIT = 8;

/** Métodos de pago que el checkout ofrece hoy (misma regla que app/checkout/page.tsx), en una frase. */
function paymentSentence(online: boolean, transfer: boolean): string {
  const ways = [online && "en línea", "al recoger", transfer && "por transferencia"].filter(
    (w): w is string => Boolean(w),
  );
  const list = ways.length > 1 ? `${ways.slice(0, -1).join(", ")} o ${ways.at(-1)}` : ways[0];
  return `Paga ${list}.`;
}

/**
 * Home cinematográfico. Solo compone datos reales con las funciones de lib/ (sin lógica nueva de precios,
 * fechas ni catálogo) y los entrega a componentes de components/cinematic. El movimiento vive en CSS
 * (app/motion.css) y en lib/motion; esta página no declara animaciones.
 */
export default async function HomePage() {
  const business = await getBusiness();
  const joinUrl = `${SITE_URL}/unete`;
  const [featured, categories, products, promos, joinQr, program, rewards, tiers] =
    await Promise.all([
      listFeatured(6),
      listCategories(),
      listProducts(),
      listPromos(4),
      qrDataUrl(joinUrl, 256),
      getProgram(),
      listActiveRewards(),
      listTiers(),
    ]);
  const status = openStatus(business);
  const options = fulfillmentOptions(business);
  const next = options[0] ? { date: options[0].date, orderBy: options[0].orderBy } : null;
  const clubOn = loyaltyEnabled(business.flags, program);

  // Estrella: primero los que tienen fotografía real, sin cambiar el orden relativo del catálogo.
  const showcase = [...featured].sort(
    (a, b) => Number(Boolean(productPhoto(b))) - Number(Boolean(productPhoto(a))),
  );
  // Catálogo: promociones vigentes primero y después el resto, sin repetir los productos estrella.
  const shown = new Set(featured.map((p) => p.id));
  const catalog = [...promos, ...products]
    .filter((p) => (shown.has(p.id) ? false : (shown.add(p.id), true)))
    .slice(0, CATALOG_LIMIT);

  return (
    <>
      <ScrollProgress />
      <CinematicHero status={status} next={next} />
      <EditorialStatement />
      <Marquee />
      <ProductShowcase products={showcase} />
      <CategoryExperience categories={categories} />
      <StickyStory photos={getStoryPhotos()} />

      {catalog.length > 0 && (
        <section id="catalogo" className="cin-section" aria-labelledby="catalogo-title">
          <div className="cin-wrap">
            <SectionHeading
              id="catalogo-title"
              index="05"
              eyebrow={promos.length > 0 ? "Promociones y más" : "Del mostrador"}
              title="Más para tu pedido"
            >
              <CinLink href="/menu" variant="secondary">
                Ver todo el menú
              </CinLink>
            </SectionHeading>
            <div className="cin-catalog-grid" data-reveal-group="70">
              {catalog.map((p) => (
                <Reveal key={p.id} className="h-full">
                  <ProductCard p={p} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      <Timeline
        payment={paymentSentence(
          mercadoPagoAvailable(business.flags),
          Boolean(business.policies.transfer_instructions),
        )}
      />
      <NextDate options={options} />
      <VisitUs
        status={status}
        hours={business.hours}
        today={nowFor(business).weekday}
        point={business.pickupPoints[0]}
        address={fullAddress(business)}
        instagram={business.instagramHandle}
      />
      <ClubSection
        qrDataUrl={joinQr}
        joinUrl={joinUrl}
        program={clubOn ? program : null}
        rewards={clubOn ? rewards : []}
        tierCount={clubOn ? tiers.length : 0}
      />
      <CinematicCTA next={next} />
    </>
  );
}
