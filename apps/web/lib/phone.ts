/**
 * Normaliza un teléfono mexicano capturado en formularios públicos a 10 dígitos cuando trae lada
 * de país (+52 / 52 / 521). Así el mismo cliente se reconoce igual en web, POS y club
 * (`find_customer` compara el teléfono de forma exacta). Otros formatos se devuelven tal cual:
 * los valida el esquema compartido `phoneMX` (10–15 dígitos).
 */
export function normalizeMxPhone(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/[^0-9+]/g, "");
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("52")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("521")) return digits.slice(3);
  return s;
}
