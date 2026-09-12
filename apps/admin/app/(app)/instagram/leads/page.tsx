import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Table, Badge, LinkButton, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { listLeads, LEAD_STATUS } from "@/lib/instagram";
import { ActionForm } from "@/components/customers/action-form";
import { updateLeadAction } from "../actions";

export const metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession("marketing.read");
  const canWrite = hasPermission(session, "marketing.write");
  const sp = await searchParams;
  const status = (Array.isArray(sp.estado) ? sp.estado[0] : sp.estado) ?? "";
  const leads = await listLeads({ status: LEAD_STATUS[status] ? status : undefined });
  return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Interesados que aún no compran: Instagram, web, QR o WhatsApp"
        actions={
          <LinkButton href="/instagram" variant="secondary">
            Bandeja de Instagram
          </LinkButton>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        <Link
          href="/instagram/leads"
          role="tab"
          aria-selected={!status}
          className={`pill px-3 py-1.5 text-sm font-medium ${!status ? "bg-teal text-white" : "st-gray"}`}
        >
          Todos
        </Link>
        {Object.entries(LEAD_STATUS).map(([k, v]) => (
          <Link
            key={k}
            href={`/instagram/leads?estado=${k}`}
            role="tab"
            aria-selected={status === k}
            className={`pill px-3 py-1.5 text-sm font-medium ${status === k ? "bg-teal text-white" : "st-gray"}`}
          >
            {v.label}
          </Link>
        ))}
      </div>
      {leads.length === 0 ? (
        <EmptyState
          title="Sin leads"
          body="Crea leads desde una conversación de Instagram o llegarán solos por el webhook."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Origen</th>
              <th>Contacto</th>
              <th>Interés</th>
              <th>Cliente / pedido</th>
              <th>Estado</th>
              {canWrite && <th>Actualizar</th>}
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap text-muted">
                  {fmtDate(l.created_at, "datetime")}
                </td>
                <td>
                  {l.source === "instagram" && l.source_ref ? (
                    <Link
                      href={`/instagram/${l.source_ref}`}
                      className="text-teal-d hover:underline"
                    >
                      instagram
                    </Link>
                  ) : (
                    l.source
                  )}
                </td>
                <td>
                  <div>{l.name ?? l.handle ?? "—"}</div>
                  <div className="text-xs text-muted">
                    {[l.handle && `@${l.handle}`, l.phone, l.email].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="max-w-[240px]">
                  <div className="truncate" title={l.interest ?? ""}>
                    {l.interest ?? "—"}
                  </div>
                  {l.product_name && <div className="text-xs text-muted">{l.product_name}</div>}
                </td>
                <td className="text-xs">
                  {l.customer_id ? (
                    <Link href={`/clientes/${l.customer_id}`} className="hover:underline">
                      {l.customer_name}
                    </Link>
                  ) : (
                    <span className="text-muted">sin cliente</span>
                  )}
                  {l.folio && <div className="font-mono">{l.folio}</div>}
                </td>
                <td>
                  <Badge tone={LEAD_STATUS[l.status]!.tone}>{LEAD_STATUS[l.status]!.label}</Badge>
                  {l.converted_at && (
                    <div className="text-xs text-muted">{fmtDate(l.converted_at)}</div>
                  )}
                </td>
                {canWrite && (
                  <td>
                    <ActionForm
                      action={updateLeadAction}
                      inline
                      submitLabel="OK"
                      variant="secondary"
                      size="sm"
                    >
                      <input type="hidden" name="id" value={l.id} />
                      <select
                        name="status"
                        className="input w-auto"
                        defaultValue={l.status}
                        aria-label="Estado"
                      >
                        {Object.entries(LEAD_STATUS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                      {!l.customer_id && (
                        <input
                          name="customer"
                          className="input w-[130px]"
                          placeholder="PDP / tel."
                          aria-label="Cliente"
                        />
                      )}
                      {!l.order_id && (
                        <input
                          name="folio"
                          className="input w-[140px]"
                          placeholder="Folio pedido"
                          aria-label="Folio"
                        />
                      )}
                    </ActionForm>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
