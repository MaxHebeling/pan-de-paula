import { Badge } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "./action-form";
import { TextInput } from "./fields";
import {
  deleteProductImage,
  moveImage,
  setPrimaryImage,
  uploadProductImage,
} from "@/app/(app)/productos/actions";

export type ProductImage = {
  id: string;
  url: string;
  alt: string | null;
  is_primary: boolean;
  sort_order: number;
};

export function ImageManager({
  productId,
  images,
  canWrite,
}: {
  productId: string;
  images: ProductImage[];
  canWrite: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {images.length === 0 ? (
        <p className="text-sm text-muted">Sin imágenes. La primera que subas será la principal.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img, i) => (
            <li key={img.id} className="card overflow-hidden">
              <div className="relative aspect-square bg-black/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.alt ?? ""}
                  className="size-full object-cover"
                  loading="lazy"
                />
                {img.is_primary && (
                  <Badge tone="blue" className="absolute left-2 top-2">
                    Principal
                  </Badge>
                )}
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-1 p-2">
                  {!img.is_primary && (
                    <form action={setPrimaryImage.bind(null, productId, img.id)}>
                      <ConfirmButton title="Hacer principal">★</ConfirmButton>
                    </form>
                  )}
                  <form action={moveImage.bind(null, productId, img.id, "up")}>
                    <ConfirmButton title="Mover antes" className={i === 0 ? "invisible" : ""}>
                      ←
                    </ConfirmButton>
                  </form>
                  <form action={moveImage.bind(null, productId, img.id, "down")}>
                    <ConfirmButton
                      title="Mover después"
                      className={i === images.length - 1 ? "invisible" : ""}
                    >
                      →
                    </ConfirmButton>
                  </form>
                  <form
                    action={deleteProductImage.bind(null, productId, img.id)}
                    className="ml-auto"
                  >
                    <ConfirmButton
                      variant="danger"
                      title="Eliminar"
                      confirm="¿Eliminar esta imagen?"
                    >
                      ✕
                    </ConfirmButton>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <ActionForm
          action={uploadProductImage.bind(null, productId)}

          resetOnSuccess
          className="flex flex-col gap-3 md:flex-row md:items-end"
        >
          <TextInput
            label="Nueva imagen"
            name="image"
            type="file"
            required
            accept="image/jpeg,image/png,image/webp,image/avif"
            hint="JPG, PNG, WebP o AVIF · máx. 5 MB"
            className="md:flex-1"
          />
          <TextInput label="Texto alternativo" name="alt" maxLength={140} className="md:flex-1" />
          <SubmitButton pendingText="Subiendo…" variant="secondary">
            Subir
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
