import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { getOpenRegister, getRegisterSummary } from "@/lib/pos";
import { Alert, Badge, Card, Money, PageHeader, Table } from "@/components/ui";
import { RegisterCloseForm, RegisterOpenForm } from "@/components/pos/register-forms";
import { RegisterSummaryTable } from "@/components/pos/register-summary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Caja" };

export default async function CajaPage({
  searchParams,
}: {
  searchParams: Promise<{ abierta?: string }>;
}) {
  await requireSession("pos.register");
  const sp = await searchParams;
  const open = await getOpenRegister();
  const summary = open ? await getRegisterSummary(open.id) : null;
  const history = await sql<{
    id: string;
    opened_at: Date;
    closed_at: Date | null;
    status: string;
    opened_by: string;
    opening_cash_cents: number;
    expected_cash_cents: number | null;
    counted_cash_cents: number | null;
    difference_cents: number | null;
    sales_count: number;
  }>`select rs.id, rs.opened_at, rs.closed_at, rs.status, su.full_name as opened_by, rs.opening_cash_cents,
            rs.expected_cash_cents, rs.counted_cash_cents, rs.difference_cents,
            (select count(*)::int from sales s where s.register_session_id = rs.id and s.voided_at is null) as sales_count
     from register_sessions rs join staff_users su on su.id = rs.opened_by
     order by rs.opened_at desc limit 30`.execute(db());

  return (
    <>
      <PageHeader
        title="Caja"
        subtitle={
          open
            ? `Abierta desde ${fmtDate(open.openedAt, "datetime")} por ${open.openedByName}`
            : "No hay caja abierta. Las ventas en efectivo requieren abrirla."
        }
        actions={
          <Link href="/pos" className="btn btn-secondary">
            Ir al POS
          </Link>
        }
      />
      {sp.abierta === "1" && open && (
        <div className="mb-4">
          <Alert tone="green">Caja abierta. Ya puedes cobrar en efectivo.</Alert>
        </div>
      )}
      {open && summary ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card title="Sesión actual" action={<Badge tone="green">Abierta</Badge>}>
            <RegisterSummaryTable s={summary} compact />
            {open.notes && (
              <p className="mt-3 text-sm text-muted">Notas de apertura: {open.notes}</p>
            )}
          </Card>
          <Card title="Cierre de caja">
            <p className="mb-3 text-sm text-muted">
              Cuenta el efectivo del cajón (incluido el fondo) y captúralo. El sistema calcula la
              diferencia contra lo esperado.
            </p>
            <RegisterCloseForm
              sessionId={open.id}
              expectedCashCents={summary.expected_cash_cents}
            />
          </Card>
        </div>
      ) : (
        <Card title="Abrir caja">
          <p className="mb-3 text-sm text-muted">
            Captura el fondo inicial en efectivo con el que inicia el turno.
          </p>
          <RegisterOpenForm />
        </Card>
      )}

      <h2 className="mb-2 mt-6 text-base font-semibold">Historial de cortes</h2>
      {history.rows.length === 0 ? (
        <p className="card p-6 text-center text-sm text-muted">Aún no hay sesiones de caja.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Apertura</th>
              <th>Cierre</th>
              <th className="hidden xl:table-cell">Abrió</th>
              <th className="text-right">Ventas</th>
              <th className="hidden text-right lg:table-cell">Esperado</th>
              <th className="text-right">Contado</th>
              <th className="text-right">Diferencia</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.opened_at, "datetime")}</td>
                <td>
                  {r.closed_at ? (
                    fmtDate(r.closed_at, "datetime")
                  ) : (
                    <Badge tone="green">Abierta</Badge>
                  )}
                </td>
                <td className="hidden xl:table-cell">{r.opened_by}</td>
                <td className="text-right tabular-nums">{r.sales_count}</td>
                <td className="hidden text-right lg:table-cell">
                  {r.expected_cash_cents === null ? "—" : <Money cents={r.expected_cash_cents} />}
                </td>
                <td className="text-right">
                  {r.counted_cash_cents === null ? "—" : <Money cents={r.counted_cash_cents} />}
                </td>
                <td
                  className={`text-right font-semibold ${r.difference_cents ? "text-red-d" : "text-green-d"}`}
                >
                  {r.difference_cents === null ? "—" : <Money cents={r.difference_cents} />}
                </td>
                <td className="text-right">
                  <Link href={`/caja/${r.id}`} className="btn btn-secondary btn-sm min-h-9">
                    Detalle
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
