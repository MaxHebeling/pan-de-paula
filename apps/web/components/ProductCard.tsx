import Link from "next/link";
import type { CatalogProduct } from "@/lib/catalog";
import { availability } from "@/lib/availability";
import { AddToCart } from "./AddToCart";
import { Badges } from "./Badges";
import { Price } from "./Price";
import { ProductImage } from "./ProductImage";

export function ProductCard({
  p,
  priority = false,
  headingLevel = 3,
}: {
  p: CatalogProduct;
  priority?: boolean;
  /** 2 en listados bajo un h1 (menú); 3 dentro de secciones con h2 (home, relacionados). */
  headingLevel?: 2 | 3;
}) {
  const av = availability(p);
  const href = `/producto/${p.slug}`;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      className="card lift group relative flex h-full flex-col overflow-hidden"
      data-testid="product-card"
    >
      {/* Enlace de imagen decorativo: el título ya enlaza, se oculta a lectores de pantalla y al tabulador */}
      <Link
        href={href}
        className="relative block aspect-[4/3] overflow-hidden bg-cream-2"
        aria-hidden="true"
        tabIndex={-1}
      >
        <ProductImage
          url={p.primaryImageUrl}
          alt={p.name}
          seed={p.slug}
          sizes="(min-width: 1024px) 300px, (min-width: 640px) 45vw, 92vw"
          priority={priority}
          className="transition duration-500 group-hover:scale-[1.03]"
        />
      </Link>
      <Badges badges={av.badges} className="pointer-events-none absolute top-3 left-3" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        {p.categoryName && <p className="eyebrow">{p.categoryName}</p>}
        <Heading className="font-display text-lg leading-snug text-ink">
          <Link href={href} className="hover:text-sage">
            {p.name}
          </Link>
        </Heading>
        {p.shortDescription && (
          <p className="line-clamp-2 text-sm text-ink-2">{p.shortDescription}</p>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          <Price cents={p.priceCents} regularCents={p.regularPriceCents} />
          {av.canAdd ? (
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
          ) : (
            <span className="text-sm text-ink-2">No disponible</span>
          )}
        </div>
      </div>
    </article>
  );
}
