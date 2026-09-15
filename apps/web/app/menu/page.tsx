import type { Metadata } from "next";
import { listCategories, listProducts } from "@/lib/catalog";
import { MenuBrowser } from "./MenuBrowser";

export const metadata: Metadata = {
  title: "Menú",
  description:
    "Todo nuestro pan artesanal: croissants, kouign-amann, galletas, docenas para compartir y especialidades de temporada.",
  alternates: { canonical: "/menu" },
};

export default async function MenuPage() {
  const [products, categories] = await Promise.all([listProducts(), listCategories()]);
  return (
    <div className="container-x py-10 sm:py-14">
      <header className="mb-8 max-w-2xl">
        <p className="eyebrow mb-2">Menú</p>
        <h1 className="display text-4xl sm:text-5xl">Todo sale del horno el día que lo recoges</h1>
        <p className="mt-3 text-lg text-ink-2">
          Elige tus favoritos y escoge la fecha de recolección al hacer tu pedido.
        </p>
      </header>
      <MenuBrowser products={products} categories={categories} activeCategory={null} />
    </div>
  );
}
