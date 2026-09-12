import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, Badge, EmptyState } from "@/components/ui";
import { UnreadBadge } from "@/components/ops/unread-badge";
import { ActionForm } from "@/components/ops/action-form";
import { PendingButton } from "@/components/ops/pending-button";
import { Field } from "@/components/ops/field";
import { fmtDate } from "@/lib/format";
import { markAllReadAction, markReadAction } from "./actions";

export const metadata = { title: "Notificaciones" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;
const KIND_LABELS: Record<string, string> = {
  new_order: "Nuevo pedido",
  payment_received: "Pago recibido",
  payment_failed: "Pago rechazado",
  low_stock: "Stock bajo",
  out_of_stock: "Agotado",
  ingredient_low: "Insumo crítico",
  birthday: "Cumpleaños",
};
const SEVERITY_TONE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = { info: "blue", success: "green", warning: "amber", error: "red" };

/** Enlace a la entidad relacionada. */
function entityHref(entity: string | null, entityId: string | null): string | null {
  if (!entity || !entityId) return null;
  switch (entity) {
    case "order":
      return `/pedidos/${entityId}`;
    case "product":
      return `/inventario?tab=stock`;
    case "ingredient":
      return `/inventario?tab=insumos`;
    case "customer":
      return `/clientes/${entityId}`;
    default:
      return null;
  }
}

export default async function NotificacionesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession();
  const sp = await searchParams;
  const estado = sp.estado === "leidas" || sp.estado === "todas" ? sp.estado : "sin_leer";
  const tipo = sp.tipo && sp.tipo in KIND_LABELS ? sp.tipo : null;
  const alcance = sp.alcance === "mias" || sp.alcance === "todos" ? sp.alcance : "ambas";
  const page = Math.max(1, Number(sp.pagina ?? 1) || 1);
  const limit = 30;
  const rows = await sql<{
    id: string;
    kind: string;
    severity: string;
    title: string;
    body: string | null;
    entity: string | null;
    entity_id: string | null;
    staff_id: string | null;
    read_at: Date | null;
    created_at: Date;
  }>`select id, kind, severity, title, body, entity, entity_id, staff_id, read_at, created_at
     from notifications
     where (staff_id is null or staff_id = ${session.staff.id})
       and (${alcance} <> 'mias' or staff_id = ${session.staff.id})
       and (${alcance} <> 'todos' or staff_id is null)
       and (${estado} = 'todas' or (${estado} = 'leidas' and read_at is not null) or (${estado} = 'sin_leer' and read_at is null))
       and (${tipo}::text is null or kind = ${tipo}::text)
     order by created_at desc
     limit ${limit + 1} offset ${(page - 1) * limit}`.execute(db());
  const hasMore = rows.rows.length > limit;
  const list = rows.rows.slice(0, limit);
  const keep = { estado, tipo: tipo ?? "", alcance };
  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...keep, ...extra });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/notificaciones?${p.toString()}`;
  };
  return (
    <>
      <PageHeader
        title="Notificaciones"
        subtitle="Pedidos, pagos, stock e insumos: lo que requiere tu atención."
        actions={
          <>
            <UnreadBadge />
            <ActionForm action={markAllReadAction} resetOnSuccess={false} className="flex flex-col items-end gap-1">
              <PendingButton className="btn btn-secondary" pendingLabel="Marcando…">Marcar todas como leídas</PendingButton>
            </ActionForm>
          </>
        }
      />
      <form className="card mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-4" method="get">
        <Field label="Estado" htmlFor="estado">
          <select id="estado" name="estado" className="input min-h-11" defaultValue={estado}>
            <option value="sin_leer">Sin leer</option>
            <option value="leidas">Leídas</option>
            <option value="todas">Todas</option>
          </select>
        </Field>
        <Field label="Tipo" htmlFor="tipo">
          <select id="tipo" name="tipo" className="input min-h-11" defaultValue={tipo ?? ""}>
            <option value="">Todos</option>
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Para" htmlFor="alcance">
          <select id="alcance" name="alcance" className="input min-h-11" defaultValue={alcance}>
            <option value="ambas">Todo el equipo y mías</option>
            <option value="todos">Solo del equipo</option>
            <option value="mias">Solo mías</option>
          </select>
        </Field>
        <div className="flex items-end">
          <button className="btn btn-secondary min-h-11 w-full">Filtrar</button>
        </div>
      </form>
      {list.length === 0 ? (
        <EmptyState title={estado === "sin_leer" ? "Todo al día" : "Sin notificaciones"} body={estado === "sin_leer" ? "No tienes notificaciones pendientes." : undefined} />
      ) : (
        <ul className="card divide-y divide-line">
          {list.map((n) => {
            const link = entityHref(n.entity, n.entity_id);
            return (
              <li key={n.id} className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${n.read_at ? "opacity-70" : ""}`} data-testid="notification">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[n.severity] ?? "gray"}>{KIND_LABELS[n.kind] ?? n.kind}</Badge>
                    <span className="font-medium">{n.title}</span>
                    {n.staff_id && <Badge tone="gray">personal</Badge>}
                  </div>
                  {n.body && <p className="mt-0.5 text-sm text-muted">{n.body}</p>}
                  <p className="mt-0.5 text-xs text-muted">
                    {fmtDate(n.created_at, "datetime")}
                    {link && (
                      <>
                        {" · "}
                        <Link href={link} className="underline">
                          Ver {n.entity === "order" ? "pedido" : n.entity === "product" ? "inventario" : n.entity === "ingredient" ? "insumos" : n.entity === "customer" ? "cliente" : "detalle"}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                {!n.read_at && (
                  <ActionForm action={markReadAction} resetOnSuccess={false} className="shrink-0">
                    <input type="hidden" name="id" value={n.id} />
                    <PendingButton className="btn btn-secondary btn-sm min-h-9" pendingLabel="…">
                      Marcar leída
                    </PendingButton>
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(page > 1 || hasMore) && (
        <div className="mt-3 flex justify-between">
          {page > 1 ? <Link href={href({ pagina: String(page - 1) })} className="btn btn-secondary">← Anteriores</Link> : <span />}
          {hasMore && <Link href={href({ pagina: String(page + 1) })} className="btn btn-secondary">Siguientes →</Link>}
        </div>
      )}
    </>
  );
}
