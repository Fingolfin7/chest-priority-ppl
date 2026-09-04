import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parseInvitation } from "./peerSyncCrypto.ts";

export function PairingScanner({ onScan, onCancel }: { onScan: (invitation: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onScan, onCancel });
  const [status, setStatus] = useState("Allow camera access to scan your other device.");
  const [error, setError] = useState("");
  useEffect(() => { callbacks.current = { onScan, onCancel }; }, [onScan, onCancel]);
  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const element = video.current!;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let previousCode = "";
    const stop = () => {
      stopped = true; clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      element.srcObject = null;
    };
    const scan = async () => {
      if (stopped) return;
      try {
        if (element.readyState >= 2 && element.videoWidth && context) {
          const scale = Math.min(1, 960 / element.videoWidth);
          canvas.width = Math.round(element.videoWidth * scale);
          canvas.height = Math.round(element.videoHeight * scale);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
          if (code?.data && code.data !== previousCode) {
            previousCode = code.data;
            try {
              await parseInvitation(code.data);
              if (stopped) return;
              stop(); callbacks.current.onScan(code.data); return;
            } catch (cause) {
              if (!stopped) setStatus(cause instanceof Error && cause.message.includes("expired") ? "This code expired. Show a new QR on your other device." : "Point at the QR shown in Rolling PPL → Devices.");
            }
          }
        }
        if (!stopped) timer = setTimeout(() => { void scan(); }, 250);
      } catch {
        stop(); setError("The camera preview was interrupted. Close the scanner and try again.");
      }
    };
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !context) throw new Error("unsupported");
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
        element.srcObject = stream;
        await element.play();
        if (stopped) return;
        setStatus("Point at your other device’s QR. They will link automatically.");
        void scan();
      } catch (cause) {
        if (stopped) return;
        stop();
        const name = cause instanceof Error ? cause.name : "";
        setError(name === "NotAllowedError" || name === "SecurityError" ? "Camera access is blocked. Allow it in your browser’s site settings, or paste a pairing link below."
          : name === "NotFoundError" ? "No camera was found. You can paste a pairing link instead."
          : "The camera could not start. Check that another app isn’t using it, or paste a pairing link instead.");
      }
    };
    const hidden = () => { if (document.hidden) { stop(); callbacks.current.onCancel(); } };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    void start();
    return () => { stop(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", stop); };
  }, []);
  return <section className="pairing-scanner" aria-label="Scan a device QR code">
    <div className="scanner-preview"><video ref={video} muted playsInline aria-label="Camera preview" /><div className="scanner-frame" aria-hidden="true" /></div>
    <p role="status">{error || status}</p>
    <button type="button" className="secondary-action" onClick={onCancel}>Close scanner</button>
  </section>;
}
