import type { PortalStep } from "@pdp/domain";
import { dateTimeMX } from "@/lib/format";

/**
 * La línea de tiempo del pedido. Server component: no necesita JavaScript para verse, y cuando el
 * estado cambia el portal vuelve a renderizar la página (ver `LiveOrders`).
 *
 * Los hitos los calcula `portalTimeline` en `@pdp/domain` a partir de los estados que YA existen,
 * así que esto solo pinta. La hora de cada paso sale del historial, no de una marca aparte.
 */
export function OrderTimeline({ steps, timezone }: { steps: PortalStep[]; timezone: string }) {
  return (
    <ol className="mt-4 space-y-0" data-testid="portal-timeline">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={`mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs ${
                  s.state === "done"
                    ? "border-sage bg-sage text-white"
                    : s.state === "current"
                      ? "border-sage bg-paper text-sage"
                      : "border-line bg-paper text-ink-2"
                }`}
              >
                {s.state === "done" ? "✓" : s.state === "current" ? "●" : ""}
              </span>
              {!last && (
                <span
                  aria-hidden
                  className={`w-px flex-1 ${s.state === "done" ? "bg-sage" : "bg-line"}`}
                  style={{ minHeight: "1.5rem" }}
                />
              )}
            </div>
            <div className={`pb-5 ${last ? "pb-0" : ""}`}>
              <p
                className={`font-medium ${s.state === "pending" ? "text-ink-2" : "text-ink"}`}
                data-testid={`paso-${s.key}`}
                data-state={s.state}
              >
                {s.label}
                {s.state === "current" && (
                  <span className="ml-2 align-middle text-xs text-sage">ahora</span>
                )}
              </p>
              {s.at && <p className="text-sm text-ink-2">{dateTimeMX(s.at, timezone)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
