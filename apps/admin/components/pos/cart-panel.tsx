"use client";
import { useState } from "react";
import { Gift, Minus, Plus, StickyNote, Tag, Trash2, X } from "lucide-react";
import { formatMXN, type CartTotals } from "@pdp/domain";
import { CustomerPanel } from "./customer-panel";
import type { CartLineState, CouponResult, PosConfig, PosCustomer, RewardAvailable, RewardIssued } from "./types";

export type CartPanelProps = {
  lines: CartLineState[];
  totals: CartTotals;
  config: PosConfig;
  customer: PosCustomer | null;
  onSelectCustomer: (c: PosCustomer) => void;
  onClearCustomer: () => void;
  coupon: (CouponResult & { valid: true }) | null;
  couponMessage: string | null;
  couponBusy: boolean;
  onApplyCoupon: (code: string) => void;
  onRemoveCoupon: () => void;
  reward: RewardIssued | null;
  rewardsIssued: RewardIssued[];
  rewardsAvailable: RewardAvailable[];
  onSelectReward: (r: RewardIssued | null) => void;
  onRedeemReward: (r: RewardAvailable) => void;
  rewardBusy: boolean;
  onQty: (productId: string, delta: number) => void;
  onRemove: (productId: string) => void;
  onNote: (productId: string, note: string) => void;
  onDiscount: (productId: string, cents: number) => void;
  onClear: () => void;
  onCheckout: () => void;
};

function rewardLabel(r: RewardIssued) {
  switch (r.kind) {
    case "discount_pct":
      return `${(r.valueBps ?? 0) / 100}% de descuento`;
    case "discount_amount":
      return `${formatMXN(r.valueCents ?? 0, { compact: true })} de descuento`;
    case "free_product":
      return `${r.productName ?? "Producto"} gratis`;
    default:
      return "Regalo";
  }
}

export function CartPanel(p: CartPanelProps) {
  const [couponInput, setCouponInput] = useState("");
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [openDiscount, setOpenDiscount] = useState<string | null>(null);
  const [showRewards, setShowRewards] = useState(false);
  const empty = p.lines.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-base font-semibold">
          Venta{" "}
          {p.totals.itemsCount > 0 && (
            <span className="text-sm font-normal text-muted">
              · {p.totals.itemsCount} {p.totals.itemsCount === 1 ? "artículo" : "artículos"}
            </span>
          )}
        </h2>
        {!empty && (
          <button type="button" onClick={p.onClear} className="btn btn-secondary btn-sm min-h-9 text-red-d" aria-label="Vaciar carrito">
            <Trash2 size={15} /> Vaciar
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <p className="px-3 py-8 text-center text-sm text-muted">Toca un producto para agregarlo.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="cart-lines">
            {p.lines.map((l) => {
              const lineTotal = Math.max(Math.round(l.unitPriceCents * l.qty) - l.discountCents, 0);
              return (
                <li key={l.productId} className="py-2" data-testid="cart-line">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm font-semibold leading-tight">
                        {l.name}
                        {l.variantLabel ? <span className="font-normal text-muted"> · {l.variantLabel}</span> : null}
                      </div>
                      <div className="text-xs text-muted tabular-nums">
                        {formatMXN(l.unitPriceCents)} c/u
                        {l.discountCents > 0 && <span className="text-amber-d"> · −{formatMXN(l.discountCents)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1" role="group" aria-label={`Cantidad de ${l.name}`}>
                      <button type="button" onClick={() => p.onQty(l.productId, -1)} className="btn btn-secondary min-h-11 min-w-11 px-0" aria-label={`Quitar uno de ${l.name}`}>
                        <Minus size={16} />
                      </button>
                      <span className="w-8 text-center text-base font-semibold tabular-nums" data-testid="line-qty">
                        {l.qty}
                      </span>
                      <button type="button" onClick={() => p.onQty(l.productId, 1)} className="btn btn-secondary min-h-11 min-w-11 px-0" aria-label={`Agregar uno de ${l.name}`}>
                        <Plus size={16} />
                      </button>
                    </div>
                    <div className="w-20 text-right text-sm font-semibold tabular-nums">{formatMXN(lineTotal)}</div>
                  </div>
                  <div className="mt-1 flex gap-1 pl-0.5">
                    <button
                      type="button"
                      onClick={() => setOpenNote(openNote === l.productId ? null : l.productId)}
                      className={`btn btn-sm min-h-9 ${l.notes ? "st-blue" : "btn-secondary"}`}
                      aria-label={`Nota para ${l.name}`}
                    >
                      <StickyNote size={14} /> {l.notes ? "Nota" : "Nota"}
                    </button>
                    {p.config.canDiscount && (
                      <button
                        type="button"
                        onClick={() => setOpenDiscount(openDiscount === l.productId ? null : l.productId)}
                        className={`btn btn-sm min-h-9 ${l.discountCents ? "st-amber" : "btn-secondary"}`}
                        aria-label={`Descuento para ${l.name}`}
                      >
                        <Tag size={14} /> Desc.
                      </button>
                    )}
                    <button type="button" onClick={() => p.onRemove(l.productId)} className="btn btn-secondary btn-sm ml-auto min-h-9 text-red-d" aria-label={`Eliminar ${l.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                  {openNote === l.productId && (
                    <input
                      className="input mt-1.5 min-h-11 text-sm"
                      placeholder="Nota (ej. sin azúcar glass)"
                      value={l.notes}
                      maxLength={200}
                      autoFocus
                      onChange={(e) => p.onNote(l.productId, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && setOpenNote(null)}
                      aria-label={`Nota de ${l.name}`}
                    />
                  )}
                  {openDiscount === l.productId && p.config.canDiscount && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <label className="text-xs text-muted" htmlFor={`disc-${l.productId}`}>
                        Descuento $
                      </label>
                      <input
                        id={`disc-${l.productId}`}
                        type="number"
                        min={0}
                        step="0.5"
                        inputMode="decimal"
                        className="input min-h-11 w-28 text-sm"
                        value={l.discountCents ? (l.discountCents / 100).toString() : ""}
                        onChange={(e) => {
                          const v = Math.round(Number(e.target.value || 0) * 100);
                          p.onDiscount(l.productId, Math.min(Math.max(v, 0), Math.round(l.unitPriceCents * l.qty)));
                        }}
                        autoFocus
                      />
                      <button type="button" className="btn btn-secondary btn-sm min-h-9" onClick={() => setOpenDiscount(null)}>
                        Listo
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
        <CustomerPanel customer={p.customer} onSelect={p.onSelectCustomer} onClear={p.onClearCustomer} loyaltyEnabled={p.config.flags.loyalty} />

        {/* Cupón */}
        {p.coupon ? (
          <div className="st-green flex items-center justify-between gap-2 rounded-[var(--r-btn)] px-3 py-2 text-sm">
            <span>
              <Tag size={14} className="mr-1 inline" />
              Cupón <strong>{p.coupon.code}</strong> · −{formatMXN(p.coupon.discountCents)}
            </span>
            <button type="button" onClick={p.onRemoveCoupon} className="btn btn-secondary btn-sm min-h-9 bg-white/70" aria-label="Quitar cupón">
              <X size={14} />
            </button>
          </div>
        ) : (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (couponInput.trim()) p.onApplyCoupon(couponInput.trim());
            }}
          >
            <input
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              placeholder="Cupón"
              aria-label="Código de cupón"
              className="input min-h-11 uppercase"
              autoComplete="off"
              disabled={empty}
            />
            <button className="btn btn-secondary min-h-11" disabled={empty || !couponInput.trim() || p.couponBusy}>
              {p.couponBusy ? "…" : "Aplicar"}
            </button>
          </form>
        )}
        {p.couponMessage && (
          <p role="alert" className="st-amber rounded-[var(--r-btn)] px-3 py-1.5 text-xs">
            {p.couponMessage}
          </p>
        )}

        {/* Recompensas */}
        {p.config.flags.loyalty && p.customer && (
          <div>
            {p.reward ? (
              <div className="st-green flex items-center justify-between gap-2 rounded-[var(--r-btn)] px-3 py-2 text-sm">
                <span>
                  <Gift size={14} className="mr-1 inline" />
                  {p.reward.rewardName} · {rewardLabel(p.reward)}
                </span>
                <button type="button" onClick={() => p.onSelectReward(null)} className="btn btn-secondary btn-sm min-h-9 bg-white/70" aria-label="Quitar recompensa">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowRewards((s) => !s)}
                className="btn btn-secondary min-h-11 w-full justify-between"
                aria-expanded={showRewards}
              >
                <span>
                  <Gift size={15} className="mr-1.5 inline" />
                  Recompensas
                  {p.rewardsIssued.length > 0 && <span className="st-green pill ml-2 px-2 py-0.5 text-xs">{p.rewardsIssued.length} lista{p.rewardsIssued.length > 1 ? "s" : ""}</span>}
                </span>
                <span className="text-xs text-muted">{p.customer.pointsBalance} pts</span>
              </button>
            )}
            {showRewards && !p.reward && (
              <div className="mt-1.5 flex flex-col gap-1 rounded-[var(--r-card)] border border-line p-2">
                {p.rewardsIssued.length === 0 && p.rewardsAvailable.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted">Sin recompensas disponibles.</p>
                )}
                {p.rewardsIssued.map((r) => (
                  <button
                    key={r.redemptionId}
                    type="button"
                    onClick={() => {
                      p.onSelectReward(r);
                      setShowRewards(false);
                    }}
                    className="btn btn-secondary min-h-11 justify-between text-left"
                  >
                    <span className="text-sm">
                      {r.rewardName}
                      <span className="block text-xs font-normal text-muted">
                        {rewardLabel(r)} · código {r.code}
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-green-d">Aplicar</span>
                  </button>
                ))}
                {p.rewardsAvailable.length > 0 && (
                  <p className="mt-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Canjear con puntos</p>
                )}
                {p.rewardsAvailable.map((r) => (
                  <button
                    key={r.rewardId}
                    type="button"
                    disabled={!r.affordable || p.rewardBusy}
                    onClick={() => p.onRedeemReward(r)}
                    className="btn btn-secondary min-h-11 justify-between text-left disabled:opacity-50"
                  >
                    <span className="text-sm">
                      {r.name}
                      {r.description && <span className="block text-xs font-normal text-muted">{r.description}</span>}
                    </span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums">{r.pointsCost} pts</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Totales */}
        <dl className="space-y-0.5 px-1 text-sm">
          <div className="flex justify-between text-muted">
            <dt>Subtotal</dt>
            <dd className="tabular-nums">{formatMXN(p.totals.subtotalCents)}</dd>
          </div>
          {p.totals.discountCents > 0 && (
            <div className="flex justify-between text-green-d">
              <dt>Descuentos</dt>
              <dd className="tabular-nums">−{formatMXN(p.totals.discountCents)}</dd>
            </div>
          )}
          {p.totals.taxCents > 0 && (
            <div className="flex justify-between text-muted">
              <dt>IVA</dt>
              <dd className="tabular-nums">{formatMXN(p.totals.taxCents)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between pt-1 text-lg font-semibold">
            <dt>Total</dt>
            <dd className="text-2xl tabular-nums" data-testid="cart-total">
              {formatMXN(p.totals.totalCents)}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={p.onCheckout}
          disabled={empty}
          className="btn btn-confirm btn-lg min-h-14 w-full text-lg"
          data-testid="checkout-button"
        >
          COBRAR {empty ? "" : formatMXN(p.totals.totalCents)} <span className="ml-1 text-xs font-normal opacity-80">F9</span>
        </button>
      </div>
    </div>
  );
}
