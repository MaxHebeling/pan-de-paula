/** Estado compartido de server actions usadas con useActionState. */
export type ActionState = { error?: string; ok?: string; data?: Record<string, unknown> };

export const str = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();
export const optStr = (fd: FormData, name: string): string | undefined =>
  str(fd, name) || undefined;
export const bool = (fd: FormData, name: string): boolean => {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
};
export const num = (fd: FormData, name: string): number | undefined => {
  const s = str(fd, name);
  if (!s) return undefined;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
};
/** "45.50" → 4550 (centavos). Vacío → undefined. */
export const cents = (fd: FormData, name: string): number | undefined => {
  const n = num(fd, name);
  if (n === undefined) return undefined;
  return Number.isNaN(n) ? Number.NaN : Math.round(n * 100);
};
