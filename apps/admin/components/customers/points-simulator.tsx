"use client";
import { useState } from "react";
import { pointsForPurchase, formatMXN, type LoyaltyProgram } from "@pdp/domain";

/** "Una compra de $Y da N puntos" — misma regla que loyalty_points_for en SQL (pointsForPurchase). */
export function PointsSimulator({
  program,
  featureEnabled,
}: {
  program: LoyaltyProgram;
  featureEnabled: boolean;
}) {
  const [pesos, setPesos] = useState("250");
  const [birthday, setBirthday] = useState(false);
  const [bonus, setBonus] = useState("0");
  const cents = Math.round((Number(pesos.replace(",", ".")) || 0) * 100);
  const pts = pointsForPurchase(program, cents, {
    isBirthday: birthday,
    productBonuses: Number(bonus) || 0,
    featureEnabled,
  });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="sim_pesos">
            Compra de ($)
          </label>
          <input
            id="sim_pesos"
            className="input"
            inputMode="decimal"
            value={pesos}
            onChange={(e) => setPesos(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="sim_bonus">
            Bonos por producto (pts)
          </label>
          <input
            id="sim_bonus"
            className="input"
            inputMode="numeric"
            value={bonus}
            onChange={(e) => setBonus(e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={birthday}
          onChange={(e) => setBirthday(e.target.checked)}
        />
        Es su cumpleaños (×{program.birthdayMultiplier})
      </label>
      <p className="rounded-[var(--r-btn)] bg-black/[0.04] px-3 py-2">
        Una compra de <strong>{formatMXN(cents)}</strong> da{" "}
        <strong className="text-teal-d">
          {pts} punto{pts === 1 ? "" : "s"}
        </strong>
        {!featureEnabled && <span className="text-red-d"> (motor de puntos desactivado)</span>}
        {featureEnabled && !program.isActive && (
          <span className="text-red-d"> (programa pausado)</span>
        )}
      </p>
      <p className="text-xs text-muted">
        Regla: {program.pointsPerUnit} pt por cada {formatMXN(program.unitCents)} (
        {program.rounding === "floor" ? "redondeo hacia abajo" : "redondeo normal"})
        {program.minPurchaseCents > 0 && ` · compra mínima ${formatMXN(program.minPurchaseCents)}`}
      </p>
    </div>
  );
}
