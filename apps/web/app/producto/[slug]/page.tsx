import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badges } from "@/components/Badges";
import { JsonLd } from "@/components/JsonLd";
import { ProductCard } from "@/components/ProductCard";
import { availability } from "@/lib/availability";
import { getProductBySlug, listImages, listRelated, listVariants } from "@/lib/catalog";
import { getBusiness } from "@/lib/site";
import { Gallery } from "./Gallery";
import { VariantPicker } from "./VariantPicker";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProductBySlug(slug);
  if (!p) return { title: "Producto no encontrado" };
  return {
    title: p.name,
    description: p.shortDescription ?? p.description ?? `${p.name} artesanal de El Pan de Paula.`,
    alternates: { canonical: `/producto/${p.slug}` },
    openGraph: p.primaryImageUrl ? { images: [{ url: p.primaryImageUrl }] } : undefined,
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const p = await getProductBySlug(slug);
  if (!p || p.parentId) notFound();
  const [variants, images, related, business] = await Promise.all([
    listVariants(p.id),
    listImages(p.id),
    listRelated(p.categoryId, p.id, 4),
    getBusiness(),
  ]);
  const av = availability(p);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const productLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.shortDescription ?? p.description ?? undefined,
    sku: p.slug,
    category: p.categoryName ?? undefined,
    image: p.primaryImageUrl ? [p.primaryImageUrl] : [`${siteUrl}/brand/logo-512.png`],
    brand: { "@type": "Brand", name: business.name },
    url: `${siteUrl}/producto/${p.slug}`,
  };
  if (p.priceCents !== null) {
    productLd.offers = {
      "@type": "Offer",
      priceCurrency: "MXN",
      price: (p.priceCents / 100).toFixed(2),
      availability: av.canAdd ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `${siteUrl}/producto/${p.slug}`,
      seller: { "@type": "Bakery", name: business.name },
    };
  }

  return (
    <div className="container-x py-8 sm:py-12">
      <nav aria-label="Migas de pan" className="mb-6 text-sm text-ink-2">
        <Link href="/menu" className="hover:text-sage">
          Menú
        </Link>
        {p.categorySlug && p.categoryName && (
          <>
            <span aria-hidden="true"> / </span>
            <Link href={`/menu/${p.categorySlug}`} className="hover:text-sage">
              {p.categoryName}
            </Link>
          </>
        )}
        <span aria-hidden="true"> / </span>
        <span className="text-ink">{p.name}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-14">
        <Gallery images={images} name={p.name} seed={p.slug} />
        <div className="reveal">
          <Badges badges={av.badges} className="mb-3" />
          {p.categoryName && <p className="eyebrow mb-2">{p.categoryName}</p>}
          <h1 className="display text-4xl sm:text-5xl" data-testid="product-title">
            {p.name}
          </h1>
          {p.shortDescription && <p className="mt-4 text-lg text-ink-2">{p.shortDescription}</p>}
          <div className="mt-6">
            <VariantPicker base={p} variants={variants} />
          </div>

          <dl className="mt-8 grid gap-4 sm:grid-cols-2">
            {p.highlightedIngredients.length > 0 && (
              <div className="card p-4">
                <dt className="eyebrow mb-2">Ingredientes destacados</dt>
                <dd className="text-sm text-ink">{p.highlightedIngredients.join(", ")}</dd>
              </div>
            )}
            {p.allergens.length > 0 && (
              <div className="card p-4">
                <dt className="eyebrow mb-2">Alérgenos</dt>
                <dd className="text-sm text-ink">{p.allergens.join(", ")}</dd>
              </div>
            )}
            <div className="card p-4">
              <dt className="eyebrow mb-2">Preparación</dt>
              <dd className="text-sm text-ink">
                {p.requiresPreorder
                  ? p.preparationHours
                    ? `Bajo pedido, con ${p.preparationHours} horas de anticipación.`
                    : "Bajo pedido: se prepara especialmente para tu fecha."
                  : "Se hornea el mismo día que lo recoges."}
              </dd>
            </div>
            <div className="card p-4">
              <dt className="eyebrow mb-2">Entrega</dt>
              <dd className="text-sm text-ink">Eliges la fecha de recolección al finalizar tu pedido.</dd>
            </div>
          </dl>

          {p.description && (
            <div className="prose-warm mt-8 text-ink-2">
              <h2 className="font-display text-2xl text-ink">Sobre este pan</h2>
              {p.description.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="mt-3">
                  {para}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-16" aria-labelledby="relacionados">
          <h2 id="relacionados" className="display mb-6 text-3xl">
            También te puede gustar
          </h2>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((r) => (
              <ProductCard key={r.id} p={r} />
            ))}
          </div>
        </section>
      )}
      <JsonLd data={productLd} />
    </div>
  );
}
