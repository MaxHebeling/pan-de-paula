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
  /** A dónde volver tras abrir. Ver `destinoSeguro`: nunca se confía en el valor tal cual. */
  next: z.string().max(200).optional(),
});

/*
 * Redirección de retorno acotada a RUTAS INTERNAS del punto de venta.
 *
 * El caso que resuelve: con la caja cerrada, el panel de cobro de un pedido manda a abrirla y
 * antes el operador tenía que volver a buscar el pedido a mano. Ahora vuelve solo.
 *
 * Y no se confía en el parámetro: un `next` con `//otro.sitio` o `https://…` sería una redirección
 * abierta servida por nuestro propio dominio. Solo se aceptan rutas que empiecen por `/pos/` y sin
 * doble barra inicial; cualquier otra cosa cae al destino de siempre.
 */
function destinoSeguro(next: string | undefined): string {
  if (!next) return "/caja?abierta=1";
  if (!next.startsWith("/pos/") || next.startsWith("//")) return "/caja?abierta=1";
  if (next.includes("\\") || next.includes("..")) return "/caja?abierta=1";
  return next;
}

export async function openRegisterAction(
  _prev: RegisterActionState,
  form: FormData,
): Promise<RegisterActionState> {
  const s = await requireSession("pos.register");
  const parsed = openSchema.safeParse({
    opening_cash_cents: form.get("opening_cash_cents"),
    notes: form.get("notes") || undefined,
    next: (form.get("next") as string | null) || undefined,
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
  redirect(destinoSeguro(parsed.data.next));
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
