/**
 * Fotografías reales disponibles hoy en public/editorial (no hay más: nada de stock ni imágenes generadas).
 * Se usan solo donde la foto corresponde de verdad al producto o a la categoría; el resto recibe un
 * "plato" tipográfico (Plate.tsx). Si el producto ya tiene foto propia en `product_images`, esa manda.
 * Para ampliar: agrega la foto en public/editorial y su entrada aquí (ver docs/WEB_MOTION.md → Fotografías).
 */
export type EditorialPhoto = { src: string; alt: string; width: number; height: number };

const PISTACHIO: EditorialPhoto = {
  src: "/editorial/pistachio-original.webp",
  alt: "Croissant Dubai cubierto de chocolate y pistache",
  width: 1600,
  height: 1200,
};
const ALMOND: EditorialPhoto = {
  src: "/editorial/almond-original.webp",
  alt: "Croissant Chocolate Almendra cubierto de chocolate blanco y almendras",
  width: 1600,
  height: 1200,
};
export const SMORES: EditorialPhoto = {
  src: "/editorial/smores-original.webp",
  alt: "Croissant S'mores con chocolate, galleta graham y bombón flameado",
  width: 1600,
  height: 1200,
};
export const HERO: EditorialPhoto = {
  src: "/editorial/hero-pastries.webp",
  alt: "Tres croissants artesanales de El Pan de Paula sobre una mesa de madera",
  width: 1672,
  height: 941,
};
/** Recorte cuadrado de la MISMA foto (x 600–1541) para pantallas verticales: nítido y más ligero. */
export const HERO_SQUARE: EditorialPhoto = {
  src: "/editorial/hero-pastries-square.webp",
  alt: HERO.alt,
  width: 941,
  height: 941,
};

/** Por slug de producto. */
export const PRODUCT_PHOTOS: Record<string, EditorialPhoto> = {
  "croissant-dubai": PISTACHIO,
  "croissant-chocolate-almendra": ALMOND,
  "croissant-s-mores": SMORES,
};

/** Por slug de categoría (se usa si la categoría no tiene `image_url`). */
export const CATEGORY_PHOTOS: Record<string, EditorialPhoto> = {
  croissants: ALMOND,
};

/** Foto de un producto: la suya (`product_images`) o la editorial que le corresponde. */
export function productPhoto(p: {
  slug: string;
  name: string;
  primaryImageUrl: string | null;
}): EditorialPhoto | null {
  if (p.primaryImageUrl) return { src: p.primaryImageUrl, alt: p.name, width: 1200, height: 1500 };
  return PRODUCT_PHOTOS[p.slug] ?? null;
}
