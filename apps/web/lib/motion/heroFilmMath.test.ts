import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERO_FILM } from "@/components/cinematic/heroFilm.config";
import { resolveHeroFilm } from "@/lib/heroFilm";
import {
  createSeekScheduler,
  entranceOpacity,
  pinProgress,
  sceneIndex,
  timeForProgress,
} from "./heroFilmMath";

describe("película de la portada · cálculos", () => {
  it("el progreso va de 0 a 1 a lo largo del recorrido fijado y se acota", () => {
    expect(pinProgress(0, 4000, 1000)).toBe(0);
    expect(pinProgress(-1500, 4000, 1000)).toBe(0.5);
    expect(pinProgress(-3000, 4000, 1000)).toBe(1);
    expect(pinProgress(200, 4000, 1000)).toBe(0);
    expect(pinProgress(-9000, 4000, 1000)).toBe(1);
    expect(pinProgress(-10, 900, 1000)).toBe(0); // sin recorrido no hay progreso
  });

  it("el tiempo del video respeta los bordes y tolera duraciones inválidas", () => {
    expect(timeForProgress(0, 15, 0.04)).toBeCloseTo(0.04);
    expect(timeForProgress(1, 15, 0.04)).toBeCloseTo(14.96);
    expect(timeForProgress(0.5, 15, 0.04)).toBeCloseTo(7.5);
    expect(timeForProgress(0.5, Number.NaN, 0.04)).toBe(0);
    expect(timeForProgress(0.5, Infinity, 0.04)).toBe(0);
    expect(timeForProgress(2, 10, 0)).toBe(10);
  });

  it("las escenas siguen los tramos de la configuración, también al volver hacia arriba", () => {
    const at = (p: number) => HERO_FILM.scenes[sceneIndex(p, HERO_FILM.scenes)]!.key;
    expect(at(0)).toBe("origen");
    expect(at(0.25)).toBe("laminado");
    expect(at(0.5)).toBe("forma");
    expect(at(0.7)).toBe("horno");
    expect(at(0.82)).toBe("resultado");
    expect(at(1)).toBe("resultado");
    expect(at(0.39)).toBe("laminado"); // reversible: misma escena para el mismo progreso
  });

  it("la entrada se ve completa al inicio y cede en el tramo configurado", () => {
    expect(entranceOpacity(0, 0.08)).toBe(1);
    expect(entranceOpacity(0.04, 0.08)).toBeCloseTo(0.5);
    expect(entranceOpacity(0.2, 0.08)).toBe(0);
  });

  it("los tramos de escena cubren 0–1 sin huecos", () => {
    const s = HERO_FILM.scenes;
    expect(s[0]!.from).toBe(0);
    expect(s.at(-1)!.to).toBe(1);
    for (let i = 1; i < s.length; i++) expect(s[i]!.from).toBe(s[i - 1]!.to);
  });
});

describe("película de la portada · búsquedas", () => {
  /** Doble del <video>: `seeking` se pone en true al asignar currentTime, como en el navegador. */
  const fakeVideo = () => {
    let t = 0;
    const v = {
      seeking: false,
      get currentTime() {
        return t;
      },
      set currentTime(x: number) {
        t = x;
        v.seeking = true;
      },
    };
    return v;
  };

  it("en scroll rápido no acumula búsquedas: aplica solo el último destino al terminar", () => {
    const v = fakeVideo();
    const s = createSeekScheduler(v);
    expect(s.seek(1)).toBe(true);
    s.seek(2);
    s.seek(3);
    s.seek(4.5);
    expect(s.requested).toBe(1);
    expect(s.pending).toBe(4.5);
    v.seeking = false;
    expect(s.onSeeked()).toBe(true);
    expect(v.currentTime).toBe(4.5);
    expect(s.requested).toBe(2);
    v.seeking = false;
    expect(s.onSeeked()).toBe(false);
  });

  it("ignora diferencias menores a medio fotograma", () => {
    const v = fakeVideo();
    const s = createSeekScheduler(v);
    s.seek(2);
    v.seeking = false;
    expect(s.seek(2.005)).toBe(false);
    expect(s.requested).toBe(1);
  });
});

describe("película de la portada · archivos", () => {
  const publicDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "pdp-film-"));
    mkdirSync(join(dir, HERO_FILM.dir));
    return dir;
  };
  const touch = (dir: string, name: string, bytes = "x") =>
    writeFileSync(join(dir, HERO_FILM.dir, name), bytes);

  it("sin archivos no inventa rutas: la portada queda estática", () => {
    expect(resolveHeroFilm(publicDir(), true)).toEqual({});
  });

  it("detecta cada composición con su póster y no usa archivos vacíos", () => {
    const dir = publicDir();
    touch(dir, "del-amasado-al-aroma-horizontal.mp4");
    touch(dir, "del-amasado-al-aroma-horizontal.jpg");
    touch(dir, "del-amasado-al-aroma-vertical.mp4", "");
    const r = resolveHeroFilm(dir, false);
    expect(Object.keys(r)).toEqual(["horizontal"]);
    expect(r.horizontal!.provisional).toBe(false);
    // La huella depende del tamaño y la fecha del archivo, así que se afirma la forma, no un literal.
    expect(r.horizontal!.src).toMatch(
      /^\/film\/del-amasado-al-aroma-horizontal\.mp4\?v=[0-9a-z]+$/,
    );
    expect(r.horizontal!.poster).toMatch(
      /^\/film\/del-amasado-al-aroma-horizontal\.jpg\?v=[0-9a-z]+$/,
    );
  });

  it("al cambiar el archivo cambia la huella de la URL", () => {
    // Es lo que hace segura la caché `immutable` de /film/:path* (next.config.ts): si al recodificar
    // la película la URL no cambiara, los navegadores servirían la versión vieja durante un año.
    const dir = publicDir();
    touch(dir, "del-amasado-al-aroma-horizontal.mp4", "primera versión");
    const antes = resolveHeroFilm(dir, false).horizontal!.src;
    touch(dir, "del-amasado-al-aroma-horizontal.mp4", "segunda versión, otro tamaño");
    const despues = resolveHeroFilm(dir, false).horizontal!.src;
    expect(despues).not.toBe(antes);
    expect(despues).toMatch(/\?v=[0-9a-z]+$/);
  });

  it("el material provisional solo cuenta con la variable de entorno", () => {
    const dir = publicDir();
    touch(dir, "del-amasado-al-aroma-horizontal.provisional.mp4");
    expect(resolveHeroFilm(dir, false)).toEqual({});
    expect(resolveHeroFilm(dir, true).horizontal).toMatchObject({ provisional: true });
  });

  it("la película final tiene prioridad sobre la provisional", () => {
    const dir = publicDir();
    touch(dir, "del-amasado-al-aroma-vertical.mp4");
    touch(dir, "del-amasado-al-aroma-vertical.provisional.mp4");
    expect(resolveHeroFilm(dir, true).vertical).toMatchObject({ provisional: false });
  });
});
