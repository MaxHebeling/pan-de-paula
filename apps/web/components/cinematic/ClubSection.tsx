import type { RewardView, ProgramView } from "@/lib/loyalty";
import { money } from "@/lib/format";
import { ClubCard } from "../ClubCard";
import { Reveal } from "../Reveal";
import { CinLink } from "./Button";

/**
 * Club: sección diferenciada en tinta. La tarjeta con QR real es la protagonista y entra con
 * scale .95→1 y rotate 2°→0 (Reveal variant "card"). Los beneficios salen del programa y de las
 * recompensas vigentes; si el programa está apagado solo se invita a conocerlo.
 */
export function ClubSection({
  qrDataUrl,
  joinUrl,
  program,
  rewards,
  tierCount,
}: {
  qrDataUrl: string;
  joinUrl: string;
  program: ProgramView | null;
  rewards: RewardView[];
  tierCount: number;
}) {
  const benefits: Array<{ value: string; label: string }> = [];
  if (program) {
    benefits.push({
      value: `${program.pointsPerUnit} ${program.pointsPerUnit === 1 ? "punto" : "puntos"}`,
      label: `por cada ${money(program.unitCents, true)} de compra`,
    });
    if (program.signupBonusPoints > 0)
      benefits.push({ value: `+${program.signupBonusPoints}`, label: "puntos de bienvenida" });
    if (program.birthdayMultiplier > 1)
      benefits.push({
        value: `×${program.birthdayMultiplier}`,
        label: "puntos en tu cumpleaños (si nos lo compartes)",
      });
    for (const r of rewards.slice(0, 2))
      benefits.push({ value: `${r.pointsCost} puntos`, label: `= ${r.name}` });
    if (tierCount > 1)
      benefits.push({
        value: `${tierCount} niveles`,
        label: "según tus compras, cada uno con sus beneficios",
      });
  }
  return (
    <section className="cin-section cin-club on-dark" aria-labelledby="club-title">
      <div className="cin-club-glow" aria-hidden="true" />
      <div className="cin-wrap cin-club-grid">
        <Reveal>
          <p className="cin-index">
            <span className="cin-index-num">09</span> Club El Pan de Paula
          </p>
          <h2 id="club-title" className="cin-h2 mt-5">
            Cada compra <em>suma.</em>
          </h2>
          <p className="cin-club-lead mt-5">
            Regístrate en 30 segundos, recibe tu tarjeta digital con QR y canjea tus puntos en la
            panadería.
          </p>
          {benefits.length > 0 && (
            <ul className="cin-benefits">
              {benefits.slice(0, 5).map((b) => (
                <li key={b.value + b.label} className="cin-benefit">
                  <span className="cin-benefit-value">{b.value}</span>
                  <span className="cin-benefit-label">{b.label}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="cin-club-actions">
            <CinLink href="/unete" magnetic>
              Quiero unirme
            </CinLink>
            <CinLink href="/club" variant="text">
              Conocer el programa
            </CinLink>
          </div>
        </Reveal>
        <Reveal variant="card" delay={150} className="cin-club-card">
          <ClubCard qrDataUrl={qrDataUrl} joinUrl={joinUrl} />
        </Reveal>
      </div>
    </section>
  );
}
