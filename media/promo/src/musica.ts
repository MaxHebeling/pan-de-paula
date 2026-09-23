/**
 * Pista original del video. Se sintetiza aquí, con matemáticas y nada más: no hay samples ni música
 * de terceros, así que no hay licencia que rastrear ni atribución pendiente. Autoría: generada para
 * este repositorio; se puede usar, modificar y redistribuir junto con el proyecto.
 *
 * 120 pulsos por minuto · 14 s · 28 pulsos. Los golpes caen en 2, 4, 6, 8, 10 y 12 s, exactamente
 * donde el montaje corta de plano, y el cierre entra con un impacto y una cola que se apaga sola:
 * nada de finales cortados en seco.
 *
 *   node --experimental-strip-types src/musica.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SR = 48_000;
const DUR = 14;
const N = SR * DUR;
const BPM = 120;
const PULSO = 60 / BPM; // 0.5 s
const CORTES = [2, 4, 6, 8, 10, 12];
const SALIDA = resolve(import.meta.dirname, "../audio");

const izq = new Float64Array(N);
const der = new Float64Array(N);

const enMuestra = (s: number) => Math.round(s * SR);
const suma = (i: number, v: number, pan = 0) => {
  if (i < 0 || i >= N) return;
  izq[i]! += v * (1 - Math.max(0, pan));
  der[i]! += v * (1 + Math.min(0, pan));
};

/** Ruido reproducible: el render debe sonar igual cada vez que se regenere. */
let semilla = 20260922;
const ruido = () => {
  semilla = (semilla * 1664525 + 1013904223) % 4294967296;
  return semilla / 2147483648 - 1;
};

const nota = (semitonos: number) => 440 * Math.pow(2, semitonos / 12);
// La menor: la tónica del conjunto. Grados usados más abajo.
const LA = -24,
  DO = -21,
  MI = -17,
  SOL = -14,
  LA2 = -12,
  DO2 = -9,
  MI2 = -5;

// ── Bombo: seno que cae de 120 a 45 Hz ──────────────────────────────────────
function bombo(t0: number, gan = 0.9) {
  const dur = 0.26;
  let fase = 0;
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const f = 120 * Math.pow(45 / 120, Math.pow(x, 0.34));
    fase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-x * 7.5);
    suma(enMuestra(t0) + k, Math.sin(fase) * env * gan);
  }
}

// ── Charles: ruido corto y brillante ────────────────────────────────────────
function charles(t0: number, gan = 0.16) {
  const dur = 0.045;
  let prev = 0;
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const n = ruido();
    const alto = n - prev; // diferenciar = quitar graves
    prev = n;
    suma(enMuestra(t0) + k, alto * Math.exp(-x * 26) * gan, k % 2 ? 0.25 : -0.25);
  }
}

// ── Bajo sub: la base que sostiene el pulso ─────────────────────────────────
function sub(t0: number, semis: number, dur: number, gan = 0.5) {
  const f = nota(semis);
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const env = Math.min(1, x * 60) * Math.exp(-x * 2.4);
    suma(enMuestra(t0) + k, Math.sin((2 * Math.PI * f * k) / SR) * env * gan);
  }
}

// ── Pulsación: la melodía corta que da el aire "producto tecnológico" ───────
function pulsacion(t0: number, semis: number, gan = 0.2, pan = 0) {
  const dur = 0.5;
  const f = nota(semis);
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const env = Math.min(1, x * 300) * Math.exp(-x * 6.5);
    // Dos osciladores apenas desafinados: suena más ancho que uno solo.
    const v =
      Math.sin((2 * Math.PI * f * k) / SR) * 0.6 +
      Math.sin((2 * Math.PI * f * 1.0018 * k) / SR) * 0.4 +
      Math.sin((2 * Math.PI * f * 2 * k) / SR) * 0.12;
    suma(enMuestra(t0) + k, v * env * gan, pan);
  }
}

// ── Colchón: acorde sostenido y filtrado, que llena el fondo ────────────────
function colchon(t0: number, dur: number, semis: number[], gan = 0.12) {
  let lp = 0;
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const env = Math.min(1, x * 3.2) * Math.min(1, (1 - x) * 5);
    let v = 0;
    for (const s of semis) v += Math.sin((2 * Math.PI * nota(s) * k) / SR);
    v /= semis.length;
    lp += (v - lp) * 0.06; // paso bajo de un polo: quita el filo
    suma(enMuestra(t0) + k, lp * env * gan, Math.sin(x * 3) * 0.3);
  }
}

// ── Barrido: el aire que acompaña cada corte de plano ───────────────────────
function barrido(tCorte: number, gan = 0.2) {
  const dur = 0.55;
  const t0 = tCorte - dur * 0.82;
  let lp = 0;
  for (let k = 0; k < enMuestra(dur); k++) {
    const x = k / (dur * SR);
    const n = ruido();
    lp += (n - lp) * (0.02 + x * 0.5); // el filtro se abre: efecto de "subida"
    const env = Math.pow(x, 2.2) * Math.exp(-Math.max(0, x - 0.82) * 40);
    suma(enMuestra(t0) + k, lp * env * gan, (x - 0.5) * 1.2);
  }
}

// ── Impacto del cierre, con cola que se apaga sola ──────────────────────────
function impacto(t0: number, gan = 0.85) {
  for (let k = 0; k < enMuestra(1.9); k++) {
    const x = k / (1.9 * SR);
    const env = Math.exp(-x * 3.1);
    const grave = Math.sin((2 * Math.PI * 52 * k) / SR) * env;
    const cuerpo = Math.sin((2 * Math.PI * nota(LA2) * k) / SR) * env * 0.35;
    const aire = ruido() * Math.exp(-x * 16) * 0.22;
    suma(enMuestra(t0) + k, (grave + cuerpo + aire) * gan);
  }
}

// ── Arreglo ─────────────────────────────────────────────────────────────────
// Progresión por compás (4 pulsos): Am · Am · F · C · G · Am · Am
const ACORDES: number[][] = [
  [LA, MI, LA2, DO2],
  [LA, MI, LA2, DO2],
  [LA - 4, DO, LA2 - 4, LA2],
  [DO, SOL, DO2, MI2],
  [SOL - 2, MI - 2, SOL, DO2 - 2],
  [LA, MI, LA2, DO2],
  [LA, MI, LA2, DO2],
];
const RAICES = [LA, LA, LA - 4, DO, SOL - 2, LA, LA];

for (let compas = 0; compas < 7; compas++) {
  const t0 = compas * 4 * PULSO;
  colchon(t0, 4 * PULSO + 0.3, ACORDES[compas]!, compas === 6 ? 0.1 : 0.13);
  sub(t0, RAICES[compas]!, 4 * PULSO * 0.92, compas === 6 ? 0.34 : 0.46);

  for (let p = 0; p < 4; p++) {
    const t = t0 + p * PULSO;
    if (t >= 12.5) continue; // el cierre respira: solo cola
    if (p === 0 || p === 2) bombo(t, p === 0 ? 0.9 : 0.72);
    charles(t + PULSO / 2, 0.15);
    if (p % 2 === 1) charles(t + PULSO * 0.75, 0.09);
  }

  // Arpegio en corcheas sobre las notas del acorde: entra a partir del segundo compás.
  if (compas >= 1 && compas <= 5) {
    const escala = ACORDES[compas]!;
    for (let s = 0; s < 8; s++) {
      const t = t0 + s * (PULSO / 2);
      if (t >= 12) break;
      if (s % 4 === 3) continue; // huecos: respira y no satura
      pulsacion(t, escala[(s + compas) % escala.length]! + 12, 0.17, ((s % 3) - 1) * 0.35);
    }
  }
}

for (const c of CORTES) barrido(c, c === 12 ? 0.26 : 0.17);
impacto(12, 0.8);
// Una nota larga que sostiene la marca mientras aparece el logo.
colchon(12, 2, [LA, MI, LA2, DO2], 0.11);

// ── Mezcla: suavizado, entrada y salida ─────────────────────────────────────
const salida = Buffer.alloc(44 + N * 4);
salida.write("RIFF", 0);
salida.writeUInt32LE(36 + N * 4, 4);
salida.write("WAVEfmt ", 8);
salida.writeUInt32LE(16, 16);
salida.writeUInt16LE(1, 20);
salida.writeUInt16LE(2, 22);
salida.writeUInt32LE(SR, 24);
salida.writeUInt32LE(SR * 4, 28);
salida.writeUInt16LE(4, 32);
salida.writeUInt16LE(16, 34);
salida.write("data", 36);
salida.writeUInt32LE(N * 4, 40);

let pico = 0;
for (let i = 0; i < N; i++) pico = Math.max(pico, Math.abs(izq[i]!), Math.abs(der[i]!));
const norm = 0.82 / Math.max(pico, 0.0001);

for (let i = 0; i < N; i++) {
  const t = i / SR;
  // Entrada corta y salida larga: nada arranca ni termina de golpe.
  const env = Math.min(1, t / 0.12) * Math.min(1, (DUR - t) / 1.1);
  for (const [canal, buf] of [
    [izq, 0],
    [der, 2],
  ] as const) {
    const v = Math.tanh(canal[i]! * norm * 1.08) * 0.92 * env; // tanh = saturación suave, sin recortes
    salida.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 4 + buf);
  }
}

mkdirSync(SALIDA, { recursive: true });
writeFileSync(`${SALIDA}/pista.wav`, salida);
console.info(
  `Pista original: ${SALIDA}/pista.wav · ${DUR}s · ${BPM} ppm · pico ${pico.toFixed(2)}`,
);
