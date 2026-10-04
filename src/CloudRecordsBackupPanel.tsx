import { useState, useSyncExternalStore } from "react";
import {
  backupCloudRecordsNow, enableCloudRecordsBackup, fetchCloudRecordsCopy, getCloudRecordsBackupState, listCloudRecordsCopies,
  pauseCloudRecordsBackup, restoreCloudRecords, signInToRestoreCloudRecords, subscribeCloudRecordsBackup, type CloudRecordsDevice,
} from "./cloudRecordsBackup";
import { useCloudPhotoBackup } from "./CloudPhotoBackupPanel";
import { describeBackup, type ReadyBackup } from "./completeBackup";
import "./cloudPhotoBackup.css";

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function CloudRecordsBackupPanel({ mode }: { mode: "backup" | "restore" }) {
  const account = useCloudPhotoBackup();
  const state = useSyncExternalStore(subscribeCloudRecordsBackup, getCloudRecordsBackupState, getCloudRecordsBackupState);
  if (!account.ready) return null;
  if (mode === "restore") return account.available ? <CloudRecordsRestore signedIn={account.signedIn} device={state.device} /> : null;
  return <section className="cloud-photo-backup cloud-records-backup" aria-labelledby="cloud-records-title">
    <div className="cloud-photo-heading"><div><h3 id="cloud-records-title">Cloud backup</h3><p>Workouts, food log, body records and plans, saved automatically to your private account.</p></div>
      <span className="cloud-photo-state">{!account.available ? "Unavailable" : state.busy ? "Backing up…" : state.enabled ? "On" : "Off"}</span>
    </div>
    {!account.available ? <p>Not available yet. Download a backup file instead.</p>
      : !account.signedIn ? <><p>Uses the same private account as photo backup. Photos are not included here.</p><button type="button" className="primary-action" onClick={() => void enableCloudRecordsBackup()}>Turn on &amp; sign in</button></>
      : !state.enabled ? <><p>Signed in{account.email ? ` as ${account.email}` : ""}. Automatic backup is off for this browser.</p><button type="button" className="primary-action" onClick={() => void enableCloudRecordsBackup()}>Turn on automatic backup</button></>
      : <>
        <p className="cloud-photo-counts">{state.last ? `Last backed up ${when(state.last.savedAt)} · ${plural(state.last.workouts, "workout")} · ${plural(state.last.foodDays, "food day")}` : "Not backed up from this browser yet."}</p>
        <p>Saves about 30 seconds after a change and when you leave the app. Each browser keeps its own copy, and one copy per day is kept for 90 days.</p>
        <div className="cloud-photo-actions">
          <button type="button" onClick={() => void backupCloudRecordsNow(true)} disabled={state.busy}>Back up now</button>
          <button type="button" className="text-action" onClick={pauseCloudRecordsBackup}>Pause</button>
        </div>
      </>}
    {state.status && !state.error && <p role="status">{state.status}</p>}
    {state.error && <p className="photo-progress-error" role="alert">{state.error}</p>}
  </section>;
}

function CloudRecordsRestore({ signedIn, device }: { signedIn: boolean; device: string }) {
  const [devices, setDevices] = useState<CloudRecordsDevice[] | null>(null);
  const [copies, setCopies] = useState<Record<string, string>>({});
  const [ready, setReady] = useState<ReadyBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function run(message: string, work: () => Promise<void>) {
    setBusy(true); setNotice(message);
    try { await work(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Cloud backup could not connect. Nothing has changed."); }
    finally { setBusy(false); }
  }
  const load = () => run("Loading cloud copies…", async () => {
    setReady(null);
    const list = await listCloudRecordsCopies();
    setDevices(list);
    setNotice(list.length ? "" : "No cloud records copies yet. Turn on cloud backup on a browser that has your records.");
  });
  const check = (item: CloudRecordsDevice) => run("Checking the cloud copy…", async () => {
    setReady(await fetchCloudRecordsCopy(item.device, copies[item.device] ?? "latest"));
    setNotice("Cloud copy checked. Review its contents before restoring.");
  });
  const restore = (backup: ReadyBackup) => run("Restoring the cloud copy. Keep this page open…", async () => {
    await restoreCloudRecords(backup);
    setReady(null);
    setNotice("Cloud copy restored. Existing unrelated records were kept.");
  });
  return <section className="cloud-photo-backup cloud-records-backup" aria-labelledby="cloud-records-restore-title">
    <div className="cloud-photo-heading"><div><h3 id="cloud-records-restore-title">Restore from cloud</h3><p>Merge a cloud copy of workouts, food log, body records and plans into this browser.</p></div></div>
    {!signedIn ? <><p>Sign in to the account you used for cloud backup.</p><button type="button" className="primary-action" onClick={() => void signInToRestoreCloudRecords()}>Sign in</button></>
      : !devices ? <button type="button" disabled={busy} onClick={() => void load()}>Show cloud copies</button>
      : <>
        {devices.map((item) => <div className="cloud-records-device" key={item.device}>
          <strong>{item.name || "Browser"}{item.device === device ? " · this browser" : ""}</strong>
          <p>Latest {when(item.savedAt)} · {plural(item.workouts, "workout")} · {plural(item.foodDays, "food day")} · {plural(item.weighIns, "weigh-in")}</p>
          <label className="transfer-format">Copy<select value={copies[item.device] ?? "latest"} disabled={busy} onChange={(event) => { setCopies({ ...copies, [item.device]: event.target.value }); setReady(null); }}>
            <option value="latest">Latest · {when(item.savedAt)}</option>
            {item.copies.map((copy) => <option key={copy.date} value={copy.date}>{copy.date} · last save that day</option>)}
          </select></label>
          <button type="button" disabled={busy} onClick={() => void check(item)}>Check this copy</button>
        </div>)}
        <button type="button" className="text-action" disabled={busy} onClick={() => void load()}>Refresh list</button>
      </>}
    {ready && <div className="backup-preview">
      <strong>Ready to restore</strong>
      <p>{describeBackup(ready)}</p>
      <p>Matching workout IDs use the cloud copy. Body records and food days use their latest saved version. Nothing on this browser is deleted.</p>
      <button type="button" className="primary-action" disabled={busy} onClick={() => void restore(ready)}>Restore this copy</button>
      <button type="button" className="secondary-action" disabled={busy} onClick={() => { setReady(null); setNotice("Restore canceled."); }}>Cancel</button>
    </div>}
    {notice && <p role="status" className="backup-notice">{notice}</p>}
  </section>;
}
