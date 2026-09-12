import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { LinkButton } from "@/components/ui";
import { PrintButton } from "@/components/reports/print-button";
import { getCustomer } from "@/lib/customers";
import "@/components/reports/print.css";

export const metadata = { title: "Tarjeta de cliente" };

export default async function CustomerCardPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession("customers.read");
  const { id } = await params;
  const c = await getCustomer(id);
  if (!c || c.deleted_at) notFound();
  const [qr, biz] = await Promise.all([
    QRCode.toDataURL(c.qr_token, { errorCorrectionLevel: "M", margin: 1, width: 360, color: { dark: "#1d1d1f", light: "#ffffff" } }),
    sql<{ name: string; tagline: string | null; instagram_handle: string | null; phone: string | null }>`select name, tagline, instagram_handle, phone from business_settings where id = 1`.execute(
      db(),
    ),
  ]);
  const b = biz.rows[0]!;
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tarjeta QR</h1>
          <p className="text-sm text-muted">
            El QR contiene el identificador opaco del cliente: al escanearlo en el POS se acumulan puntos. No expone datos personales.
          </p>
        </div>
        <div className="flex gap-2">
          <LinkButton href={`/clientes/${c.id}`} variant="secondary">
            Volver
          </LinkButton>
          <PrintButton label="Imprimir tarjeta" />
        </div>
      </div>
      <div className="print-area mx-auto grid max-w-[720px] gap-6 md:grid-cols-2">
        <section className="card-lg card flex flex-col items-center gap-3 p-6 text-center" aria-label="Frente de la tarjeta">
          <div className="text-lg font-semibold">{b.name}</div>
          {b.tagline && <div className="-mt-2 text-xs text-muted">{b.tagline}</div>}
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generado en servidor */}
          <img src={qr} alt={`Código QR del cliente ${c.public_code}`} width={220} height={220} className="rounded-lg" />
          <div className="font-mono text-xl font-semibold tracking-wider">{c.public_code}</div>
          <div className="text-base font-medium">{c.full_name}</div>
          <div className="text-xs text-muted">Presenta esta tarjeta en cada compra para acumular puntos.</div>
        </section>
        <section className="card-lg card flex flex-col justify-between gap-3 p-6 text-sm" aria-label="Reverso de la tarjeta">
          <div>
            <div className="text-base font-semibold">Programa de puntos</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Acumula puntos en cada compra en mostrador o en línea.</li>
              <li>Canjea tus puntos por descuentos y productos.</li>
              <li>Puntos dobles el día de tu cumpleaños.</li>
              <li>Si pierdes la tarjeta, identifícate con tu teléfono o código.</li>
            </ul>
          </div>
          <div className="text-xs text-muted">
            {b.instagram_handle && <div>@{b.instagram_handle}</div>}
            {b.phone && <div>{b.phone}</div>}
            <div className="mt-1 font-mono">{c.public_code}</div>
          </div>
        </section>
      </div>
    </>
  );
}
