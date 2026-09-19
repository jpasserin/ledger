/**
 * backend.js — the only file in this app that touches the network.
 *
 * It talks to ONE url: the Apps Script /exec you paste in yourself. There is
 * no analytics, no CDN, no telemetry, nothing else. If this file is not
 * loaded the rest of the app is exactly as offline as it was before.
 *
 * The script runs as YOU on Google's side, so it opens your spreadsheet with
 * your own permission and this code never sees a Google credential. The token
 * is the only thing between the url and your data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerBackend = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {

  /* Apps Script answers a cross-origin POST only for simple content types, so
     the body goes as text/plain and the script parses it. A JSON content type
     triggers a preflight that /exec does not answer. */
  async function call(cfg, action, extra) {
    if (!cfg || !cfg.url) throw new Error('No backend url set.');
    const body = Object.assign({ token: cfg.token || '', action }, extra || {});
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('Backend said ' + res.status + '.');
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); }
    catch (e) {
      /* Almost always the deployment's access setting: Google serves a login
         page instead of the script, and a login page is not JSON. */
      throw new Error('That url did not return JSON. Check the deployment is '
        + 'set to "anyone with the link".');
    }
    if (!j.ok) throw new Error(j.error || 'Backend refused.');
    return j;
  }

  const ping = (cfg) => call(cfg, 'ping');
  const pull = (cfg) => call(cfg, 'pull');
  const push = (cfg, dataset) => call(cfg, 'push', {
    snapshot: dataset,
    tabs: tabsFor(dataset),
  });

  /* A human-readable mirror alongside the snapshot, so the spreadsheet is
     worth opening on its own rather than being one opaque blob. */
  function tabsFor(d) {
    return [
      { name: 'Entries',
        headers: ['Date', 'Account', 'Party', 'Amount', 'Currency', 'Tag', 'Type',
          'One off', 'Budget', 'Note', 'Id'],
        rows: d.ledger.map((r) => [r.date, r.account, r.party, r.amount, r.currency,
          r.group, r.type, r.oneoff ? 'yes' : '', r.budget || '', r.note || '', r.src]) },
      { name: 'Accounts',
        headers: ['Code', 'Key', 'Bank', 'Type', 'Subtype', 'Category', 'Currency',
          'Owners', 'Closed'],
        rows: d.accounts.map((a) => [a.code, a.key || a.code, a.bank || '', a.type,
          a.subtype || '', a.category, a.currency, (a.owners || []).join(' '),
          a.closed ? 'yes' : '']) },
      { name: 'People',
        headers: ['Code', 'Name', 'Kind'],
        rows: Object.keys(d.owners || {}).map((o) => [o, d.owners[o], (d.ownerKind || {})[o] || 'parent']) },
    ];
  }

  return { call, ping, pull, push, tabsFor };
}));
