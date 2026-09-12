import "server-only";
import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "Falta DATABASE_URL"),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_ADMIN_URL: z.string().url().default("http://localhost:3001"),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_PUBLIC_KEY: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  INSTAGRAM_PAGE_ACCESS_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

let cached: z.infer<typeof schema> | null = null;

/** Variables validadas una sola vez. Falla temprano con mensaje claro si falta algo crítico. */
export function env(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      "Configuración inválida: " +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  cached = parsed.data;
  return cached;
}
