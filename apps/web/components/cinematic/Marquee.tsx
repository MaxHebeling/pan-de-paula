const WORDS = ["Hecho a mano", "Horneado para ti", "Boulangerie", "Made with love"];

/** Cinta tipográfica lenta entre secciones. Decorativa (repite ideas ya escritas): oculta a lectores. */
export function Marquee() {
  const group = (
    <span className="cin-marquee-group">
      {WORDS.map((w) => (
        <span key={w} className="contents">
          <span>{w}</span>
          <i>✦</i>
        </span>
      ))}
    </span>
  );
  return (
    <div className="cin-marquee" aria-hidden="true">
      <div className="cin-marquee-track">
        {group}
        {group}
      </div>
    </div>
  );
}
