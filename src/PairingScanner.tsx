import { useEffect, useRef, useState } from "react";
import { parseInvitation } from "./peerSyncCrypto.ts";
import { nativeQrDetector, readQrFrame, type QrDetector } from "./qrFrame.ts";

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
    let detector: QrDetector | undefined;
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
          const code = await readQrFrame(element, canvas, context, detector);
          if (stopped) return;
          if (code && code !== previousCode) {
            previousCode = code;
            try {
              await parseInvitation(code);
              if (stopped) return;
              stop(); callbacks.current.onScan(code); return;
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
        element.srcObject = stream;
        await element.play();
        detector = await nativeQrDetector();
        if (stopped) return;
        setStatus("Center the QR in the frame. Move closer if needed; linking is automatic.");
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
