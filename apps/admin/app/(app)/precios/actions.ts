"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, sql, withStaff, callFn } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { cents, failure, str, strOrNull, zCents, zId, zodMessage } from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";
import { zonedToUtc } from "@/lib/tz";

async function businessTz(): Promise<string> {
  const r = await sql<{ timezone: string }>`select timezone from business_settings where id = 1`.execute(db());
  return r.rows[0]?.timezone ?? "America/Tijuana";
}

const channel = z.enum(["all", "web", "pos"], { error: "Canal inválido" });

function revalidate(productId: string) {
  revalidatePath("/precios");
  revalidatePath(`/precios/${productId}`);
  revalidatePath("/productos");
  revalidatePath(`/productos/${productId}`);
  revalidatePath("/recetas");
}

const regularSchema = z.object({ channel, price_cents: zCents, label: z.string().trim().max(80).nullable() });

export async function setRegularPrice(productId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  const parsed = regularSchema.safeParse({
    channel: str(form, "channel"),
    price_cents: cents(form, "price"),
    label: strOrNull(form, "label"),
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "set_regular_price", [productId, parsed.data.channel, parsed.data.price_cents, parsed.data.label]),
    );
  } catch (e) {
    return failure("precios.regular", e);
  }
  revalidate(productId);
  return { ok: "Nuevo precio regular vigente. El anterior quedó cerrado en el historial." };
}

const promoSchema = z
  .object({
    channel,
    price_cents: zCents,
    valid_from: z.string().min(1, "Indica el inicio"),
    valid_to: z.string().nullable(),
    label: z.string().trim().min(1, "Ponle nombre a la promoción").max(80),
  })
  .refine((v) => !Number.isNaN(Date.parse(v.valid_from)), { message: "Fecha de inicio inválida", path: ["valid_from"] })
  .refine((v) => v.valid_to === null || !Number.isNaN(Date.parse(v.valid_to)), { message: "Fecha de fin inválida", path: ["valid_to"] });

export async function createPromotion(productId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  const parsed = promoSchema.safeParse({
    channel: str(form, "channel"),
    price_cents: cents(form, "price"),
    valid_from: str(form, "valid_from") ?? new Date().toISOString(),
    valid_to: strOrNull(form, "valid_to"),
    label: str(form, "label") ?? "",
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    const tz = await businessTz();
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "create_promotion", [
        productId,
        parsed.data.channel,
        parsed.data.price_cents,
        zonedToUtc(parsed.data.valid_from, tz).toISOString(),
        parsed.data.valid_to ? zonedToUtc(parsed.data.valid_to, tz).toISOString() : null,
        parsed.data.label,
      ]),
    );
  } catch (e) {
    return failure("precios.promo", e);
  }
  revalidate(productId);
  return { ok: `Promoción "${parsed.data.label}" creada.` };
}

export async function endPromotion(productId: string, priceId: string): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success || !zId.safeParse(priceId).success) return;
  try {
    await withStaff(db(), s.staff.id, (trx) => callFn(trx, "end_promotion", [priceId]));
  } catch (e) {
    console.error("[admin:precios.end_promotion]", (e as Error).message);
  }
  revalidate(productId);
}
