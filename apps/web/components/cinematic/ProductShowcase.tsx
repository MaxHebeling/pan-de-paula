import Image from "next/image";
import Link from "next/link";
import { availability } from "@/lib/availability";
import type { CatalogProduct } from "@/lib/catalog";
import { AddToCart } from "../AddToCart";
import { Badges } from "../Badges";
import { Price } from "../Price";
import { Reveal } from "../Reveal";
import { CinLink } from "./Button";
import { Plate } from "./Plate";
import { productPhoto } from "./photos";
import { SectionHeading } from "./SectionHeading";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Productos estrella (`is_featured`) como showcase editorial 01/02/03…: foto grande (o plato tipográfico),
 * nombre, descripción corta, precio web vigente y "Agregar" con la lógica de carrito de siempre.
 * Desktop: filas alternadas con la foto en parallax sutil. Tablet: dos columnas. Móvil: fila con swipe nativo.
 * Nunca secuestra el scroll ni anima precios ni botones.
 */
export function ProductShowcase({ products }: { products: CatalogProduct[] }) {
  if (products.length === 0) return null;
  return (
    <section id="destacados" className="cin-section" aria-labelledby="destacados-title">
      <div className="cin-wrap">
        <SectionHeading
          id="destacados-title"
          index="02"
          eyebrow="Productos estrella"
          title="Los que más se piden"
          intro="Los favoritos de la casa, con su precio de hoy."
        >
          <CinLink href="/menu" variant="text">
            Ver todo el menú
          </CinLink>
        </SectionHeading>

        <ol className="cin-showcase-list" aria-label="Productos estrella">
          {products.map((p, i) => {
            const av = availability(p);
            const photo = productPhoto(p);
            const href = `/producto/${p.slug}`;
            return (
              <li
                key={p.id}
                className="cin-showcase-item"
                data-testid="product-card"
                data-product-card
              >
                <Reveal variant="fade" className="cin-showcase-media">
                  <Link
                    href={href}
                    aria-hidden="true"
                    tabIndex={-1}
                    className="absolute inset-0 block"
                  >
                    {photo ? (
                      <span className="cin-showcase-parallax block" data-parallax="0.05">
                        <span className="card-img-wrap cin-reveal-media absolute inset-0 block">
                          <Image
                            src={photo.src}
                            alt={photo.alt}
                            fill
                            sizes="(min-width: 1024px) 55vw, (min-width: 768px) 46vw, 84vw"
                            className="cin-showcase-img"
                          />
                        </span>
                      </span>
                    ) : (
                      <span className="card-img-wrap absolute inset-0 block">
                        <Plate
                          name={p.name}
                          seed={p.slug}
                          tone={i}
                          top={p.categoryName ?? undefined}
                        />
                      </span>
                    )}
                  </Link>
                  <Badges
                    badges={av.badges}
                    className="pointer-events-none absolute top-3 left-3"
                  />
                </Reveal>

                <Reveal className="cin-showcase-body" delay={120}>
                  <p className="cin-showcase-num" aria-hidden="true">
                    {pad(i + 1)}
                  </p>
                  {p.categoryName && <p className="cin-showcase-cat">{p.categoryName}</p>}
                  <h3 className="cin-showcase-name">
                    <Link href={href}>{p.name}</Link>
                  </h3>
                  {p.shortDescription && <p className="cin-showcase-desc">{p.shortDescription}</p>}
                  <div className="cin-showcase-buy">
                    <Price cents={p.priceCents} regularCents={p.regularPriceCents} size="lg" />
                    {av.canAdd ? (
                      <span className="cin-add card-cta inline-flex rounded-pill">
                        <AddToCart
                          compact
                          product={{
                            productId: p.id,
                            slug: p.slug,
                            name: p.name,
                            variantLabel: p.variantLabel,
                            unitPriceCents: p.priceCents ?? 0,
                            imageUrl: p.primaryImageUrl,
                            categorySlug: p.categorySlug,
                          }}
                        />
                      </span>
                    ) : (
                      <span className="text-sm text-ink-2">No disponible</span>
                    )}
                  </div>
                  {av.note && <p className="mt-3 text-sm text-ink-2">{av.note}</p>}
                </Reveal>
              </li>
            );
          })}
        </ol>
        {products.length > 1 && (
          <p className="cin-swipe-hint" aria-hidden="true">
            <span>Desliza para ver los {products.length}</span>
            <span>→</span>
          </p>
        )}
      </div>
    </section>
  );
}
