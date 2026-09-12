import { requireSession } from "@/lib/auth";
import { PageHeader, Card, LinkButton } from "@/components/ui";
import { CouponForm } from "@/components/customers/coupon-form";
import { activeProducts } from "@/lib/loyalty";
import { loyaltyTiers } from "@/lib/customers";
import { upsertCouponAction } from "../actions";

export const metadata = { title: "Nuevo cupón" };

export default async function NewCouponPage() {
  await requireSession("loyalty.write");
  const [products, tiers] = await Promise.all([activeProducts(), loyaltyTiers()]);
  return (
    <>
      <PageHeader
        title="Nuevo cupón"
        subtitle="El código se valida en servidor en POS y tienda; los descuentos se calculan al cobrar."
        actions={
          <LinkButton href="/cupones" variant="secondary">
            Volver
          </LinkButton>
        }
      />
      <Card>
        <CouponForm action={upsertCouponAction} products={products} tiers={tiers} />
      </Card>
    </>
  );
}
