import { useState } from "react";
import { exerciseImageSources } from "./exerciseLibrary";

export function ExerciseImages({ slug, label, onOpen }: { slug: string; label: string; onOpen?: (image: { src: string; alt: string }) => void }) {
  const [failed, setFailed] = useState<string[]>([]);
  const sources = exerciseImageSources(slug);
  return <div className="poses">{sources.map((src, index) => {
    const alt = `${label}: ${index ? "second" : "first"} position`;
    return <span className="exercise-pose" key={src}>{index > 0 && <span className="pose-arrow" aria-hidden="true">→</span>}{failed.includes(src) ? <span className="exercise-image-unavailable">Image unavailable. Connect to load it, then reopen the exercise.</span> : onOpen ? <button className="image-button" type="button" onClick={() => onOpen({ src, alt })} aria-label={`Enlarge ${alt}`}><img src={src} alt={alt} crossOrigin="anonymous" loading="lazy" onError={() => setFailed((previous) => [...previous, src])} /></button> : <img src={src} alt={alt} crossOrigin="anonymous" loading="lazy" onError={() => setFailed((previous) => [...previous, src])} />}</span>;
  })}</div>;
}
