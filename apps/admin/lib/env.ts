import "server-only";
import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "Falta DATABASE_URL"),
  // OJO: hoy esta variable NO protege nada. Se exige aquí y en `scripts/check-env.mjs`, pero ningún
  // módulo la lee: las sesiones del staff son un token aleatorio de 32 bytes guardado como sha256 en
  // `staff_sessions` (`packages/auth/src/session.ts`), no una cookie firmada con este secreto.
  // Se deja porque romper el contrato de entorno de dos proyectos de Vercel no gana seguridad, pero
  // nadie debe asumir que rotarla invalida sesiones ni que compartirla entre ambientes las expone.
  // Si algún día se firma algo, que sea con esta y se borre este comentario.
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
