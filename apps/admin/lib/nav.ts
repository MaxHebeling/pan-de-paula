/**
 * Navegación del CRM. TODAS las secciones se declaran aquí (aunque la página aún no exista) para que
 * los módulos se implementen en paralelo sin tocar este archivo. `permission` filtra por rol.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: string;
  permission?: string;
  group: "operacion" | "catalogo" | "clientes" | "analitica" | "sistema";
};

export const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: "🏠",
    permission: "dashboard.read",
    group: "operacion",
  },
  {
    href: "/pos",
    label: "Punto de venta",
    icon: "🛒",
    permission: "pos.sell",
    group: "operacion",
  },
  {
    href: "/pedidos",
    label: "Pedidos",
    icon: "📋",
    permission: "orders.read",
    group: "operacion",
  },
  {
    href: "/produccion",
    label: "Producción",
    icon: "🥐",
    permission: "production.read",
    group: "operacion",
  },
  {
    href: "/inventario",
    label: "Inventario",
    icon: "📦",
    permission: "inventory.read",
    group: "operacion",
  },
  { href: "/caja", label: "Caja", icon: "💵", permission: "pos.register", group: "operacion" },

  {
    href: "/productos",
    label: "Productos",
    icon: "🧁",
    permission: "catalog.read",
    group: "catalogo",
  },
  {
    href: "/categorias",
    label: "Categorías",
    icon: "🏷️",
    permission: "catalog.read",
    group: "catalogo",
  },
  {
    href: "/ingredientes",
    label: "Ingredientes",
    icon: "🌾",
    permission: "recipes.read",
    group: "catalogo",
  },
  {
    href: "/recetas",
    label: "Recetas y costos",
    icon: "📖",
    permission: "recipes.read",
    group: "catalogo",
  },
  {
    href: "/precios",
    label: "Precios y promos",
    icon: "💰",
    permission: "catalog.read",
    group: "catalogo",
  },

  {
    href: "/clientes",
    label: "Clientes",
    icon: "👥",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/fidelizacion",
    label: "Fidelización",
    icon: "🎁",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/cupones",
    label: "Cupones",
    icon: "🎟️",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/instagram",
    label: "Instagram",
    icon: "📸",
    permission: "marketing.read",
    group: "clientes",
  },

  {
    href: "/reportes",
    label: "Reportes",
    icon: "📊",
    permission: "reports.read",
    group: "analitica",
  },
  { href: "/notificaciones", label: "Notificaciones", icon: "🔔", group: "analitica" },

  {
    href: "/configuracion",
    label: "Configuración",
    icon: "⚙️",
    permission: "settings.write",
    group: "sistema",
  },
  {
    href: "/usuarios",
    label: "Usuarios",
    icon: "🛡️",
    permission: "staff.write",
    group: "sistema",
  },
  {
    href: "/auditoria",
    label: "Auditoría",
    icon: "📜",
    permission: "audit.read",
    group: "sistema",
  },
];

export const NAV_GROUPS: Record<NavItem["group"], string> = {
  operacion: "Operación",
  catalogo: "Catálogo",
  clientes: "Clientes",
  analitica: "Analítica",
  sistema: "Sistema",
};
