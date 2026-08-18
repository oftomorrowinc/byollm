import { fingerprintOf } from "./daemon-plane.js";
import type { RoutedJob } from "./state.js";
import type { RoutingStore } from "./store.js";

/**
 * The debug page — cloud_004 §10.
 *
 * It exists because watching a stub get claimed beats reading store rows, and
 * it earns its keep from the first routed job rather than being a thing
 * someone builds later when routing is already hard to follow.
 *
 * One screen, no build step, no dependencies. It renders from the relay's own
 * state, so it cannot show anything the relay does not actually know — which
 * makes it an honest demonstration of blindness as well as a debugging tool.
 * There is no view here that could show a prompt, because there is no prompt
 * to show.
 */

const escape = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

const STATE_COLOUR: Record<string, string> = {
  queued: "#8a8a8a",
  "awaiting-payload": "#c98a00",
  ready: "#0a7",
  running: "#06c",
  done: "#444",
};

function jobRow(job: RoutedJob, now: number): string {
  const claimed = job.claimedBy;
  const waiting =
    job.state === "awaiting-payload" && job.awaitingUntil !== undefined
      ? `${String(Math.max(0, job.awaitingUntil - now))}ms left`
      : "";
  return `<tr>
    <td><code>${escape(job.id)}</code></td>
    <td>${escape(job.stub.kind)}</td>
    <td>${escape(job.stub.owner)}</td>
    <td>${escape(job.stub.audience)}</td>
    <td>${escape(job.stub.sizeClass)}</td>
    <td>${job.stub.streaming ? "yes" : "no"}</td>
    <td><b style="color:${STATE_COLOUR[job.state] ?? "#000"}">${escape(job.state)}</b> <span class="dim">${escape(waiting)}</span></td>
    <td>${claimed ? `<code>${escape(fingerprintOf(claimed.device))}</code>` : "<span class='dim'>—</span>"}</td>
    <td>${job.payload ? "sealed" : "<span class='dim'>—</span>"}</td>
    <td>${job.result ? escape(job.disposition ?? "?") : "<span class='dim'>—</span>"}</td>
  </tr>`;
}

export async function debugPage(
  state: RoutingStore,
  now: number,
  /**
   * Asked whether each device's owner still consents — cloud_008 §2.3.
   *
   * The page used to read a `revoked` boolean off presence. That flag was a
   * stored copy of a fact the projection owns, and it is gone; the page asks
   * the authority instead, which is also the only thing that stays correct
   * when one daemon serves several sites.
   */
  routesFor?: { siteId: string; consents: (owner: string) => boolean },
): Promise<string> {
  const jobs = await state.jobs();
  const devices = await state.everyone();

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>byollm relay — debug</title>
<meta http-equiv="refresh" content="1">
<style>
 body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:24px;color:#111;background:#fff}
 h1{font-size:15px;margin:0 0 4px} h2{font-size:13px;margin:24px 0 6px}
 table{border-collapse:collapse;width:100%;margin-top:4px}
 th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top}
 th{font-weight:600;color:#666;border-bottom:1px solid #ccc}
 code{background:#f5f5f5;padding:1px 4px;border-radius:3px}
 .dim{color:#aaa} .note{color:#666;max-width:70ch;margin:8px 0 0}
 @media(prefers-color-scheme:dark){
  body{background:#111;color:#eee} th{color:#999;border-color:#333}
  td{border-color:#222} code{background:#1c1c1c} .note{color:#999}
 }
</style></head><body>
<h1>byollm relay — debug</h1>
<p class="note">Everything this relay knows, which is everything on this page.
There is no prompt or result text here because it holds none: payloads and
results are sealed to their endpoints and pass through as ciphertext.</p>

<h2>Routed jobs (${String(jobs.length)})</h2>
<table>
<tr><th>job</th><th>kind</th><th>owner</th><th>audience</th><th>size</th>
    <th>stream</th><th>state</th><th>claimed by</th><th>payload</th><th>result</th></tr>
${jobs.length ? jobs.map((j) => jobRow(j, now)).join("\n") : `<tr><td colspan="10" class="dim">nothing routed yet</td></tr>`}
</table>

<h2>Presence (${String(devices.length)})</h2>
<table>
<tr><th>runner</th><th>owner</th><th>fingerprint</th><th>last seen</th><th>routing</th></tr>
${
  devices.length
    ? devices
        .map(
          (d) => `<tr>
  <td><code>${escape(d.runnerId)}</code></td>
  <td>${escape(d.owner)}</td>
  <td><code>${escape(fingerprintOf(d.device))}</code></td>
  <td>${String(Math.max(0, now - d.lastSeenAt))}ms ago</td>
  <td>${
    routesFor && !routesFor.consents(d.owner)
      ? "<b style='color:#c00'>no consent</b>"
      : "active"
  }</td>
</tr>`,
        )
        .join("\n")
    : `<tr><td colspan="5" class="dim">no devices connected</td></tr>`
}
</table>
</body></html>`;
}
