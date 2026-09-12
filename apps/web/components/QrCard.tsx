"use client";

export function SaveQrButton({ dataUrl, fileName }: { dataUrl: string; fileName: string }) {
  return (
    <a href={dataUrl} download={fileName} className="btn btn-primary">
      Guardar en el teléfono
    </a>
  );
}

export function CopyLinkButton({ url }: { url: string }) {
  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          window.alert("Enlace copiado. Guárdalo en tus notas o favoritos.");
        } catch (e) {
          console.error("[club] no se pudo copiar el enlace", e);
          window.prompt("Copia este enlace:", url);
        }
      }}
    >
      Copiar enlace de mi tarjeta
    </button>
  );
}
