import { NextResponse } from "next/server";
import { customerRegistrationCompleteSchema, parseOptionalPhone } from "@pdp/domain";
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

const quickSchema = customerRegistrationCompleteSchema;

/**
 * POST {full_name, phone, email, birthday} → alta desde el POS (deduplica por teléfono/email).
 *
 * Desde la migración 0045 el alta pide los cuatro datos, aquí y en cualquier otra pantalla: el correo
 * es la llave del portal y de la fecha de nacimiento sale el cumpleaños. En mostrador esto NO frena
 * la venta: si el cliente no quiere darlos, se cobra sin asignarle cuenta y se le da de alta después.
 * Un cliente que ya existe no se duplica: `register_customer` le completa los huecos y devuelve el suyo.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  const raw = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
  // El servidor manda: país + número se combinan aquí en el valor canónico que se guarda
  // (10 dígitos si es México, "+<prefijo><nacional>" en el resto).
  const phone = parseOptionalPhone(
    typeof raw.phone_country === "string" ? raw.phone_country : null,
    typeof raw.phone === "string" ? raw.phone : "",
  );
  if (!phone.ok) return jsonError(400, phone.error, "VALIDATION");
  const parsed = quickSchema.safeParse({
    ...raw,
    phone: phone.value ?? "",
    source: "pos",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(400, issue?.message ?? "Datos inválidos", "VALIDATION");
  }
  try {
    const r = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<{ customer_id: string; created: boolean }>(trx, "register_customer", [
        JSON.stringify(parsed.data),
      ]),
    );
    const customer = await getCustomer(r.customer_id);
    return NextResponse.json({ customer, created: r.created }, { status: r.created ? 201 : 200 });
  } catch (e) {
    return dbErrorResponse(e, "register_customer");
  }
}
