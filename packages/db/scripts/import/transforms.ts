/**
 * Transformaciones de celda → valor normalizado. Todas devuelven null para celdas vacías
 * y lanzan ImportError con mensaje en español cuando el valor es inválido.
 */
import { normalizePhone, normalizeUnit, toCents } from "@pdp/domain";
import { ImportError, type MappingOptions, type Transform } from "./types.ts";

const CURRENCY_RE = /(mxn|usd|pesos|\$|\s)/gi;

export function parseNumber(raw: string, opts: MappingOptions = {}): number | null {
  let s = raw.trim().replace(CURRENCY_RE, "");
  if (s === "" || s === "-") return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()]/g, "").replace(/^-/, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // El último separador es el decimal: "1,234.50" → 1234.50 · "1.234,50" → 1234.50
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    if (opts.decimal_comma) s = s.replace(",", ".");
    else if (/^\d{1,3}(,\d{3})+$/.test(s))
      s = s.replace(/,/g, ""); // "1,234" · "12,345,678"
    else if (/^\d+,\d{1,2}$/.test(s))
      s = s.replace(",", "."); // "45,5" · "45,50"
    else s = s.replace(/,/g, "");
  }
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s))
    throw new ImportError(`Número inválido: "${raw}"`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ImportError(`Número inválido: "${raw}"`);
  return neg ? -n : n;
}

export function toMoneyCents(raw: string, opts: MappingOptions = {}): number | null {
  const n = parseNumber(raw, opts);
  if (n === null) return null;
  return toCents(n);
}

export function toQty(raw: string, opts: MappingOptions = {}): number | null {
  const n = parseNumber(raw, opts);
  if (n === null) return null;
  if (n < 0) throw new ImportError(`Cantidad negativa: "${raw}"`);
  return n;
}

export function toInt(raw: string, opts: MappingOptions = {}): number | null {
  const n = parseNumber(raw, opts);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw new ImportError(`Se esperaba un entero: "${raw}"`);
  return n;
}

export function toUnit(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (s === "") return null;
  const u = normalizeUnit(s);
  if (!u) throw new ImportError(`Unidad desconocida: "${raw}" (usa g, kg, ml, l, pz, docena…)`);
  return s;
}

export function toPhone(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  let p = normalizePhone(s);
  if (p === "") return null;
  // México: +52 / +521 + 10 dígitos → 10 dígitos (misma forma que los teléfonos capturados en POS)
  if (/^\+521\d{10}$/.test(p)) p = p.slice(4);
  else if (/^\+52\d{10}$/.test(p)) p = p.slice(3);
  if (!/^\+?\d{10,15}$/.test(p)) throw new ImportError(`Teléfono inválido: "${raw}" (10 dígitos)`);
  return p;
}

const MONTHS: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/** Devuelve "YYYY-MM-DD". Acepta yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd/mm/yy, "12 mar 2026" y hora opcional. */
export function toDate(raw: string, opts: MappingOptions = {}): string | null {
  let s = raw.trim();
  if (s === "") return null;
  s = s.split(/[ T]/)[0]!; // quita hora
  let y: number, m: number, d: number;
  let mt: RegExpMatchArray | null;
  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  } else if ((mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const a = Number(mt[1]);
    const b = Number(mt[2]);
    y = Number(mt[3]);
    if (y < 100) y += 2000;
    if (opts.date_format === "mm/dd/yyyy") [m, d] = [a, b];
    else [d, m] = [a, b];
  } else if (
    (mt = raw.trim().match(/^(\d{1,2})\s+(?:de\s+)?([a-záé]+)\.?\s+(?:de\s+)?(\d{4})$/i))
  ) {
    d = Number(mt[1]);
    const mm = MONTHS[mt[2]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
    if (!mm) throw new ImportError(`Fecha inválida: "${raw}"`);
    m = mm;
    y = Number(mt[3]);
  } else throw new ImportError(`Fecha inválida: "${raw}" (usa dd/mm/aaaa)`);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    throw new ImportError(`Fecha inválida: "${raw}"`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const TRUE_WORDS = new Set([
  "si",
  "sí",
  "s",
  "yes",
  "y",
  "true",
  "1",
  "x",
  "✓",
  "✔",
  "ok",
  "pagado",
  "pagada",
  "pago",
  "listo",
  "entregado",
  "activo",
  "verdadero",
]);
const FALSE_WORDS = new Set([
  "no",
  "n",
  "false",
  "0",
  "",
  "pendiente",
  "debe",
  "por pagar",
  "sin pagar",
  "inactivo",
  "falso",
  "-",
]);

export function toBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  throw new ImportError(`Valor sí/no inválido: "${raw}"`);
}

export function toText(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

export function applyTransform(t: Transform, raw: string, opts: MappingOptions = {}): unknown {
  switch (t) {
    case "text":
      return toText(raw);
    case "money":
      return toMoneyCents(raw, opts);
    case "qty":
      return toQty(raw, opts);
    case "int":
      return toInt(raw, opts);
    case "unit":
      return toUnit(raw);
    case "phone":
      return toPhone(raw);
    case "date":
      return toDate(raw, opts);
    case "bool":
      return toBool(raw);
  }
}
