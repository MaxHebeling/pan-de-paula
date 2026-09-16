import { NextResponse } from "next/server";
import { customerRegistrationSchema } from "@pdp/domain";
import { db, callFn, withStaff } from "@/lib/db";
import {
  apiSession,
  dbErrorResponse,
  getCustomer,
  jsonError,
  readJson,
  searchCustomers,
} from "@/lib/pos";

export const dynamic = "force-dynamic";

/** GET ?q=  → busca por QR token / código PDP / teléfono / email (exacto) o nombre (parcial). */
export async function GET(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ customers: [] });
  try {
    const customers = await searchCustomers(q);
    return NextResponse.json({ customers });
  } catch (e) {
    return dbErrorResponse(e, "buscar cliente");
  }
}

const quickSchema = customerRegistrationSchema;

/**
 * POST {full_name, phone?, email?} → alta rápida desde POS (deduplica por teléfono/email).
 *
 * Excepción documentada al correo obligatorio (migración 0043): esta alta ocurre en el mostrador con
 * fila detrás; exigir el correo para poder cobrar frenaría la venta. El panel del POS sí ofrece el
 * campo de correo (opcional) porque es la llave del portal del cliente, y si el cliente lo da ahí
 * queda listo; si no, el CRM puede completarlo después sin duplicar el registro.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  const parsed = quickSchema.safeParse({
    ...(typeof body === "object" && body ? body : {}),
    source: "pos",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(400, issue?.message ?? "Datos inválidos", "VALIDATION");
  }
  try {
    const r = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<{ customer_id: string; created: boolean }>(trx, "register_customer", [
        JSON.stringify({ ...parsed.data, allow_without_email: true }),
      ]),
    );
    const customer = await getCustomer(r.customer_id);
    return NextResponse.json({ customer, created: r.created }, { status: r.created ? 201 : 200 });
  } catch (e) {
    return dbErrorResponse(e, "register_customer");
  }
}
