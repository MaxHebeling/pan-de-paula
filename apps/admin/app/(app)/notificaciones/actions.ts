"use server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { db, sql, withStaff } from "@/lib/db";
import { fail, str } from "@/lib/ops";
import type { FormState } from "@/components/ops/action-form";

/** Marca una notificación como leída (solo globales o propias). */
export async function markReadAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const id = str(form, "id");
  if (!z.string().uuid().safeParse(id).success) return { error: "Notificación inválida" };
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      sql`update notifications set read_at = now() where id = ${id} and read_at is null and (staff_id is null or staff_id = ${session.staff.id})`.execute(
        trx,
      ),
    );
    return { ok: true };
  } catch (e) {
    return fail(e, "mark_read");
  }
}

/** Marca todas las visibles (globales + propias) como leídas. */
export async function markAllReadAction(_prev: FormState, _form: FormData): Promise<FormState> {
  const session = await requireSession();
  try {
    const r = await withStaff(db(), session.staff.id, (trx) =>
      sql<{
        n: number;
      }>`with u as (update notifications set read_at = now() where read_at is null and (staff_id is null or staff_id = ${session.staff.id}) returning 1)
                          select count(*)::int as n from u`.execute(trx),
    );
    return { ok: true, message: `${r.rows[0]?.n ?? 0} notificaciones marcadas como leídas` };
  } catch (e) {
    return fail(e, "mark_all_read");
  }
}
