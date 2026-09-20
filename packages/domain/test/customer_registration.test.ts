/**
 * Alta de cliente con datos completos, del lado del formulario.
 *
 * Es el espejo en TypeScript de lo que `register_customer` vuelve a exigir en SQL (0045): aquí se
 * comprueba que el mensaje que ve la persona sea el correcto y que la normalización (correo en
 * minúsculas, teléfono canónico) ocurra ANTES de llegar a la base.
 */
import { describe, expect, it } from "vitest";
import {
  birthdaySchema,
  customerRegistrationCompleteSchema,
  customerRegistrationWithEmailSchema,
} from "../src/validation.ts";

const completo = {
  full_name: "Rosa Méndez",
  phone: "664 123 0001",
  email: "  Rosa@Correo.COM ",
  birthday: "1990-03-21",
  source: "web" as const,
};

const err = (input: Record<string, unknown>) => {
  const r = customerRegistrationCompleteSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? "" : (r.error.issues[0]?.message ?? "");
};

describe("alta completa de cliente", () => {
  it("acepta los cuatro datos y los deja normalizados", () => {
    const r = customerRegistrationCompleteSchema.parse(completo);
    expect(r).toMatchObject({
      full_name: "Rosa Méndez",
      phone: "6641230001", // canónico: 10 dígitos en México
      email: "rosa@correo.com", // minúsculas y sin espacios
      birthday: "1990-03-21",
    });
  });

  it("dice qué falta, con el nombre que usa la panadería", () => {
    expect(err({ ...completo, phone: "" })).toMatch(/celular es obligatorio/i);
    expect(err({ ...completo, email: "" })).toMatch(/correo electrónico es obligatorio/i);
    expect(err({ ...completo, birthday: "" })).toMatch(/fecha de nacimiento es obligatoria/i);
    expect(err({ ...completo, full_name: " " })).toMatch(/nombre/i);
  });

  it("distingue 'vacío' de 'mal escrito'", () => {
    expect(err({ ...completo, email: "no-es-correo" })).toMatch(/no parece válido/i);
    expect(err({ ...completo, phone: "123" })).toMatch(/inválido/i);
  });

  it("no acepta fechas futuras, imposibles ni anteriores a 1900", () => {
    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(err({ ...completo, birthday: manana })).toMatch(/no puede ser futura/i);
    expect(err({ ...completo, birthday: "1990-02-31" })).toMatch(/no existe/i);
    expect(err({ ...completo, birthday: "1899-12-31" })).toMatch(/revisa/i);
    expect(err({ ...completo, birthday: "21/03/1990" })).toMatch(/día, mes y año/i);
    // Hoy sí vale: el día de hoy no es futuro (una fecha de nacimiento de hoy es un recién nacido).
    expect(birthdaySchema.safeParse(new Date().toISOString().slice(0, 10)).success).toBe(true);
  });

  it("el esquema anterior sigue existiendo para los flujos históricos", () => {
    // Importación y seeds siguen pudiendo dar de alta sin teléfono ni fecha.
    const r = customerRegistrationWithEmailSchema.safeParse({
      full_name: "Cliente histórico",
      email: "historico@correo.com",
    });
    expect(r.success).toBe(true);
  });
});
