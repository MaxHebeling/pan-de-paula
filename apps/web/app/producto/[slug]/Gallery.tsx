"use client";

import Image from "next/image";
import { useState } from "react";
import { ProductArt } from "@/components/ProductArt";
import type { ProductImage as Img } from "@/lib/catalog";

const KNOWN_HOST = /^(\/|https:\/\/[a-z0-9-]+\.supabase\.co\/)/i;

export function Gallery({ images, name, seed }: { images: Img[]; name: string; seed: string }) {
  const [idx, setIdx] = useState(0);
  if (images.length === 0) {
    return (
      <div className="card aspect-square overflow-hidden">
        <ProductArt name={name} seed={seed} className="h-full w-full" large />
      </div>
    );
  }
  const current = images[Math.min(idx, images.length - 1)]!;
  return (
    <div className="space-y-3">
      <div className="card relative aspect-square overflow-hidden bg-cream-2">
        <Image
          key={current.id}
          src={current.url}
          alt={current.alt ?? name}
          fill
          priority
          sizes="(min-width: 1024px) 560px, 92vw"
          unoptimized={!KNOWN_HOST.test(current.url)}
          className="object-cover"
        />
      </div>
      {images.length > 1 && (
        <ul className="flex gap-2 overflow-x-auto" aria-label="Miniaturas">
          {images.map((im, i) => (
            <li key={im.id}>
              <button
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`Ver imagen ${i + 1}`}
                aria-pressed={i === idx}
                className={`relative h-16 w-16 overflow-hidden rounded-[12px] border-2 ${i === idx ? "border-sage" : "border-transparent"}`}
              >
                <Image src={im.url} alt="" fill sizes="64px" unoptimized={!KNOWN_HOST.test(im.url)} className="object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
