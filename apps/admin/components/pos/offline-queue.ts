/**
 * Cola offline del POS (flag `pos_offline_queue`). Solo ventas en EFECTIVO: se guardan con su
 * idempotency_key y se reenvían al volver la red. Mercado Pago nunca se encola (requiere confirmación real).
 * Lógica pura (sin React) para poder probarla con storage falso.
 */
import { NetworkError, type ApiResult } from "./api";
import type { CheckoutRequest, CheckoutResult } from "./types";

export const OFFLINE_QUEUE_KEY = "pdp.pos.offline-queue.v1";

export type QueuedSale = {
  key: string; // = request.idempotency_key
  createdAt: string;
  request: CheckoutRequest;
  summary: {
    totalCents: number;
    changeCents: number;
    itemsCount: number;
    customerName: string | null;
  };
  attempts: number;
  lastError: string | null;
  lastStatus: number | null;
};

export type QueueStorage = Pick<Storage, "getItem" | "setItem">;

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;

export function createOfflineQueue(storage: QueueStorage, storageKey = OFFLINE_QUEUE_KEY) {
  function list(): QueuedSale[] {
    let raw: string | null = null;
    try {
      raw = storage.getItem(storageKey);
    } catch (e) {
      console.error("[pos] no se pudo leer la cola offline", (e as Error).message);
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as QueuedSale[]) : [];
    } catch (e) {
      console.error("[pos] cola offline corrupta; se ignora", (e as Error).message);
      return [];
    }
  }
  function save(items: QueuedSale[]) {
    try {
      storage.setItem(storageKey, JSON.stringify(items));
    } catch (e) {
      console.error("[pos] no se pudo guardar la cola offline", (e as Error).message);
      throw new Error("No se pudo guardar la venta en este dispositivo");
    }
  }
  function enqueue(request: CheckoutRequest, summary: QueuedSale["summary"]): QueuedSale {
    const items = list();
    const existing = items.find((i) => i.key === request.idempotency_key);
    if (existing) return existing;
    const item: QueuedSale = {
      key: request.idempotency_key,
      createdAt: new Date().toISOString(),
      request,
      summary,
      attempts: 0,
      lastError: null,
      lastStatus: null,
    };
    save([...items, item]);
    return item;
  }
  function remove(key: string) {
    save(list().filter((i) => i.key !== key));
  }
  function update(
    key: string,
    patch: Partial<Pick<QueuedSale, "attempts" | "lastError" | "lastStatus">>,
  ) {
    save(list().map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }
  return { list, enqueue, remove, update, size: () => list().length };
}

/** Solo se encolan ventas 100% en efectivo (o de $0) cuando el flag está activo. */
export function canQueue(
  request: Pick<CheckoutRequest, "payments">,
  flagEnabled: boolean,
): boolean {
  if (!flagEnabled) return false;
  return request.payments.every((p) => p.provider === "cash" && p.method === "cash");
}

export type SyncPoster = (request: CheckoutRequest) => Promise<ApiResult<CheckoutResult>>;

export type SyncReport = {
  synced: Array<{ key: string; result: CheckoutResult }>;
  failed: Array<{ key: string; error: string; status: number }>;
  /** true si se detuvo por falta de red (quedan pendientes sin intentar). */
  stoppedOffline: boolean;
};

/**
 * Reenvía la cola en orden. Red caída → se detiene (se reintenta después). 5xx → se detiene (transitorio).
 * 4xx → error de negocio: la venta se queda marcada con error para que la cajera decida (no se reintenta sola).
 * Éxito (incluido `duplicate`) → se elimina de la cola.
 */
export async function syncQueue(queue: OfflineQueue, post: SyncPoster): Promise<SyncReport> {
  const report: SyncReport = { synced: [], failed: [], stoppedOffline: false };
  for (const item of queue.list()) {
    if (item.lastStatus !== null && item.lastStatus >= 400 && item.lastStatus < 500) continue; // requiere decisión humana
    let res: ApiResult<CheckoutResult>;
    try {
      res = await post(item.request);
    } catch (e) {
      if (e instanceof NetworkError) {
        report.stoppedOffline = true;
        return report;
      }
      queue.update(item.key, {
        attempts: item.attempts + 1,
        lastError: (e as Error).message,
        lastStatus: 0,
      });
      report.failed.push({ key: item.key, error: (e as Error).message, status: 0 });
      continue;
    }
    if (res.ok) {
      queue.remove(item.key);
      report.synced.push({ key: item.key, result: res.data });
      continue;
    }
    queue.update(item.key, {
      attempts: item.attempts + 1,
      lastError: res.error,
      lastStatus: res.status,
    });
    report.failed.push({ key: item.key, error: res.error, status: res.status });
    if (res.status >= 500) return report;
  }
  return report;
}

export type SyncStatus = "synced" | "saving" | "offline" | "error";

export function syncStatusOf(input: { online: boolean; syncing: boolean; items: QueuedSale[] }): {
  status: SyncStatus;
  count: number;
} {
  const errors = input.items.filter(
    (i) => i.lastStatus !== null && i.lastStatus >= 400 && i.lastStatus < 500,
  );
  if (input.syncing) return { status: "saving", count: input.items.length };
  if (errors.length) return { status: "error", count: errors.length };
  if (!input.online || input.items.length) return { status: "offline", count: input.items.length };
  return { status: "synced", count: 0 };
}
