/**
 * Texto del saludo de cumpleaños (función pura, sin acceso a base ni a red).
 *
 * Reglas de redacción acordadas con el negocio:
 * - Español latinoamericano neutro: cálido y profesional, SIN modismos regionales
 *   ("chido", "padrísimo", "guay", "che", "bacán"…). El mismo texto debe leerse bien en
 *   México, Colombia, Argentina o España.
 * - Se usa el PRIMER NOMBRE del cliente (nunca el nombre completo ni el código interno).
 * - El nivel de fidelización solo se menciona cuando aporta: un cierre distinto para VIP y
 *   Embajador. Nuevo y Frecuente reciben el mismo texto base (mencionar "eres Nuevo" no aporta).
 * - NO se prometen premios, descuentos ni beneficios inventados. El único beneficio que puede
 *   mencionarse es el real del programa de puntos (`loyalty_program.birthday_multiplier`), y solo
 *   si el programa está activo y el multiplicador es mayor que 1.
 */

/** Niveles reales del sistema (tabla `loyalty_tiers`). */
export type TierKey = "new" | "frequent" | "vip" | "ambassador";

export type BirthdayGreetingInput = {
  /** Nombre completo del cliente tal como está en el CRM. */
  fullName: string;
  /** `customers.tier_key` (o null si aún no tiene nivel). */
  tierKey?: string | null;
  /** Nombre del negocio; por defecto "El Pan de Paula". */
  businessName?: string;
  /** `loyalty_program.is_active` && feature flag de puntos. */
  loyaltyActive?: boolean;
  /** `loyalty_program.birthday_multiplier` (2.0 = puntos dobles). */
  birthdayMultiplier?: number;
};

const DEFAULT_BUSINESS = "El Pan de Paula";

/**
 * Primer nombre presentable: toma la primera palabra y normaliza mayúsculas
 * ("ana lópez" → "Ana", "MARÍA JOSÉ" → "María"). Conserva acentos y la ñ.
 * Si el nombre viene vacío devuelve cadena vacía (el saludo cae a una forma sin nombre).
 */
export function firstName(fullName: string): string {
  const word = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!word) return "";
  // Solo se re-capitaliza cuando viene todo en mayúsculas o todo en minúsculas:
  // nombres como "McCarthy" o "DiCaprio" se dejan como el staff los escribió.
  const isAllUpper = word === word.toLocaleUpperCase("es-MX");
  const isAllLower = word === word.toLocaleLowerCase("es-MX");
  if (!isAllUpper && !isAllLower) return word;
  const lower = word.toLocaleLowerCase("es-MX");
  return lower.charAt(0).toLocaleUpperCase("es-MX") + lower.slice(1);
}

/** "puntos dobles" / "puntos triples" / "4× los puntos de siempre" según el multiplicador real. */
function multiplierPhrase(multiplier: number): string {
  if (multiplier === 2) return "puntos dobles";
  if (multiplier === 3) return "puntos triples";
  const n = Number.isInteger(multiplier)
    ? String(multiplier)
    : multiplier.toFixed(1).replace(".", ",");
  return `${n}× los puntos de siempre`;
}

/** Cierre por nivel. Solo VIP y Embajador reciben una línea propia. */
function tierLine(tierKey: string | null | undefined): string | null {
  switch (tierKey) {
    case "vip":
      return "Gracias por acompañarnos como cliente VIP: nos alegra mucho tenerte cerca.";
    case "ambassador":
      return "Gracias por ser embajador de nuestra panadería y por recomendarnos a quienes quieres.";
    default:
      return null;
  }
}

/**
 * Arma el mensaje de cumpleaños listo para copiar a WhatsApp o enviar por correo.
 * Devuelve texto plano con saltos de línea (una idea por línea).
 */
export function birthdayGreetingMessage(input: BirthdayGreetingInput): string {
  const business = (input.businessName ?? "").trim() || DEFAULT_BUSINESS;
  const name = firstName(input.fullName);
  const multiplier = input.birthdayMultiplier ?? 0;
  const lines: string[] = [
    name ? `¡Feliz cumpleaños, ${name}! 🎂` : "¡Feliz cumpleaños! 🎂",
    "Hoy queremos celebrar contigo. Gracias por elegirnos y permitirnos ser parte de tus momentos especiales.",
    "Deseamos que disfrutes un día lleno de alegría, buenos momentos y, por supuesto, algo delicioso.",
  ];
  if (input.loyaltyActive && multiplier > 1) {
    lines.push(`Hoy, además, tus compras acumulan ${multiplierPhrase(multiplier)}.`);
  }
  const tier = tierLine(input.tierKey);
  if (tier) lines.push(tier);
  lines.push(`Con cariño, ${business}`);
  return lines.join("\n");
}

/** Asunto del correo de cumpleaños (cuando el email está configurado). */
export function birthdayGreetingSubject(input: BirthdayGreetingInput): string {
  const business = (input.businessName ?? "").trim() || DEFAULT_BUSINESS;
  const name = firstName(input.fullName);
  return name ? `¡Feliz cumpleaños, ${name}! · ${business}` : `¡Feliz cumpleaños! · ${business}`;
}
