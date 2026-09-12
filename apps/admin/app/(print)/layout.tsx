import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Vistas imprimibles: exigen sesión pero no cargan el shell del CRM. */
export default async function PrintLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return <div className="mx-auto max-w-[420px] bg-white px-4 py-6 text-ink print:max-w-none print:px-0 print:py-0">{children}</div>;
}
