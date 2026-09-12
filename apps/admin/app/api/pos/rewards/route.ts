import { NextResponse } from "next/server";
import { z } from "zod";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { apiSession, dbErrorResponse, getFlags, jsonError, readJson } from "@/lib/pos";
import type { RewardAvailable, RewardIssued } from "@/components/pos/types";

export const dynamic = "force-dynamic";

async function loadRewards(customerId: string) {
  const d = db();
  const [issued, available] = await Promise.all([
    sql<{
      redemption_id: string;
      code: string;
      reward_name: string;
      kind: RewardIssued["kind"];
      value_bps: number | null;
      value_cents: number | null;
      product_id: string | null;
      product_name: string | null;
      expires_at: Date | null;
    }>`select rr.id as redemption_id, rr.code, r.name as reward_name, r.kind, r.value_bps, r.value_cents, r.product_id, p.name as product_name, rr.expires_at
       from reward_redemptions rr join rewards r on r.id = rr.reward_id left join products p on p.id = r.product_id
       where rr.customer_id = ${customerId}::uuid and rr.status = 'issued' and (rr.expires_at is null or rr.expires_at > now())
       order by rr.issued_at desc`.execute(d),
    sql<{
      reward_id: string;
      name: string;
      description: string | null;
      points_cost: number;
      kind: RewardIssued["kind"];
      affordable: boolean;
    }>`select r.id as reward_id, r.name, r.description, r.points_cost, r.kind,
              (c.points_balance >= r.points_cost
               and (r.min_tier_key is null or coalesce((select rank from loyalty_tiers where key = c.tier_key), 0) >= (select rank from loyalty_tiers where key = r.min_tier_key))) as affordable
       from rewards r cross join customers c
       where c.id = ${customerId}::uuid and r.is_active
         and (r.starts_at is null or r.starts_at <= now()) and (r.ends_at is null or r.ends_at >= now())
       order by r.points_cost`.execute(d),
  ]);
  const issuedOut: RewardIssued[] = issued.rows.map((r) => ({
    redemptionId: r.redemption_id,
    code: r.code,
    rewardName: r.reward_name,
    kind: r.kind,
    valueBps: r.value_bps,
    valueCents: r.value_cents,
    productId: r.product_id,
    productName: r.product_name,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  }));
  const availableOut: RewardAvailable[] = available.rows.map((r) => ({
    rewardId: r.reward_id,
    name: r.name,
    description: r.description,
    pointsCost: r.points_cost,
    kind: r.kind,
    affordable: r.affordable,
  }));
  const bal = await sql<{
    points_balance: number;
  }>`select points_balance from customers where id = ${customerId}::uuid`.execute(d);
  return {
    issued: issuedOut,
    available: availableOut,
    pointsBalance: bal.rows[0]?.points_balance ?? 0,
  };
}

/** GET ?customer_id= → recompensas emitidas (status issued) y disponibles para canjear. */
export async function GET(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const customerId = new URL(req.url).searchParams.get("customer_id");
  if (!customerId || !z.string().uuid().safeParse(customerId).success)
    return jsonError(400, "customer_id inválido", "VALIDATION");
  try {
    return NextResponse.json(await loadRewards(customerId));
  } catch (e) {
    return dbErrorResponse(e, "cargar recompensas");
  }
}

const redeemSchema = z.object({ customer_id: z.string().uuid(), reward_id: z.string().uuid() });

/** POST {customer_id, reward_id} → redeem_reward (descuenta puntos y emite la recompensa). */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const parsed = redeemSchema.safeParse(await readJson(req));
  if (!parsed.success) return jsonError(400, "Datos inválidos", "VALIDATION");
  const flags = await getFlags(["loyalty"] as const);
  if (!flags.loyalty)
    return jsonError(409, "El programa de puntos está desactivado", "LOYALTY_OFF");
  try {
    const r = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<{ redemption_id: string; code: string }>(trx, "redeem_reward", [
        parsed.data.customer_id,
        parsed.data.reward_id,
      ]),
    );
    const rewards = await loadRewards(parsed.data.customer_id);
    return NextResponse.json(
      { redemptionId: r.redemption_id, code: r.code, ...rewards },
      { status: 201 },
    );
  } catch (e) {
    return dbErrorResponse(e, "redeem_reward");
  }
}
