/** Almacenamiento de imágenes de productos. Drivers: local (dev, carpeta public/uploads de la app) o supabase (Storage). */
export type UploadInput = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  folder?: string;
};
export type UploadResult = { url: string; key: string };

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function validateImage(input: Pick<UploadInput, "bytes" | "contentType">): void {
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType))
    throw new Error("Formato de imagen no permitido (usa JPG, PNG, WebP o AVIF)");
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("La imagen supera 5 MB");
}

export async function uploadImage(_input: UploadInput): Promise<UploadResult> {
  throw new Error("uploadImage: pendiente de implementación");
}

export async function deleteImage(_key: string): Promise<void> {
  throw new Error("deleteImage: pendiente de implementación");
}
