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
  .refine((s) => /^\+?\d{10,15}$/.test(s), "Teléfono inválido (10 dígitos)");

export const emailSchema = z.string().trim().toLowerCase().email("Email inválido").max(254);

export const customerRegistrationSchema = z
  .object({
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
  })
  .refine((v) => v.phone || v.email, { message: "Se requiere teléfono o email", path: ["phone"] });

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
