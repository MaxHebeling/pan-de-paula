import type { Metadata } from "next";
import { CartPage } from "./CartPage";

export const metadata: Metadata = { title: "Carrito", robots: { index: false } };

export default function Page() {
  return <CartPage />;
}
