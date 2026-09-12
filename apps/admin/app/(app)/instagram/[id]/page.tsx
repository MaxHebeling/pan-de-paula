import Link from "next/link";
import { notFound } from "next/navigation";
import { isInstagramConfigured } from "@pdp/integrations";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, Card, Badge, LinkButton, Alert } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { getConversation, conversationLeads, CONV_STATUS, LEAD_STATUS } from "@/lib/instagram";
import { activeProducts } from "@/lib/loyalty";
import { ActionForm } from "@/components/customers/action-form";
import { replyAction, setConversationStatusAction, assignConversationAction, linkCustomerAction, unlinkCustomerAction, createLeadAction, updateLeadAction } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getConversation(id);
  return { title: c ? `@${c.conversation.ig_username ?? "instagram"} · Instagram` : "Instagram" };
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession("marketing.read");
  const canWrite = hasPermission(session, "marketing.write");
  const { id } = await params;
  const data = await getConversation(id);
  if (!data) notFound();
  const { conversation: c, messages } = data;
  const [leads, products, staff] = await Promise.all([
    conversationLeads(id),
    activeProducts(),
    sql<{ id: string; full_name: string }>`select id, full_name from staff_users where is_active and deleted_at is null order by full_name`.execute(db()),
  ]);
  const configured = isInstagramConfigured();
  return (
    <>
      <PageHeader
        title={`@${c.ig_username ?? c.ig_user_id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={CONV_STATUS[c.status]!.tone}>{CONV_STATUS[c.status]!.label}</Badge>
            {c.last_intent && <span>intención: {c.last_intent}</span>}
            <span>· {messages.length} mensajes</span>
            {c.assigned_name && <span>· asignada a {c.assigned_name}</span>}
          </span>
        }
        actions={
          <LinkButton href="/instagram" variant="secondary">
            Bandeja
          </LinkButton>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <Card title="Conversación">
            <ol className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
              {messages.map((m) => (
                <li key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-[var(--r-card)] px-3 py-2 text-sm ${m.direction === "out" ? "bg-teal text-white" : "bg-black/[0.05]"}`}>
                    <div className="whitespace-pre-wrap">{m.text ?? "(adjunto)"}</div>
                    <div className={`mt-1 flex flex-wrap items-center gap-1.5 text-[11px] ${m.direction === "out" ? "text-white/80" : "text-muted"}`}>
                      <span>{fmtDate(m.created_at, "datetime")}</span>
                      {m.direction === "out" && m.sent_by_name && <span>· {m.sent_by_name}</span>}
                      {m.auto_reply && <span>· bot</span>}
                      {m.intent && m.direction === "in" && <span>· {m.intent}</span>}
                      {m.direction === "out" && m.delivery_status === "pending" && <span className="rounded bg-white/90 px-1 font-semibold text-amber-d">NO ENVIADO · pendiente</span>}
                      {m.direction === "out" && m.delivery_status === "failed" && (
                        <span className="rounded bg-white/90 px-1 font-semibold text-red-d" title={m.delivery_error ?? ""}>
                          FALLÓ
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {canWrite ? (
              <div className="mt-4 border-t border-line pt-3">
                {!configured && (
                  <div className="mb-2">
                    <Alert tone="amber">Instagram no está conectado: lo que escribas se guardará como pendiente y NO se enviará.</Alert>
                  </div>
                )}
                <ActionForm action={replyAction} submitLabel={configured ? "Enviar" : "Guardar como pendiente"} resetOnOk>
                  <input type="hidden" name="id" value={c.id} />
                  <textarea name="text" className="input" rows={3} maxLength={1000} placeholder="Escribe la respuesta…" required />
                </ActionForm>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted">Necesitas permiso de marketing para responder.</p>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Estado">
            {canWrite ? (
              <div className="flex flex-wrap gap-2">
                {(["open", "handled", "converted", "closed"] as const)
                  .filter((s) => s !== c.status)
                  .map((s) => (
                    <ActionForm key={s} action={setConversationStatusAction} inline submitLabel={`Marcar ${CONV_STATUS[s]!.label}`} variant={s === "converted" ? "confirm" : "secondary"} size="sm">
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="status" value={s} />
                    </ActionForm>
                  ))}
              </div>
            ) : (
              <Badge tone={CONV_STATUS[c.status]!.tone}>{CONV_STATUS[c.status]!.label}</Badge>
            )}
            {canWrite && (
              <ActionForm action={assignConversationAction} inline submitLabel="Asignar" variant="secondary" size="sm" className="mt-3">
                <input type="hidden" name="id" value={c.id} />
                <div className="min-w-[180px] flex-1">
                  <label className="label" htmlFor="staff_id">
                    Responsable
                  </label>
                  <select id="staff_id" name="staff_id" className="input" defaultValue={c.assigned_to ?? ""}>
                    <option value="">Sin asignar</option>
                    {staff.rows.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </ActionForm>
            )}
          </Card>
          <Card title="Cliente">
            {c.customer_id ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <Link href={`/clientes/${c.customer_id}`} className="font-medium hover:underline">
                  {c.customer_name} <span className="font-mono text-xs text-muted">{c.public_code}</span>
                </Link>
                {canWrite && (
                  <ActionForm action={unlinkCustomerAction} inline submitLabel="Desvincular" variant="secondary" size="sm">
                    <input type="hidden" name="id" value={c.id} />
                  </ActionForm>
                )}
              </div>
            ) : (
              <>
                <p className="mb-2 text-sm text-muted">Sin cliente vinculado.</p>
                {canWrite && (
                  <ActionForm action={linkCustomerAction} inline submitLabel="Vincular" variant="secondary" size="sm">
                    <input type="hidden" name="id" value={c.id} />
                    <input name="query" className="input min-w-[200px] flex-1" placeholder="PDP-000123, teléfono o email" required />
                  </ActionForm>
                )}
                <p className="mt-2 text-xs text-muted">
                  ¿No existe?{" "}
                  <Link href="/clientes/nuevo" className="text-teal-d underline">
                    Registrar cliente
                  </Link>{" "}
                  y vuelve a vincular.
                </p>
              </>
            )}
          </Card>
          <Card title={`Leads (${leads.length})`}>
            {leads.length > 0 && (
              <ul className="mb-3 divide-y divide-line text-sm">
                {leads.map((l) => (
                  <li key={l.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{l.interest ?? "—"}</span>
                      <Badge tone={LEAD_STATUS[l.status]!.tone}>{LEAD_STATUS[l.status]!.label}</Badge>
                    </div>
                    <div className="text-xs text-muted">
                      {fmtDate(l.created_at)}
                      {l.product_name && ` · ${l.product_name}`}
                      {l.folio && ` · pedido ${l.folio}`}
                    </div>
                    {canWrite && l.status !== "converted" && (
                      <ActionForm action={updateLeadAction} inline className="mt-1.5" submitLabel="Actualizar" variant="secondary" size="sm">
                        <input type="hidden" name="id" value={l.id} />
                        <input type="hidden" name="conversation_id" value={c.id} />
                        <select name="status" className="input w-auto" defaultValue={l.status}>
                          {Object.entries(LEAD_STATUS).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                        <input name="folio" className="input w-[150px]" placeholder="Folio pedido" />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-teal-d">Crear lead desde esta conversación</summary>
                <ActionForm action={createLeadAction} submitLabel="Crear lead" variant="secondary" resetOnOk className="mt-2">
                  <input type="hidden" name="id" value={c.id} />
                  <input name="interest" className="input" placeholder="Interés (ej. 12 roles para el sábado) *" required />
                  <select name="product_id" className="input" defaultValue="">
                    <option value="">Producto (opcional)</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <input name="name" className="input" placeholder="Nombre" />
                    <input name="phone" className="input" placeholder="Teléfono" inputMode="tel" />
                  </div>
                </ActionForm>
              </details>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
