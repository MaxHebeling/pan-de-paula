/** Identificadores y utilidades de texto. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isCustomerCode(s: string): boolean {
  return /^PDP-\d{6}$/i.test(s.trim());
}

export function newIdempotencyKey(prefix = "k"): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${rnd}`;
}

/** Normaliza teléfono mexicano a dígitos (10) o E.164 si trae +. */
export function normalizePhone(raw: string): string {
  const s = raw.replace(/[^0-9+]/g, "");
  if (s.startsWith("+")) return s;
  if (s.length === 12 && s.startsWith("52")) return s.slice(2);
  if (s.length === 13 && s.startsWith("521")) return s.slice(3);
  return s;
}
