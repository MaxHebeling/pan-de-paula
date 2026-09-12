import { NextResponse, type NextRequest } from "next/server";
import { getSession, hasPermission } from "@/lib/auth";
import { exportRows, toCsv, REPORT_KINDS, type ReportKind } from "@/lib/reports";

export const dynamic = "force-dynamic";

const isDate = (s: string | null): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

/** GET /api/reports/export?report=diario&from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv — requiere reports.export. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (!hasPermission(session, "reports.export")) return NextResponse.json({ error: "Sin permiso para exportar reportes" }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("report") as ReportKind | null;
  if (!kind || !REPORT_KINDS.some((k) => k.key === kind)) return NextResponse.json({ error: "Reporte inválido" }, { status: 400 });
  const from = sp.get("from");
  const to = sp.get("to");
  if (!isDate(from) || !isDate(to) || from > to) return NextResponse.json({ error: "Rango inválido (from/to YYYY-MM-DD)" }, { status: 400 });
  try {
    const data = await exportRows(kind, from, to);
    const csv = toCsv(data.columns, data.rows);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${data.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    console.error("[reportes] exportación falló", { kind, from, to, error: (e as Error).message });
    return NextResponse.json({ error: "No se pudo generar el reporte" }, { status: 500 });
  }
}
