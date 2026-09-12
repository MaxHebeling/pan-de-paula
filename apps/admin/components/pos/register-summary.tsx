import { formatMXN } from "@pdp/domain";
import type { RegisterSummary } from "@/lib/pos";

/** Desglose de una sesión de caja (pantalla y corte impreso). Sin "use client": se puede renderizar en servidor. */
export function RegisterSummaryTable({ s, compact = false }: { s: RegisterSummary; compact?: boolean }) {
  const closed = s.status === "closed";
  const rows: Array<{ label: string; value: string; strong?: boolean; tone?: string }> = [
    { label: "Fondo inicial", value: formatMXN(s.opening_cash_cents) },
    { label: "Ventas en efectivo", value: `+${formatMXN(s.cash_cents)}` },
    ...(s.refunds_cash_cents ? [{ label: "Reembolsos en efectivo", value: `−${formatMXN(s.refunds_cash_cents)}` }] : []),
    { label: "Efectivo esperado", value: formatMXN(s.expected_cash_cents), strong: true },
    ...(closed && s.counted_cash_cents !== null
      ? [
          { label: "Efectivo contado", value: formatMXN(s.counted_cash_cents), strong: true },
          {
            label: "Diferencia",
            value: `${(s.difference_cents ?? 0) > 0 ? "+" : (s.difference_cents ?? 0) < 0 ? "−" : ""}${formatMXN(Math.abs(s.difference_cents ?? 0))}`,
            strong: true,
            tone: (s.difference_cents ?? 0) === 0 ? "text-green-d" : "text-red-d",
          },
        ]
      : []),
    { label: "Tarjeta (terminal)", value: formatMXN(s.card_cents) },
    { label: "Transferencias", value: formatMXN(s.transfer_cents) },
    { label: "Mercado Pago", value: formatMXN(s.mercadopago_cents) },
    ...(s.other_cents ? [{ label: "Otros", value: formatMXN(s.other_cents) }] : []),
    ...(s.refunds_other_cents ? [{ label: "Reembolsos (no efectivo)", value: `−${formatMXN(s.refunds_other_cents)}` }] : []),
    { label: `Ventas (${s.sales_count})${s.voided_count ? ` · ${s.voided_count} anuladas` : ""}`, value: formatMXN(s.sales_total_cents), strong: true },
  ];
  return (
    <table className={`w-full ${compact ? "text-sm" : "text-base"}`} data-testid="register-summary">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-line first:border-0">
            <td className={`py-1.5 ${r.strong ? "font-semibold" : "text-muted"}`}>{r.label}</td>
            <td className={`py-1.5 text-right tabular-nums ${r.strong ? "font-semibold" : ""} ${r.tone ?? ""}`} data-testid={r.label === "Diferencia" ? "summary-difference" : undefined}>
              {r.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
