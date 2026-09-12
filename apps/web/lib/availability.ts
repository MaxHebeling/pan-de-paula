/** Reglas de disponibilidad y badges de un producto (cliente y servidor; sin acceso a datos). */
export type ProductLike = {
  tags: string[];
  categorySlug: string | null;
  trackStock: boolean;
  allowPreorder: boolean;
  requiresPreorder: boolean;
  onHand: number;
  seasonStart: string | null;
  seasonEnd: string | null;
  priceCents: number | null;
  regularPriceCents: number | null;
  preparationHours: number | null;
};

export type Badge = { key: "nuevo" | "temporada" | "pedido" | "agotado" | "promo"; label: string };

export type Availability = {
  canAdd: boolean;
  soldOut: boolean;
  badges: Badge[];
  note: string | null;
};

export function availability(p: ProductLike): Availability {
  const badges: Badge[] = [];
  const soldOut = p.trackStock && p.onHand <= 0;
  const promo =
    p.priceCents !== null && p.regularPriceCents !== null && p.priceCents < p.regularPriceCents;
  if (promo) badges.push({ key: "promo", label: "Promo" });
  if (p.tags.includes("nuevo") || p.categorySlug === "nuevos")
    badges.push({ key: "nuevo", label: "Nuevo" });
  if (p.seasonStart || p.seasonEnd || p.categorySlug === "temporada")
    badges.push({ key: "temporada", label: "Temporada" });
  if (p.requiresPreorder) badges.push({ key: "pedido", label: "Bajo pedido" });
  if (soldOut && !p.allowPreorder) {
    badges.push({ key: "agotado", label: "Agotado" });
    return { canAdd: false, soldOut, badges, note: "Por ahora no hay piezas disponibles." };
  }
  let note: string | null = null;
  if (p.requiresPreorder && p.preparationHours)
    note = `Se prepara bajo pedido (${p.preparationHours} h de anticipación).`;
  else if (p.requiresPreorder) note = "Se prepara bajo pedido para tu fecha de entrega.";
  else if (soldOut) note = "Se hornea para tu fecha de entrega.";
  return { canAdd: p.priceCents !== null, soldOut, badges, note };
}

export const BADGE_CLASS: Record<Badge["key"], string> = {
  nuevo: "bg-sage text-white",
  temporada: "bg-crust text-ink",
  pedido: "bg-cream-2 text-ink",
  agotado: "bg-ink text-cream",
  promo: "bg-wine text-white",
};
