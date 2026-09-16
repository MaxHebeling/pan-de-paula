/** Esquemas zod compartidos entre apps (validación en servidor siempre). */
import { z } from "zod";

// Zod v4 prueba `Function("")` para compilar validadores (JIT). Bajo la Content-Security-Policy (sin 'unsafe-eval')
// esa prueba genera una violación en cada carga del navegador; en modo jitless valida igual, sin eval.
z.config({ jitless: true });

/**
 * Normaliza un teléfono capturado a la forma canónica que se guarda y se compara:
 * números mexicanos ("+52 664 123 4567", "52 664…", "+521…", "01 664…") → 10 dígitos;
 * otros internacionales con "+" se conservan en E.164. Así "6641234567" y "+526641234567"
 * son el mismo cliente (espejo de normalize_mx_phone en SQL).
 *
 * Es la forma "a ciegas" (sin saber el país) que usan el POS, el importador y las búsquedas. Cuando
 * el formulario SÍ dice el país —selector con bandera— la función correcta es `parsePhone()` de
 * `./phone.ts`, que valida la longitud nacional y da un error en español. Las dos escriben el mismo
 * valor canónico: 10 dígitos para México, "+<prefijo><nacional>" para el resto.
 */
export function canonicalPhone(raw: string): string {
  const s = raw.replace(/[^0-9+]/g, "");
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("52")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("521")) return digits.slice(3);
  if (digits.length === 12 && digits.startsWith("01")) return digits.slice(2);
  return s.startsWith("+") ? `+${digits}` : digits;
}

export const phoneMX = z
  .string()
  .trim()
  .transform(canonicalPhone)
  .refine((s) => /^\+?\d{10,15}$/.test(s), "Teléfono inválido");

export const emailSchema = z.string().trim().toLowerCase().email("Email inválido").max(254);

/**
 * Correo OBLIGATORIO: mismo formato que `emailSchema` pero distingue "lo dejaste vacío" de
 * "está mal escrito" para poder dar un mensaje claro en el formulario.
 */
export const requiredEmailSchema = z
  .string({ message: "El correo electrónico es obligatorio" })
  .trim()
  .min(1, "El correo electrónico es obligatorio")
  .toLowerCase()
  .email("Ese correo no parece válido")
  .max(254);

const customerRegistrationFields = z.object({
  full_name: z.string().trim().min(2, "Nombre muy corto").max(120),
  phone: phoneMX.optional().or(z.literal("").transform(() => undefined)),
  email: emailSchema.optional().or(z.literal("").transform(() => undefined)),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  marketing_consent: z.boolean().default(false),
  source: z.enum(["pos", "web", "qr", "instagram", "import", "admin"]).default("qr"),
});

/**
 * Alta con correo opcional. Solo para los flujos con la excepción documentada de
 * `register_customer(allow_without_email)`: alta rápida del POS, importación histórica y seeds.
 */
export const customerRegistrationSchema = customerRegistrationFields.refine(
  (v) => v.phone || v.email,
  { message: "Se requiere teléfono o email", path: ["phone"] },
);

/**
 * Alta humana (sitio `/unete` y CRM): el correo es obligatorio porque es la llave del portal
 * del cliente (`/portal`). El teléfono sigue siendo opcional.
 */
export const customerRegistrationWithEmailSchema = customerRegistrationFields.extend({
  email: requiredEmailSchema,
});

export const cartItemSchema = z.object({
  product_id: z.string().uuid(),
  qty: z.number().int().positive().max(500),
  notes: z.string().trim().max(200).optional(),
});

export const webCheckoutSchema = z.object({
  items: z.array(cartItemSchema).min(1, "El carrito está vacío").max(50),
  fulfillment_type: z.enum(["pickup", "scheduled_pickup", "delivery", "preorder"]),
  ordering_window_id: z.string().uuid().optional(),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  pickup_point_id: z.string().uuid().optional(),
  customer_name: z.string().trim().min(2).max(120),
  customer_phone: phoneMX,
  customer_email: emailSchema.optional().or(z.literal("").transform(() => undefined)),
  delivery_address: z
    .object({
      street: z.string().trim().min(3).max(200),
      neighborhood: z.string().trim().max(120).optional(),
      references_note: z.string().trim().max(300).optional(),
    })
    .optional(),
  coupon_code: z
    .string()
    .trim()
    .max(40)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(500).optional(),
  payment_method: z.enum(["mercadopago", "cash", "transfer"]),
  marketing_consent: z.boolean().default(false),
  idempotency_key: z.string().min(8).max(80),
});
export type WebCheckoutInput = z.infer<typeof webCheckoutSchema>;

export const posCheckoutSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        qty: z.number().positive().max(999),
        discount_cents: z.number().int().nonnegative().optional(),
        notes: z.string().max(200).optional(),
      }),
    )
    .min(1),
  customer_id: z.string().uuid().optional().nullable(),
  coupon_code: z.string().trim().max(40).optional().nullable(),
  reward_redemption_id: z.string().uuid().optional().nullable(),
  payments: z.array(
    z.object({
      provider: z.enum(["cash", "mercadopago", "manual"]),
      method: z.enum(["cash", "mercadopago", "card_terminal", "transfer", "other"]),
      amount_cents: z.number().int().positive(),
      tendered_cents: z.number().int().positive().optional(),
      reference: z.string().trim().max(80).optional(),
      external_id: z.string().trim().max(80).optional(),
    }),
  ),
  register_session_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(300).optional(),
  idempotency_key: z.string().min(8).max(80),
});
export type PosCheckoutInput = z.infer<typeof posCheckoutSchema>;
