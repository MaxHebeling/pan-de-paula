"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

/** Contador de notificaciones sin leer; se refresca cada 60 s desde /api/notifications/unread-count. */
export function UnreadBadge({ initial }: { initial?: number }) {
  const [unread, setUnread] = useState<number | null>(initial ?? null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/notifications/unread-count", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { unread: number };
        if (alive) setUnread(j.unread);
      } catch (e) {
        console.warn("[notificaciones] no se pudo refrescar el contador", e);
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (unread === null || unread === 0) return null;
  return (
    <Link
      href="/notificaciones"
      className="st-amber pill inline-flex min-h-9 items-center gap-1.5 px-3 text-xs font-semibold"
      aria-label={`${unread} notificaciones sin leer`}
    >
      <Bell size={14} aria-hidden /> {unread} sin leer
    </Link>
  );
}
