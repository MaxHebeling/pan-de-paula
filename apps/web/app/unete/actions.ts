"use server";

import { redirect } from "next/navigation";
import { customerRegistrationWithEmailSchema, parseOptionalPhone } from "@pdp/domain";
import { isEmailConfigured, sendEmail } from "@pdp/integrations";
import { findCustomer } from "@/lib/customers";
import { callFn, db, dbErrorMessage } from "@/lib/db";
import { cardUrl } from "@/lib/qr";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { getBusiness } from "@/lib/site";

export type JoinValues = {
  full_name: string;
  /** País (ISO) elegido en el selector; se repuebla tal cual si hay que mostrar un error. */
  phone_country: string;
  /** Número NACIONAL tal como lo escribió la persona (sin prefijo de país). */
  phone: string;
  email: string;
  birthday: string;
  marketing_consent: boolean;
};
export type JoinState = {
  error?: string;
  field?: string;
  /** "existing": ya hay una tarjeta con ese teléfono/correo; no se muestra ni se modifica (privacidad). */
  notice?: "existing";
  emailSent?: boolean;
  values?: JoinValues;
} | null;

export async function joinClubAction(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const raw = {
    full_name: String(formData.get("full_name") ?? ""),
    phone_country: String(formData.get("phone_country") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    birthday: String(formData.get("birthday") ?? ""),
    marketing_consent: formData.get("marketing_consent") === "on",
    source: "qr" as const,
  };
  // El servidor manda: país + número se combinan aquí en el valor canónico que se guarda
  // (10 dígitos si es México, "+<prefijo><nacional>" en cualquier otro país). El navegador no decide.
  const phone = parseOptionalPhone(raw.phone_country, raw.phone);
  if (!phone.ok) return { error: phone.error, field: "phone", values: { ...raw } };
  // Alta humana: el correo es obligatorio (es la llave de /portal). Mismo criterio en el servidor SQL.
  const parsed = customerRegistrationWithEmailSchema.safeParse({
    ...raw,
    phone: phone.value ?? "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0]?.toString();
    const msg =
      field === "phone"
        ? "Escribe un teléfono válido."
        : field === "email"
          ? !raw.email
            ? "Necesitamos tu correo: con él entras a tu cuenta y te mandamos tu tarjeta."
            : "Ese correo no parece válido."
          : field === "full_name"
            ? "Escribe tu nombre."
            : (issue?.message ?? "Revisa los datos.");
    return { error: msg, field, values: { ...raw } };
  }
  let token: string;
  try {
    const rl = await rateLimit("register");
    if (!rl.allowed) return { error: RATE_LIMIT_MESSAGE, values: { ...raw } };

    // Ya existe una cuenta con ese teléfono o correo: no se revela, no se modifica y no se redirige a su
    // tarjeta (cualquiera podría escribir el teléfono de otra persona). Si la cuenta tiene correo y el envío
    // está configurado, se le manda el enlace a ESE correo.
    const existing =
      (parsed.data.phone ? await findCustomer(parsed.data.phone) : null) ??
      (parsed.data.email ? await findCustomer(parsed.data.email) : null);
    if (existing) {
      console.info(`[club] registro repetido para ${existing.publicCode}; no se expone la tarjeta`);
      return { notice: "existing", emailSent: await sendCardLink(existing), values: { ...raw } };
    }

    const r = await callFn<{
      customer_id: string;
      public_code: string;
      qr_token: string;
      created: boolean;
    }>(db(), "register_customer", [JSON.stringify(parsed.data)]);
    if (!r.created) {
      // Carrera entre la comprobación y el alta: mismo tratamiento que arriba.
      console.info(`[club] registro repetido (carrera) para ${r.public_code}`);
      return { notice: "existing", emailSent: false, values: { ...raw } };
    }
    token = r.qr_token;
  } catch (e) {
    // 23505: dos altas simultáneas con el mismo correo/teléfono. Mismo trato que "ya existe" para no
    // confirmarle a nadie que un correo ajeno está registrado.
    if ((e as { code?: string }).code === "23505") {
      console.info("[club] alta simultánea con datos ya registrados; respuesta genérica");
      return { notice: "existing", emailSent: false, values: { ...raw } };
    }
    console.error("[joinClubAction]", e);
    return { error: dbErrorMessage(e).message, values: { ...raw } };
  }
  redirect(`/mi-tarjeta/${encodeURIComponent(token)}?bienvenida=1`);
}

async function sendCardLink(c: {
  id: string;
  email: string | null;
  qrToken: string;
  fullName: string;
}) {
  if (!c.email || !isEmailConfigured()) return false;
  try {
    const business = await getBusiness();
    const link = cardUrl(c.qrToken);
    const first = c.fullName.split(/\s+/)[0] ?? "";
    const r = await sendEmail({
      to: c.email,
      subject: `Tu tarjeta del club · ${business.name}`,
      html: `<p>Hola ${escapeHtml(first)}, aquí tienes el enlace a tu tarjeta del club de ${escapeHtml(business.name)}:</p><p><a href="${link}">${link}</a></p><p>Es personal: no lo compartas.</p>`,
      text: `Hola ${first}, tu tarjeta del club de ${business.name}: ${link}`,
      idempotencyKey: `card-link-${c.id}-${new Date().toISOString().slice(0, 10)}`,
    });
    return Boolean(r.sent);
  } catch (e) {
    console.error("[club] no se pudo enviar el enlace de la tarjeta", e);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
