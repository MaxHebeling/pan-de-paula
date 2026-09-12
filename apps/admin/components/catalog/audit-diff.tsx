/** Diff legible entre old_data y new_data de audit_logs (solo claves que cambiaron). */
type J = Record<string, unknown> | null | undefined;

const HIDDEN = new Set(["updated_at", "created_at", "password_hash", "pin_hash", "token_hash"]);

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return v.length > 160 ? v.slice(0, 157) + "…" : v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function diffRows(
  oldData: J,
  newData: J,
): Array<{ key: string; from: unknown; to: unknown }> {
  const o = oldData ?? {};
  const n = newData ?? {};
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)])).filter(
    (k) => !HIDDEN.has(k),
  );
  const rows: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of keys.sort()) {
    const a = o[k];
    const b = n[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ key: k, from: a, to: b });
  }
  return rows;
}

export function AuditDiff({
  action,
  oldData,
  newData,
}: {
  action: string;
  oldData: J;
  newData: J;
}) {
  const rows = diffRows(oldData, newData);
  if (rows.length === 0)
    return <p className="text-xs text-muted">Sin cambios de datos registrados.</p>;
  return (
    <table className="w-full text-xs [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:text-muted">
      <thead>
        <tr>
          <th className="w-40">Campo</th>
          {action !== "INSERT" && <th>Antes</th>}
          {action !== "DELETE" && <th>Después</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-line">
            <td className="font-mono">{r.key}</td>
            {action !== "INSERT" && (
              <td className="text-red-d line-through decoration-red-d/40">{fmt(r.from)}</td>
            )}
            {action !== "DELETE" && <td className="text-green-d">{fmt(r.to)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
