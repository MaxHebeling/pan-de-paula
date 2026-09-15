import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { NAV } from "@/lib/nav";
import { Shell } from "@/components/shell";
import { countUnseenOrders } from "@/lib/orders-unseen";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  owner: "Dueño",
  manager: "Gerente",
  cashier: "Caja",
  production: "Producción",
  sales: "Ventas",
  marketing: "Marketing",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const items = NAV.filter((i) => !i.permission || hasPermission(session, i.permission));
  const unread = await sql<{
    n: number;
  }>`select count(*)::int as n from notifications where read_at is null and (staff_id is null or staff_id = ${session.staff.id})`.execute(
    db(),
  );
  const unseenOrders = hasPermission(session, "orders.read") ? await countUnseenOrders() : null;
  return (
    <Shell
      items={items}
      user={{
        name: session.staff.fullName,
        role: ROLE_LABEL[session.staff.roleKey] ?? session.staff.roleKey,
      }}
      unread={unread.rows[0]?.n ?? 0}
      unseenOrders={unseenOrders}
    >
      {children}
    </Shell>
  );
}
