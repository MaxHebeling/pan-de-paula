import type { Metadata } from "next";
import Link from "next/link";
import { money } from "@/lib/format";
import { getProgram, listActiveRewards, loyaltyEnabled } from "@/lib/loyalty";
import { getBusiness } from "@/lib/site";
import { JoinForm } from "./JoinForm";

export const metadata: Metadata = {
  title: "Únete al club",
  description: "Regístrate en 30 segundos y recibe tu tarjeta digital con QR. Acumula puntos en cada compra y canjéalos por pan.",
  alternates: { canonical: "/unete" },
};

export default async function JoinPage() {
  const [business, program, rewards] = await Promise.all([getBusiness(), getProgram(), listActiveRewards()]);
  const enabled = loyaltyEnabled(business.flags, program);
  return (
    <div className="container-x py-10 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-start">
        <div className="reveal">
          <p className="eyebrow mb-2">Club El Pan de Paula</p>
          <h1 className="display text-4xl sm:text-5xl">Tu tarjeta del club en 30 segundos</h1>
          <p className="mt-4 text-lg text-ink-2">
            Regístrate una sola vez. Te damos un código personal y un QR: muéstralo al pagar en la panadería o vincúlalo a tus pedidos en línea.
          </p>
          <ul className="mt-6 space-y-3 text-ink">
            {enabled && (
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sage text-xs text-white">1</span>
                <span>
                  Ganas <strong>{program.pointsPerUnit} {program.pointsPerUnit === 1 ? "punto" : "puntos"}</strong> por cada {money(program.unitCents, true)} de compra
                  {program.minPurchaseCents > 0 ? ` (a partir de ${money(program.minPurchaseCents, true)})` : ""}.
                </span>
              </li>
            )}
            <li className="flex gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sage text-xs text-white">2</span>
              <span>Subes de nivel con tus compras y desbloqueas beneficios.</span>
            </li>
            {rewards.length > 0 && (
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sage text-xs text-white">3</span>
                <span>
                  Canjeas puntos por recompensas como <strong>{rewards[0]!.name.toLowerCase()}</strong>
                  {rewards[1] ? ` o ${rewards[1].name.toLowerCase()}` : ""}.
                </span>
              </li>
            )}
            {program.signupBonusPoints > 0 && (
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-crust text-xs text-ink">★</span>
                <span>
                  Al registrarte recibes <strong>{program.signupBonusPoints} puntos</strong> de bienvenida.
                </span>
              </li>
            )}
          </ul>
          <p className="mt-6 text-sm text-ink-2">
            <Link href="/club" className="text-sage underline">
              Conoce niveles y recompensas
            </Link>
          </p>
        </div>
        <div className="reveal reveal-2">
          <JoinForm />
        </div>
      </div>
    </div>
  );
}
