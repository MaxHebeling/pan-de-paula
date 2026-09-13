import Image from "next/image";
import Link from "next/link";
import { hour12 } from "@/lib/format";

type OpenStatus = { open: boolean; reason?: string; opensAt?: string; closesAt?: string };

export function Hero({ status }: { status: OpenStatus }) {
  return (
    <section className="cinematic-hero" data-hero>
      <Image src="/editorial/hero-pastries.webp" alt="Tres croissants artesanales de El Pan de Paula" fill priority sizes="100vw" className="cinematic-hero-image" />
      <div className="cinematic-hero-shade" aria-hidden="true" />
      <div className="cinematic-hero-grain" aria-hidden="true" />
      <div className="container-x cinematic-hero-content">
        <p className="hero-eyebrow cinematic-kicker">Boulangerie · Hecho con amor</p>
        <h1 className="cinematic-title">
          <span className="hero-line">Pan recién horneado.</span>
          <span className="hero-line cinematic-title-accent">Una experiencia.</span>
        </h1>
        <p className="hero-sub cinematic-copy">Croissants artesanales, horneados para tu fecha y terminados a mano, uno por uno.</p>
        <div className="hero-cta cinematic-actions">
          <Link href="/menu" className="btn cinematic-primary" data-testid="cta-menu" data-magnetic>Descubrir el menú <span aria-hidden="true">→</span></Link>
          <Link href="/menu" className="btn cinematic-secondary" data-magnetic>Pedir ahora</Link>
        </div>
        <p className="hero-status cinematic-status" data-testid="open-status">
          <span className={status.open ? "status-dot" : "status-dot-closed"} aria-hidden="true" />
          {status.open ? (
            <span><strong>Abierto ahora</strong>{status.closesAt && <span> · cerramos a las {hour12(status.closesAt)}</span>}</span>
          ) : (
            <span><strong>Cerrado</strong><span>{status.opensAt && status.reason?.startsWith("Abrimos") ? ` · abrimos a las ${hour12(status.opensAt)}` : status.reason ? ` · ${status.reason.toLowerCase()}` : ""}</span></span>
          )}
        </p>
      </div>
      <div className="cinematic-scroll" aria-hidden="true"><span>Desliza para descubrir</span><i /></div>
    </section>
  );
}
