import {
  LayoutDashboard,
  Store,
  ClipboardList,
  ChefHat,
  Boxes,
  Wallet,
  Croissant,
  Tags,
  Wheat,
  BookOpen,
  BadgeDollarSign,
  Users,
  Gift,
  Ticket,
  AtSign,
  BarChart3,
  Bell,
  Settings,
  ShieldCheck,
  ScrollText,
  type LucideProps,
} from "lucide-react";

const ICONS = {
  LayoutDashboard,
  Store,
  ClipboardList,
  ChefHat,
  Boxes,
  Wallet,
  Croissant,
  Tags,
  Wheat,
  BookOpen,
  BadgeDollarSign,
  Users,
  Gift,
  Ticket,
  AtSign,
  BarChart3,
  Bell,
  Settings,
  ShieldCheck,
  ScrollText,
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, ...props }: { name: string } & LucideProps) {
  const C = ICONS[name as IconName] ?? LayoutDashboard;
  return <C size={18} strokeWidth={1.8} aria-hidden {...props} />;
}
