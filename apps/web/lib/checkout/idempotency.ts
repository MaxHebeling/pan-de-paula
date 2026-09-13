import { newIdempotencyKey } from "@pdp/domain";

/**
 * Clave de idempotencia del checkout, persistida en sessionStorage y ligada al contenido del carrito.
 * Un refresh o un "atrás" a mitad del envío reutiliza la misma clave: `create_order` devuelve el pedido
 * ya creado en vez de duplicarlo. Cambiar el carrito (firma distinta) genera una clave nueva.
 */
export const IDEMPOTENCY_STORAGE_KEY = "pdp.checkout.idem.v1";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function cartSignature(lines: Array<{ productId: string; qty: number }>): string {
  return lines.map((l) => `${l.productId}:${l.qty}`).join("|");
}

export function getOrCreateIdempotencyKey(
  storage: StorageLike | null | undefined,
  signature: string,
  make: () => string = () => newIdempotencyKey("web"),
): string {
  try {
    const raw = storage?.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { key?: unknown; sig?: unknown };
      if (
        parsed &&
        parsed.sig === signature &&
        typeof parsed.key === "string" &&
        parsed.key.length >= 8 &&
        parsed.key.length <= 80
      ) {
        return parsed.key;
      }
    }
  } catch {
    // almacenamiento no disponible o corrupto: se genera una clave nueva
  }
  const key = make();
  try {
    storage?.setItem(IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key, sig: signature }));
  } catch {
    // modo privado / cuota: la clave vive solo en memoria durante este render
  }
  return key;
}

export function clearIdempotencyKey(storage: StorageLike | null | undefined): void {
  try {
    storage?.removeItem(IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // nada que limpiar
  }
}
