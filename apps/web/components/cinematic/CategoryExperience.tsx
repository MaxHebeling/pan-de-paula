import Image from "next/image";
import Link from "next/link";
import type { Category } from "@/lib/catalog";
import { Reveal } from "../Reveal";
import { Arrow, CinLink } from "./Button";
import { Plate } from "./Plate";
import { CATEGORY_PHOTOS } from "./photos";
import { SectionHeading } from "./SectionHeading";

const KNOWN_HOST = /^(\/|https:\/\/[a-z0-9-]+\.supabase\.co\/)/i;
const pad = (n: number) => String(n).padStart(2, "0");
/** Una lista tipográfica grande pierde fuerza con muchas filas: se muestran las primeras (orden del admin). */
const MAX_ROWS = 8;

/**
 * Categorías como índice tipográfico grande. Cada fila es un enlace normal a /menu/[categoria]
 * (Tab/Enter, tap en móvil). En desktop, hover o foco cambia la imagen del panel fijo con un crossfade
 * de 320 ms resuelto solo con CSS (:has), sin JavaScript. Sin foto real se muestra un plato tipográfico.
 */
export function CategoryExperience({ categories }: { categories: Category[] }) {
  if (categories.length === 0) return null;
  const list = categories.slice(0, MAX_ROWS);
  const more = categories.length - list.length;
  return (
    <section id="categorias" className="cin-section cin-tint" aria-labelledby="categorias-title">
      <div className="cin-wrap">
        <SectionHeading
          id="categorias-title"
          index="03"
          eyebrow="Explora el menú"
          title="¿Qué se te antoja hoy?"
          intro="Elige una categoría y ve todo lo que tenemos en ella."
        />
        <div className="cin-cats">
          <Reveal as="ol" variant="fade" className="cin-cat-list" aria-label="Categorías del menú">
            {list.map((c, i) => (
              <li key={c.id} className="cin-cat-item">
                <Link href={`/menu/${c.slug}`} className="cin-cat-link" data-testid="category-card">
                  <span className="cin-cat-num" aria-hidden="true">
                    {pad(i + 1)}
                  </span>
                  <span className="cin-cat-name">{c.name}</span>
                  <span className="cin-cat-meta">
                    <span className="cin-cat-count">
                      {c.productCount} {c.productCount === 1 ? "producto" : "productos"}
                    </span>
                    <span className="cin-cat-arrow" aria-hidden="true">
                      <Arrow size={18} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            {more > 0 && (
              <li className="cin-cat-item cin-cat-more">
                <CinLink href="/menu" variant="text">
                  Ver las {categories.length} categorías
                </CinLink>
              </li>
            )}
          </Reveal>

          <div className="cin-cat-preview" aria-hidden="true">
            {list.map((c, i) => {
              const url = c.imageUrl;
              const photo = CATEGORY_PHOTOS[c.slug];
              return (
                <div key={c.id} className="cin-cat-layer">
                  {url ? (
                    <Image
                      src={url}
                      alt=""
                      fill
                      sizes="(min-width: 1024px) 38vw, 1px"
                      unoptimized={!KNOWN_HOST.test(url)}
                      className="object-cover"
                    />
                  ) : photo ? (
                    <Image
                      src={photo.src}
                      alt=""
                      fill
                      sizes="(min-width: 1024px) 38vw, 1px"
                      className="object-cover"
                    />
                  ) : (
                    <Plate name={c.name} seed={c.slug} tone={i} top="Categoría" />
                  )}
                  <span className="cin-cat-layer-caption">
                    <span>{c.name}</span>
                    <span>
                      {c.productCount} {c.productCount === 1 ? "producto" : "productos"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
