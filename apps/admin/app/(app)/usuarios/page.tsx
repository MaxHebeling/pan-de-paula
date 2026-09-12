import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Card, Table, Badge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/catalog/action-form";
import { Select, TextInput } from "@/components/catalog/fields";
import { createUser } from "./actions";

export const metadata = { title: "Usuarios" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await requireSession("staff.write");
  const [users, roles] = await Promise.all([
    db()
      .selectFrom("staff_users as u")
      .innerJoin("roles as r", "r.key", "u.role_key")
      .select([
        "u.id",
        "u.email",
        "u.full_name",
        "u.role_key",
        "r.name as role_name",
        "r.rank",
        "u.is_active",
        "u.must_change_password",
        "u.last_login_at",
        "u.locked_until",
        sql<number>`(select count(*)::int from staff_sessions s where s.staff_id = u.id and s.revoked_at is null and s.expires_at > now())`.as(
          "sessions",
        ),
      ])
      .where("u.deleted_at", "is", null)
      .orderBy("u.is_active", "desc")
      .orderBy("r.rank", "desc")
      .orderBy("u.full_name")
      .execute(),
    db().selectFrom("roles").select(["key", "name", "rank"]).orderBy("rank", "desc").execute(),
  ]);
  const myRank = roles.find((r) => r.key === session.staff.roleKey)?.rank ?? 0;
  const assignable = roles.filter((r) => r.rank <= myRank);

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle="Cuentas del equipo, roles y acceso. Solo puedes administrar roles iguales o inferiores al tuyo."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0">
          <Table>
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Último acceso</th>
                <th className="text-right">Sesiones</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const locked = u.locked_until && new Date(u.locked_until) > new Date();
                const editable = u.rank <= myRank;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="font-medium">
                        {u.full_name}
                        {u.id === session.staff.id && (
                          <span className="ml-1 text-xs text-muted">(tú)</span>
                        )}
                      </div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </td>
                    <td>{u.role_name}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={u.is_active ? "green" : "gray"}>
                          {u.is_active ? "Activo" : "Inactivo"}
                        </Badge>
                        {u.must_change_password && (
                          <Badge tone="amber">Debe cambiar contraseña</Badge>
                        )}
                        {locked && <Badge tone="red">Bloqueado</Badge>}
                      </div>
                    </td>
                    <td className="text-muted">
                      {u.last_login_at ? fmtDate(u.last_login_at, "datetime") : "nunca"}
                    </td>
                    <td className="text-right tabular-nums">{u.sessions}</td>
                    <td className="text-right">
                      {editable ? (
                        <Link href={`/usuarios/${u.id}`} className="btn btn-secondary btn-sm">
                          Gestionar
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">rol superior</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        <Card title="Nuevo usuario">
          <ActionForm
            action={createUser}
            resetOnSuccess
            className="flex flex-col gap-3"
            secret={{
              label: "Contraseña temporal",
              valueKey: "password",
              hint: "Deberá cambiarla en su primer acceso.",
            }}
          >
            <TextInput
              label="Nombre completo"
              name="full_name"
              required
              maxLength={120}
              autoComplete="off"
            />
            <TextInput label="Correo" name="email" type="email" required autoComplete="off" />
            <Select
              label="Rol"
              name="role_key"
              defaultValue={
                assignable.find((r) => r.key === "cashier")?.key ?? assignable.at(-1)?.key
              }
            >
              {assignable.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted">
              Se genera una contraseña temporal que verás una sola vez. El usuario deberá cambiarla
              en su primer acceso.
            </p>
            <div>
              <SubmitButton pendingText="Creando…">Crear usuario</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
