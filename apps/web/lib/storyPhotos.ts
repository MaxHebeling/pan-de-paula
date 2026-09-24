import "server-only";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import type { ProcessStepKey } from "@/components/ProcessArt";
import type { StoryPhoto } from "@/components/cinematic/StickyStory";

/**
 * Fotografías reales de "Del horno a tu mesa". Mientras no existan se usa el arte SVG (ProcessArt).
 * Para activarlas basta con colocar los archivos (formato 4:5, recomendado 1200×1500) en apps/web/public/story/:
 *   01-preparamos.jpg · 02-horneamos.jpg · 03-empacamos.jpg · 04-disfrutas.jpg  (también .webp o .png)
 * No hace falta tocar código: se detectan en cada petición.
 */
const FILES: Record<ProcessStepKey, { base: string; alt: string }> = {
  preparamos: {
    base: "01-preparamos",
    alt: "Un panadero lamina con rodillo una plancha de masa enharinada sobre la mesa de trabajo",
  },
  horneamos: {
    base: "02-horneamos",
    alt: "Un croissant recién formado, todavía crudo, sobre la charola a la entrada del horno",
  },
  empacamos: {
    base: "03-empacamos",
    alt: 'Cajas de pedidos ya empacadas, con croissants y la etiqueta "Muchas gracias por tu compra"',
  },
  disfrutas: {
    base: "04-disfrutas",
    alt: "Una mano sostiene la caja del pedido recién recogido, con los croissants dentro",
  },
};
const EXTS = ["jpg", "jpeg", "webp", "png"];

export const getStoryPhotos = cache((): Partial<Record<ProcessStepKey, StoryPhoto>> => {
  const dir = join(process.cwd(), "public", "story");
  const out: Partial<Record<ProcessStepKey, StoryPhoto>> = {};
  for (const [key, f] of Object.entries(FILES) as Array<
    [ProcessStepKey, { base: string; alt: string }]
  >) {
    for (const ext of EXTS) {
      const archivo = join(dir, `${f.base}.${ext}`);
      if (existsSync(archivo)) {
        /*
         * La huella del archivo va en la URL. El optimizador de imágenes cachea por URL, así que
         * reemplazar una foto conservando el nombre servía la versión vieja ya optimizada: el archivo
         * nuevo estaba en disco y en pantalla seguía la anterior. Con la huella, cambiar la foto
         * cambia la URL y la caché deja de estorbar sola.
         */
        const { size, mtimeMs } = statSync(archivo);
        const huella = ((size ^ Math.round(mtimeMs)) >>> 0).toString(36);
        out[key] = {
          src: `/story/${f.base}.${ext}?v=${huella}`,
          alt: f.alt,
          width: 1200,
          height: 1500,
        };
        break;
      }
    }
  }
  return out;
});
