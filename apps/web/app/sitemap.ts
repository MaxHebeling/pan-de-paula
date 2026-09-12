import type { MetadataRoute } from "next";
import { listCategories, listProducts } from "@/lib/catalog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const now = new Date();
  const statics: MetadataRoute.Sitemap = ["", "/menu", "/club", "/unete", "/horarios", "/ubicacion", "/nosotros", "/privacidad", "/terminos"].map((p) => ({
    url: `${base}${p}`,
    lastModified: now,
    changeFrequency: p === "" || p === "/menu" ? "daily" : "monthly",
    priority: p === "" ? 1 : p === "/menu" ? 0.9 : 0.5,
  }));
  try {
    const [cats, products] = await Promise.all([listCategories(), listProducts()]);
    return [
      ...statics,
      ...cats.map((c) => ({ url: `${base}/menu/${c.slug}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.7 })),
      ...products.map((p) => ({ url: `${base}/producto/${p.slug}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.6 })),
    ];
  } catch (e) {
    console.error("[sitemap] no se pudo leer el catálogo; se publica solo lo estático", e);
    return statics;
  }
}
