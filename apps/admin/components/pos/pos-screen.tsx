"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ShoppingBag, Wallet } from "lucide-react";
import {
  cartTotals,
  formatMXN,
  newIdempotencyKey,
  type CartDiscount,
  type CartLine,
} from "@pdp/domain";
import { apiFetch, NetworkError, postJson } from "./api";
import { useScanner } from "./use-scanner";
import { CartPanel } from "./cart-panel";
import { CheckoutModal } from "./checkout-modal";
import type { MpHandlers } from "./mp-payment";
import { canQueue } from "./offline-queue";
import { ProductGrid } from "./product-grid";
import { SaleSuccess, type SaleOutcome } from "./sale-success";
import { SyncIndicator } from "./sync-indicator";
import type {
  CartLineState,
  CheckoutPayment,
  CheckoutRequest,
  CheckoutResult,
  CouponResult,
  MpStartResult,
  PaymentStatusResult,
  PosCatalog,
  PosConfig,
  PosCustomer,
  PosProduct,
  RewardAvailable,
  RewardIssued,
} from "./types";
import { useOfflineQueue } from "./use-offline-queue";

type ValidCoupon = CouponResult & { valid: true };

function rewardDiscount(r: RewardIssued | null): CartDiscount | null {
  if (!r) return null;
  if (r.kind === "discount_pct") return { kind: "pct", valueBps: r.valueBps ?? 0 };
  if (r.kind === "discount_amount") return { kind: "amount", valueCents: r.valueCents ?? 0 };
  if (r.kind === "free_product" && r.productId)
    return { kind: "free_product", productId: r.productId };
  return null;
}

export function PosScreen({ catalog, config }: { catalog: PosCatalog; config: PosConfig }) {
  const [lines, setLines] = useState<CartLineState[]>([]);
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [coupon, setCoupon] = useState<ValidCoupon | null>(null);
  const [couponMessage, setCouponMessage] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [reward, setReward] = useState<RewardIssued | null>(null);
  const [rewardsIssued, setRewardsIssued] = useState<RewardIssued[]>([]);
  const [rewardsAvailable, setRewardsAvailable] = useState<RewardAvailable[]>([]);
  const [rewardBusy, setRewardBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [sale, setSale] = useState<SaleOutcome | null>(null);
  const [toast, setToast] = useState<{ tone: "green" | "amber" | "red"; text: string } | null>(
    null,
  );
  const [registerOpen, setRegisterOpen] = useState(Boolean(config.register));
  const idemRef = useRef<string>(newIdempotencyKey("pos"));
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  const say = useCallback((tone: "green" | "amber" | "red", text: string) => {
    setToast({ tone, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const offline = useOfflineQueue(config.flags.pos_offline_queue, (report) => {
    if (report.synced.length)
      say(
        "green",
        `${report.synced.length} venta(s) offline sincronizada(s): ${report.synced.map((s) => s.result.folio).join(", ")}`,
      );
    if (report.failed.some((f) => f.status >= 400 && f.status < 500))
      say("red", "Una venta offline fue rechazada por el servidor. Revisa la cola.");
  });

  const effectiveConfig = useMemo<PosConfig>(
    () => ({
      ...config,
      register: registerOpen
        ? (config.register ?? { id: "", openedAt: "", openingCashCents: 0 })
        : null,
    }),
    [config, registerOpen],
  );

  // ── Totales (previsualización; el servidor recalcula) ─────────────────────
  const cartLines: CartLine[] = useMemo(
    () =>
      lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
      })),
    [lines],
  );
  const totals = useMemo(() => {
    const discounts: CartDiscount[] = [];
    if (coupon) discounts.push({ kind: "amount", valueCents: coupon.discountCents });
    const rd = rewardDiscount(reward);
    if (rd) discounts.push(rd);
    return cartTotals(cartLines, {
      discounts,
      taxRateBps: config.business.taxRateBps,
      pricesIncludeTax: config.business.pricesIncludeTax,
    });
  }, [cartLines, coupon, reward, config.business.taxRateBps, config.business.pricesIncludeTax]);

  // ── Carrito ───────────────────────────────────────────────────────────────
  const addProduct = useCallback(
    (p: PosProduct) => {
      if (p.priceCents === null) {
        say("amber", `${p.name} no tiene precio configurado`);
        return;
      }
      if (p.trackStock && p.level === "out" && !config.business.allowNegativeStock) {
        say("red", `${p.name} está agotado`);
        return;
      }
      setLines((prev) => {
        const i = prev.findIndex((l) => l.productId === p.id);
        if (i >= 0) return prev.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
        return [
          ...prev,
          {
            productId: p.id,
            name: p.name,
            variantLabel: p.variantLabel,
            unitPriceCents: p.priceCents!,
            qty: 1,
            discountCents: 0,
            notes: "",
          },
        ];
      });
    },
    [config.business.allowNegativeStock, say],
  );
  const applyLines = (next: CartLineState[]) => {
    setLines(next);
    if (next.length === 0) {
      setCoupon(null);
      setCouponMessage(null);
      setReward(null);
    }
  };
  const changeQty = (productId: string, delta: number) =>
    applyLines(
      lines
        .map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );
  const removeLine = (productId: string) =>
    applyLines(lines.filter((l) => l.productId !== productId));
  const setNote = (productId: string, notes: string) =>
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, notes } : l)));
  const setDiscount = (productId: string, discountCents: number) =>
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, discountCents } : l)));

  const resetAll = useCallback(() => {
    setLines([]);
    setCustomer(null);
    setCoupon(null);
    setCouponMessage(null);
    setReward(null);
    setRewardsIssued([]);
    setRewardsAvailable([]);
    setCheckoutOpen(false);
    setCartOpen(false);
    setSale(null);
    idemRef.current = newIdempotencyKey("pos");
    window.setTimeout(() => searchRef.current?.focus(), 50);
  }, []);

  // ── Cliente y recompensas ────────────────────────────────────────────────
  const loadRewards = useCallback(async (customerId: string) => {
    try {
      const r = await apiFetch<{
        issued: RewardIssued[];
        available: RewardAvailable[];
        pointsBalance: number;
      }>(`/api/pos/rewards?customer_id=${customerId}`);
      if (r.ok) {
        setRewardsIssued(r.data.issued);
        setRewardsAvailable(r.data.available);
        setCustomer((c) =>
          c && c.id === customerId ? { ...c, pointsBalance: r.data.pointsBalance } : c,
        );
      }
    } catch (e) {
      console.error("[pos] recompensas", (e as Error).message);
    }
  }, []);
  const selectCustomer = (c: PosCustomer) => {
    setCustomer(c);
    setReward(null);
    if (config.flags.loyalty) void loadRewards(c.id);
  };
  const clearCustomer = () => {
    setCustomer(null);
    setReward(null);
    setRewardsIssued([]);
    setRewardsAvailable([]);
  };

  /*
   * Lector de códigos USB o Bluetooth: funciona en cualquier punto de la pantalla, sin tener que
   * poner el cursor en el campo del cliente. El aviso dice qué pasó —lo encontró o no— porque un
   * lector que "no hizo nada" es peor que uno que falla en voz alta.
   */
  const [scanAviso, setScanAviso] = useState<string | null>(null);
  const onScannerInput = useCallback(
    async (codigo: string) => {
      try {
        const r = await apiFetch<{ customers: PosCustomer[] }>(
          `/api/pos/customers?q=${encodeURIComponent(codigo)}&via=scanner`,
        );
        const found = r.ok ? r.data.customers[0] : undefined;
        if (!found) {
          setScanAviso("No se encontró ningún cliente con ese código.");
          return;
        }
        selectCustomer(found);
        setScanAviso(`Cliente: ${found.fullName} · ${found.publicCode}`);
      } catch {
        setScanAviso("No se pudo consultar el cliente. Inténtalo de nuevo.");
      }
    },
    // selectCustomer se redefine en cada render pero no cambia de comportamiento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.flags.loyalty],
  );
  useScanner((codigo) => void onScannerInput(codigo), !sale);
  useEffect(() => {
    if (!scanAviso) return;
    const t = setTimeout(() => setScanAviso(null), 4000);
    return () => clearTimeout(t);
  }, [scanAviso]);
  async function redeemReward(r: RewardAvailable) {
    if (!customer) return;
    if (
      !window.confirm(
        `¿Canjear ${r.pointsCost} puntos por "${r.name}"? Los puntos se descuentan ahora.`,
      )
    )
      return;
    setRewardBusy(true);
    try {
      const res = await postJson<{
        redemptionId: string;
        issued: RewardIssued[];
        available: RewardAvailable[];
        pointsBalance: number;
      }>("/api/pos/rewards", {
        customer_id: customer.id,
        reward_id: r.rewardId,
      });
      if (!res.ok) {
        say("red", res.error);
        return;
      }
      setRewardsIssued(res.data.issued);
      setRewardsAvailable(res.data.available);
      setCustomer((c) => (c ? { ...c, pointsBalance: res.data.pointsBalance } : c));
      const issued = res.data.issued.find((i) => i.redemptionId === res.data.redemptionId);
      if (issued) setReward(issued);
      say("green", `Recompensa emitida: ${r.name}`);
    } catch (e) {
      say(
        "red",
        e instanceof NetworkError
          ? "Sin conexión: no se pueden canjear recompensas"
          : (e as Error).message,
      );
    } finally {
      setRewardBusy(false);
    }
  }

  // ── Cupón (valida en servidor; se revalida cuando cambia el carrito) ──────
  const validateCoupon = useCallback(
    async (code: string, quiet = false) => {
      if (lines.length === 0) return;
      setCouponBusy(true);
      try {
        const r = await postJson<CouponResult>("/api/pos/coupon", {
          code,
          customer_id: customer?.id ?? null,
          items: lines.map((l) => ({
            product_id: l.productId,
            qty: l.qty,
            discount_cents: l.discountCents || undefined,
          })),
        });
        if (!r.ok) {
          setCouponMessage(r.error);
          setCoupon(null);
          return;
        }
        if (r.data.valid) {
          setCoupon(r.data);
          setCouponMessage(null);
        } else {
          setCoupon(null);
          setCouponMessage(
            quiet ? `Cupón ${code} ya no aplica: ${r.data.message}` : r.data.message,
          );
        }
      } catch (e) {
        setCoupon(null);
        setCouponMessage(
          e instanceof NetworkError
            ? "Sin conexión: no se puede validar el cupón"
            : (e as Error).message,
        );
      } finally {
        setCouponBusy(false);
      }
    },
    [lines, customer],
  );
  const couponCode = coupon?.code ?? null;
  useEffect(() => {
    if (!couponCode || lines.length === 0) return;
    const t = window.setTimeout(() => void validateCoupon(couponCode, true), 300);
    return () => window.clearTimeout(t);
    // Revalidar solo cuando cambian carrito o cliente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, customer?.id]);

  // ── Cobro ────────────────────────────────────────────────────────────────
  const buildRequest = useCallback(
    (payments: CheckoutPayment[]): CheckoutRequest => ({
      idempotency_key: idemRef.current,
      items: lines.map((l) => ({
        product_id: l.productId,
        qty: l.qty,
        ...(l.discountCents > 0 ? { discount_cents: l.discountCents } : {}),
        ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
      })),
      customer_id: customer?.id ?? null,
      coupon_code: coupon?.code ?? null,
      reward_redemption_id: reward?.redemptionId ?? null,
      payments,
    }),
    [lines, customer, coupon, reward],
  );

  const onSubmit = useCallback(
    async (payments: CheckoutPayment[]): Promise<{ ok: true } | { ok: false; error: string }> => {
      const request = buildRequest(payments);
      const cashChange = payments
        .filter((p) => p.method === "cash")
        .reduce(
          (s, p) => s + Math.max((p.tendered_cents ?? p.amount_cents) - p.amount_cents, 0),
          0,
        );
      try {
        const r = await postJson<CheckoutResult>("/api/pos/checkout", request);
        if (!r.ok) {
          if (r.code === "REGISTER_CLOSED") setRegisterOpen(false);
          return { ok: false, error: r.error };
        }
        setSale({
          kind: "online",
          result: r.data,
          payments,
          changeCents: r.data.duplicate ? cashChange : r.data.changeCents,
        });
        setCheckoutOpen(false);
        return { ok: true };
      } catch (e) {
        if (e instanceof NetworkError) {
          if (offline.enabled && canQueue(request, true) && registerOpen) {
            try {
              offline.enqueue(request, {
                totalCents: totals.totalCents,
                changeCents: cashChange,
                itemsCount: totals.itemsCount,
                customerName: customer?.fullName ?? null,
              });
            } catch (qe) {
              return { ok: false, error: (qe as Error).message };
            }
            setSale({
              kind: "queued",
              key: request.idempotency_key,
              totalCents: totals.totalCents,
              changeCents: cashChange,
              itemsCount: totals.itemsCount,
            });
            setCheckoutOpen(false);
            return { ok: true };
          }
          return {
            ok: false,
            error: offline.enabled
              ? "Sin conexión. Solo las ventas 100% en efectivo se guardan offline."
              : "Sin conexión con el servidor. Reintenta cuando vuelva la red (la venta no se duplicará).",
          };
        }
        return { ok: false, error: (e as Error).message };
      }
    },
    [buildRequest, customer, offline, registerOpen, totals.itemsCount, totals.totalCents],
  );

  const mp = useMemo<MpHandlers>(
    () => ({
      start: (kind) =>
        postJson<MpStartResult>("/api/pos/payments/mercadopago", {
          ...buildRequest([]),
          kind,
          payments: undefined,
        }),
      status: (orderId) =>
        apiFetch<PaymentStatusResult>(`/api/pos/payments/status?orderId=${orderId}`),
      cancel: (orderId) =>
        postJson<{ cancelled: boolean; saleId: string | null }>(
          "/api/pos/payments/mercadopago/cancel",
          { orderId },
        ),
      onConfirmed: (s) => {
        setSale({
          kind: "online",
          result: {
            orderId: s.orderId,
            saleId: s.saleId,
            folio: s.folio,
            totalCents: s.totalCents,
            paidCents: s.paidCents,
            changeCents: 0,
            pointsEarned: s.pointsEarned,
            pointsBalance: null,
            duplicate: false,
            status: s.status,
          },
          payments: [
            { provider: "mercadopago", method: "mercadopago", amount_cents: s.totalCents },
          ],
          changeCents: 0,
        });
        setCheckoutOpen(false);
      },
      onAbandoned: () => {
        // El pedido MP quedó cancelado: el siguiente intento necesita una clave nueva.
        idemRef.current = newIdempotencyKey("pos");
        setCheckoutOpen(false);
        say("amber", "Cobro con Mercado Pago cancelado. Puedes cobrar con otro método.");
      },
    }),
    [buildRequest, say],
  );

  // ── Atajos ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F9") {
        e.preventDefault();
        if (lines.length && !sale) setCheckoutOpen(true);
      } else if (e.key === "Escape" && !checkoutOpen && !sale) {
        setCartOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lines.length, sale, checkoutOpen]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const cart = (
    <CartPanel
      lines={lines}
      totals={totals}
      config={effectiveConfig}
      customer={customer}
      onSelectCustomer={selectCustomer}
      onClearCustomer={clearCustomer}
      coupon={coupon}
      couponMessage={couponMessage}
      couponBusy={couponBusy}
      onApplyCoupon={(code) => void validateCoupon(code)}
      onRemoveCoupon={() => {
        setCoupon(null);
        setCouponMessage(null);
      }}
      reward={reward}
      rewardsIssued={rewardsIssued}
      rewardsAvailable={rewardsAvailable}
      onSelectReward={setReward}
      onRedeemReward={(r) => void redeemReward(r)}
      rewardBusy={rewardBusy}
      onQty={changeQty}
      onRemove={removeLine}
      onNote={setNote}
      onDiscount={setDiscount}
      onClear={() => {
        setLines([]);
        setCoupon(null);
        setReward(null);
      }}
      onCheckout={() => setCheckoutOpen(true)}
    />
  );

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[520px] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Punto de venta</h1>
          {registerOpen ? (
            <span className="st-green pill px-2.5 py-0.5 text-xs font-semibold">Caja abierta</span>
          ) : (
            <Link
              href="/caja"
              className="st-amber pill flex min-h-9 items-center gap-1 px-3 text-xs font-semibold"
              data-testid="register-closed"
            >
              <Wallet size={14} /> Caja cerrada ·{" "}
              {config.canRegister ? "abrir" : "solo tarjeta/transferencia"}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2">
          {offline.enabled && (
            <SyncIndicator
              status={offline.status.status}
              count={offline.status.count}
              items={offline.items}
              online={offline.online}
              onRetry={offline.retry}
              onDiscard={offline.discard}
              onSyncNow={() => void offline.syncNow()}
            />
          )}
          <Link href="/pos/ventas" className="btn btn-secondary btn-sm min-h-9">
            Ventas del día
          </Link>
        </div>
      </div>

      {toast && (
        <p role="status" className={`st-${toast.tone} rounded-[var(--r-card)] px-4 py-2 text-sm`}>
          {toast.text}
        </p>
      )}

      {/* Resultado de un código leído con lector físico: siempre se dice si entró o no. */}
      {scanAviso && (
        <p
          role="status"
          data-testid="scan-aviso"
          className={`st-${scanAviso.startsWith("Cliente:") ? "green" : "amber"} rounded-[var(--r-card)] px-4 py-2 text-sm`}
        >
          {scanAviso}
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="min-h-0 min-w-0" aria-label="Catálogo">
          <ProductGrid
            catalog={catalog}
            onAdd={addProduct}
            searchRef={searchRef}
            allowNegativeStock={config.business.allowNegativeStock}
          />
        </section>
        {/* Una sola instancia del carrito: aside fijo en tablet/desktop, cajón inferior en móvil. */}
        {cartOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
            onClick={() => setCartOpen(false)}
            aria-hidden
          />
        )}
        <aside
          className={`card min-h-0 p-3 ${
            cartOpen
              ? "fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col rounded-b-none lg:static lg:z-auto lg:block lg:rounded-b-[var(--r-card)]"
              : "hidden lg:block"
          }`}
          aria-label="Carrito"
          role={cartOpen ? "dialog" : undefined}
          aria-modal={cartOpen ? true : undefined}
        >
          <div className="flex h-full min-h-0 flex-col">
            {cartOpen && (
              <button
                type="button"
                className="btn btn-secondary btn-sm mb-2 min-h-11 self-end lg:hidden"
                onClick={() => setCartOpen(false)}
              >
                Seguir agregando
              </button>
            )}
            <div className="min-h-0 flex-1">{cart}</div>
          </div>
        </aside>
      </div>

      {/* Móvil: barra inferior */}
      {!cartOpen && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 p-2 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="btn btn-primary min-h-14 w-full justify-between text-base"
            data-testid="open-cart"
            aria-label="Ver carrito"
          >
            <span className="flex items-center gap-2">
              <ShoppingBag size={20} /> {totals.itemsCount}{" "}
              {totals.itemsCount === 1 ? "artículo" : "artículos"}
            </span>
            <span className="tabular-nums">{formatMXN(totals.totalCents)}</span>
          </button>
        </div>
      )}

      <CheckoutModal
        open={checkoutOpen}
        totalCents={totals.totalCents}
        config={effectiveConfig}
        onClose={() => setCheckoutOpen(false)}
        onSubmit={onSubmit}
        mp={mp}
      />
      {sale && <SaleSuccess sale={sale} config={config} customer={customer} onNew={resetAll} />}
    </div>
  );
}
