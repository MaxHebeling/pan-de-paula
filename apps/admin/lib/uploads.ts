import "server-only";
import { uploadImage, deleteImage, keyFromUrl, validateImage } from "@pdp/integrations";

/** Lee un archivo de imagen del FormData (o null si no se adjuntó nada). Valida tipo y tamaño. */
export async function imageFromForm(
  form: FormData,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string } | null> {
  const f = form.get(key);
  if (!(f instanceof File) || f.size === 0) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const input = { bytes, contentType: f.type, fileName: f.name };
  validateImage(input);
  return input;
}

/** Sube una imagen del formulario a la carpeta indicada y devuelve su URL pública (o null si no había archivo). */
export async function uploadFromForm(form: FormData, key: string, folder: string): Promise<string | null> {
  const img = await imageFromForm(form, key);
  if (!img) return null;
  const r = await uploadImage({ ...img, folder });
  return r.url;
}

/** Borra del almacenamiento una URL nuestra; URLs externas se ignoran. Los fallos se registran y no rompen el flujo. */
export async function removeStoredImage(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = keyFromUrl(url);
  if (!key) return;
  try {
    await deleteImage(key);
  } catch (e) {
    console.error("[uploads] no se pudo borrar la imagen", key, (e as Error).message);
  }
}
