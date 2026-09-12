/** Tipos compartidos entre servidor y cliente del POS (sin dependencias de servidor). */
import type { PaymentMethod } from "@pdp/domain";

export type StockLevel = "ok" | "low" | "out";

export type PosProduct = {
  id: string;
  name: string;
  sku: string | null;
  parentId: string | null;
  variantLabel: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Precio POS vigente en centavos; null = sin precio configurado (no vendible). */
  priceCents: number | null;
  imageUrl: string | null;
  favorite: boolean;
  trackStock: boolean;
  onHand: number;
  level: StockLevel;
};

export type PosCategory = { id: string; name: string; slug: string };

export type PosCatalog = { categories: PosCategory[]; products: PosProduct[] };

export type PosCustomer = {
  id: string;
  fullName: string;
  publicCode: string;
  phone: string | null;
  email: string | null;
  pointsBalance: number;
  tierKey: string | null;
  tierName: string | null;
  totalOrders: number;
  birthdayToday: boolean;
};

export type RewardIssued = {
  redemptionId: string;
  code: string;
  rewardName: string;
  kind: "discount_pct" | "discount_amount" | "free_product" | "gift";
  valueBps: number | null;
  valueCents: number | null;
  productId: string | null;
  productName: string | null;
  expiresAt: string | null;
};

export type RewardAvailable = {
  rewardId: string;
  name: string;
  description: string | null;
  pointsCost: number;
  kind: RewardIssued["kind"];
  affordable: boolean;
};

export type CouponResult =
  | { valid: true; code: string; kind: "pct" | "amount" | "free_product"; discountCents: number }
  | { valid: false; reason: string; message: string };

export type CartLineState = {
  productId: string;
  name: string;
  variantLabel: string | null;
  unitPriceCents: number;
  qty: number;
  discountCents: number;
  notes: string;
};

export type CheckoutPayment = {
  provider: "cash" | "manual" | "mercadopago";
  method: PaymentMethod;
  amount_cents: number;
  tendered_cents?: number;
  reference?: string;
  external_id?: string;
};

export type CheckoutRequest = {
  idempotency_key: string;
  items: Array<{ product_id: string; qty: number; discount_cents?: number; notes?: string }>;
  customer_id?: string | null;
  coupon_code?: string | null;
  reward_redemption_id?: string | null;
  payments: CheckoutPayment[];
  notes?: string;
};

export type CheckoutResult = {
  orderId: string;
  saleId: string | null;
  folio: string;
  totalCents: number;
  paidCents: number;
  changeCents: number;
  pointsEarned: number;
  pointsBalance: number | null;
  duplicate: boolean;
  status: string;
};

export type PaymentStatusResult = {
  orderId: string;
  folio: string;
  status: string;
  paymentStatus: string;
  totalCents: number;
  paidCents: number;
  saleId: string | null;
  pointsEarned: number;
  payments: Array<{ method: string; status: string; amountCents: number; externalStatus: string | null }>;
  /** Resumen para el POS: confirmed = hay venta; failed = pedido cancelado o pago rechazado; pending = sigue esperando. */
  outcome: "confirmed" | "failed" | "pending";
};

export type MpStartResult = {
  orderId: string;
  folio: string;
  totalCents: number;
  mpOrderId: string;
  qrData?: string;
};

export type PosConfig = {
  flags: {
    mercadopago_point: boolean;
    mercadopago_qr: boolean;
    email_receipts: boolean;
    pos_offline_queue: boolean;
    loyalty: boolean;
  };
  mpConfigured: boolean;
  mpPointDeviceConfigured: boolean;
  emailConfigured: boolean;
  canDiscount: boolean;
  canRefund: boolean;
  canRegister: boolean;
  register: { id: string; openedAt: string; openingCashCents: number } | null;
  business: {
    name: string;
    whatsapp: string | null;
    taxRateBps: number;
    pricesIncludeTax: boolean;
    allowNegativeStock: boolean;
  };
  staffName: string;
};

export type ApiError = { error: string; code?: string };
