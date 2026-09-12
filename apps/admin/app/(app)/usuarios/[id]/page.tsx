import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Card, Badge, Alert } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/catalog/action-form";
import { Checkbox, Select, TextInput } from "@/components/catalog/fields";
import { generateResetLink, revokeSessions, updateUser } from "../actions";

export const dynamic = "force-dynamic";

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession("staff.write");
  const { id } = await params;
  const [u, roles, sessions] = await Promise.all([
    db()
      .selectFrom("staff_users as u")
      .innerJoin("roles as r", "r.key", "u.role_key")
      .select(["u.id", "u.email", "u.full_name", "u.role_key", "r.name as role_name", "r.rank", "u.is_active", "u.must_change_password", "u.last_login_at", "u.locked_until", "u.failed_logins", "u.created_at"])
      .where("u.id", "=", id)
      .where("u.deleted_at", "is", null)
      .executeTakeFirst(),
    db().selectFrom("roles").select(["key", "name", "rank"]).orderBy("rank", "desc").execute(),
    db()
      .selectFrom("staff_sessions")
      .select(["id", "user_agent", "ip", "created_at", "last_seen_at", "expires_at"])
      .where("staff_id", "=", id)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .orderBy("last_seen_at", "desc")
      .execute(),
  ]);
  if (!u) notFound();
  const myRank = roles.find((r) => r.key === session.staff.roleKey)?.rank ?? 0;
  if (u.rank > myRank) redirect("/usuarios");
  const assignable = roles.filter((r) => r.rank <= myRank);
  const isSelf = u.id === session.staff.id;
  const locked = u.locked_until && new Date(u.locked_until) > new Date();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={u.full_name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/usuarios" className="hover:underline">
              ← Usuarios
            </Link>
            <span>{u.email}</span>
            <Badge tone={u.is_active ? "green" : "gray"}>{u.is_active ? "Activo" : "Inactivo"}</Badge>
            {u.must_change_password && <Badge tone="amber">Debe cambiar contraseña</Badge>}
            {locked && <Badge tone="red">Bloqueado hasta {fmtDate(u.locked_until, "time")}</Badge>}
          </span>
        }
      />
      {isSelf && (
        <div className="mb-4">
          <Alert tone="blue">Es tu propia cuenta: puedes cambiar tu nombre, pero no tu rol ni tu estado.</Alert>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Datos y rol">
          <ActionForm action={updateUser.bind(null, u.id)} className="flex flex-col gap-3">
            <TextInput label="Nombre completo" name="full_name" required maxLength={120} defaultValue={u.full_name} />
            <Select label="Rol" name="role_key" defaultValue={u.role_key} disabled={isSelf}>
              {(isSelf ? roles : assignable).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
            {isSelf && <input type="hidden" name="role_key" value={u.role_key} />}
            <Checkbox label="Cuenta activa" name="is_active" defaultChecked={u.is_active} disabled={isSelf} hint="Al desactivar se cierran sus sesiones y no puede entrar." />
            {isSelf && <input type="hidden" name="is_active" value="on" />}
            <div>
              <SubmitButton>Guardar</SubmitButton>
            </div>
          </ActionForm>
          <dl className="mt-4 grid grid-cols-2 gap-1 text-xs text-muted">
            <dt>Creado</dt>
            <dd>{fmtDate(u.created_at, "datetime")}</dd>
            <dt>Último acceso</dt>
            <dd>{u.last_login_at ? fmtDate(u.last_login_at, "datetime") : "nunca"}</dd>
            <dt>Intentos fallidos</dt>
            <dd>{u.failed_logins}</dd>
          </dl>
        </Card>
        <div className="flex flex-col gap-4">
          <Card title="Restablecer contraseña">
            <p className="mb-3 text-sm text-muted">Genera un enlace de un solo uso (vence en 1 hora). Compártelo por WhatsApp o en persona.</p>
            <ActionForm action={generateResetLink.bind(null, u.id)} secret={{ label: "Enlace de restablecimiento", valueKey: "url" }}>
              <SubmitButton variant="secondary" pendingText="Generando…" disabled={!u.is_active}>
                Generar enlace
              </SubmitButton>
            </ActionForm>
          </Card>
          <Card title={`Sesiones activas (${sessions.length})`}>
            {sessions.length === 0 ? (
              <p className="text-sm text-muted">Sin sesiones abiertas.</p>
            ) : (
              <ul className="mb-3 divide-y divide-line text-xs">
                {sessions.map((s) => (
                  <li key={s.id} className="py-1.5">
                    <div className="truncate" title={s.user_agent ?? ""}>
                      {s.user_agent ?? "dispositivo desconocido"}
                    </div>
                    <div className="text-muted">
                      {s.ip ?? "—"} · visto {fmtDate(s.last_seen_at, "datetime")} · vence {fmtDate(s.expires_at)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form action={revokeSessions.bind(null, u.id)}>
              <ConfirmButton variant="danger" confirm={isSelf ? "Se cerrarán TODAS tus sesiones, incluida esta. ¿Continuar?" : `¿Cerrar todas las sesiones de ${u.full_name}?`}>
                Cerrar todas las sesiones
              </ConfirmButton>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
