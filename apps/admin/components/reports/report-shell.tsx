import { requireSession, hasPermission } from "@/lib/auth";
import { parseRange, defaultRanges, REPORT_KINDS, type Range, type ReportKind } from "@/lib/reports";
import { RangeBar } from "./range-bar";
import { ReportHeading } from "./compare";

type SP = Record<string, string | string[] | undefined>;

/** Sesión + rango + barra de navegación/rango común a todos los reportes. */
export async function reportContext(sp: SP, kind: ReportKind, defaults: (d: ReturnType<typeof defaultRanges>) => { from: string; to: string }) {
  const session = await requireSession("reports.read");
  const d = defaultRanges();
  const range = parseRange(sp, defaults(d));
  const canExport = hasPermission(session, "reports.export");
  return { session, range, canExport, today: d.today, kind };
}

export function ReportShell({ ctx, title, children }: { ctx: { range: Range; canExport: boolean; today: string; kind: ReportKind }; title: string; children: React.ReactNode }) {
  return (
    <>
      <RangeBar kinds={REPORT_KINDS} today={ctx.today} from={ctx.range.from} to={ctx.range.to} canExport={ctx.canExport} reportKey={ctx.kind} />
      <ReportHeading title={title} from={ctx.range.from} to={ctx.range.to} prevFrom={ctx.range.prevFrom} prevTo={ctx.range.prevTo} />
      {children}
    </>
  );
}
