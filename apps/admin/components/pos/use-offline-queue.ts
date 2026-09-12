"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { postJson } from "./api";
import {
  createOfflineQueue,
  OFFLINE_QUEUE_KEY,
  syncQueue,
  syncStatusOf,
  type OfflineQueue,
  type QueuedSale,
  type SyncReport,
} from "./offline-queue";
import type { CheckoutRequest, CheckoutResult } from "./types";

const SYNC_INTERVAL_MS = 30_000;
const EMPTY: QueuedSale[] = [];

// ── Store externo: la cola vive en localStorage; React la lee con useSyncExternalStore ─────────
const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedItems: QueuedSale[] = EMPTY;

function notify() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === OFFLINE_QUEUE_KEY) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
function readItems(): QueuedSale[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(OFFLINE_QUEUE_KEY);
  } catch (e) {
    console.error("[pos] localStorage no disponible", (e as Error).message);
    return EMPTY;
  }
  if (raw === cachedRaw) return cachedItems;
  cachedRaw = raw;
  if (!raw) return (cachedItems = EMPTY);
  try {
    const parsed = JSON.parse(raw) as unknown;
    cachedItems = Array.isArray(parsed) ? (parsed as QueuedSale[]) : EMPTY;
  } catch (e) {
    console.error("[pos] cola offline corrupta", (e as Error).message);
    cachedItems = EMPTY;
  }
  return cachedItems;
}

const subscribeOnline = (l: () => void) => {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
};

/** Estado de la cola offline + sincronización automática al volver la red (y cada 30 s). */
export function useOfflineQueue(enabled: boolean, onSynced?: (report: SyncReport) => void) {
  const queueRef = useRef<OfflineQueue | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const onSyncedRef = useRef(onSynced);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  const items = useSyncExternalStore(subscribe, enabled ? readItems : () => EMPTY, () => EMPTY);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

  const queue = useCallback((): OfflineQueue | null => {
    if (!enabled) return null;
    if (!queueRef.current) {
      try {
        queueRef.current = createOfflineQueue(window.localStorage);
      } catch (e) {
        console.error(
          "[pos] localStorage no disponible; cola offline desactivada",
          (e as Error).message,
        );
        return null;
      }
    }
    return queueRef.current;
  }, [enabled]);

  const syncNow = useCallback(async () => {
    const q = queue();
    if (!q || q.size() === 0 || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const report = await syncQueue(q, (request) =>
        postJson<CheckoutResult>("/api/pos/checkout", request),
      );
      if (report.synced.length || report.failed.length) onSyncedRef.current?.(report);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      notify();
    }
  }, [queue]);

  useEffect(() => {
    if (!enabled) return;
    const onUp = () => void syncNow();
    window.addEventListener("online", onUp);
    const t = window.setInterval(onUp, SYNC_INTERVAL_MS);
    const first = window.setTimeout(onUp, 500);
    return () => {
      window.removeEventListener("online", onUp);
      window.clearInterval(t);
      window.clearTimeout(first);
    };
  }, [enabled, syncNow]);

  const enqueue = useCallback(
    (request: CheckoutRequest, summary: QueuedSale["summary"]) => {
      const q = queue();
      if (!q) throw new Error("La cola offline no está disponible en este dispositivo");
      const item = q.enqueue(request, summary);
      notify();
      return item;
    },
    [queue],
  );

  const discard = useCallback(
    (key: string) => {
      queue()?.remove(key);
      notify();
    },
    [queue],
  );

  const retry = useCallback(
    (key: string) => {
      queue()?.update(key, { lastStatus: null, lastError: null });
      notify();
      void syncNow();
    },
    [queue, syncNow],
  );

  const status = useMemo(() => syncStatusOf({ online, syncing, items }), [online, syncing, items]);
  return { enabled, items, online, syncing, status, enqueue, discard, retry, syncNow };
}
