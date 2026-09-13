import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Badge, EmptyState } from "@/components/ui";
import { Select, TextInput } from "@/components/catalog/fields";
import { AuditDiff } from "@/components/catalog/audit-diff";

export const metadata = { title: "Auditoría" };
export const dynamic = "force-dynamic";

const PAGE = 50;
const ACTION_TONE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = {
  INSERT: "green",
  UPDATE: "amber",
  DELETE: "red",
};
const ENTITY_LABEL: Record<string, string> = {
  products: "Productos",
  product_prices: "Precios",
  categories: "Categorías",
  ingredients: "Ingredientes",
  ingredient_prices: "Precios de insumo",
  recipes: "Recetas",
  recipe_items: "Líneas de receta",
  staff_users: "Usuarios",
  business_settings: "Negocio",
  feature_flags: "Funciones",
  ordering_windows: "Ventanas de pedido",
  calendar_exceptions: "Calendario",
  orders: "Pedidos",
  customers: "Clientes",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "AAAA-MM-DD" real (rechaza 2026-13-45); vacío si no es válida. */
function validDate(v: string | undefined): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  const d = new Date(v + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? "" : v;
}

type Search = {
  entidad?: string;
  usuario?: string;
  accion?: string;
  desde?: string;
  hasta?: string;
  q?: string;
  pagina?: string;
};

type Row = {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  ip: string | null;
  created_at: Date;
  staff_name: string | null;
  staff_email: string | null;
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireSession("audit.read");
  const sp = await searchParams;
  // Filtros saneados: lo que no encaja se ignora (nunca llega a un cast ::uuid/::date que tumbe la página).
  const entidad = (sp.entidad ?? "").slice(0, 64);
  const usuario = UUID_RE.test(sp.usuario ?? "") ? sp.usuario! : "";
  const accion = (sp.accion ?? "").slice(0, 64);
  const desde = validDate(sp.desde);
  const hasta = validDate(sp.hasta);
  const q = (sp.q ?? "").trim().slice(0, 200);
  const page = Math.min(100_000, Math.max(1, Math.floor(Number(sp.pagina)) || 1));
  const offset = (page - 1) * PAGE;

  const [entities, staff, actions, res, total] = await Promise.all([
    sql<{ entity: string }>`select distinct entity from audit_logs order by entity`.execute(db()),
    db()
      .selectFrom("staff_users")
      .select(["id", "full_name"])
      .where("deleted_at", "is", null)
      .orderBy("full_name")
      .execute(),
    sql<{ action: string }>`select distinct action from audit_logs order by action`.execute(db()),
    sql<Row>`
      select a.id, a.action, a.entity, a.entity_id, a.old_data, a.new_data, a.ip::text as ip, a.created_at, u.full_name as staff_name, u.email as staff_email
      from audit_logs a left join staff_users u on u.id = a.staff_id
      where (${entidad} = '' or a.entity = ${entidad})
        and (${usuario} = '' or a.staff_id = ${usuario || null}::uuid)
        and (${accion} = '' or a.action = ${accion})
        and (${desde} = '' or a.created_at >= ${desde || null}::date)
        and (${hasta} = '' or a.created_at < (${hasta || null}::date + 1))
        and (${q} = '' or a.entity_id = ${q} or coalesce(a.new_data::text, '') ilike ${"%" + q + "%"} or coalesce(a.old_data::text, '') ilike ${"%" + q + "%"})
      order by a.created_at desc, a.id desc
      limit ${PAGE} offset ${offset}`.execute(db()),
    sql<{ n: number }>`
      select count(*)::int as n from audit_logs a
      where (${entidad} = '' or a.entity = ${entidad})
        and (${usuario} = '' or a.staff_id = ${usuario || null}::uuid)
        and (${accion} = '' or a.action = ${accion})
        and (${desde} = '' or a.created_at >= ${desde || null}::date)
        and (${hasta} = '' or a.created_at < (${hasta || null}::date + 1))
        and (${q} = '' or a.entity_id = ${q} or coalesce(a.new_data::text, '') ilike ${"%" + q + "%"} or coalesce(a.old_data::text, '') ilike ${"%" + q + "%"})`.execute(
      db(),
    ),
  ]);
  const rows = res.rows;
  const n = total.rows[0]?.n ?? 0;
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const qs = (p: number) => {
    const u = new URLSearchParams({ entidad, usuario, accion, desde, hasta, q, pagina: String(p) });
    for (const [k, v] of Array.from(u.entries())) if (!v) u.delete(k);
    return `/auditoria?${u.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Auditoría"
        subtitle={`${n.toLocaleString("es-MX")} eventos · quién cambió qué y cuándo`}
      />
      <form
        method="get"
        className="card mb-4 grid grid-cols-2 gap-3 p-3 md:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_140px_140px_1fr_auto] xl:items-end"
      >
        <Select label="Entidad" name="entidad" defaultValue={entidad}>
          <option value="">Todas</option>
          {entities.rows.map((e) => (
            <option key={e.entity} value={e.entity}>
              {ENTITY_LABEL[e.entity] ?? e.entity}
            </option>
          ))}
        </Select>
        <Select label="Usuario" name="usuario" defaultValue={usuario}>
          <option value="">Todos</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name}
            </option>
          ))}
        </Select>
        <Select label="Acción" name="accion" defaultValue={accion}>
          <option value="">Todas</option>
          {actions.rows.map((a) => (
            <option key={a.action} value={a.action}>
              {a.action}
            </option>
          ))}
        </Select>
        <TextInput label="Desde" name="desde" type="date" defaultValue={desde} />
        <TextInput label="Hasta" name="hasta" type="date" defaultValue={hasta} />
        <TextInput label="Buscar (id o texto)" name="q" defaultValue={q} />
        <div className="flex gap-2">
          <button className="btn btn-secondary" type="submit">
            Filtrar
          </button>
          {(entidad || usuario || accion || desde || hasta || q) && (
            <Link href="/auditoria" className="btn btn-secondary">
              Limpiar
            </Link>
          )}
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="Sin eventos" body="Ningún registro coincide con los filtros." />
      ) : (
        <div className="card divide-y divide-line">
          {rows.map((r) => (
            <details key={r.id} className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-black/[0.02]">
                <span className="w-32 shrink-0 tabular-nums text-muted">
                  {fmtDate(r.created_at, "datetime")}
                </span>
                <Badge tone={ACTION_TONE[r.action] ?? "blue"}>{r.action}</Badge>
                <span className="font-medium">{ENTITY_LABEL[r.entity] ?? r.entity}</span>
                <span className="truncate font-mono text-xs text-muted" title={r.entity_id ?? ""}>
                  {entityLabel(r)}
                </span>
                <span className="ml-auto text-xs text-muted">{r.staff_name ?? "sistema"}</span>
              </summary>
              <div className="border-t border-line bg-black/[0.015] px-4 py-3">
                <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    id: <span className="font-mono">{r.entity_id ?? "—"}</span>
                  </span>
                  <span>por: {r.staff_email ?? "sistema"}</span>
                  {r.ip && <span>ip: {r.ip}</span>}
                  <span>#{r.id}</span>
                </div>
                <AuditDiff action={r.action} oldData={r.old_data} newData={r.new_data} />
              </div>
            </details>
          ))}
        </div>
      )}
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Paginación">
          {page > 1 ? (
            <Link href={qs(page - 1)} className="btn btn-secondary btn-sm">
              ← Anterior
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Página {page} de {pages}
          </span>
          {page < pages ? (
            <Link href={qs(page + 1)} className="btn btn-secondary btn-sm">
              Siguiente →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}

function entityLabel(r: Row): string {
  const d = r.new_data ?? r.old_data ?? {};
  const name = (d.name ?? d.full_name ?? d.label ?? d.key ?? d.email) as string | undefined;
  if (name) return String(name);
  return r.entity_id ? r.entity_id.slice(0, 8) : "";
}
