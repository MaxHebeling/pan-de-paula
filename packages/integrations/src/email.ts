/** Email transaccional (Resend). Si no hay API key, se registra y no falla el flujo principal. */
import { NotConfiguredError } from "./errors.ts";

export type EmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
};
export type EmailResult = {
  sent: boolean;
  id?: string;
  skipped?: "not_configured";
  error?: string;
};

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(_input: EmailInput): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  throw new Error("sendEmail: pendiente de implementación");
}

export type ReceiptData = {
  folio: string;
  businessName: string;
  soldAt: Date;
  items: Array<{ name: string; qty: number; unitPriceCents: number; totalCents: number }>;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  payments: Array<{ method: string; amountCents: number }>;
  customerName?: string | null;
  pointsEarned?: number;
  pointsBalance?: number;
};

/** HTML del comprobante (compartido por email, impresión y PDF). */
export function renderReceiptHtml(_data: ReceiptData): string {
  throw new Error("renderReceiptHtml: pendiente de implementación");
}

export async function sendReceiptEmail(_to: string, _data: ReceiptData): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  throw new Error("sendReceiptEmail: pendiente de implementación");
}

export { NotConfiguredError };
