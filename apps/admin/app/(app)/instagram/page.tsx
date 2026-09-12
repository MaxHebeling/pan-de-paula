import Link from "next/link";
import { isInstagramConfigured } from "@pdp/integrations";
import { requireSession } from "@/lib/auth";
import { PageHeader, Card, Stat, Badge, LinkButton, EmptyState, Alert } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { listConversations, instagramMetrics, CONV_STATUS } from "@/lib/instagram";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Instagram" };
export const dynamic = "force-dynamic";

const FILTERS = [
  ["open", "Abiertas"],
  ["handled", "Atendidas"],
  ["converted", "Convertidas"],
  ["closed", "Cerradas"],
  ["all", "Todas"],
] as const;

export default async function InstagramPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession("marketing.read");
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? "";
  const status = FILTERS.some(([k]) => k === one("estado")) ? one("estado") : "open";
  const q = one("q");
  const mine = one("mias") === "1";
  const [convs, m] = await Promise.all([
    listConversations({ status, q, mine: mine ? session.staff.id : undefined }),
    instagramMetrics(),
  ]);
  const configured = isInstagramConfigured();
  const conversion = m.totals.total ? Math.round((m.totals.converted / m.totals.total) * 100) : 0;
  const link = (patch: Record<string, string>) => {
    const p = new URLSearchParams({
      estado: status,
      ...(q ? { q } : {}),
      ...(mine ? { mias: "1" } : {}),
      ...patch,
    });
    for (const [k, v] of Object.entries(patch)) if (!v) p.delete(k);
    return `/instagram?${p.toString()}`;
  };
  return (
    <>
      <PageHeader
        title="Instagram"
        subtitle={`${m.totals.open} abiertas · ${m.totals.unanswered} sin responder · conversión ${conversion}%`}
        actions={
          <LinkButton href="/instagram/leads" variant="secondary">
            Leads ({m.totals.leads_new} nuevos)
          </LinkButton>
        }
      />
      {!configured && (
        <div className="mb-4">
          <Alert tone="amber">
            Instagram no está conectado (faltan INSTAGRAM_PAGE_ACCESS_TOKEN / META_APP_SECRET).
            Puedes leer y redactar: las respuestas se guardan como{" "}
            <strong>pendientes, no enviadas</strong>
            {m.totals.pending_out > 0 && ` (${m.totals.pending_out} pendientes ahora)`}.
          </Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Sin responder"
          value={m.totals.unanswered}
          tone={m.totals.unanswered ? "amber" : undefined}
          hint={`${m.totals.open} abiertas`}
        />
        <Stat
          label="Conversión"
          value={`${conversion}%`}
          hint={`${m.totals.converted} de ${m.totals.total} conversaciones`}
        />
        <Stat
          label="Leads"
          value={m.totals.leads_total}
          hint={`${m.totals.leads_converted} convertidos · ${m.totals.leads_new} nuevos`}
        />
        <Stat
          label="1ª respuesta (prom.)"
          value={
            m.totals.avg_first_reply_min !== null ? `${m.totals.avg_first_reply_min} min` : "—"
          }
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <form
            className="card mb-3 flex flex-wrap items-end gap-2 p-3"
            action="/instagram"
            method="get"
          >
            <input type="hidden" name="estado" value={status} />
            {mine && <input type="hidden" name="mias" value="1" />}
            <div className="min-w-[200px] flex-1">
              <label className="label" htmlFor="q">
                Buscar
              </label>
              <input
                id="q"
                name="q"
                className="input"
                defaultValue={q}
                placeholder="Usuario, cliente o texto del mensaje"
              />
            </div>
            <button className="btn btn-primary">Buscar</button>
          </form>
          <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist">
            {FILTERS.map(([k, label]) => (
              <Link
                key={k}
                href={link({ estado: k })}
                role="tab"
                aria-selected={status === k}
                className={`pill px-3 py-1.5 text-sm font-medium ${status === k ? "bg-teal text-white" : "st-gray"}`}
              >
                {label}
              </Link>
            ))}
            <Link
              href={link({ mias: mine ? "" : "1" })}
              className={`pill ml-auto px-3 py-1.5 text-sm font-medium ${mine ? "bg-teal text-white" : "st-gray"}`}
            >
              Asignadas a mí
            </Link>
          </div>
          {convs.length === 0 ? (
            <EmptyState
              title="Sin conversaciones"
              body="Cuando lleguen mensajes por el webhook de Meta aparecerán aquí."
            />
          ) : (
            <ul className="card divide-y divide-line">
              {convs.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/instagram/${c.id}`}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-black/[0.02]"
                  >
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal/10 text-sm font-semibold text-teal-d">
                      {(c.ig_username ?? "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">@{c.ig_username ?? c.ig_user_id}</span>
                        {c.customer_name && (
                          <span className="text-xs text-muted">· {c.customer_name}</span>
                        )}
                        {c.last_intent && <Badge tone="gray">{c.last_intent}</Badge>}
                        <Badge tone={CONV_STATUS[c.status]!.tone}>
                          {CONV_STATUS[c.status]!.label}
                        </Badge>
                        {c.unanswered && c.status !== "closed" && (
                          <Badge tone="red">sin responder</Badge>
                        )}
                        {c.pending_out > 0 && (
                          <Badge tone="amber">{c.pending_out} sin enviar</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-sm text-muted">
                        {c.last_direction === "out" && <span className="text-teal-d">Tú: </span>}
                        {c.last_text ?? "(adjunto)"}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted">
                      <div>{fmtDate(c.last_message_at, "datetime")}</div>
                      {c.assigned_name && <div>{c.assigned_name}</div>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Consultas por semana">
            <Bars
              items={m.weeks.map((w) => ({
                label: fmtDate(new Date(w.week + "T12:00:00Z")),
                value: w.inbound,
                hint: `${w.conversations} conversaciones · ${w.converted} convertidas`,
              }))}
            />
          </Card>
          <Card title="Intenciones">
            {m.intents.length === 0 ? (
              <p className="text-sm text-muted">Sin datos.</p>
            ) : (
              <Bars items={m.intents.map((i) => ({ label: i.intent, value: i.n }))} />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
