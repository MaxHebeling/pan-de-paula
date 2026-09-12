/** Clientes: register_customer(source='import'). Identidad = teléfono/email; nombres parecidos se reportan, no se fusionan. */

import type { EntityHandler, WorkUnit } from "../types.ts";
import {
  bool,
  errorUnit,
  loadCustomers,
  mappedErrors,
  resolveByName,
  rowFrom,
  similarReason,
  skippedUnit,
  str,
} from "./common.ts";
import { callFn } from "../../../src/index.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const customers: EntityHandler = {
  entity: "customers",
  fields: {
    full_name: { transform: "text", required: true, help: "Nombre completo (Cliente)" },
    phone: { transform: "phone", help: "Teléfono a 10 dígitos (Teléfono)" },
    email: { transform: "text", help: "Email" },
    birthday: { transform: "date", help: "Cumpleaños (dd/mm/aaaa)" },
    notes: { transform: "text", help: "Notas" },
    marketing_consent: { transform: "bool", help: "Acepta promociones (sí/no)" },
  },
  async plan(rows, ctx) {
    const existing = await loadCustomers(ctx.db);
    const seenPhone = new Map<string, number>();
    const seenEmail = new Map<string, number>();
    const units: WorkUnit[] = [];
    for (const mr of rows) {
      const bad = mappedErrors(mr);
      if (bad) {
        units.push(bad);
        continue;
      }
      const name = str(mr.values.full_name)!;
      const phone = str(mr.values.phone);
      const email = str(mr.values.email)?.toLowerCase() ?? null;
      if (email && !EMAIL_RE.test(email)) {
        units.push(errorUnit(mr, `Email inválido: "${email}"`, mr.values));
        continue;
      }
      if (!phone && !email) {
        units.push(
          errorUnit(mr, "Se requiere teléfono o email para registrar al cliente", mr.values),
        );
        continue;
      }
      if (phone && seenPhone.has(phone)) {
        units.push(
          skippedUnit(
            mr,
            `Teléfono repetido en el archivo (fila ${seenPhone.get(phone)})`,
            mr.values,
          ),
        );
        continue;
      }
      if (email && seenEmail.has(email)) {
        units.push(
          skippedUnit(mr, `Email repetido en el archivo (fila ${seenEmail.get(email)})`, mr.values),
        );
        continue;
      }
      if (phone) seenPhone.set(phone, mr.rowNumber);
      if (email) seenEmail.set(email, mr.rowNumber);
      const normalized = {
        full_name: name,
        phone,
        email,
        birthday: str(mr.values.birthday),
        notes: str(mr.values.notes),
        marketing_consent: bool(mr.values.marketing_consent) ?? false,
        source: "import",
      };
      const byContact = existing.find(
        (c) => (phone && c.phone === phone) || (email && c.email?.toLowerCase() === email),
      );
      let action: "created" | "matched" = "created";
      if (byContact) {
        action = "matched";
      } else {
        const res = resolveByName(name, existing, (c) => c.full_name, ctx);
        if (res.kind !== "none" && ctx.options.similar_policy === "skip") {
          const other = res.item;
          const score = res.kind === "similar" ? res.score : 1;
          units.push(
            skippedUnit(
              mr,
              similarReason(
                name,
                other.full_name,
                score,
                ` — ${other.public_code}${other.phone ? ", tel " + other.phone : ""} con otro contacto`,
              ),
              normalized,
            ),
          );
          continue;
        }
      }
      const row = rowFrom(mr, action, normalized);
      row.targetId = byContact?.id ?? null;
      units.push({
        key: `row-${mr.rowNumber}`,
        rows: [row],
        apply: async (trx) => {
          const r = await callFn<{ customer_id: string; created: boolean }>(
            trx,
            "register_customer",
            [JSON.stringify(normalized)],
          );
          if (r.created)
            existing.push({ id: r.customer_id, full_name: name, phone, email, public_code: "" });
          return { targetId: r.customer_id, action: r.created ? "created" : "matched" };
        },
      });
    }
    return units;
  },
};
