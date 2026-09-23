/**
 * Montaje del video promocional del CRM.
 *
 * Compone fotograma a fotograma con sharp y se lo pasa a ffmpeg por una tubería, sin escribir cientos
 * de PNG al disco. No hay plantillas ni efectos prefabricados: cada movimiento —el empuje sobre una
 * métrica, el desplazamiento por una tabla, la entrada del texto— está escrito aquí y sincronizado con
 * el pulso de la música (120 pulsos por minuto, un corte cada 4 pulsos).
 *
 * La versión vertical NO recorta la horizontal: tiene sus propios encuadres, más cerrados, para que la
 * letra del CRM se lea en un teléfono, y su propia distribución de textos.
 *
 *   node --experimental-strip-types src/render.ts            # ambas versiones
 *   node --experimental-strip-types src/render.ts horizontal # solo una
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sharp = require_(
  "../../../node_modules/.pnpm/sharp@0.35.4_@types+node@22.20.2/node_modules/sharp/dist/index.cjs",
) as typeof import("sharp");

const RAIZ = resolve(import.meta.dirname, "..");
const CAP = `${RAIZ}/capturas`;
const SALIDA = `${RAIZ}/salida`;
const AUDIO = `${RAIZ}/audio/pista.wav`;

const FPS = 30;
const DUR = 14; // segundos · 28 pulsos a 120 ppm
const TOTAL = FPS * DUR;

// ── Identidad: colores del propio producto ──────────────────────────────────
const TINTA = "#0b0d10"; // fondo
const CREMA = "#f3eee6"; // texto
const TEAL = "#0a9cb8"; // acento del CRM (--teal)
const VINO = "#97666c"; // color del logo
const SANS = "Futura, Avenir Next, Helvetica Neue, Arial, sans-serif";
const SERIF = "Georgia, Times New Roman, serif";

// ── Utilidades de animación ─────────────────────────────────────────────────
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Avance 0→1 dentro de un tramo. */
const tramo = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mezcla = (a: number, b: number, t: number) => a + (b - a) * t;

type Rect = { x: number; y: number; w: number; h: number }; // en fracciones 0..1 de la fuente

/** Un plano: de dónde sale la imagen, cómo se mueve la cámara y qué dice el texto. */
type Escena = {
  desde: number;
  hasta: number;
  /** Un PNG, o una secuencia (interacción real fotograma a fotograma). */
  fuente: string | string[];
  /** Encuadre inicial y final por formato: el movimiento de cámara vive aquí. */
  enc: { h: [Rect, Rect]; v: [Rect, Rect] };
  titulo?: string;
  pie?: string;
};

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Secuencia de la ráfaga del POS: escribir el código del cliente en la caja. */
const RAFAGA_POS = [
  "07-pos-cliente-00",
  "08-pos-cliente-01",
  "09-pos-cliente-02",
  "10-pos-cliente-03",
  "11-pos-cliente-04",
  "12-pos-cliente-05",
  "13-pos-cliente-06",
  "14-pos-cliente-07",
  "15-pos-cliente-08",
  "16-pos-cliente-09",
  "17-pos-cliente-10",
  "18-pos-cliente-11",
  "19-pos-cliente-12",
  "20-pos-cliente-13",
  "21-pos-cliente-listo",
].map((n) => `${CAP}/${n}.png`);

/*
 * Los siete planos. Los cortes caen en 2, 4, 6, 8, 10 y 12 s: cada cuatro pulsos de la música.
 * En horizontal la cámara respira sobre la pantalla completa; en vertical entra más cerca, porque
 * lo que en un monitor se lee de lejos en un teléfono hay que acercarlo.
 */
const ESCENAS: Escena[] = [
  {
    desde: 0,
    hasta: 2,
    fuente: `${CAP}/01-panel.png`,
    // Gancho: arranca cerca del saludo en vivo y abre hasta ver el panel entero.
    enc: {
      h: [r(0.166, 0.03, 0.42, 0.42), r(0.0, 0.0, 1.0, 1.0)],
      v: [r(0.166, 0.025, 0.375, 0.45), r(0.02, 0.0, 0.78, 0.78)],
    },
    titulo: "Tu panadería,\nbajo control",
  },
  {
    desde: 2,
    hasta: 4,
    fuente: `${CAP}/03-panel-metricas.png`,
    // Las cifras del día: un desplazamiento lateral que las recorre una por una.
    enc: {
      h: [r(0.16, 0.0, 0.42, 1.0), r(0.58, 0.0, 0.42, 1.0)],
      v: [r(0.16, 0.0, 0.35, 1.0), r(0.65, 0.0, 0.35, 1.0)],
    },
  },
  {
    desde: 4,
    hasta: 6,
    fuente: `${CAP}/22-pedidos.png`,
    enc: {
      h: [r(0.38, 0.12, 0.56, 0.5), r(0.4, 0.22, 0.5, 0.44)],
      v: [r(0.4, 0.14, 0.48, 0.42), r(0.42, 0.24, 0.42, 0.38)],
    },
    titulo: "Pedidos, caja\ny producción",
    pie: "en un solo lugar",
  },
  {
    desde: 6,
    hasta: 8,
    fuente: RAFAGA_POS,
    // Interacción real: se teclea el código y el cliente aparece con sus puntos y su nivel.
    enc: {
      h: [r(0.44, 0.4, 0.56, 0.58), r(0.46, 0.43, 0.52, 0.54)],
      v: [r(0.53, 0.4, 0.47, 0.56), r(0.55, 0.44, 0.43, 0.52)],
    },
    titulo: "Identifica\nal cliente\nen la caja",
  },
  {
    desde: 8,
    hasta: 10,
    fuente: `${CAP}/31-reportes.png`,
    enc: {
      h: [r(0.22, 0.18, 0.46, 0.46), r(0.24, 0.28, 0.4, 0.4)],
      v: [r(0.23, 0.19, 0.4, 0.4), r(0.25, 0.29, 0.34, 0.34)],
    },
  },
  {
    desde: 10,
    hasta: 12,
    fuente: `${CAP}/35-recetas-hoja.png`,
    // Valor: del nombre del producto al margen real que calcula su receta.
    enc: {
      h: [r(0.14, 0.2, 0.68, 0.68), r(0.16, 0.26, 0.54, 0.54)],
      v: [r(0.16, 0.22, 0.56, 0.56), r(0.18, 0.28, 0.46, 0.46)],
    },
    titulo: "El costo real\nde cada pieza",
  },
];

// ── Formatos ────────────────────────────────────────────────────────────────
type Formato = {
  nombre: string;
  W: number;
  H: number;
  clave: "h" | "v";
  tarjeta: { w: number; h: number; x: number; y: number; radio: number };
  texto: {
    x: number;
    y: number;
    ancho: number;
    tam: number;
    tamPie: number;
    alineado: "start" | "middle";
  };
  cierre: { logo: number; marcaY: number; ctaY: number; tamMarca: number; tamCta: number };
};

const FORMATOS: Record<string, Formato> = {
  horizontal: {
    nombre: "horizontal",
    W: 1920,
    H: 1080,
    clave: "h",
    // La tarjeta se va a la derecha y deja la columna izquierda para el texto.
    tarjeta: { w: 1120, h: 700, x: 720, y: 190, radio: 20 },
    texto: { x: 96, y: 474, ancho: 580, tam: 58, tamPie: 32, alineado: "start" },
    cierre: { logo: 210, marcaY: 585, ctaY: 735, tamMarca: 58, tamCta: 33 },
  },
  vertical: {
    nombre: "vertical",
    W: 1080,
    H: 1920,
    clave: "v",
    // En vertical manda el centro: texto arriba, pantalla en medio, apoyo abajo.
    tarjeta: { w: 1000, h: 750, x: 40, y: 770, radio: 20 },
    texto: { x: 540, y: 480, ancho: 960, tam: 78, tamPie: 42, alineado: "middle" },
    cierre: { logo: 292, marcaY: 1043, ctaY: 1217, tamMarca: 76, tamCta: 44 },
  },
};

// ── Piezas estáticas (se construyen una vez por formato) ────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fondo(f: Formato): Promise<Buffer> {
  const { W, H } = f;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="a" cx="${f.clave === "h" ? "0.68" : "0.5"}" cy="0.28" r="0.75">
        <stop offset="0" stop-color="${TEAL}" stop-opacity="0.26"/>
        <stop offset="1" stop-color="${TEAL}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="b" cx="0.12" cy="0.92" r="0.6">
        <stop offset="0" stop-color="${VINO}" stop-opacity="0.2"/>
        <stop offset="1" stop-color="${VINO}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${TINTA}"/>
    <rect width="${W}" height="${H}" fill="url(#a)"/>
    <rect width="${W}" height="${H}" fill="url(#b)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Máscara de esquinas redondeadas del tamaño exacto de la tarjeta. */
async function mascara(f: Formato): Promise<Buffer> {
  const { w, h, radio } = f.tarjeta;
  return sharp(
    Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" rx="${radio}" ry="${radio}" fill="#fff"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/** Sombra y filo de la tarjeta: se pinta una vez sobre el fondo, no en cada fotograma. */
async function fondoConSombra(f: Formato): Promise<Buffer> {
  const { W, H } = f;
  const { w, h, x, y, radio } = f.tarjeta;
  const sombra = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="s" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="34" stdDeviation="46" flood-color="#000" flood-opacity="0.62"/>
    </filter></defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radio}" ry="${radio}" fill="#000" filter="url(#s)"/>
  </svg>`;
  return sharp(await fondo(f))
    .composite([{ input: Buffer.from(sombra), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Filo claro de 1 px que separa la tarjeta del fondo (el detalle que la hace parecer vidrio). */
async function filo(f: Formato): Promise<Buffer> {
  const { w, h, radio } = f.tarjeta;
  return sharp(
    Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${radio}" ry="${radio}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.5"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

/** Bloque de texto de un plano (título + pie + regla de acento). */
async function textoEscena(f: Formato, titulo: string, pie?: string): Promise<Buffer> {
  const { x, y, ancho, tam, tamPie, alineado } = f.texto;
  const lineas = titulo.split("\n");
  const alto = Math.round(tam * 1.16);
  // El bloque queda centrado a la misma altura tenga dos líneas o tres.
  const y0 = y - Math.round(((lineas.length - 2) * alto) / 2);
  const W = f.W;
  const H = f.H;
  const anchoRegla = Math.round(tam * 1.4);
  const reglaX = alineado === "middle" ? x - anchoRegla / 2 : x;
  const textos = lineas
    .map(
      (l, i) =>
        `<text x="${x}" y="${y0 + i * alto}" text-anchor="${alineado}" font-family="${SANS}" font-size="${tam}" font-weight="700" fill="${CREMA}" letter-spacing="-0.5">${esc(l)}</text>`,
    )
    .join("");
  const piePx = pie
    ? `<text x="${x}" y="${y0 + lineas.length * alto + tamPie * 0.9}" text-anchor="${alineado}" font-family="${SANS}" font-size="${tamPie}" font-weight="500" fill="${CREMA}" fill-opacity="0.72">${esc(pie)}</text>`
    : "";
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${reglaX}" y="${y0 - alto - Math.round(tam * 0.52)}" width="${anchoRegla}" height="5" rx="2.5" fill="${TEAL}"/>
    ${textos}${piePx}
  </svg>`;
  void ancho;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Cierre: el logo original, el nombre del sistema y la llamada a la acción. */
async function piezasCierre(f: Formato) {
  const { W, H } = f;
  const { logo, marcaY, ctaY, tamMarca, tamCta } = f.cierre;
  const logoBuf = await sharp(`${RAIZ}/../../apps/web/public/brand/logo.png`)
    .resize(logo, logo, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const marca = await sharp(
    Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${W / 2}" y="${marcaY}" text-anchor="middle" font-family="${SERIF}" font-size="${tamMarca}" fill="${CREMA}">El Pan de Paula</text>
        <text x="${W / 2}" y="${marcaY + Math.round(tamMarca * 0.78)}" text-anchor="middle" font-family="${SANS}" font-size="${Math.round(tamMarca * 0.42)}" font-weight="600" fill="${TEAL}" letter-spacing="3">SISTEMA OPERATIVO</text>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  const cta = await sharp(
    Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${W / 2 - Math.round(tamCta * 6.4)}" y="${ctaY - Math.round(tamCta * 1.5)}" width="${Math.round(tamCta * 12.8)}" height="${Math.round(tamCta * 2.3)}" rx="${Math.round(tamCta * 1.15)}" fill="none" stroke="${CREMA}" stroke-opacity="0.34" stroke-width="1.6"/>
        <text x="${W / 2}" y="${ctaY}" text-anchor="middle" font-family="${SANS}" font-size="${tamCta}" font-weight="600" fill="${CREMA}" letter-spacing="1">Solicita una demo</text>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();
  return { logoBuf, marca, cta };
}

// ── Composición de un fotograma ─────────────────────────────────────────────
type Cache = {
  base: Buffer;
  mask: Buffer;
  edge: Buffer;
  textos: Map<number, Buffer>;
  cierre: Awaited<ReturnType<typeof piezasCierre>>;
  fuentes: Map<string, { w: number; h: number }>;
};

/**
 * Cuadra el encuadre a la proporción de la tarjeta SIN deformar la imagen: crece el lado que falta,
 * manteniendo el centro, y se queda dentro de la captura. Los encuadres de arriba expresan la
 * intención ("esta zona"); de que la pantalla no salga estirada se encarga esto.
 */
function ajustar(rect: Rect, meta: { w: number; h: number }, aspecto: number) {
  let w = rect.w * meta.w;
  let h = rect.h * meta.h;
  const cx = rect.x * meta.w + w / 2;
  const cy = rect.y * meta.h + h / 2;
  if (w / h < aspecto) w = h * aspecto;
  else h = w / aspecto;
  const escala = Math.min(1, meta.w / w, meta.h / h);
  w = Math.max(16, w * escala);
  h = Math.max(16, h * escala);
  const x = Math.min(Math.max(0, cx - w / 2), meta.w - w);
  const y = Math.min(Math.max(0, cy - h / 2), meta.h - h);
  // Los enteros al final, y recortados al borde: redondear antes deja el recorte un píxel fuera.
  const left = Math.max(0, Math.min(Math.round(x), meta.w - 16));
  const top = Math.max(0, Math.min(Math.round(y), meta.h - 16));
  return {
    left,
    top,
    width: Math.max(16, Math.min(Math.round(w), meta.w - left)),
    height: Math.max(16, Math.min(Math.round(h), meta.h - top)),
  };
}

/** Recorta el encuadre pedido de la fuente y lo deja del tamaño de la tarjeta. */
async function plano(f: Formato, archivo: string, rect: Rect, meta: { w: number; h: number }) {
  const { left, top, width, height } = ajustar(rect, meta, f.tarjeta.w / f.tarjeta.h);
  return sharp(archivo)
    .extract({ left, top, width, height })
    .resize(f.tarjeta.w, f.tarjeta.h, { fit: "fill", kernel: "lanczos3" })
    .toBuffer();
}

/** Interpola el encuadre y aplica el empuje/retroceso de la transición. */
function encuadreEn(e: Escena, f: Formato, t: number): Rect {
  const [a, b] = e.enc[f.clave];
  const p = easeInOutCubic(tramo(t, e.desde, e.hasta));
  return r(mezcla(a.x, b.x, p), mezcla(a.y, b.y, p), mezcla(a.w, b.w, p), mezcla(a.h, b.h, p));
}

async function fotograma(f: Formato, c: Cache, i: number): Promise<Buffer> {
  const t = i / FPS;
  const capas: sharp.OverlayOptions[] = [];
  const CIERRE = 12;

  if (t < CIERRE + 0.5) {
    // Qué plano toca, y con cuál se está fundiendo.
    const idx = Math.min(
      ESCENAS.length - 1,
      Math.max(
        0,
        ESCENAS.findIndex((e) => t < e.hasta),
      ),
    );
    const e = ESCENAS[idx === -1 ? ESCENAS.length - 1 : idx]!;
    const DISOLV = 0.28;
    const entrando = tramo(t, e.desde, e.desde + DISOLV);

    // Plano saliente: sigue vivo durante el fundido y se aleja un poco. Así el corte "conecta".
    if (entrando < 1 && idx > 0) {
      const prev = ESCENAS[idx - 1]!;
      const rectPrev = encuadreEn(prev, f, Math.min(t, prev.hasta));
      const archivoPrev = Array.isArray(prev.fuente) ? prev.fuente.at(-1)! : prev.fuente;
      const img = await plano(f, archivoPrev, rectPrev, c.fuentes.get(archivoPrev)!);
      capas.push({
        input: await sharp(img)
          .composite([{ input: c.mask, blend: "dest-in" }])
          .png()
          .toBuffer(),
        top: f.tarjeta.y,
        left: f.tarjeta.x,
      });
    }

    // Plano entrante.
    const archivo = Array.isArray(e.fuente)
      ? e.fuente[
          Math.min(
            e.fuente.length - 1,
            Math.floor(tramo(t, e.desde + 0.25, e.hasta - 0.35) * e.fuente.length),
          )
        ]!
      : e.fuente;
    const img = await plano(f, archivo, encuadreEn(e, f, t), c.fuentes.get(archivo)!);
    // El primer plano NO se funde desde negro: la sombra de la tarjeta está pintada en el fondo,
    // así que un fundido de entrada dejaría un rectángulo negro en el fotograma inicial.
    const op = idx === 0 ? 1 : easeOutCubic(entrando);
    let tarjeta = sharp(img).composite([{ input: c.mask, blend: "dest-in" }]);
    if (op < 1) {
      const png = await tarjeta.png().toBuffer();
      tarjeta = sharp(
        await sharp(png)
          .ensureAlpha()
          .composite([
            {
              input: Buffer.from([255, 255, 255, Math.round(op * 255)]),
              raw: { width: 1, height: 1, channels: 4 },
              tile: true,
              blend: "dest-in",
            },
          ])
          .png()
          .toBuffer(),
      );
    }
    capas.push({ input: await tarjeta.png().toBuffer(), top: f.tarjeta.y, left: f.tarjeta.x });
    capas.push({ input: c.edge, top: f.tarjeta.y, left: f.tarjeta.x });

    // Texto del plano: entra desde abajo, se sostiene y sale hacia arriba.
    if (e.titulo) {
      const base = c.textos.get(idx)!;
      const ent = easeOutExpo(tramo(t, e.desde + 0.18, e.desde + 0.62));
      const sal = easeOutCubic(tramo(t, e.hasta - 0.42, e.hasta - 0.02));
      const opTxt = ent * (1 - sal);
      if (opTxt > 0.01) {
        const dy = Math.round(mezcla(34, 0, ent) - sal * 18);
        capas.push({
          input: await sharp(base)
            .composite([
              {
                input: Buffer.from([255, 255, 255, Math.round(clamp01(opTxt) * 255)]),
                raw: { width: 1, height: 1, channels: 4 },
                tile: true,
                blend: "dest-in",
              },
            ])
            .png()
            .toBuffer(),
          top: dy,
          left: 0,
        });
      }
    }
  }

  // ── Cierre: el logo real, el nombre y la llamada a la acción ──────────────
  if (t >= CIERRE - 0.25) {
    const velo = easeOutCubic(tramo(t, CIERRE - 0.25, CIERRE + 0.35)) * 0.97;
    capas.push({
      input: Buffer.from([11, 13, 16, Math.round(velo * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: "over",
    });
    const apLogo = easeOutExpo(tramo(t, CIERRE + 0.05, CIERRE + 0.7));
    if (apLogo > 0.01) {
      const tam = Math.round(f.cierre.logo * mezcla(0.9, 1, apLogo));
      capas.push({
        input: await sharp(c.cierre.logoBuf)
          .resize(tam, tam)
          .ensureAlpha()
          .composite([
            {
              input: Buffer.from([255, 255, 255, Math.round(apLogo * 255)]),
              raw: { width: 1, height: 1, channels: 4 },
              tile: true,
              blend: "dest-in",
            },
          ])
          .png()
          .toBuffer(),
        top: Math.round(f.cierre.marcaY - f.cierre.logo * 1.28 - (tam - f.cierre.logo) / 2),
        left: Math.round((f.W - tam) / 2),
      });
    }
    for (const [pieza, inicio] of [
      [c.cierre.marca, CIERRE + 0.35],
      [c.cierre.cta, CIERRE + 0.75],
    ] as const) {
      const ap = easeOutExpo(tramo(t, inicio, inicio + 0.55));
      if (ap > 0.01)
        capas.push({
          input: await sharp(pieza)
            .composite([
              {
                input: Buffer.from([255, 255, 255, Math.round(ap * 255)]),
                raw: { width: 1, height: 1, channels: 4 },
                tile: true,
                blend: "dest-in",
              },
            ])
            .png()
            .toBuffer(),
          top: Math.round(mezcla(16, 0, ap)),
          left: 0,
        });
    }
  }

  return sharp(c.base).composite(capas).removeAlpha().raw().toBuffer();
}

// ── Render + codificación ───────────────────────────────────────────────────
async function render(f: Formato) {
  const base = await fondoConSombra(f);
  const cache: Cache = {
    base,
    mask: await mascara(f),
    edge: await filo(f),
    textos: new Map(),
    cierre: await piezasCierre(f),
    fuentes: new Map(),
  };
  for (const [i, e] of ESCENAS.entries())
    if (e.titulo) cache.textos.set(i, await textoEscena(f, e.titulo, e.pie));
  for (const e of ESCENAS)
    for (const a of Array.isArray(e.fuente) ? e.fuente : [e.fuente]) {
      if (!existsSync(a)) throw new Error(`Falta la captura ${a}. Corre capturar.ts primero.`);
      const m = await sharp(a).metadata();
      cache.fuentes.set(a, { w: m.width!, h: m.height! });
    }

  const destino = `${SALIDA}/pan-de-paula-crm-${f.nombre}.mp4`;
  const args = [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${f.W}x${f.H}`,
    "-r",
    String(FPS),
    "-i",
    "-",
    ...(existsSync(AUDIO) ? ["-i", AUDIO] : []),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-movflags",
    "+faststart",
    "-g",
    String(FPS * 2),
    ...(existsSync(AUDIO) ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest"] : []),
    "-t",
    String(DUR),
    destino,
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d) => (err += d.toString()));

  for (let i = 0; i < TOTAL; i++) {
    const buf = await fotograma(f, cache, i);
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once("drain", res));
    if (i % 60 === 0) process.stdout.write(`\r  ${f.nombre}: ${i}/${TOTAL} fotogramas`);
  }
  ff.stdin.end();
  const code: number = await new Promise((res) => ff.on("close", res));
  process.stdout.write(`\r  ${f.nombre}: ${TOTAL}/${TOTAL} fotogramas\n`);
  if (code !== 0)
    throw new Error(`ffmpeg falló (${code}):\n${err.split("\n").slice(-12).join("\n")}`);
  console.info(`  → ${destino}`);
}

const pedido = process.argv[2];
for (const f of Object.values(FORMATOS)) {
  if (pedido && f.nombre !== pedido) continue;
  await render(f);
}
