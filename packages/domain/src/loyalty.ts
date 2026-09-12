/** Motor de fidelización (espejo de loyalty_points_for en SQL). */
import type { Cents } from "./money.ts";

export type LoyaltyProgram = {
  isActive: boolean;
  pointsPerUnit: number;
  unitCents: Cents;
  minPurchaseCents: Cents;
  birthdayMultiplier: number;
  rounding: "floor" | "round";
};

export type LoyaltyTier = {
  key: string;
  name: string;
  rank: number;
  minOrders: number;
  minSpentCents: Cents;
  minLifetimePoints: number;
};

export function pointsForPurchase(
  program: LoyaltyProgram,
  totalCents: Cents,
  opts: { productBonuses?: number; isBirthday?: boolean; featureEnabled?: boolean } = {},
): number {
  if (opts.featureEnabled === false || !program.isActive || totalCents < program.minPurchaseCents)
    return 0;
  let pts = (totalCents / program.unitCents) * program.pointsPerUnit;
  pts = program.rounding === "round" ? Math.round(pts) : Math.floor(pts);
  if (opts.isBirthday) pts = Math.floor(pts * program.birthdayMultiplier);
  return Math.max(0, pts + (opts.productBonuses ?? 0));
}

export function resolveTier(
  tiers: LoyaltyTier[],
  stats: { totalOrders: number; totalSpentCents: Cents; lifetimePoints: number },
): LoyaltyTier | null {
  const eligible = tiers.filter(
    (t) =>
      stats.totalOrders >= t.minOrders &&
      stats.totalSpentCents >= t.minSpentCents &&
      stats.lifetimePoints >= t.minLifetimePoints,
  );
  eligible.sort((a, b) => b.rank - a.rank);
  return eligible[0] ?? null;
}

/** Progreso hacia el siguiente nivel (para UI del cliente/POS). */
export function tierProgress(
  tiers: LoyaltyTier[],
  current: LoyaltyTier | null,
  stats: { totalOrders: number; totalSpentCents: Cents; lifetimePoints: number },
) {
  const next = tiers
    .filter((t) => t.rank > (current?.rank ?? 0))
    .sort((a, b) => a.rank - b.rank)[0];
  if (!next) return null;
  const ordersLeft = Math.max(0, next.minOrders - stats.totalOrders);
  const spendLeft = Math.max(0, next.minSpentCents - stats.totalSpentCents);
  return { next, ordersLeft, spendLeftCents: spendLeft };
}

export function isBirthdayToday(birthday: string | null | undefined, localDate: string): boolean {
  if (!birthday) return false;
  return birthday.slice(5, 10) === localDate.slice(5, 10);
}
