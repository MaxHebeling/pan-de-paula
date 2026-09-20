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

/**
 * Línea de tiempo del pedido TAL COMO LA VE EL CLIENTE.
 *
 * No es una segunda lógica de estados: es una LECTURA de los estados que ya existen
 * (`ORDER_STATUSES`), agrupados en los pocos hitos que a una persona le importan. La panadería sigue
 * moviendo el pedido con `change_order_status` y sus transiciones de siempre; aquí solo se traduce.
 *
 * Los hitos cambian según cómo recibe el cliente: quien pasa por su pedido espera "Listo para
 * recoger"; a quien se lo llevan le toca "En camino".
 */
export type PortalStepKey = "received" | "confirmed" | "preparing" | "ready" | "done";

export type PortalStep = {
  key: PortalStepKey;
  label: string;
  /** "done" = ya pasó, "current" = donde está ahora, "pending" = todavía no. */
  state: "done" | "current" | "pending";
  /** Cuándo ocurrió, si quedó registrado en el historial. */
  at: Date | null;
};

/** Estado del pedido → hito del cliente. Los estados contables (`paid`) no mueven la línea sin más. */
const STEP_OF: Partial<Record<OrderStatus, PortalStepKey>> = {
  new: "received",
  payment_pending: "received",
  confirmed: "confirmed",
  paid: "confirmed",
  in_production: "preparing",
  ready: "ready",
  ready_for_pickup: "ready",
  out_for_delivery: "ready",
  delivered: "done",
  completed: "done",
};

const ORDER: PortalStepKey[] = ["received", "confirmed", "preparing", "ready", "done"];

export function portalTimeline(
  status: OrderStatus,
  fulfillmentType: string,
  history: Array<{ status: OrderStatus; at: Date }> = [],
): { steps: PortalStep[]; cancelled: boolean } {
  const entrega = fulfillmentType === "delivery";
  const labels: Record<PortalStepKey, string> = {
    received: "Pedido recibido",
    confirmed: "Confirmado",
    preparing: "En preparación",
    ready: entrega ? "En camino" : "Listo para recoger",
    done: entrega ? "Entregado" : "Recogido",
  };
  // Cancelado o reembolsado: la línea de tiempo deja de avanzar. Se muestra hasta dónde llegó.
  const cancelled = status === "cancelled" || status === "refunded";
  const actual = cancelled
    ? // El último estado "normal" por el que pasó antes de cancelarse.
      (history
        .map((h) => STEP_OF[h.status])
        .filter((k): k is PortalStepKey => Boolean(k))
        .pop() ?? "received")
    : (STEP_OF[status] ?? "received");
  const idx = ORDER.indexOf(actual);

  // Primera vez que el pedido llegó a cada hito (el historial guarda todos los cambios, no solo el último).
  const at = new Map<PortalStepKey, Date>();
  for (const h of history) {
    const k = STEP_OF[h.status];
    if (k && !at.has(k)) at.set(k, h.at);
  }

  return {
    cancelled,
    steps: ORDER.map((key, i) => ({
      key,
      label: labels[key],
      state: cancelled
        ? i <= idx
          ? "done"
          : "pending"
        : i < idx
          ? "done"
          : i === idx
            ? "current"
            : "pending",
      at: at.get(key) ?? null,
    })),
  };
}
