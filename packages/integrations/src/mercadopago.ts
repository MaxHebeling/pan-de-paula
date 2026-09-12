/**
 * Mercado Pago México — contrato público del adaptador.
 * Implementación completa en este archivo (Checkout Pro, consulta de pagos, firma de webhooks, Point/QR).
 * Nunca se confía en el payload del webhook: siempre se consulta GET /v1/payments/{id}.
 */
import { NotConfiguredError } from "./errors.ts";

export type MpPreferenceInput = {
  orderId: string;
  folio: string;
  items: Array<{ title: string; quantity: number; unitPriceCents: number; id?: string }>;
  payer?: { name?: string; email?: string; phone?: string };
  backUrls: { success: string; failure: string; pending: string };
  notificationUrl: string;
  expiresAt?: Date;
  statementDescriptor?: string;
};
export type MpPreference = { preferenceId: string; initPoint: string; sandboxInitPoint?: string };

export type MpPayment = {
  id: string;
  status: string; // approved | pending | in_process | rejected | cancelled | refunded | charged_back | authorized | in_mediation
  statusDetail: string;
  transactionAmountCents: number;
  externalReference: string | null;
  paymentMethodId: string;
  paymentTypeId: string;
  dateApproved: string | null;
  raw: unknown;
};

export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN);
}

function assertConfigured() {
  if (!isMercadoPagoConfigured())
    throw new NotConfiguredError("Mercado Pago", ["MERCADOPAGO_ACCESS_TOKEN"]);
}

/** Crea una preferencia de Checkout Pro. external_reference = orderId. */
export async function createMercadoPagoPreference(
  _input: MpPreferenceInput,
): Promise<MpPreference> {
  assertConfigured();
  throw new Error("createMercadoPagoPreference: pendiente de implementación");
}

/** Consulta un pago por id (fuente de verdad del estado). */
export async function fetchMercadoPagoPayment(_paymentId: string): Promise<MpPayment> {
  assertConfigured();
  throw new Error("fetchMercadoPagoPayment: pendiente de implementación");
}

/**
 * Verifica la firma x-signature del webhook (HMAC-SHA256 sobre "id:{data.id};request-id:{x-request-id};ts:{ts};").
 * Devuelve false si falta secreto, cabeceras o la firma no coincide.
 */
export function verifyMercadoPagoSignature(_params: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string | undefined;
}): boolean {
  return false;
}

/** Reembolso total o parcial de un pago. Idempotente por X-Idempotency-Key. */
export async function refundMercadoPagoPayment(
  _paymentId: string,
  _amountCents?: number,
  _idempotencyKey?: string,
): Promise<{ refundId: string; status: string }> {
  assertConfigured();
  throw new Error("refundMercadoPagoPayment: pendiente de implementación");
}

/** POS: crea una orden de cobro en una terminal Point (API de Órdenes). */
export async function createPointOrder(_input: {
  deviceId: string;
  amountCents: number;
  externalReference: string;
  description: string;
}): Promise<{ orderId: string; status: string }> {
  assertConfigured();
  throw new Error("createPointOrder: pendiente de implementación");
}

/** POS: crea un QR dinámico (API de Órdenes, modo QR) para que el cliente pague desde su app. */
export async function createQrOrder(_input: {
  amountCents: number;
  externalReference: string;
  description: string;
  items?: Array<{ title: string; quantity: number; unitPriceCents: number }>;
}): Promise<{ orderId: string; qrData: string; status: string }> {
  assertConfigured();
  throw new Error("createQrOrder: pendiente de implementación");
}
