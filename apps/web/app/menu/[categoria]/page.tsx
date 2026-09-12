import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCategoryBySlug, listCategories, listProducts } from "@/lib/catalog";
import { MenuBrowser } from "../MenuBrowser";

type Props = { params: Promise<{ categoria: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { categoria } = await params;
  const cat = await getCategoryBySlug(categoria);
  if (!cat) return { title: "Categoría no encontrada" };
  return {
    title: cat.name,
    description: cat.description ?? `${cat.name} artesanales de El Pan de Paula. Pide en línea y recoge en tu fecha.`,
    alternates: { canonical: `/menu/${cat.slug}` },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { categoria } = await params;
  const cat = await getCategoryBySlug(categoria);
  if (!cat) notFound();
  const [all, categories] = await Promise.all([listProducts(), listCategories()]);
  const products = all.filter((p) => p.categorySlug === cat.slug);
  return (
    <div className="container-x py-10 sm:py-14">
      <nav aria-label="Migas de pan" className="mb-4 text-sm text-ink-2">
        <Link href="/menu" className="hover:text-sage">
          Menú
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink">{cat.name}</span>
      </nav>
      <header className="mb-8 max-w-2xl">
        <p className="eyebrow mb-2">Categoría</p>
        <h1 className="display text-4xl sm:text-5xl">{cat.name}</h1>
        {cat.description && <p className="mt-3 text-lg text-ink-2">{cat.description}</p>}
      </header>
      <MenuBrowser products={products} categories={categories} activeCategory={cat.slug} />
    </div>
  );
}
