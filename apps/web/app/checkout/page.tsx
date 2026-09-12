import type { Metadata } from "next";
import Link from "next/link";
import { mercadoPagoAvailable } from "@/lib/orders";
import { fulfillmentOptions, getBusiness, whatsappLink } from "@/lib/site";
import { CheckoutForm } from "./CheckoutForm";

export const metadata: Metadata = { title: "Finalizar pedido", robots: { index: false } };

export default async function CheckoutPage() {
  const business = await getBusiness();
  const options = fulfillmentOptions(business);
  const wa = whatsappLink(business, "Hola, quiero hacer un pedido");

  if (!business.flags.web_checkout) {
    return (
      <div className="container-x py-14">
        <h1 className="display text-4xl">Pedidos en línea en pausa</h1>
        <p className="mt-4 max-w-xl text-ink-2">
          Por ahora no estamos tomando pedidos desde el sitio. Con gusto te atendemos por mensaje.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {wa && (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
              Escribir por WhatsApp
            </a>
          )}
          <Link href="/menu" className="btn btn-secondary">
            Volver al menú
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container-x py-10 sm:py-14">
      <h1 className="display text-4xl">Finalizar pedido</h1>
      <p className="mt-2 text-ink-2">Tres pasos: fecha, tus datos y forma de pago.</p>
      <CheckoutForm
        options={options.map((o) => ({
          windowId: o.windowId,
          windowName: o.windowName,
          fulfillmentType: o.fulfillmentType,
          date: o.date,
          from: o.from ?? null,
          to: o.to ?? null,
          orderByDate: o.orderBy.date,
          orderByTime: o.orderBy.time,
        }))}
        pickupPoints={business.pickupPoints.map((p) => ({ id: p.id, name: p.name, address: p.address, isDefault: p.isDefault }))}
        payment={{
          mercadopago: mercadoPagoAvailable(business.flags),
          transfer: Boolean(business.policies.transfer_instructions),
          cash: true,
        }}
        deliveryFeeCents={business.policies.delivery_fee_cents ?? 0}
        deliveryZone={business.policies.delivery_zone ?? null}
        whatsapp={wa}
      />
    </div>
  );
}
