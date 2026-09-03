import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { HistoryMap } from "./historyMigration";
import type { CompletedWorkout } from "./sessionModel";
import { createBackupFile, createBackupText, downloadBackup, shareableBackup, type ExportFormat } from "./transfer";

const destinations = {
  drive: { label: "Google Drive", mark: "G", url: "https://drive.google.com/", exportHint: "Upload the downloaded backup to your Drive.", importHint: "Choose Google Drive in your file picker. If it is missing, download your backup from Drive first." },
  onedrive: { label: "OneDrive", mark: "O", url: "https://onedrive.live.com/", exportHint: "Upload the downloaded backup to OneDrive.", importHint: "Choose OneDrive in your file picker. If it is missing, download your backup from OneDrive first." },
  whatsapp: { label: "WhatsApp", mark: "W", url: "https://web.whatsapp.com/", exportHint: "Attach the downloaded backup as a document in a chat, or send it to yourself.", importHint: "Save the backup attachment from your WhatsApp chat, then choose it here." },
  chatgpt: { label: "ChatGPT", mark: "C", url: "https://chatgpt.com/", exportHint: "Attach the downloaded backup to a ChatGPT conversation, or copy its contents and paste them there.", importHint: "Download a Rolling PPL JSON or CSV backup from your conversation, then choose it here. You can also paste the backup contents." },
} as const;
type Destination = keyof typeof destinations;
type Notice = { kind: "success" | "error" | "info"; message: string } | null;

export function DataMenu({ history, workouts, onImport }: {
  history: HistoryMap;
  workouts: CompletedWorkout[];
  onImport: (text: string) => string;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"export" | "import">("export");
  const [destination, setDestination] = useState<Destination | "paste" | null>(null);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [copyFallback, setCopyFallback] = useState("");
  const hasHistory = workouts.length > 0 || Object.values(history).some((sessions) => sessions.length > 0);
  const selected = destination && destination !== "paste" ? destinations[destination] : null;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        root.current.open = false;
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);

  useEffect(() => { if (root.current?.open) heading.current?.focus(); }, [mode, destination]);

  const choose = (value: Destination | "paste" | null) => {
    setDestination(value); setNotice(null); setCopyFallback("");
  };
  const download = () => {
    try {
      const file = createBackupFile(history, workouts, format);
      downloadBackup(file);
      setNotice({ kind: "info", message: `Download started: ${file.name}${selected ? `. ${selected.exportHint}` : ""}` });
    } catch { setNotice({ kind: "error", message: "The download could not start. Try copying the backup instead." }); }
  };
  const share = async () => {
    setNotice(null); setBusy(true);
    try {
      const file = createBackupFile(history, workouts, format);
      const shareFile = typeof navigator.share === "function" && typeof navigator.canShare === "function" ? shareableBackup(file, (data) => navigator.canShare(data)) : null;
      if (!shareFile) {
        setNotice({ kind: "info", message: "File sharing is unavailable here. Download the backup, then upload or attach it in your chosen app." });
        return;
      }
      await navigator.share({ files: [shareFile], title: "Rolling PPL workout history" });
      setNotice({ kind: "info", message: "Share sheet opened. Complete the transfer in your chosen app." });
    } catch (error) {
      setNotice({ kind: "info", message: error instanceof Error && error.name === "AbortError"
        ? "Sharing canceled or no app available. You can try again or download the backup."
        : "Sharing could not finish. Try again, or download and attach the backup." });
    } finally { setBusy(false); }
  };
  const copy = async () => {
    setBusy(true); setNotice(null); setCopyFallback("");
    let text = "";
    try {
      text = createBackupText(history, workouts, format);
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "success", message: "Backup copied. Paste it into a message, note, or conversation." });
    } catch {
      setCopyFallback(text);
      setNotice(text ? { kind: "info", message: "Clipboard access is unavailable. Select and copy the backup below." }
        : { kind: "error", message: "The backup could not be prepared. Try downloading it instead." });
    } finally { setBusy(false); }
  };
  const restore = (text: string) => {
    try { setNotice({ kind: "success", message: onImport(text) }); setPasted(""); }
    catch (error) { setNotice({ kind: "error", message: error instanceof Error ? error.message : "This backup could not be imported." }); }
  };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const element = event.currentTarget;
    const file = element.files?.[0];
    if (!file) return;
    setBusy(true); setNotice(null);
    try { restore(await file.text()); }
    catch { setNotice({ kind: "error", message: "The file could not be read. Download it to this device and try again." }); }
    finally { element.value = ""; setBusy(false); }
  };

  return <details className="export-menu" ref={root}>
    <summary aria-label="Export or import workout history">Data</summary>
    <div className="export-panel" aria-label="Workout history transfers">
      <div className="transfer-modes">
        {(["export", "import"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); choose(null); }}>{value === "export" ? "Export to" : "Import from"}</button>)}
      </div>
      {destination && <button className="transfer-back" type="button" disabled={busy} onClick={() => choose(null)}>‹ All {mode === "export" ? "destinations" : "sources"}</button>}
      <h2 ref={heading} tabIndex={-1}>{selected?.label ?? (destination === "paste" ? "Paste a backup" : "Workout history")}</h2>
      {mode === "export" ? <>
        <label className="transfer-format">File format<select value={format} disabled={busy} onChange={(event) => { setFormat(event.target.value as ExportFormat); setNotice(null); setCopyFallback(""); }}>
          <option value="json">JSON · full backup</option><option value="csv">CSV · spreadsheet</option>
        </select></label>
        {!hasHistory && <p>Save a workout to export your history.</p>}
        {selected ? <>
          <p>Choose {selected.label} in your device’s share sheet, if available. Otherwise, download the file and open {selected.label}.</p>
          <p>{selected.exportHint}</p>
          <button type="button" disabled={!hasHistory || busy} onClick={share}>Choose {selected.label}… <small>Share sheet</small></button>
          <button type="button" disabled={!hasHistory || busy} onClick={download}>Download file <small>{format.toUpperCase()}</small></button>
          <a className="transfer-link" href={selected.url} target="_blank" rel="noopener noreferrer">Open {selected.label} <span aria-hidden="true">↗</span></a>
          {destination === "chatgpt" && <button type="button" disabled={!hasHistory || busy} onClick={copy}>Copy to clipboard</button>}
        </> : <>
          <button type="button" disabled={!hasHistory || busy} onClick={download}>Download <small>Save to device</small></button>
          {Object.entries(destinations).map(([key, item]) => <button className="transfer-destination" type="button" key={key} disabled={!hasHistory || busy} onClick={() => choose(key as Destination)}><span className={`destination-mark ${key}`} aria-hidden="true">{item.mark}</span><span>{item.label}</span><small>Share / file</small></button>)}
          <div className="export-separator" />
          <button type="button" disabled={!hasHistory || busy} onClick={copy}>Copy to clipboard <small>Backup text</small></button>
          <button type="button" disabled={!hasHistory || busy} onClick={share}>More apps… <small>Email, AirDrop & more</small></button>
        </>}
        {copyFallback && <label className="transfer-paste">Backup to copy<textarea readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
      </> : <>
        <p>Restore a Rolling PPL JSON or CSV backup. Matching records are updated; other history is kept.</p>
        {destination === "paste" ? <>
          <label className="transfer-paste">Backup contents<textarea value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste JSON or CSV here" spellCheck={false} /></label>
          <button type="button" disabled={!pasted.trim() || busy} onClick={() => restore(pasted)}>Import backup</button>
        </> : selected ? <>
          <p>{selected.importHint}</p>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>Choose backup file</button>
          <a className="transfer-link" href={selected.url} target="_blank" rel="noopener noreferrer">Open {selected.label} <span aria-hidden="true">↗</span></a>
          <button type="button" disabled={busy} onClick={() => choose("paste")}>Paste backup contents</button>
        </> : <>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>This device <small>Choose file</small></button>
          {Object.entries(destinations).map(([key, item]) => <button className="transfer-destination" type="button" key={key} disabled={busy} onClick={() => choose(key as Destination)}><span className={`destination-mark ${key}`} aria-hidden="true">{item.mark}</span><span>{item.label}</span><small>Backup file</small></button>)}
          <div className="export-separator" />
          <button type="button" disabled={busy} onClick={() => choose("paste")}>Clipboard <small>Paste backup</small></button>
        </>}
      </>}
      <input ref={input} className="file-input" type="file" tabIndex={-1} aria-label="Choose workout backup" accept=".json,.csv,.txt,application/json,text/csv,text/plain" onChange={readFile} />
      {busy && <p role="status">{mode === "import" ? "Reading backup…" : "Preparing export…"}</p>}
      {notice && <p className={`import-result ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
    </div>
  </details>;
}
