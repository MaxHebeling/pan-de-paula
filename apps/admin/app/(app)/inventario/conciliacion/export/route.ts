import { NextResponse, type NextRequest } from "next/server";
import { getSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";

export const dynamic = "force-dynamic";

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Exporta la conciliación de inventario (inventory_reconciliation) del rango como CSV. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !hasPermission(session, "inventory.read"))
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const desde = req.nextUrl.searchParams.get("desde");
  const hasta = req.nextUrl.searchParams.get("hasta");
  if (!isDate(desde) || !isDate(hasta))
    return NextResponse.json({ error: "Rango inválido (desde/hasta YYYY-MM-DD)" }, { status: 400 });
  const rows = await sql<Record<string, string>>`
    select product_name, opening::text, production::text, sales::text, waste::text, corrections::text, other::text, closing::text
    from inventory_reconciliation(
      (${desde}::date)::timestamp at time zone (select timezone from business_settings where id = 1),
      ((${hasta}::date + 1)::timestamp) at time zone (select timezone from business_settings where id = 1))`.execute(db());
  const header = ["producto", "apertura", "produccion", "ventas", "mermas", "correcciones", "otros", "cierre"];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    header.join(","),
    ...rows.rows.map((r) =>
      [r.product_name!, r.opening!, r.production!, r.sales!, r.waste!, r.corrections!, r.other!, r.closing!]
        .map(esc)
        .join(","),
    ),
  ];
  return new NextResponse("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="conciliacion_${desde}_${hasta}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
