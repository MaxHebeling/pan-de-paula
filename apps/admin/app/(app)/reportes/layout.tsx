import { PageHeader } from "@/components/ui";
import "@/components/reports/print.css";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Reportes"
          subtitle="Ventas anuladas excluidas · reembolsos restados · fechas en horario del negocio"
        />
      </div>
      {children}
    </>
  );
}
