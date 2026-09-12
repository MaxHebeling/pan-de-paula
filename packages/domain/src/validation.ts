/** Esquemas zod compartidos entre apps (validación en servidor siempre). */
import { z } from "zod";

export const phoneMX = z
  .string()
  .trim()
  .transform((s) => s.replace(/[^0-9+]/g, ""))
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
