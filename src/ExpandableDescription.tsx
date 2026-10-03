import { useId, useState } from "react";

const PREVIEW_LENGTH = 280;

export function ExpandableDescription({ text, className = "" }: { text: string; className?: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const description = text.trim();
  if (!description) return null;
  const long = description.length > PREVIEW_LENGTH + 40;
  const opening = description.slice(0, PREVIEW_LENGTH);
  const shortened = `${opening.slice(0, opening.lastIndexOf(" ") > 0 ? opening.lastIndexOf(" ") : opening.length).trimEnd()}…`;
  return <div className={`exercise-description ${className}`}>
    <p className="exercise-description-text" id={id}>{long && !expanded ? shortened : description}</p>
    {long && <button className="text-action exercise-description-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}
  </div>;
}
