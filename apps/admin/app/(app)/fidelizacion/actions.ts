"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { db, sql, callFn, withStaff, dbErrorMessage } from "@/lib/db";
import { bool, cents, num, optStr, str, type ActionState } from "@/lib/action-state";

const uuid = z.string().uuid();
const path = "/fidelizacion";

const programSchema = z.object({
  is_active: z.boolean(),
  feature_enabled: z.boolean(),
  points_per_unit: z.number().int().min(0).max(1000),
  unit_cents: z.number().int().min(1, "El monto por punto debe ser mayor a $0").max(10_000_000),
  min_purchase_cents: z.number().int().min(0),
  birthday_multiplier: z.number().min(1).max(10),
  signup_bonus_points: z.number().int().min(0).max(10000),
  points_expire_days: z.number().int().min(1).max(3650).optional(),
  rounding: z.enum(["floor", "round"]),
});

export async function updateProgramAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = programSchema.safeParse({
    is_active: bool(fd, "is_active"),
    feature_enabled: bool(fd, "feature_enabled"),
    points_per_unit: num(fd, "points_per_unit"),
    unit_cents: cents(fd, "unit_pesos"),
    min_purchase_cents: cents(fd, "min_purchase_pesos") ?? 0,
    birthday_multiplier: num(fd, "birthday_multiplier"),
    signup_bonus_points: num(fd, "signup_bonus_points") ?? 0,
    points_expire_days: num(fd, "points_expire_days"),
    rounding: str(fd, "rounding"),
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const d = p.data;
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      await sql`update loyalty_program set is_active = ${d.is_active}, points_per_unit = ${d.points_per_unit}, unit_cents = ${d.unit_cents},
                min_purchase_cents = ${d.min_purchase_cents}, birthday_multiplier = ${d.birthday_multiplier}, signup_bonus_points = ${d.signup_bonus_points},
                points_expire_days = ${d.points_expire_days ?? null}, rounding = ${d.rounding} where id = 1`.execute(
        trx,
      );
      await sql`update feature_flags set enabled = ${d.feature_enabled} where key = 'loyalty'`.execute(
        trx,
      );
    });
    revalidatePath(path);
    return { ok: "Programa actualizado" };
  } catch (e) {
    console.error("[fidelizacion] programa falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

const tierSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,30}$/, "Clave: letras, números, guion (2–30)"),
  name: z.string().trim().min(2).max(60),
  rank: z.number().int().min(1).max(100),
  min_orders: z.number().int().min(0),
  min_spent_cents: z.number().int().min(0),
  min_lifetime_points: z.number().int().min(0),
  perks: z.string().trim().max(200).optional(),
  color: z.enum(["gray", "blue", "amber", "green", "red"]),
});

export async function upsertTierAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = tierSchema.safeParse({
    key: str(fd, "key"),
    name: str(fd, "name"),
    rank: num(fd, "rank"),
    min_orders: num(fd, "min_orders") ?? 0,
    min_spent_cents: cents(fd, "min_spent_pesos") ?? 0,
    min_lifetime_points: num(fd, "min_lifetime_points") ?? 0,
    perks: optStr(fd, "perks"),
    color: str(fd, "color") || "gray",
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const t = p.data;
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      await sql`insert into loyalty_tiers(key, name, rank, min_orders, min_spent_cents, min_lifetime_points, perks, color)
                values (${t.key}, ${t.name}, ${t.rank}, ${t.min_orders}, ${t.min_spent_cents}, ${t.min_lifetime_points}, ${t.perks ?? null}, ${t.color})
                on conflict (key) do update set name = excluded.name, rank = excluded.rank, min_orders = excluded.min_orders,
                  min_spent_cents = excluded.min_spent_cents, min_lifetime_points = excluded.min_lifetime_points, perks = excluded.perks, color = excluded.color`.execute(
        trx,
      );
      // Reclasifica a todos los clientes activos con las reglas nuevas
      await sql`select recompute_customer_tier(id) from customers where deleted_at is null and merged_into_id is null`.execute(
        trx,
      );
    });
    revalidatePath(path);
    revalidatePath("/clientes");
    return { ok: `Nivel "${t.name}" guardado y clientes reclasificados` };
  } catch (e) {
    console.error("[fidelizacion] nivel falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function deleteTierAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const key = str(fd, "key");
  if (!key) return { error: "Nivel inválido" };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      const n = await sql<{ n: number }>`select count(*)::int as n from loyalty_tiers`.execute(trx);
      if ((n.rows[0]?.n ?? 0) <= 1)
        throw Object.assign(new Error("Debe existir al menos un nivel"), { code: "P0001" });
      await sql`delete from loyalty_tiers where key = ${key}`.execute(trx);
      await sql`select recompute_customer_tier(id) from customers where deleted_at is null and merged_into_id is null`.execute(
        trx,
      );
    });
    revalidatePath(path);
    return { ok: "Nivel eliminado; clientes reclasificados" };
  } catch (e) {
    console.error("[fidelizacion] borrar nivel falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

const rewardSchema = z
  .object({
    id: uuid.optional(),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional(),
    kind: z.enum(["discount_pct", "discount_amount", "free_product", "gift"]),
    points_cost: z.number().int().min(0).max(1_000_000),
    value_bps: z.number().int().min(1).max(10000).optional(),
    value_cents: z.number().int().min(1).optional(),
    product_id: uuid.optional(),
    min_tier_key: z.string().trim().max(30).optional(),
    is_active: z.boolean(),
    starts_at: z.string().optional(),
    ends_at: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "discount_pct" && !v.value_bps)
      ctx.addIssue({ code: "custom", message: "Indica el porcentaje", path: ["value_bps"] });
    if (v.kind === "discount_amount" && !v.value_cents)
      ctx.addIssue({ code: "custom", message: "Indica el monto", path: ["value_cents"] });
    if (v.kind === "free_product" && !v.product_id)
      ctx.addIssue({ code: "custom", message: "Selecciona el producto", path: ["product_id"] });
  });

export async function upsertRewardAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const pctRaw = num(fd, "value_pct");
  const p = rewardSchema.safeParse({
    id: optStr(fd, "id"),
    name: str(fd, "name"),
    description: optStr(fd, "description"),
    kind: str(fd, "kind"),
    points_cost: num(fd, "points_cost"),
    value_bps: pctRaw === undefined ? undefined : Math.round(pctRaw * 100),
    value_cents: cents(fd, "value_pesos"),
    product_id: optStr(fd, "product_id"),
    min_tier_key: optStr(fd, "min_tier_key"),
    is_active: bool(fd, "is_active"),
    starts_at: optStr(fd, "starts_at"),
    ends_at: optStr(fd, "ends_at"),
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const r = p.data;
  const valueBps = r.kind === "discount_pct" ? r.value_bps! : null;
  const valueCents = r.kind === "discount_amount" ? r.value_cents! : null;
  const productId = r.kind === "free_product" ? r.product_id! : null;
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      if (r.id) {
        await sql`update rewards set name = ${r.name}, description = ${r.description ?? null}, kind = ${r.kind}::reward_kind, points_cost = ${r.points_cost},
                  value_bps = ${valueBps}, value_cents = ${valueCents}, product_id = ${productId}, min_tier_key = ${r.min_tier_key ?? null},
                  is_active = ${r.is_active}, starts_at = ${r.starts_at ?? null}, ends_at = ${r.ends_at ?? null} where id = ${r.id}`.execute(
          trx,
        );
      } else {
        await sql`insert into rewards(name, description, kind, points_cost, value_bps, value_cents, product_id, min_tier_key, is_active, starts_at, ends_at)
                  values (${r.name}, ${r.description ?? null}, ${r.kind}::reward_kind, ${r.points_cost}, ${valueBps}, ${valueCents}, ${productId}, ${r.min_tier_key ?? null}, ${r.is_active}, ${r.starts_at ?? null}, ${r.ends_at ?? null})`.execute(
          trx,
        );
      }
    });
    revalidatePath(path);
    return { ok: r.id ? "Recompensa actualizada" : "Recompensa creada" };
  } catch (e) {
    console.error("[fidelizacion] recompensa falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function toggleRewardAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = z
    .object({ id: uuid, active: z.enum(["1", "0"]) })
    .safeParse({ id: str(fd, "id"), active: str(fd, "active") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`update rewards set is_active = ${p.data.active === "1"} where id = ${p.data.id}`.execute(
        trx,
      ),
    );
    revalidatePath(path);
    return { ok: p.data.active === "1" ? "Recompensa activada" : "Recompensa desactivada" };
  } catch (e) {
    console.error("[fidelizacion] toggle recompensa falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function upsertBonusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = z
    .object({
      product_id: uuid,
      bonus_points: z.number().int().min(0).max(10000),
      is_active: z.boolean(),
    })
    .safeParse({
      product_id: str(fd, "product_id"),
      bonus_points: num(fd, "bonus_points"),
      is_active: bool(fd, "is_active"),
    });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`insert into loyalty_product_bonuses(product_id, bonus_points, is_active) values (${p.data.product_id}, ${p.data.bonus_points}, ${p.data.is_active})
          on conflict (product_id) do update set bonus_points = excluded.bonus_points, is_active = excluded.is_active`.execute(
        trx,
      ),
    );
    revalidatePath(path);
    return { ok: "Bono guardado" };
  } catch (e) {
    console.error("[fidelizacion] bono falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function deleteBonusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = uuid.safeParse(str(fd, "product_id"));
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`delete from loyalty_product_bonuses where product_id = ${p.data}`.execute(trx),
    );
    revalidatePath(path);
    return { ok: "Bono eliminado" };
  } catch (e) {
    console.error("[fidelizacion] borrar bono falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function cancelRedemptionAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = uuid.safeParse(str(fd, "id"));
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      const r = await sql<{ customer_id: string; points_spent: number; status: string }>`
        select customer_id, points_spent, status from reward_redemptions where id = ${p.data} for update`.execute(
        trx,
      );
      const red = r.rows[0];
      if (!red) throw Object.assign(new Error("Canje no existe"), { code: "P0001" });
      if (red.status !== "issued")
        throw Object.assign(new Error("Solo se cancelan canjes emitidos y no aplicados"), {
          code: "P0001",
        });
      await sql`update reward_redemptions set status = 'cancelled' where id = ${p.data}`.execute(
        trx,
      );
      await callFn(trx, "loyalty_post", [
        red.customer_id,
        "reversal",
        red.points_spent,
        null,
        p.data,
        "Cancelación de canje",
      ]);
    });
    revalidatePath(path);
    return { ok: "Canje cancelado y puntos devueltos" };
  } catch (e) {
    console.error("[fidelizacion] cancelar canje falló", e);
    return { error: dbErrorMessage(e).message };
  }
}
