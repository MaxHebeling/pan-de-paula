import { NextResponse } from "next/server";
import { z } from "zod";
import { emailSchema, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@pdp/domain";
import { NotConfiguredError, isEmailConfigured, sendReceiptEmail, type ReceiptData } from "@pdp/integrations";
import { db, sql } from "@/lib/db";
import { apiSession, dbErrorResponse, getFlags, jsonError, loadReceipt, readJson, receiptText } from "@/lib/pos";

export const dynamic = "force-dynamic";

const schema = z.object({
  orderId: z.string().uuid(),
  channel: z.enum(["email", "whatsapp", "print"]),
  destination: z.string().trim().max(254).optional(),
});

async function logReceipt(orderId: string, channel: string, destination: string | null, status: "sent" | "failed", error?: string) {
  await sql`insert into receipts(order_id, channel, destination, status, error)
            values (${orderId}::uuid, ${channel}, ${destination}, ${status}, ${error ?? null})`.execute(db());
}

/**
 * Comprobantes: email (si flag email_receipts y Resend configurado), WhatsApp (devuelve el enlace wa.me) e
 * impresión (solo registra). Todo intento queda en `receipts`.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return jsonError(400, "Datos inválidos", "VALIDATION");
  const { orderId, channel, destination } = parsed.data;
  let receipt;
  try {
    receipt = await loadReceipt(orderId);
  } catch (e) {
    return dbErrorResponse(e, "cargar recibo");
  }
  if (!receipt) return jsonError(404, "Pedido no encontrado", "NOT_FOUND");

  try {
    if (channel === "print") {
      await logReceipt(orderId, "print", null, "sent");
      return NextResponse.json({ ok: true });
    }
    if (channel === "whatsapp") {
      const phone = (destination ?? receipt.customerPhone ?? "").replace(/[^0-9]/g, "");
      if (phone.length < 10) return jsonError(400, "Escribe un teléfono válido (10 dígitos)", "VALIDATION");
      const intl = phone.length === 10 ? `52${phone}` : phone;
      const url = `https://wa.me/${intl}?text=${encodeURIComponent(receiptText(receipt))}`;
      await logReceipt(orderId, "whatsapp", intl, "sent");
      return NextResponse.json({ ok: true, url });
    }
    // email
    const flags = await getFlags(["email_receipts"] as const);
    if (!flags.email_receipts) return jsonError(409, "El envío de comprobantes por email está desactivado", "FLAG_OFF");
    const to = emailSchema.safeParse(destination ?? receipt.customerEmail ?? "");
    if (!to.success) return jsonError(400, "Escribe un email válido", "VALIDATION");
    if (!isEmailConfigured()) {
      return jsonError(503, "El correo no está configurado (RESEND_API_KEY, EMAIL_FROM).", "EMAIL_NOT_CONFIGURED");
    }
    const data: ReceiptData = {
      folio: receipt.folio,
      businessName: receipt.business.name,
      soldAt: receipt.soldAt,
      items: receipt.items.map((i) => ({
        name: i.variantLabel ? `${i.name} (${i.variantLabel})` : i.name,
        qty: i.qty,
        unitPriceCents: i.unitPriceCents,
        totalCents: i.totalCents,
      })),
      subtotalCents: receipt.subtotalCents,
      discountCents: receipt.discountCents,
      totalCents: receipt.totalCents,
      payments: receipt.payments.map((p) => ({
        method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
        amountCents: p.amountCents,
      })),
      customerName: receipt.customer?.name ?? null,
      pointsEarned: receipt.pointsEarned,
      pointsBalance: receipt.pointsBalance ?? undefined,
    };
    try {
      const r = await sendReceiptEmail(to.data, data);
      if (!r.sent) {
        const reason = r.skipped === "not_configured" ? "El correo no está configurado" : (r.error ?? "No se pudo enviar");
        await logReceipt(orderId, "email", to.data, "failed", reason);
        return jsonError(503, reason, "EMAIL_FAILED");
      }
      await logReceipt(orderId, "email", to.data, "sent");
      return NextResponse.json({ ok: true, id: r.id ?? null });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const friendly =
        e instanceof NotConfiguredError
          ? "El correo no está configurado"
          : /pendiente de implementaci/i.test(msg)
            ? "El envío de comprobantes por email aún no está disponible en esta versión"
            : "No se pudo enviar el correo";
      console.error("[pos] sendReceiptEmail", msg);
      await logReceipt(orderId, "email", to.data, "failed", friendly);
      return jsonError(503, friendly, "EMAIL_FAILED");
    }
  } catch (e) {
    return dbErrorResponse(e, "receipts");
  }
}
