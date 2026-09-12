import { describe, expect, it } from "vitest";
import { NetworkError, type ApiResult } from "./api";
import {
  canQueue,
  createOfflineQueue,
  syncQueue,
  syncStatusOf,
  type QueuedSale,
} from "./offline-queue";
import type { CheckoutRequest, CheckoutResult } from "./types";

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

const req = (
  key: string,
  payments: CheckoutRequest["payments"] = [
    { provider: "cash", method: "cash", amount_cents: 4500, tendered_cents: 5000 },
  ],
): CheckoutRequest => ({
  idempotency_key: key,
  items: [{ product_id: "11111111-1111-4111-8111-111111111111", qty: 1 }],
  payments,
});
const summary = { totalCents: 4500, changeCents: 500, itemsCount: 1, customerName: null };
const okResult = (key: string): CheckoutResult => ({
  orderId: "o-" + key,
  saleId: "s-" + key,
  folio: "PDP-" + key,
  totalCents: 4500,
  paidCents: 4500,
  changeCents: 500,
  pointsEarned: 0,
  pointsBalance: null,
  duplicate: false,
  status: "completed",
});

describe("createOfflineQueue", () => {
  it("encola, deduplica por idempotency_key, elimina y actualiza", () => {
    const q = createOfflineQueue(memStorage());
    q.enqueue(req("a"), summary);
    q.enqueue(req("a"), summary);
    q.enqueue(req("b"), summary);
    expect(q.size()).toBe(2);
    q.update("a", { attempts: 3, lastError: "x", lastStatus: 500 });
    expect(q.list()[0]).toMatchObject({ key: "a", attempts: 3, lastError: "x" });
    q.remove("a");
    expect(q.list().map((i) => i.key)).toEqual(["b"]);
  });

  it("tolera storage corrupto sin romper", () => {
    const q = createOfflineQueue(memStorage({ "pdp.pos.offline-queue.v1": "{no json" }));
    expect(q.list()).toEqual([]);
    q.enqueue(req("a"), summary);
    expect(q.size()).toBe(1);
  });
});

describe("canQueue", () => {
  it("solo efectivo y con flag activo", () => {
    expect(canQueue(req("a"), true)).toBe(true);
    expect(canQueue(req("a"), false)).toBe(false);
    expect(
      canQueue(
        req("a", [{ provider: "manual", method: "card_terminal", amount_cents: 4500 }]),
        true,
      ),
    ).toBe(false);
    expect(
      canQueue(
        req("a", [{ provider: "mercadopago", method: "mercadopago", amount_cents: 4500 }]),
        true,
      ),
    ).toBe(false);
    expect(
      canQueue(
        req("a", [
          { provider: "cash", method: "cash", amount_cents: 2000, tendered_cents: 2000 },
          { provider: "manual", method: "transfer", amount_cents: 2500 },
        ]),
        true,
      ),
    ).toBe(false);
    expect(canQueue(req("a", []), true)).toBe(true);
  });
});

describe("syncQueue", () => {
  it("reenvía en orden con la MISMA idempotency_key y elimina las sincronizadas", async () => {
    const q = createOfflineQueue(memStorage());
    q.enqueue(req("a"), summary);
    q.enqueue(req("b"), summary);
    const sent: string[] = [];
    const r = await syncQueue(q, async (request) => {
      sent.push(request.idempotency_key);
      return { ok: true, status: 201, data: okResult(request.idempotency_key) };
    });
    expect(sent).toEqual(["a", "b"]);
    expect(r.synced.map((s) => s.result.folio)).toEqual(["PDP-a", "PDP-b"]);
    expect(q.size()).toBe(0);
  });

  it("una respuesta duplicate también se considera sincronizada", async () => {
    const q = createOfflineQueue(memStorage());
    q.enqueue(req("a"), summary);
    const r = await syncQueue(q, async () => ({
      ok: true,
      status: 200,
      data: { ...okResult("a"), duplicate: true },
    }));
    expect(r.synced).toHaveLength(1);
    expect(q.size()).toBe(0);
  });

  it("se detiene al perder la red y conserva todo para el siguiente intento", async () => {
    const q = createOfflineQueue(memStorage());
    q.enqueue(req("a"), summary);
    q.enqueue(req("b"), summary);
    let calls = 0;
    const r = await syncQueue(q, async () => {
      calls++;
      throw new NetworkError();
    });
    expect(calls).toBe(1);
    expect(r.stoppedOffline).toBe(true);
    expect(q.size()).toBe(2);
    expect(q.list()[0]!.attempts).toBe(0);
  });

  it("error 4xx de negocio marca la venta y no la reintenta sola; 5xx detiene la ronda", async () => {
    const q = createOfflineQueue(memStorage());
    q.enqueue(req("a"), summary);
    q.enqueue(req("b"), summary);
    q.enqueue(req("c"), summary);
    const responses: Record<string, ApiResult<CheckoutResult>> = {
      a: { ok: false, status: 409, error: "Stock insuficiente" },
      b: { ok: false, status: 500, error: "Error del servidor" },
      c: { ok: true, status: 201, data: okResult("c") },
    };
    const r1 = await syncQueue(q, async (request) => responses[request.idempotency_key]!);
    expect(r1.failed.map((f) => f.key)).toEqual(["a", "b"]);
    expect(r1.synced).toEqual([]);
    expect(q.list().map((i) => [i.key, i.lastStatus])).toEqual([
      ["a", 409],
      ["b", 500],
      ["c", null],
    ]);
    // Segunda ronda: 'a' se salta (requiere decisión), 'b' ahora funciona, 'c' también.
    responses.b = { ok: true, status: 201, data: okResult("b") };
    const attempted: string[] = [];
    const r2 = await syncQueue(q, async (request) => {
      attempted.push(request.idempotency_key);
      return responses[request.idempotency_key]!;
    });
    expect(attempted).toEqual(["b", "c"]);
    expect(r2.synced.map((s) => s.key)).toEqual(["b", "c"]);
    expect(q.list().map((i) => i.key)).toEqual(["a"]);
  });
});

describe("syncStatusOf", () => {
  const item = (lastStatus: number | null): QueuedSale => ({
    key: "k" + lastStatus,
    createdAt: "",
    request: req("k"),
    summary,
    attempts: 0,
    lastError: null,
    lastStatus,
  });
  it("prioriza GUARDANDO > ERROR > OFFLINE(n) > SINCRONIZADO", () => {
    expect(syncStatusOf({ online: true, syncing: false, items: [] })).toEqual({
      status: "synced",
      count: 0,
    });
    expect(syncStatusOf({ online: false, syncing: false, items: [] })).toEqual({
      status: "offline",
      count: 0,
    });
    expect(syncStatusOf({ online: true, syncing: false, items: [item(null), item(null)] })).toEqual(
      {
        status: "offline",
        count: 2,
      },
    );
    expect(syncStatusOf({ online: true, syncing: false, items: [item(409), item(null)] })).toEqual({
      status: "error",
      count: 1,
    });
    expect(syncStatusOf({ online: true, syncing: true, items: [item(null)] })).toEqual({
      status: "saving",
      count: 1,
    });
  });
});
