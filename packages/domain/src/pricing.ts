import type { Cents } from "./money.ts";

export type PriceChannel = "all" | "web" | "pos";
export type PriceRow = {
  channel: PriceChannel;
  kind: "regular" | "promo";
  priceCents: Cents;
  validFrom: Date;
  validTo: Date | null;
  label?: string | null;
};

/** Espejo de current_price_cents(): promo vigente > regular del canal > regular 'all'. */
export function resolvePrice(
  rows: PriceRow[],
  channel: Exclude<PriceChannel, "all">,
  at = new Date(),
): PriceRow | null {
  const valid = rows.filter(
    (r) =>
      (r.channel === channel || r.channel === "all") &&
      r.validFrom <= at &&
      (r.validTo === null || r.validTo > at),
  );
  valid.sort((a, b) => {
    const kind = (a.kind === "promo" ? 0 : 1) - (b.kind === "promo" ? 0 : 1);
    if (kind !== 0) return kind;
    const ch = (a.channel === channel ? 0 : 1) - (b.channel === channel ? 0 : 1);
    if (ch !== 0) return ch;
    return b.validFrom.getTime() - a.validFrom.getTime();
  });
  return valid[0] ?? null;
}
