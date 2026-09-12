"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { db, callFn, withStaff, dbErrorMessage } from "@/lib/db";

export type RegisterActionState = { error?: string };

const openSchema = z.object({
  opening_cash_cents: z.coerce.number().int().min(0).max(100_000_000),
  notes: z.string().trim().max(300).optional(),
});

export async function openRegisterAction(
  _prev: RegisterActionState,
  form: FormData,
): Promise<RegisterActionState> {
  const s = await requireSession("pos.register");
  const parsed = openSchema.safeParse({
    opening_cash_cents: form.get("opening_cash_cents"),
    notes: form.get("notes") || undefined,
  });
  if (!parsed.success) return { error: "Fondo inicial inválido" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "open_register", [parsed.data.opening_cash_cents, parsed.data.notes ?? null]),
    );
  } catch (e) {
    const m = dbErrorMessage(e);
    console.error("[caja] open_register", m);
    return { error: m.code === "23505" ? "Ya hay una caja abierta" : m.message };
  }
  revalidatePath("/caja");
  revalidatePath("/pos");
  redirect("/caja?abierta=1");
}

const closeSchema = z.object({
  session_id: z.string().uuid(),
  counted_cash_cents: z.coerce.number().int().min(0).max(100_000_000),
  notes: z.string().trim().max(500).optional(),
  confirm: z.literal("on", { message: "Confirma el cierre" }),
});

export async function closeRegisterAction(
  _prev: RegisterActionState,
  form: FormData,
): Promise<RegisterActionState> {
  const s = await requireSession("pos.register");
  const parsed = closeSchema.safeParse({
    session_id: form.get("session_id"),
    counted_cash_cents: form.get("counted_cash_cents"),
    notes: form.get("notes") || undefined,
    confirm: form.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "close_register", [
        parsed.data.session_id,
        parsed.data.counted_cash_cents,
        parsed.data.notes ?? null,
      ]),
    );
  } catch (e) {
    const m = dbErrorMessage(e);
    console.error("[caja] close_register", m);
    return { error: m.message };
  }
  revalidatePath("/caja");
  revalidatePath("/pos");
  redirect(`/caja/${parsed.data.session_id}?cerrada=1`);
}
