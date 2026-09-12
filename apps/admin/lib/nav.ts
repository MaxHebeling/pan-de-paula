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
    icon: "LayoutDashboard",
    permission: "dashboard.read",
    group: "operacion",
  },
  {
    href: "/pos",
    label: "Punto de venta",
    icon: "Store",
    permission: "pos.sell",
    group: "operacion",
  },
  {
    href: "/pedidos",
    label: "Pedidos",
    icon: "ClipboardList",
    permission: "orders.read",
    group: "operacion",
  },
  {
    href: "/produccion",
    label: "Producción",
    icon: "ChefHat",
    permission: "production.read",
    group: "operacion",
  },
  {
    href: "/inventario",
    label: "Inventario",
    icon: "Boxes",
    permission: "inventory.read",
    group: "operacion",
  },
  { href: "/caja", label: "Caja", icon: "Wallet", permission: "pos.register", group: "operacion" },

  {
    href: "/productos",
    label: "Productos",
    icon: "Croissant",
    permission: "catalog.read",
    group: "catalogo",
  },
  {
    href: "/categorias",
    label: "Categorías",
    icon: "Tags",
    permission: "catalog.read",
    group: "catalogo",
  },
  {
    href: "/ingredientes",
    label: "Ingredientes",
    icon: "Wheat",
    permission: "recipes.read",
    group: "catalogo",
  },
  {
    href: "/recetas",
    label: "Recetas y costos",
    icon: "BookOpen",
    permission: "recipes.read",
    group: "catalogo",
  },
  {
    href: "/precios",
    label: "Precios y promos",
    icon: "BadgeDollarSign",
    permission: "catalog.read",
    group: "catalogo",
  },

  {
    href: "/clientes",
    label: "Clientes",
    icon: "Users",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/fidelizacion",
    label: "Fidelización",
    icon: "Gift",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/cupones",
    label: "Cupones",
    icon: "Ticket",
    permission: "customers.read",
    group: "clientes",
  },
  {
    href: "/instagram",
    label: "Instagram",
    icon: "AtSign",
    permission: "marketing.read",
    group: "clientes",
  },

  {
    href: "/reportes",
    label: "Reportes",
    icon: "BarChart3",
    permission: "reports.read",
    group: "analitica",
  },
  { href: "/notificaciones", label: "Notificaciones", icon: "Bell", group: "analitica" },

  {
    href: "/configuracion",
    label: "Configuración",
    icon: "Settings",
    permission: "settings.write",
    group: "sistema",
  },
  {
    href: "/usuarios",
    label: "Usuarios",
    icon: "ShieldCheck",
    permission: "staff.write",
    group: "sistema",
  },
  {
    href: "/auditoria",
    label: "Auditoría",
    icon: "ScrollText",
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
