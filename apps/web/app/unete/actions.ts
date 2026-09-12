"use server";

import { redirect } from "next/navigation";
import { customerRegistrationSchema } from "@pdp/domain";
import { callFn, db, dbErrorMessage } from "@/lib/db";
import { rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

export type JoinValues = {
  full_name: string;
  phone: string;
  email: string;
  birthday: string;
  marketing_consent: boolean;
};
export type JoinState = { error?: string; field?: string; values?: JoinValues } | null;

export async function joinClubAction(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const raw = {
    full_name: String(formData.get("full_name") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    birthday: String(formData.get("birthday") ?? ""),
    marketing_consent: formData.get("marketing_consent") === "on",
    source: "qr" as const,
  };
  const parsed = customerRegistrationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0]?.toString();
    const msg =
      field === "phone" && !raw.phone && !raw.email
        ? "Necesitamos tu teléfono (o tu correo) para crear tu tarjeta."
        : field === "phone"
          ? "Escribe un teléfono válido de 10 dígitos."
          : field === "email"
            ? "Ese correo no parece válido."
            : field === "full_name"
              ? "Escribe tu nombre."
              : (issue?.message ?? "Revisa los datos.");
    return { error: msg, field, values: { ...raw } };
  }
  let token: string;
  try {
    const rl = await rateLimit("register");
    if (!rl.allowed) return { error: RATE_LIMIT_MESSAGE, values: { ...raw } };
    const r = await callFn<{
      customer_id: string;
      public_code: string;
      qr_token: string;
      created: boolean;
    }>(db(), "register_customer", [JSON.stringify(parsed.data)]);
    token = r.qr_token;
    if (!r.created) {
      console.info(`[club] registro repetido, se reutiliza la cuenta ${r.public_code}`);
    }
  } catch (e) {
    console.error("[joinClubAction]", e);
    return { error: dbErrorMessage(e).message, values: { ...raw } };
  }
  redirect(`/mi-tarjeta/${encodeURIComponent(token)}?bienvenida=1`);
}
