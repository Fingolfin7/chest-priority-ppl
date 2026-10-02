import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { HistoryMap } from "./historyMigration";
import type { CompletedWorkout } from "./sessionModel";
import type { PeerSyncManager } from "./peerSyncManager";
import { FullBackup } from "./FullBackup";
import { createBackupFile, createBackupText, downloadBackup, shareableBackup, type ExportFormat } from "./transfer";

const destinations = {
  drive: { label: "Google Drive", mark: "G", importHint: "Choose Google Drive in your file picker. If it is missing, save your backup to this device from the Drive app first." },
  onedrive: { label: "OneDrive", mark: "O", importHint: "Choose OneDrive in your file picker. If it is missing, save your backup to this device from the OneDrive app first." },
  whatsapp: { label: "WhatsApp", mark: "W", importHint: "Save the backup attachment from your WhatsApp chat, then choose it here." },
  chatgpt: { label: "ChatGPT", mark: "C", importHint: "Save a Rolling PPL JSON or CSV backup from your ChatGPT conversation to this device, then choose it here. You can also paste the backup contents." },
} as const;
type Destination = keyof typeof destinations;
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type DataPanel = "backup" | "workouts" | "restore";

export function DataMenu({ history, workouts, onImport, manager }: {
  history: HistoryMap;
  workouts: CompletedWorkout[];
  onImport: (text: string) => string;
  manager?: PeerSyncManager;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<DataPanel>(manager ? "backup" : "workouts");
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

  useEffect(() => {
    if (root.current?.open && panel !== "backup") heading.current?.focus();
  }, [panel, destination]);

  const choose = (value: Destination | "paste" | null) => {
    setDestination(value);
    setNotice(null);
    setCopyFallback("");
  };
  const selectPanel = (value: DataPanel) => {
    setPanel(value);
    choose(null);
  };
  const download = () => {
    try {
      const file = createBackupFile(history, workouts, format);
      downloadBackup(file);
      setNotice({ kind: "info", message: `Download started: ${file.name}` });
    } catch { setNotice({ kind: "error", message: "The download could not start. Try copying the backup instead." }); }
  };
  const share = async (target?: Destination) => {
    const app = target ? destinations[target].label : "an app";
    setNotice({ kind: "info", message: `Choose ${app} in the share sheet.` });
    setBusy(true);
    setCopyFallback("");
    try {
      const file = createBackupFile(history, workouts, format);
      const shareFile = typeof navigator.share === "function" && typeof navigator.canShare === "function" ? shareableBackup(file, (data) => navigator.canShare(data)) : null;
      if (!shareFile) {
        setNotice({ kind: "info", message: "This browser cannot share backup files with installed apps. Use Download or Copy to clipboard, then attach or paste the backup in the app." });
        return;
      }
      await navigator.share({ files: [shareFile], title: "Rolling PPL workout history" });
      setNotice({ kind: "info", message: `Choose ${app} in the share sheet to complete the transfer. If it is missing, use Download or Copy to clipboard and attach or paste the backup in the app.` });
    } catch (error) {
      setNotice({ kind: "info", message: error instanceof Error && error.name === "AbortError"
        ? "Sharing canceled or no app available. You can try again or download the backup."
        : "Sharing could not finish. Try again, or download and attach the backup." });
    } finally { setBusy(false); }
  };
  const copy = async () => {
    setBusy(true);
    setNotice(null);
    setCopyFallback("");
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
    setBusy(true);
    setNotice(null);
    try { restore(await file.text()); }
    catch { setNotice({ kind: "error", message: "The file could not be read. Download it to this device and try again." }); }
    finally { element.value = ""; setBusy(false); }
  };

  return <details className="export-menu" ref={root}>
    <summary aria-label="Back up, export, or restore data">Data</summary>
    <div className="export-panel" aria-label="Data and backups">
      <div className="data-menu-tabs" role="group" aria-label="Data actions">
        {manager && <button id="data-tab-backup" type="button" aria-pressed={panel === "backup"} aria-controls="data-complete-backup" onClick={() => selectPanel("backup")}>Backup</button>}
        <button id="data-tab-workouts" type="button" aria-pressed={panel === "workouts"} aria-controls="data-panel-workouts" onClick={() => selectPanel("workouts")}>Workout export</button>
        <button id="data-tab-restore" type="button" aria-pressed={panel === "restore"} aria-controls="data-panel-restore" onClick={() => selectPanel("restore")}>Restore</button>
      </div>
        {manager && <div id="data-complete-backup" role="region" aria-label={panel === "restore" ? "Restore complete backup" : "Complete backup"} hidden={panel === "workouts"}><FullBackup manager={manager} embedded mode={panel === "restore" ? "restore" : "backup"} /></div>}

      {panel === "workouts" && <section id="data-panel-workouts" aria-labelledby="data-tab-workouts" className="data-workout-panel">
        <h2 ref={heading} tabIndex={-1}>Workout export</h2>
        <p>Share workout history or download a spreadsheet. Workout exports do not include body records or photos.</p>
        <label className="transfer-format">File format<select value={format} disabled={busy} onChange={(event) => { setFormat(event.target.value as ExportFormat); setNotice(null); setCopyFallback(""); }}>
          <option value="json">JSON · workout history</option><option value="csv">CSV · spreadsheet</option>
        </select></label>
        {!hasHistory && <p>Save a workout to export your history.</p>}
        <p>App options open your device’s share sheet. Select the installed app there.</p>
        <button type="button" disabled={!hasHistory || busy} onClick={download}>Download <small>Save to device</small></button>
        {Object.entries(destinations).map(([key, item]) => <button className="transfer-destination" type="button" key={key} disabled={!hasHistory || busy} onClick={() => void share(key as Destination)}><span className={`destination-mark ${key}`} aria-hidden="true">{item.mark}</span><span>{item.label}</span><small>Share sheet</small></button>)}
        <div className="export-separator" />
        <button type="button" disabled={!hasHistory || busy} onClick={() => void copy()}>Copy to clipboard <small>Backup text</small></button>
        <button type="button" disabled={!hasHistory || busy} onClick={() => void share()}>More apps… <small>Email, AirDrop & more</small></button>
        {copyFallback && <label className="transfer-paste">Backup to copy<textarea readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
        {busy && <p role="status">Preparing export…</p>}
        {notice && panel === "workouts" && <p className={`import-result ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
      </section>}

      {panel === "restore" && <section id="data-panel-restore" aria-labelledby="data-tab-restore" className="data-workout-panel">
        <h2 ref={heading} tabIndex={-1}>Restore workout history</h2>
        <p>Import a Rolling PPL JSON or CSV backup. Matching records are updated; other history is kept.</p>
        {destination === "paste" ? <>
          <label className="transfer-paste">Backup contents<textarea value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste JSON or CSV here" spellCheck={false} /></label>
          <button type="button" disabled={!pasted.trim() || busy} onClick={() => restore(pasted)}>Import backup</button>
          <button className="transfer-back" type="button" disabled={busy} onClick={() => choose(null)}>‹ Choose another source</button>
        </> : selected ? <>
          <p>{selected.importHint}</p>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>Choose backup file</button>
          <button type="button" disabled={busy} onClick={() => choose("paste")}>Paste backup contents</button>
          <button className="transfer-back" type="button" disabled={busy} onClick={() => choose(null)}>‹ Choose another source</button>
        </> : <>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>This device <small>Choose file</small></button>
          {Object.entries(destinations).map(([key, item]) => <button className="transfer-destination" type="button" key={key} disabled={busy} onClick={() => choose(key as Destination)}><span className={`destination-mark ${key}`} aria-hidden="true">{item.mark}</span><span>{item.label}</span><small>Backup file</small></button>)}
          <div className="export-separator" />
          <button type="button" disabled={busy} onClick={() => choose("paste")}>Clipboard <small>Paste backup</small></button>
        </>}
        <input ref={input} className="file-input" type="file" tabIndex={-1} aria-label="Choose workout backup" accept=".json,.csv,.txt,application/json,text/csv,text/plain" onChange={readFile} />
        {busy && <p role="status">Reading backup…</p>}
        {notice && <p className={`import-result ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
      </section>}
    </div>
  </details>;
}
