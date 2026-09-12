import "server-only";
import { cache } from "react";
import type { LoyaltyTier } from "@pdp/domain";
import { db } from "@/lib/db";

export type ProgramView = {
  isActive: boolean;
  pointsPerUnit: number;
  unitCents: number;
  minPurchaseCents: number;
  birthdayMultiplier: number;
  signupBonusPoints: number;
  pointsExpireDays: number | null;
};

export type TierView = LoyaltyTier & { perks: string | null; color: string | null };

export type RewardView = {
  id: string;
  name: string;
  description: string | null;
  kind: "discount_pct" | "discount_amount" | "free_product" | "gift";
  pointsCost: number;
  valueBps: number | null;
  valueCents: number | null;
  productName: string | null;
  minTierKey: string | null;
};

export const getProgram = cache(async (): Promise<ProgramView> => {
  const p = await db()
    .selectFrom("loyalty_program")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  return {
    isActive: p.is_active,
    pointsPerUnit: p.points_per_unit,
    unitCents: p.unit_cents,
    minPurchaseCents: p.min_purchase_cents,
    birthdayMultiplier: Number(p.birthday_multiplier),
    signupBonusPoints: p.signup_bonus_points,
    pointsExpireDays: p.points_expire_days,
  };
});

export const listTiers = cache(async (): Promise<TierView[]> => {
  const rows = await db().selectFrom("loyalty_tiers").selectAll().orderBy("rank").execute();
  return rows.map((t) => ({
    key: t.key,
    name: t.name,
    rank: t.rank,
    minOrders: t.min_orders,
    minSpentCents: Number(t.min_spent_cents),
    minLifetimePoints: t.min_lifetime_points,
    perks: t.perks,
    color: t.color,
  }));
});

export const listActiveRewards = cache(async (): Promise<RewardView[]> => {
  const rows = await db()
    .selectFrom("rewards")
    .leftJoin("products", "products.id", "rewards.product_id")
    .select([
      "rewards.id",
      "rewards.name",
      "rewards.description",
      "rewards.kind",
      "rewards.points_cost",
      "rewards.value_bps",
      "rewards.value_cents",
      "rewards.min_tier_key",
      "rewards.starts_at",
      "rewards.ends_at",
      "products.name as product_name",
    ])
    .where("rewards.is_active", "=", true)
    .orderBy("rewards.points_cost")
    .execute();
  const now = Date.now();
  return rows
    .filter(
      (r) =>
        (!r.starts_at || r.starts_at.getTime() <= now) &&
        (!r.ends_at || r.ends_at.getTime() >= now),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      pointsCost: r.points_cost,
      valueBps: r.value_bps,
      valueCents: r.value_cents,
      productName: r.product_name,
      minTierKey: r.min_tier_key,
    }));
});

export function loyaltyEnabled(flags: Record<string, boolean>, program: ProgramView): boolean {
  return Boolean(flags.loyalty) && program.isActive;
}
