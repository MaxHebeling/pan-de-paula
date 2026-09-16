/**
 * Teléfonos con país: catálogo curado, validación y normalización.
 *
 * ── REGLA DE ALMACENAMIENTO (no cambiarla sin migrar datos) ─────────────────
 * México se guarda como **10 dígitos sin prefijo** ("6641234567"), igual que siempre: todos los
 * clientes reales del negocio son mexicanos y no se tocó un solo registro existente.
 * Cualquier otro país se guarda en **formato internacional E.164** con "+" y prefijo
 * ("+16195550100"). Así el cambio es puramente aditivo: lo que ya estaba guardado sigue siendo
 * exactamente el mismo texto, y los teléfonos extranjeros —que antes no se podían capturar— entran
 * con una forma inequívoca.
 *
 * El espejo en SQL vive en `normalize_mx_phone()` / `normalize_phone_digits()` (migraciones 0014 y
 * 0044). La comparación entre un valor escrito y uno guardado se hace siempre sobre esa forma
 * canónica, nunca sobre el texto crudo.
 *
 * ── CATÁLOGO CURADO ────────────────────────────────────────────────────────
 * `PHONE_COUNTRIES` es una lista **curada a mano**, no una base de datos de numeración mundial: el
 * bundle del sitio público importa este módulo y una librería tipo `libphonenumber-js` pesa cientos
 * de kilobytes. Cubre los países desde los que realmente escriben los clientes de la panadería.
 *
 * Para ampliarla: agrega una entrada con el ISO 3166-1 alfa-2, el nombre en español, la bandera
 * (emoji), el prefijo telefónico sin "+", las longitudes válidas del número NACIONAL (sin prefijo de
 * país ni cero troncal) y un ejemplo real escrito como lo escribiría una persona. Nada más: las
 * funciones de este archivo se adaptan solas. Si el prefijo ya lo usa otro país (el "+1" del plan
 * norteamericano), añádelo también a `DEFAULT_COUNTRY_FOR_DIAL` si quieres que sea el que se muestre
 * al leer un número guardado con ese prefijo.
 */

export type PhoneCountry = {
  /** ISO 3166-1 alfa-2, en mayúsculas. Es lo que viaja en el formulario. */
  iso: string;
  /** Nombre en español, como se lista en el selector. */
  name: string;
  /** Bandera en emoji (sin dependencias ni imágenes). */
  flag: string;
  /** Prefijo telefónico del país, sin "+". */
  dial: string;
  /** Longitudes válidas del número nacional (sin prefijo de país ni cero troncal). */
  lengths: readonly number[];
  /** Ejemplo escrito como lo escribiría una persona; se muestra como ayuda del campo. */
  example: string;
};

/** País por defecto en todos los formularios: la panadería está en México. */
export const DEFAULT_PHONE_COUNTRY = "MX";

/**
 * Orden del selector: México primero (es el caso normal) y el resto alfabético en español.
 * Lista curada — ver el comentario de cabecera para ampliarla.
 */
export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { iso: "MX", name: "México", flag: "🇲🇽", dial: "52", lengths: [10], example: "664 123 4567" },
  {
    iso: "AR",
    name: "Argentina",
    flag: "🇦🇷",
    dial: "54",
    // 10 dígitos (área + abonado) y 11 con el "9" que usan los móviles en formato internacional.
    lengths: [10, 11],
    example: "11 2345 6789",
  },
  { iso: "CA", name: "Canadá", flag: "🇨🇦", dial: "1", lengths: [10], example: "604 555 0132" },
  { iso: "CL", name: "Chile", flag: "🇨🇱", dial: "56", lengths: [9], example: "9 6123 4567" },
  { iso: "CO", name: "Colombia", flag: "🇨🇴", dial: "57", lengths: [10], example: "300 123 4567" },
  { iso: "CR", name: "Costa Rica", flag: "🇨🇷", dial: "506", lengths: [8], example: "8312 3456" },
  // Ecuador: 9 dígitos los móviles (9XXXXXXXX), 8 los fijos.
  { iso: "EC", name: "Ecuador", flag: "🇪🇨", dial: "593", lengths: [8, 9], example: "99 123 4567" },
  { iso: "ES", name: "España", flag: "🇪🇸", dial: "34", lengths: [9], example: "612 345 678" },
  {
    iso: "US",
    name: "Estados Unidos",
    flag: "🇺🇸",
    dial: "1",
    lengths: [10],
    example: "619 555 0100",
  },
  { iso: "GT", name: "Guatemala", flag: "🇬🇹", dial: "502", lengths: [8], example: "5123 4567" },
  { iso: "PE", name: "Perú", flag: "🇵🇪", dial: "51", lengths: [9], example: "987 654 321" },
  {
    iso: "DO",
    name: "República Dominicana",
    flag: "🇩🇴",
    dial: "1",
    lengths: [10],
    example: "809 555 0123",
  },
] as const;

/**
 * Prefijos compartidos por varios países (plan de numeración norteamericano): al LEER un número
 * guardado no se puede saber si "+1809…" es de Estados Unidos, Canadá o República Dominicana, así que
 * se muestra el país de esta tabla. El valor guardado es idéntico en los tres casos, así que la
 * elección solo afecta la bandera que ve quien edita.
 */
const DEFAULT_COUNTRY_FOR_DIAL: Record<string, string> = { "1": "US" };

const BY_ISO = new Map(PHONE_COUNTRIES.map((c) => [c.iso, c]));

/** Busca un país del catálogo por ISO (tolera minúsculas y espacios). `null` si no está. */
export function findPhoneCountry(iso: string | null | undefined): PhoneCountry | null {
  if (!iso) return null;
  return BY_ISO.get(iso.trim().toUpperCase()) ?? null;
}

/** El país del catálogo o México si el valor recibido no sirve (el servidor nunca confía en el cliente). */
export function phoneCountryOrDefault(iso: string | null | undefined): PhoneCountry {
  return findPhoneCountry(iso) ?? BY_ISO.get(DEFAULT_PHONE_COUNTRY)!;
}

/** "10 dígitos" / "8 o 9 dígitos" para los mensajes de error. */
function lengthsLabel(c: PhoneCountry): string {
  const l = [...c.lengths];
  const last = l.pop();
  return `${l.length ? `${l.join(", ")} o ${last}` : last} dígitos`;
}

/** Texto de ayuda del campo (va en el `aria-describedby` del input). */
export function phoneExample(c: PhoneCountry): string {
  return `Ejemplo: ${c.example}`;
}

export type PhoneParse =
  | { ok: true; value: string; country: PhoneCountry; national: string }
  | { ok: false; error: string };

/**
 * Elige el país de un número escrito en formato internacional: el prefijo más largo que deje un
 * número nacional de longitud válida. Si el país que eligió la persona es uno de los candidatos, gana
 * (escribió "+1" con "República Dominicana" seleccionado → se queda en República Dominicana).
 */
function detectByDial(digits: string, preferred?: PhoneCountry | null): PhoneCountry | null {
  const candidates = PHONE_COUNTRIES.filter(
    (c) => digits.startsWith(c.dial) && c.lengths.includes(digits.length - c.dial.length),
  );
  if (!candidates.length) return null;
  const longest = Math.max(...candidates.map((c) => c.dial.length));
  const best = candidates.filter((c) => c.dial.length === longest);
  if (preferred && best.some((c) => c.iso === preferred.iso)) return preferred;
  const fallbackIso = DEFAULT_COUNTRY_FOR_DIAL[best[0]!.dial];
  return best.find((c) => c.iso === fallbackIso) ?? best[0]!;
}

/**
 * Valida y normaliza "país + número escrito" al valor canónico que se guarda.
 *
 * Acepta el número con espacios, guiones, paréntesis y puntos; con el prefijo del país delante
 * (con "+", con "00" o pelado); con el cero troncal; y las formas mexicanas de siempre ("52…",
 * "+521…", "01…"). Si viene en formato internacional de OTRO país del catálogo, se respeta lo que
 * está escrito (pegar "+1 619 555 0100" con México seleccionado guarda un número de Estados Unidos).
 */
export function parsePhone(iso: string | null | undefined, raw: string): PhoneParse {
  const selected = phoneCountryOrDefault(iso);
  const kept = (raw ?? "").replace(/[^0-9+]/g, "");
  let digits = kept.replace(/\D/g, "");
  if (!digits) return { ok: false, error: "Escribe un número de teléfono." };

  // "00" es el prefijo internacional escrito a la europea; equivale a "+".
  const international = kept.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Legado mexicano: "+52 1 …" (móvil antiguo) → "+52 …". Ningún otro país usa el prefijo 521.
  if (digits.length === 13 && digits.startsWith("521")) digits = `52${digits.slice(3)}`;
  // "01 664 123 4567": larga distancia nacional de México. Solo con México seleccionado.
  if (!international && selected.iso === "MX" && digits.length === 12 && digits.startsWith("01"))
    digits = digits.slice(2);

  if (international) {
    const country = detectByDial(digits, selected);
    if (!country)
      return {
        ok: false,
        error: `No reconocemos ese número internacional. Elige el país en la lista y escribe el número sin el prefijo (${phoneExample(selected).toLowerCase()}).`,
      };
    return canonical(country, digits.slice(country.dial.length));
  }

  // Sin "+": el número es del país elegido. Se acepta que venga con su propio prefijo o cero troncal.
  if (selected.lengths.includes(digits.length)) return canonical(selected, digits);
  if (
    digits.startsWith(selected.dial) &&
    selected.lengths.includes(digits.length - selected.dial.length)
  )
    return canonical(selected, digits.slice(selected.dial.length));
  if (digits.startsWith("0") && selected.lengths.includes(digits.length - 1))
    return canonical(selected, digits.slice(1));

  return {
    ok: false,
    error: `El teléfono de ${selected.name} debe tener ${lengthsLabel(selected)}. ${phoneExample(selected)}.`,
  };
}

function canonical(country: PhoneCountry, national: string): PhoneParse {
  if (!country.lengths.includes(national.length))
    return {
      ok: false,
      error: `El teléfono de ${country.name} debe tener ${lengthsLabel(country)}. ${phoneExample(country)}.`,
    };
  // México: 10 dígitos pelados, como se ha guardado siempre. El resto, E.164.
  const value = country.iso === "MX" ? national : `+${country.dial}${national}`;
  return { ok: true, value, country, national };
}

/**
 * Igual que `parsePhone` pero para campos opcionales: vacío devuelve `null` en vez de error.
 * Es lo que usan las server actions al combinar los dos campos del formulario.
 */
export function parseOptionalPhone(
  iso: string | null | undefined,
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, value: null };
  const r = parsePhone(iso, raw);
  return r.ok ? { ok: true, value: r.value } : r;
}

/**
 * Lo contrario de `parsePhone`: de un teléfono ya guardado saca el país y el número nacional para
 * repoblar el campo al editar. Un valor de 10 dígitos es mexicano por la regla de almacenamiento.
 */
export function splitStoredPhone(stored: string | null | undefined): {
  country: PhoneCountry;
  national: string;
} {
  const mx = phoneCountryOrDefault("MX");
  const kept = (stored ?? "").replace(/[^0-9+]/g, "");
  const digits = kept.replace(/\D/g, "");
  if (!digits) return { country: mx, national: "" };
  if (!kept.startsWith("+") && mx.lengths.includes(digits.length))
    return { country: mx, national: digits };
  const country = detectByDial(digits);
  if (country) return { country, national: digits.slice(country.dial.length) };
  // Dato histórico con una forma que el catálogo no reconoce: se muestra tal cual, sin inventar país.
  return { country: mx, national: digits };
}

/**
 * Número listo para wa.me / tel: (siempre con prefijo de país, sin "+"): México es 52 + 10 dígitos y
 * el resto ya trae su prefijo. `null` si no hay con qué armar el enlace.
 */
export function phoneToE164Digits(stored: string | null | undefined): string | null {
  const kept = (stored ?? "").replace(/[^0-9+]/g, "");
  const digits = kept.replace(/\D/g, "");
  if (!digits) return null;
  // Ya viene en internacional: los dígitos son la respuesta.
  if (kept.startsWith("+")) return digits.length >= 8 ? digits : null;
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return digits;
  if (digits.length === 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits.length >= 10 ? digits : null;
}
