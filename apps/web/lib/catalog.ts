import "server-only";
import { cache } from "react";
import { db, sql } from "@/lib/db";

export type CatalogProduct = {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  unitLabel: string;
  highlightedIngredients: string[];
  allergens: string[];
  tags: string[];
  isFeatured: boolean;
  trackStock: boolean;
  allowPreorder: boolean;
  requiresPreorder: boolean;
  preparationHours: number | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  priceCents: number | null;
  regularPriceCents: number | null;
  primaryImageUrl: string | null;
  onHand: number;
  parentId: string | null;
  variantLabel: string | null;
  sortOrder: number;
};

type Row = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
  unit_label: string;
  highlighted_ingredients: string[];
  allergens: string[];
  tags: string[];
  is_featured: boolean;
  track_stock: boolean;
  allow_preorder: boolean;
  requires_preorder: boolean;
  preparation_hours: number | null;
  season_start: string | null;
  season_end: string | null;
  price_cents: number | null;
  regular_price_cents: number | null;
  primary_image_url: string | null;
  on_hand: number;
  parent_id: string | null;
  variant_label: string | null;
  sort_order: number;
};

function map(r: Row): CatalogProduct {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    shortDescription: r.short_description,
    description: r.description,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categorySlug: r.category_slug,
    unitLabel: r.unit_label,
    highlightedIngredients: r.highlighted_ingredients ?? [],
    allergens: r.allergens ?? [],
    tags: r.tags ?? [],
    isFeatured: r.is_featured,
    trackStock: r.track_stock,
    allowPreorder: r.allow_preorder,
    requiresPreorder: r.requires_preorder,
    preparationHours: r.preparation_hours,
    seasonStart: r.season_start,
    seasonEnd: r.season_end,
    priceCents: r.price_cents,
    regularPriceCents: r.regular_price_cents,
    primaryImageUrl: r.primary_image_url,
    onHand: Number(r.on_hand ?? 0),
    parentId: r.parent_id,
    variantLabel: r.variant_label,
    sortOrder: r.sort_order,
  };
}

/**
 * Catálogo web: activos, visibles en web, no borrados, con categoría activa (o sin categoría),
 * con precio web configurado y dentro de temporada (si la tienen). Precios siempre del servidor.
 */
const BASE = sql`
  select p.id, p.slug, p.name, p.short_description, p.description, p.category_id,
         c.name as category_name, c.slug as category_slug, p.unit_label,
         p.highlighted_ingredients, p.allergens, p.tags, p.is_featured, p.track_stock,
         p.allow_preorder, p.requires_preorder, p.preparation_hours,
         to_char(p.season_start, 'YYYY-MM-DD') as season_start,
         to_char(p.season_end, 'YYYY-MM-DD') as season_end,
         current_price_cents(p.id, 'web') as price_cents,
         (select pp.price_cents from product_prices pp
           where pp.product_id = p.id and pp.kind = 'regular' and pp.channel in ('web','all')
             and pp.valid_from <= now() and (pp.valid_to is null or pp.valid_to > now())
           order by case when pp.channel = 'web' then 0 else 1 end, pp.valid_from desc limit 1) as regular_price_cents,
         (select i.url from product_images i where i.product_id = p.id order by i.is_primary desc, i.sort_order asc limit 1) as primary_image_url,
         coalesce(l.on_hand, 0)::float8 as on_hand,
         p.parent_id, p.variant_label, p.sort_order
  from products p
  left join categories c on c.id = p.category_id and c.deleted_at is null
  left join inventory_levels l on l.product_id = p.id
  where p.deleted_at is null and p.is_active and p.show_on_web
    and (p.category_id is null or (c.id is not null and c.is_active))
    and current_price_cents(p.id, 'web') is not null
    and (p.season_start is null or p.season_start <= (now() at time zone (select timezone from business_settings where id = 1))::date)
    and (p.season_end is null or p.season_end >= (now() at time zone (select timezone from business_settings where id = 1))::date)
`;

export const listProducts = cache(async (): Promise<CatalogProduct[]> => {
  const r =
    await sql<Row>`${BASE} and p.parent_id is null order by c.sort_order nulls last, p.sort_order, p.name`.execute(
      db(),
    );
  return r.rows.map(map);
});

export const listFeatured = cache(async (limit = 6): Promise<CatalogProduct[]> => {
  const r =
    await sql<Row>`${BASE} and p.parent_id is null and p.is_featured order by p.sort_order, p.name limit ${limit}`.execute(
      db(),
    );
  return r.rows.map(map);
});

/** Productos con precio promocional vigente en web (promo < regular). */
export const listPromos = cache(async (limit = 6): Promise<CatalogProduct[]> => {
  const all = await listProducts();
  return all
    .filter(
      (p) =>
        p.priceCents !== null && p.regularPriceCents !== null && p.priceCents < p.regularPriceCents,
    )
    .slice(0, limit);
});

export const getProductBySlug = cache(async (slug: string): Promise<CatalogProduct | null> => {
  const r = await sql<Row>`${BASE} and p.slug = ${slug} limit 1`.execute(db());
  return r.rows[0] ? map(r.rows[0]) : null;
});

export const listVariants = cache(async (parentId: string): Promise<CatalogProduct[]> => {
  const r =
    await sql<Row>`${BASE} and p.parent_id = ${parentId} order by p.sort_order, p.name`.execute(
      db(),
    );
  return r.rows.map(map);
});

export const listRelated = cache(
  async (categoryId: string | null, excludeId: string, limit = 4): Promise<CatalogProduct[]> => {
    if (!categoryId) return [];
    const r =
      await sql<Row>`${BASE} and p.parent_id is null and p.category_id = ${categoryId} and p.id <> ${excludeId} order by p.is_featured desc, p.sort_order, p.name limit ${limit}`.execute(
        db(),
      );
    return r.rows.map(map);
  },
);

export async function listProductsByIds(ids: string[]): Promise<CatalogProduct[]> {
  if (ids.length === 0) return [];
  const r = await sql<Row>`${BASE} and p.id = any(${ids}::uuid[])`.execute(db());
  return r.rows.map(map);
}

export type ProductImage = { id: string; url: string; alt: string | null; isPrimary: boolean };

export const listImages = cache(async (productId: string): Promise<ProductImage[]> => {
  const rows = await db()
    .selectFrom("product_images")
    .select(["id", "url", "alt", "is_primary"])
    .where("product_id", "=", productId)
    .orderBy("is_primary", "desc")
    .orderBy("sort_order")
    .execute();
  return rows.map((r) => ({ id: r.id, url: r.url, alt: r.alt, isPrimary: r.is_primary }));
});

export type Category = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  productCount: number;
};

/** Categorías activas con al menos un producto visible en web. */
export const listCategories = cache(async (): Promise<Category[]> => {
  const products = await listProducts();
  const counts = new Map<string, number>();
  for (const p of products)
    if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  const rows = await db()
    .selectFrom("categories")
    .select(["id", "slug", "name", "description", "image_url"])
    .where("is_active", "=", true)
    .where("deleted_at", "is", null)
    .orderBy("sort_order")
    .orderBy("name")
    .execute();
  return rows
    .filter((c) => (counts.get(c.id) ?? 0) > 0)
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      imageUrl: c.image_url,
      productCount: counts.get(c.id) ?? 0,
    }));
});

export const getCategoryBySlug = cache(async (slug: string): Promise<Category | null> => {
  const cats = await listCategories();
  return cats.find((c) => c.slug === slug) ?? null;
});
