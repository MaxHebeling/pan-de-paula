/** Estados de pedido y transiciones (espejo de order_transition_allowed en SQL). */
export const ORDER_STATUSES = [
  "new",
  "confirmed",
  "payment_pending",
  "paid",
  "in_production",
  "ready",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["confirmed", "payment_pending", "paid", "cancelled"],
  confirmed: ["payment_pending", "paid", "in_production", "ready", "cancelled"],
  payment_pending: ["paid", "confirmed", "cancelled"],
  paid: [
    "in_production",
    "ready",
    "ready_for_pickup",
    "out_for_delivery",
    "completed",
    "cancelled",
    "refunded",
  ],
  in_production: ["ready", "ready_for_pickup", "out_for_delivery", "cancelled"],
  ready: ["ready_for_pickup", "out_for_delivery", "delivered", "completed"],
  ready_for_pickup: ["delivered", "completed", "out_for_delivery"],
  out_for_delivery: ["delivered", "ready"],
  delivered: ["completed", "refunded"],
  completed: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Nuevo",
  confirmed: "Confirmado",
  payment_pending: "Pago pendiente",
  paid: "Pagado",
  in_production: "En producción",
  ready: "Listo",
  ready_for_pickup: "Listo para retiro",
  out_for_delivery: "En reparto",
  delivered: "Entregado",
  completed: "Completado",
  cancelled: "Cancelado",
  refunded: "Reembolsado",
};

/** Tono visual del estado (sistema del CRM: verde/ámbar/rojo/azul/gris). */
export const ORDER_STATUS_TONE: Record<OrderStatus, "green" | "amber" | "red" | "blue" | "gray"> = {
  new: "blue",
  confirmed: "blue",
  payment_pending: "amber",
  paid: "green",
  in_production: "amber",
  ready: "green",
  ready_for_pickup: "green",
  out_for_delivery: "blue",
  delivered: "green",
  completed: "green",
  cancelled: "gray",
  refunded: "red",
};

export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  "new",
  "confirmed",
  "payment_pending",
  "paid",
  "in_production",
  "ready",
  "ready_for_pickup",
  "out_for_delivery",
];

export const PAYMENT_METHOD_LABELS = {
  cash: "Efectivo",
  mercadopago: "Mercado Pago",
  card_terminal: "Tarjeta (terminal)",
  transfer: "Transferencia",
  points: "Puntos",
  other: "Otro",
} as const;
export type PaymentMethod = keyof typeof PAYMENT_METHOD_LABELS;
