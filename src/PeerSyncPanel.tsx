import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { PairingScanner } from "./PairingScanner.tsx";
import type { PeerSyncManager } from "./peerSyncManager.ts";

const PENDING_INVITE = "rolling-ppl-pending-invitation";
export function PeerSyncPanel({ manager }: { manager: PeerSyncManager }) {
  const state = useSyncExternalStore(manager.subscribeView, manager.getView);
  const [initialInvite] = useState(() => {
    const fragment = new URLSearchParams(location.hash.slice(1)).get("pair");
    try { return fragment ?? sessionStorage.getItem(PENDING_INVITE) ?? ""; } catch { return fragment ?? ""; }
  });
  const [open, setOpen] = useState(Boolean(initialInvite));
  const [dismissedRequest, setDismissedRequest] = useState("");
  const [joinText, setJoinText] = useState(initialInvite);
  const [name, setName] = useState(state.name);
  const [qr, setQr] = useState({ link: "", image: "" });
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(Boolean(initialInvite));
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const inviteLink = state.invite ? `${location.origin}${location.pathname}#pair=${state.invite}` : "";
  const needsAttention = state.conflicts.length > 0 || Boolean(state.request) || Boolean(state.error);
  const showDialog = open || Boolean(state.request && state.request.id !== dismissedRequest);
  const close = () => { setScanning(false); manager.cancelInvite(); setOpen(false); setDismissedRequest(state.request?.id ?? ""); };

  useEffect(() => {
    if (initialInvite) {
      // Keep the invitation across an app update/reload until the user joins.
      try { sessionStorage.setItem(PENDING_INVITE, initialInvite); } catch { /* The pasted link remains usable. */ }
      // Remove the secret from the address bar immediately. A deliberate tap is
      // still required before contacting the inviting browser.
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }, [initialInvite]);
  useEffect(() => {
    const receiveLink = () => {
      const invitation = new URLSearchParams(location.hash.slice(1)).get("pair");
      if (!invitation) return;
      try { sessionStorage.setItem(PENDING_INVITE, invitation); } catch { /* The link stays in the form. */ }
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      setJoinText(invitation); setManual(true); setOpen(true);
    };
    window.addEventListener("hashchange", receiveLink);
    return () => window.removeEventListener("hashchange", receiveLink);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (showDialog && element && !element.open) element.showModal();
    if (!showDialog && element?.open) element.close();
  }, [showDialog]);
  useEffect(() => {
    let cancelled = false;
    if (!inviteLink) return;
    void QRCode.toDataURL(inviteLink, { scale: 6, margin: 4, errorCorrectionLevel: "M" })
      .then((value) => { if (!cancelled) setQr({ link: inviteLink, image: value }); })
      .catch(() => { if (!cancelled) setMessage("The QR code could not be created. Copy the pairing link instead."); });
    return () => { cancelled = true; };
  }, [inviteLink]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  };
  const remove = (id: string, deviceName: string) => {
    if (window.confirm(`Remove ${deviceName} from your synced devices? Its existing workout copy will remain. Other paired browsers will learn about the removal when they connect.`)) void run(() => manager.remove(id));
  };
  const join = async (invitation: string) => {
    await manager.join(invitation);
    try { sessionStorage.removeItem(PENDING_INVITE); } catch { /* Invitation expiry still applies. */ }
  };
  return <>
    <button className={`utility-button peer-sync-button ${needsAttention ? "attention" : ""}`} type="button" aria-label="Sync devices" onClick={() => setOpen(true)}>
      Devices{state.conflicts.length > 0 && <b>{state.conflicts.length}</b>}{state.request && <b>!</b>}
    </button>
    <dialog ref={dialog} className="peer-dialog" aria-labelledby="peer-sync-title" onCancel={close} onClose={close}>
      <div className={`peer-panel${scanning ? " peer-scanning" : ""}`}>
        <button className="peer-close secondary-action" type="button" aria-label="Close device sync" onClick={close}>Close ×</button>
        {!scanning && <span className="eyebrow">Your browsers, connected</span>}<h2 id="peer-sync-title">{scanning ? "Scan QR code" : "Device sync"}</h2>
        {scanning ? <PairingScanner onCancel={() => setScanning(false)} onScan={(invitation) => { setScanning(false); void run(() => join(invitation)); }} /> : <>
        <p>Show a QR on one device and scan it here to link automatically. Keep both pages open to sync.</p>
        <div className="peer-status" data-testid="peer-sync-status" role="status">
          <strong>{state.enabled ? (state.devices.some((device) => device.connected) ? "Connected to your devices" : "Waiting for a paired browser") : "Saved in this browser"}</strong>
          <span>{state.status}</span>
          {state.error && <span className="form-error">{state.error}</span>}
          {message && <span>{message}</span>}
        </div>
        {state.request && <section className="peer-request"><h3>Pair with {state.request.name}?</h3><p>Approve only if this is the browser where you just opened your pairing link.</p>
          <button className="primary-action" type="button" disabled={busy} onClick={() => { setOpen(true); void run(() => manager.approve(state.request!.id)); }}>Approve pairing</button>
          <button className="secondary-action" type="button" onClick={() => manager.reject(state.request!.id)}>Decline</button>
        </section>}
        <div className="peer-actions">
          <button className="primary-action" type="button" disabled={busy || scanning} onClick={() => { manager.cancelInvite(); setMessage(""); setScanning(true); }}>Scan QR code</button>
          <button className="secondary-action" type="button" disabled={busy} onClick={() => { setScanning(false); void run(async () => { await manager.createInvite(); if (!dialog.current?.open) manager.cancelInvite(); }); }}>Show my QR</button>
        </div>
        <div className="peer-actions peer-connection-actions">
          {state.enabled ? <><button className="secondary-action" type="button" disabled={busy} onClick={() => manager.reconnect()}>Sync now</button><button className="text-action" type="button" disabled={busy} onClick={() => void run(() => manager.pause())}>Pause sync</button></>
            : state.devices.length > 0 && <button className="secondary-action" type="button" disabled={busy} onClick={() => void run(() => manager.enable())}>Resume sync</button>}
        </div>
        {inviteLink && <section className="peer-invite"><h3>Scan from your other device</h3>
          {qr.link === inviteLink && qr.image && <img src={qr.image} width="320" height="320" alt="QR code for pairing this browser" />}
          <p>Open Devices → Scan QR code on your other device. Anyone with this code can link automatically, once, within five minutes.</p>
          <button className="text-action" type="button" onClick={() => manager.cancelInvite()}>Cancel code</button>
          <details><summary>Copy a link instead</summary>
          <label><span>Or copy the pairing link</span><input aria-label="Pairing link" readOnly value={inviteLink} onFocus={(event) => event.target.select()} /></label>
          <button className="secondary-action" type="button" onClick={() => void run(async () => { await navigator.clipboard.writeText(inviteLink); setMessage("Pairing link copied."); })}>Copy pairing link</button>
          </details>
        </section>}
        <details className="peer-manual" open={manual} onToggle={(event) => setManual(event.currentTarget.open)}><summary>Use a pairing link instead</summary>
        <form className="peer-join" onSubmit={(event) => { event.preventDefault(); void run(() => join(joinText)); }}>
          <label><span>Have a pairing link?</span><textarea aria-label="Pairing link or code" rows={2} value={joinText} onChange={(event) => setJoinText(event.target.value)} placeholder="Paste the link from your other browser" autoComplete="off" spellCheck={false} /></label>
          <button className="secondary-action" type="submit" disabled={busy || !joinText.trim()}>Pair this browser</button>
        </form>
        </details>
        <section className="peer-devices"><h3>Paired devices <span>{state.devices.length}</span></h3>
          {state.devices.length === 0 && <p>No paired browsers yet. Add your phone or laptop above.</p>}
          {state.devices.map((device) => <article key={device.id} data-testid="paired-device"><div><strong>{device.name}</strong><span>{device.connected ? device.current ? "Up to date" : "Exchanging changes…" : "Not connected"}</span><small>{device.lastSyncedAt ? `Last synced ${new Date(device.lastSyncedAt).toLocaleString()}` : "Waiting for first sync"}</small></div><button className="text-action" aria-label="Remove device" type="button" disabled={busy} onClick={() => remove(device.id, device.name)}>Remove</button></article>)}
        </section>
        <form className="peer-name" onSubmit={(event) => { event.preventDefault(); void run(() => manager.rename(name)); }}>
          <label><span>This browser</span><input aria-label="This browser name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
          <button className="secondary-action" type="submit" disabled={busy || !name.trim() || name.trim() === state.name}>Save name</button>
        </form>
        {state.conflicts.length > 0 && <section className="peer-conflicts"><h3>Changes to review</h3><p>Both browsers changed the same field independently. Both values are preserved. Choose the correct one to share it with your devices.</p>
          {state.conflicts.map((conflict) => <article key={conflict.key} data-testid="sync-conflict"><strong>{conflict.label}</strong><div>{conflict.options.map((option) => <button className="secondary-action" type="button" key={option.id} onClick={() => manager.resolve(conflict.key, option.id)}>Use {option.value || "empty value"}</button>)}</div></article>)}
        </section>}
        <details className="peer-details"><summary>How device sync works</summary><p>Only explicitly paired browsers can exchange workout history, active workouts, entered sets, notes, and your next workout. Autumn passwords and API tokens stay in their own browser.</p><p>Connection setup uses PeerJS Cloud and STUN. Workout transfers are encrypted between your browsers. Some restricted or mobile networks cannot establish a direct connection; try opening both pages on the same Wi-Fi.</p><p>Pair each browser with at least one of your devices. Changes can travel through a paired device when they connect at different times. A device cannot receive new data while all browsers with those changes are closed.</p><p>Removing a device stops future sync after the removal reaches each paired browser. It cannot erase copies already received. Export backups remain available under Data.</p><p>If this browser was removed while offline, reset its pairing before adding it again. Workouts are kept.</p><button className="secondary-action" type="button" disabled={busy} onClick={() => { if (window.confirm("Reset this browser's pairing identity? Your workouts stay here, but you will need to pair your devices again.")) void run(() => manager.resetPairing()); }}>Reset browser pairing</button></details>
        </>}
      </div>
    </dialog>
  </>;
}
