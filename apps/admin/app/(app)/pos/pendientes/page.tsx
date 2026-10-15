import { requireSession } from "@/lib/auth";
import { PageHeader, Card, Table, Badge, Money, LinkButton, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { balanceCents, listPendingPosOrders } from "@/lib/orderCollect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pendientes de cobro" };

const MODALIDAD: Record<string, string> = {
  pickup: "Recolección",
  scheduled_pickup: "Recolección programada",
  delivery: "A domicilio",
  preorder: "Anticipado",
};

/**
 * Pedidos enviados al punto de venta y todavía sin cobrar.
 *
 * Se consulta de la base en cada carga, no de memoria, de la URL ni del navegador: cerrar la
 * pantalla, cambiar de sección, recargar o cambiar de turno no pierde la cola. El índice parcial
 * `orders_pos_queue_idx` (migración 0082) cubre exactamente este filtro.
 *
 * Un pedido sale de la lista solo cuando deja de tener saldo —porque se cobró— o cuando se cancela.
 * Nada lo borra a mano.
 */
export default async function PendientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("pos.sell");
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const filas = await listPendingPosOrders(q);

  return (
    <>
      <PageHeader
        title="Pendientes de cobro"
        subtitle="Pedidos enviados al punto de venta que todavía tienen saldo"
        actions={
          <LinkButton href="/pos" variant="secondary">
            Volver al punto de venta
          </LinkButton>
        }
      />

      <Card>
        <form method="get" className="mb-3 flex gap-2">
          <input
            name="q"
            defaultValue={q}
            className="input min-h-11 max-w-xs"
            placeholder="Folio o cliente"
            aria-label="Buscar por folio o cliente"
          />
          <button type="submit" className="btn btn-secondary min-h-11">
            Buscar
          </button>
        </form>

        {filas.length === 0 ? (
          <EmptyState
            title={q ? "Sin resultados" : "No hay pedidos pendientes de cobro"}
            body={
              q
                ? "Ningún pedido en cola coincide con esa búsqueda."
                : "Cuando envíes un pedido al punto de venta desde su detalle, aparecerá aquí hasta que se cobre."
            }
          />
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Cliente</th>
                <th>Entrega</th>
                <th className="text-right">Total</th>
                <th className="text-right">Saldo</th>
                <th>En cola desde</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.id}>
                  <td className="font-mono text-xs">{f.folio}</td>
                  <td>{f.customer_name ?? <span className="text-muted">Sin cliente</span>}</td>
                  <td>
                    <Badge tone="gray">{MODALIDAD[f.fulfillment_type] ?? f.fulfillment_type}</Badge>
                  </td>
                  <td className="text-right">
                    <Money cents={f.total_cents} />
                  </td>
                  <td className="text-right font-semibold">
                    <Money cents={balanceCents(f)} />
                    {f.paid_cents > 0 && (
                      <div className="text-xs font-normal text-muted">con anticipo</div>
                    )}
                  </td>
                  <td className="text-xs text-muted">{fmtDate(f.pos_queued_at)}</td>
                  <td className="text-right">
                    <LinkButton href={`/pos/cobrar/${f.id}`} size="sm">
                      Cobrar
                    </LinkButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
