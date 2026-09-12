import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Notificaciones sin leer del staff actual (globales + propias). */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const r = await sql<{ n: number }>`
    select count(*)::int as n from notifications
    where read_at is null and (staff_id is null or staff_id = ${session.staff.id})`.execute(db());
  return NextResponse.json(
    { unread: r.rows[0]?.n ?? 0 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
