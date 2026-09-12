import "server-only";
import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "Falta DATABASE_URL"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET debe tener 32+ caracteres"),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_ADMIN_URL: z.string().url().default("http://localhost:3001"),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_POINT_DEVICE_ID: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("product-images"),
  SENTRY_DSN: z.string().optional(),
});

let cached: z.infer<typeof schema> | null = null;
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
