import "server-only";
import { existsSync } from "node:fs";
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
  preparamos: { base: "01-preparamos", alt: "Manos amasando y laminando la masa en la panadería" },
  horneamos: { base: "02-horneamos", alt: "Pan recién horneado saliendo del horno" },
  empacamos: { base: "03-empacamos", alt: "Pedido empacado con el nombre del cliente" },
  disfrutas: { base: "04-disfrutas", alt: "Pan de El Pan de Paula servido en la mesa" },
};
const EXTS = ["jpg", "jpeg", "webp", "png"];

export const getStoryPhotos = cache((): Partial<Record<ProcessStepKey, StoryPhoto>> => {
  const dir = join(process.cwd(), "public", "story");
  const out: Partial<Record<ProcessStepKey, StoryPhoto>> = {};
  for (const [key, f] of Object.entries(FILES) as Array<
    [ProcessStepKey, { base: string; alt: string }]
  >) {
    for (const ext of EXTS) {
      if (existsSync(join(dir, `${f.base}.${ext}`))) {
        out[key] = { src: `/story/${f.base}.${ext}`, alt: f.alt, width: 1200, height: 1500 };
        break;
      }
    }
  }
  return out;
});
