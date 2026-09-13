import Image from "next/image";
import { Logo } from "./Logo";

/**
 * Tarjeta digital del club tal como la ve el cliente en /mi-tarjeta, con un QR real que lleva a /unete
 * (escanearlo desde otro dispositivo abre el registro). No muestra datos de ninguna persona.
 */
export function ClubCard({ qrDataUrl, joinUrl }: { qrDataUrl: string; joinUrl: string }) {
  return (
    <div
      className="card w-full max-w-[340px] overflow-hidden bg-paper text-ink shadow-lift"
      data-testid="club-card"
    >
      <div className="flex items-center justify-between gap-4 bg-ink px-5 py-4 text-cream">
        <div>
          <p className="eyebrow text-crust-2">Club El Pan de Paula</p>
          <p className="font-display text-xl">Tu tarjeta digital</p>
          <p className="mt-1 font-mono text-xs tracking-widest text-cream/70">PDP-······</p>
        </div>
        <Logo size={44} />
      </div>
      <div className="flex items-center gap-4 p-5">
        <div className="w-[104px] shrink-0 rounded-[14px] border border-line bg-paper p-1.5">
          <Image
            src={qrDataUrl}
            alt={`Código QR para unirte al club (${joinUrl})`}
            width={96}
            height={96}
            unoptimized
            className="h-auto w-full"
          />
        </div>
        <div className="text-sm">
          <p className="font-medium text-ink">Escanea para unirte</p>
          <p className="mt-1 text-ink-2">
            Al registrarte recibes tu código personal y tu QR para sumar puntos al pagar.
          </p>
        </div>
      </div>
    </div>
  );
}
