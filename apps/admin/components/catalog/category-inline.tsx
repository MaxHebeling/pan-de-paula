"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { InlineCell } from "./inline-cell";

/** Nombre y orden de una categoría editables en línea (lista de categorías). */
export function CategoryNameCell({
  id,
  name,
  canWrite,
  action,
}: {
  id: string;
  name: string;
  canWrite: boolean;
  action: (id: string, field: "name" | "sort_order", value: unknown) => Promise<ActionState>;
}) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-1">
      <Link href={`/categorias/${id}`} className="font-medium hover:underline">
        {name}
      </Link>
      {canWrite && (
        <InlineCell
          kind="text"
          value={name}
          align="left"
          label={`Nombre de la categoría ${name}`}
          display={
            <span aria-hidden className="text-muted">
              ✎
            </span>
          }
          className="min-w-11"
          inputClassName="!w-56"
          onSave={async (v) => {
            const r = await action(id, "name", v);
            if (!r.error) router.refresh();
            return r;
          }}
          testId={`cat-name-${id}`}
        />
      )}
    </div>
  );
}

export function CategoryOrderCell({
  id,
  name,
  order,
  canWrite,
  action,
}: {
  id: string;
  name: string;
  order: number;
  canWrite: boolean;
  action: (id: string, field: "name" | "sort_order", value: unknown) => Promise<ActionState>;
}) {
  const router = useRouter();
  return (
    <InlineCell
      kind="integer"
      value={order}
      min={0}
      max={9999}
      label={`Orden de la categoría ${name}`}
      display={<span className="tabular-nums">{order}</span>}
      disabled={!canWrite}
      className="w-20"
      onSave={async (v) => {
        const r = await action(id, "sort_order", v);
        if (!r.error) router.refresh();
        return r;
      }}
      testId={`cat-order-${id}`}
    />
  );
}
