import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { loadReceipt } from "@/lib/pos";
import { Receipt, RECEIPT_CSS } from "@/components/pos/receipt";
import { PrintBar } from "@/components/pos/print-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recibo" };

/** Ticket imprimible (80 mm). Fuera del shell del CRM para que la impresión salga limpia. */
export default async function ReciboPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  await requireSession("pos.sell");
  const { orderId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) notFound();
  const r = await loadReceipt(orderId);
  if (!r) notFound();
  return (
    <main className="min-h-dvh bg-bg px-3 py-4">
      <style dangerouslySetInnerHTML={{ __html: RECEIPT_CSS }} />
      <PrintBar autoPrint={sp.print === "1"} backHref="/pos" />
      <div className="card mx-auto w-fit max-w-full p-2">
        <Receipt r={r} />
      </div>
    </main>
  );
}
