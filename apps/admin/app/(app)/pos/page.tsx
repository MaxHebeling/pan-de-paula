import { requireSession } from "@/lib/auth";
import { loadPosCatalog, loadPosConfig } from "@/lib/pos";
import { PosScreen } from "@/components/pos/pos-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Punto de venta" };

export default async function PosPage() {
  const session = await requireSession("pos.sell");
  const [catalog, config] = await Promise.all([loadPosCatalog(), loadPosConfig(session)]);
  return <PosScreen catalog={catalog} config={config} />;
}
