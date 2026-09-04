import jsQR from "jsqr";

export type QrDetector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = { new(options: { formats: string[] }): QrDetector; getSupportedFormats(): Promise<string[]> };

export async function nativeQrDetector(): Promise<QrDetector | undefined> {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
  try { if (Detector && (await Detector.getSupportedFormats()).includes("qr_code")) return new Detector({ formats: ["qr_code"] }); }
  catch { /* Pixel decoding remains available when the native API is absent. */ }
}

export function qrFrameRegion(width: number, height: number, centered: boolean) {
  const side = Math.min(width, height);
  const sourceWidth = centered ? side : width, sourceHeight = centered ? side : height;
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  return { x: centered ? (width - side) / 2 : 0, y: centered ? (height - side) / 2 : 0,
    width: sourceWidth, height: sourceHeight, outputWidth: Math.round(sourceWidth * scale), outputHeight: Math.round(sourceHeight * scale) };
}

export async function readQrFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, detector?: QrDetector) {
  // Match the square preview first, retaining portrait-camera detail. Try the
  // whole frame as well so a code outside the guide can still be recognized.
  for (const centered of [true, false]) {
    const r = qrFrameRegion(video.videoWidth, video.videoHeight, centered);
    canvas.width = r.outputWidth; canvas.height = r.outputHeight;
    context.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
    if (detector) {
      try { const codes = await detector.detect(canvas); if (codes[0]?.rawValue) return codes[0].rawValue; }
      catch { /* Native detection can fail on a frame; keep the pixel fallback. */ }
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
    if (code?.data) return code.data;
    if (video.videoWidth === video.videoHeight) break;
  }
}
