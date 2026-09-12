import Image from "next/image";
import { ProductArt } from "./ProductArt";

const KNOWN_HOST = /^(\/|https:\/\/[a-z0-9-]+\.supabase\.co\/)/i;

export function ProductImage({
  url,
  alt,
  seed,
  sizes,
  priority = false,
  className = "",
  large = false,
}: {
  url: string | null;
  alt: string;
  seed: string;
  sizes: string;
  priority?: boolean;
  className?: string;
  large?: boolean;
}) {
  if (!url) return <ProductArt name={alt} seed={seed} className={`h-full w-full ${className}`} large={large} />;
  return (
    <Image
      src={url}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={!KNOWN_HOST.test(url)}
      className={`object-cover ${className}`}
    />
  );
}
