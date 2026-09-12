import Image from "next/image";

export function Logo({
  size = 48,
  priority = false,
  className = "",
}: {
  size?: number;
  priority?: boolean;
  className?: string;
}) {
  return (
    <Image
      src="/brand/logo-320.webp"
      alt="El Pan de Paula · Boulangerie"
      width={size}
      height={size}
      priority={priority}
      className={`rounded-full ${className}`}
      sizes={`${size}px`}
    />
  );
}
