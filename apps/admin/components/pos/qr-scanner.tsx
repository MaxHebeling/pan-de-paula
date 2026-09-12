"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";

type Detector = { detect: (src: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> };
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector;

export function hasBarcodeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

/**
 * Lector de QR con la cámara usando BarcodeDetector del navegador (sin librerías).
 * Si el navegador no lo soporta, el POS usa entrada manual / lector USB (teclado + Enter).
 */
export function QrScanner({
  onDetected,
  onClose,
}: {
  onDetected: (value: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const supported = useSyncExternalStore(
    () => () => {},
    hasBarcodeDetector,
    () => false,
  );
  const [cameraError, setCameraError] = useState<string | null>(null);
  const error = supported
    ? cameraError
    : "Este navegador no puede leer QR con la cámara. Usa el lector USB o escribe el código.";

  useEffect(() => {
    if (!supported) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let done = false;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ["qr_code"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        timer = window.setInterval(async () => {
          if (done || !videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue?.trim();
            if (value) {
              done = true;
              onDetected(value);
            }
          } catch (e) {
            console.error("[pos] BarcodeDetector.detect", (e as Error).message);
          }
        }, 250);
      } catch (e) {
        console.error("[pos] cámara no disponible", (e as Error).message);
        setCameraError(
          "No se pudo abrir la cámara. Revisa el permiso del navegador o usa el lector USB.",
        );
      }
    })();
    return () => {
      done = true;
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetected, supported]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Escanear QR"
    >
      <div className="card w-full max-w-md overflow-hidden p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold">Escanea el QR del cliente</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm min-h-11 min-w-11"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>
        {error ? (
          <p className="st-amber m-4 rounded-[var(--r-btn)] px-3 py-2 text-sm">{error}</p>
        ) : (
          <video
            ref={videoRef}
            className="aspect-square w-full bg-black object-cover"
            muted
            playsInline
          />
        )}
      </div>
    </div>
  );
}
