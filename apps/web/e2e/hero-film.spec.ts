import { expect, test, type Page } from "@playwright/test";

/**
 * Película de la portada «Del amasado al aroma» (docs/HERO_FILM.md).
 * Solo corre si el home tiene película (archivos en public/film o, en local, HERO_FILM_PROVISIONAL=1 con el
 * material provisional). Sin película se omite: la portada estática ya la cubren smoke.spec y motion.spec.
 */

const film = (page: Page) => page.locator("[data-hero-film]");

async function ready(page: Page) {
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>("[data-hero-film]")?.dataset.film === "ready",
    null,
    { timeout: 20_000 },
  );
}

/** Lleva el recorrido fijado a una fracción (0–1) y espera a que el video y la escena se asienten. */
async function goTo(page: Page, fraction: number) {
  await page.evaluate((f) => {
    const r = document.querySelector<HTMLElement>("[data-hero-film]")!;
    const top = r.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + f * (r.offsetHeight - window.innerHeight), behavior: "instant" });
  }, fraction);
  await page.waitForTimeout(700);
}

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector<HTMLElement>("[data-hero-film]")!;
    const v = r.querySelector("video")!;
    return { scene: Number(r.dataset.scene), t: v.currentTime, duration: v.duration };
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  test.skip((await film(page).count()) === 0, "sin película en public/film");
});

test("la portada es útil desde la primera carga, antes de la película", async ({ page }) => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("cta-menu")).toBeVisible();
});

test("video, escena y texto siguen al scroll en ambas direcciones", async ({ page }) => {
  await ready(page);
  for (const [f, scene] of [
    [0.3, 1],
    [0.5, 2],
    [0.7, 3],
    [0.95, 4],
    [0.5, 2],
    [0.1, 0],
  ] as const) {
    await goTo(page, f);
    const s = await snapshot(page);
    expect(s.scene).toBe(scene);
    expect(s.t / s.duration).toBeCloseTo(f, 1);
  }
  await expect(page.locator("[data-film-cap].is-active")).toHaveCount(1);
});

test("el scroll rápido no deja búsquedas atrasadas", async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const r = document.querySelector<HTMLElement>("[data-hero-film]")!;
    for (let i = 0; i < 30; i++) {
      window.scrollTo({ top: Math.random() * (r.offsetHeight - innerHeight), behavior: "instant" });
      await new Promise((res) => setTimeout(res, 10));
    }
  });
  await goTo(page, 0.62);
  await page.waitForTimeout(800);
  const s = await snapshot(page);
  expect(s.t / s.duration).toBeCloseTo(0.62, 1);
});

test("«Saltar la historia» lleva al contenido siguiente con el foco", async ({ page }) => {
  await ready(page);
  await goTo(page, 0.2);
  await page.getByRole("button", { name: "Saltar la historia" }).click();
  await expect(page.locator("#tras-portada")).toBeFocused();
  const bottom = await film(page).evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(1);
});

test("si el video falla queda la portada estática y se puede comprar", async ({ page }) => {
  await page.route("**/film/*.mp4", (r) => r.abort());
  await page.goto("/");
  await expect(film(page)).toHaveAttribute("data-film", "failed", { timeout: 15_000 });
  await page.getByTestId("cta-menu").click();
  await expect(page).toHaveURL(/\/menu/);
});

test.describe("con movimiento reducido", () => {
  test.use({ reducedMotion: "reduce" });

  test("no descarga la película ni fija la portada", async ({ page }) => {
    let requested = false;
    page.on("request", (r) => {
      if (/\/film\/.*\.mp4/.test(r.url())) requested = true;
    });
    await page.goto("/");
    await page.waitForTimeout(3_000);
    expect(requested).toBe(false);
    await expect(film(page)).not.toHaveAttribute("data-film", "ready");
  });
});
