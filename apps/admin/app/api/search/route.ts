import { NextResponse, type NextRequest } from "next/server";
import { getSession, hasPermission } from "@/lib/auth";
import { globalSearch, searchScope } from "@/lib/search";

export const dynamic = "force-dynamic";

/** GET /api/search?q=texto — clientes, pedidos y productos para la búsqueda global (requiere sesión). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q") ?? "";
  try {
    const r = await globalSearch(
      q,
      6,
      searchScope((perm) => hasPermission(session, perm)),
    );
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[search] falló", { q, error: (e as Error).message });
    return NextResponse.json({ error: "La búsqueda falló" }, { status: 500 });
  }
}
