/**
 * Code.gs — the spreadsheet backend for Ledger.
 *
 * DEPLOY: paste into Apps Script, set SHEET_ID below, Deploy > New deployment
 * > Web app > execute as ME, access ANYONE WITH THE LINK. Copy the /exec URL
 * into the app (Settings > Data > Backend) along with the TOKEN.
 *
 * It runs as YOU, so it opens the spreadsheet with your own permission and
 * the app never sees a Google credential. The token is the only thing
 * standing between the URL and your data — make it long and random.
 *
 * DELIBERATELY GENERIC, the same way Anvil's is. The app sends tab names,
 * column headers and rows; this writes them. That means adding a field to
 * Ledger never requires redeploying the backend — which matters, because a
 * redeploy is a manual step you will forget.
 *
 * IT WRITES TO A NEW SPREADSHEET, NOT YOUR YEAR BOOKS. Point SHEET_ID at a
 * blank one. Nothing here reads or touches Book 2014..2026.
 */

var BACKEND_VERSION = 1;

/* ── configure ─────────────────────────────────────────────────────────── */
var SHEET_ID = 'PUT_A_NEW_EMPTY_SPREADSHEET_ID_HERE';
var TOKEN    = 'PUT_A_LONG_RANDOM_STRING_HERE';
/* ──────────────────────────────────────────────────────────────────────── */

function doGet(e)  { return handle(e, null); }
function doPost(e) {
  var body = null;
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = null; }
  return handle(e, body);
}

function handle(e, body) {
  var p = (e && e.parameter) || {};
  var token = (body && body.token) || p.token;
  if (token !== TOKEN) return json({ ok: false, error: 'bad token' });

  var action = (body && body.action) || p.action || 'ping';
  try {
    if (action === 'ping')     return json({ ok: true, backend: BACKEND_VERSION });
    if (action === 'pull')     return json({ ok: true, backend: BACKEND_VERSION, data: pull() });
    if (action === 'push')     return json({ ok: true, backend: BACKEND_VERSION, wrote: push(body) });
    return json({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function book() { return SpreadsheetApp.openById(SHEET_ID); }

/* Every tab, as {name, headers, rows}. The app decides what any of it means;
   this only moves it. */
function pull() {
  var ss = book(), out = {};
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i], name = sh.getName();
    if (name.charAt(0) === '_') continue;          // _Snapshot and friends
    var values = sh.getDataRange().getValues();
    if (!values.length) { out[name] = { headers: [], rows: [] }; continue; }
    out[name] = { headers: values[0].map(String), rows: values.slice(1) };
  }
  var snap = ss.getSheetByName('_Snapshot');
  if (snap) {
    /* A chunked JSON blob, because a cell caps at 50k characters and the
       dataset is megabytes. Column A, one chunk per row, in order. */
    var cells = snap.getRange(1, 1, Math.max(1, snap.getLastRow()), 1).getValues();
    var text = '';
    for (var j = 0; j < cells.length; j++) text += cells[j][0];
    if (text) { try { out._snapshot = JSON.parse(text); } catch (err) {} }
  }
  return out;
}

/* body.tabs = [{name, headers, rows}], body.snapshot = any JSON. */
function push(body) {
  var ss = book(), wrote = [];
  var tabs = (body && body.tabs) || [];
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    if (!t || !t.name) continue;
    var sh = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
    sh.clear();
    var rows = [t.headers || []].concat(t.rows || []);
    if (rows.length && rows[0].length) {
      var w = 0;
      for (var r = 0; r < rows.length; r++) w = Math.max(w, rows[r].length);
      for (var r2 = 0; r2 < rows.length; r2++) {
        while (rows[r2].length < w) rows[r2].push('');
      }
      sh.getRange(1, 1, rows.length, w).setValues(rows);
      sh.setFrozenRows(1);
    }
    wrote.push(t.name + ':' + ((t.rows || []).length));
  }

  if (body && body.snapshot !== undefined) {
    var snap = ss.getSheetByName('_Snapshot') || ss.insertSheet('_Snapshot');
    snap.clear();
    var text = JSON.stringify(body.snapshot);
    var CHUNK = 40000;                              // under the 50k cell cap
    var out = [];
    for (var k = 0; k < text.length; k += CHUNK) out.push([text.substr(k, CHUNK)]);
    if (!out.length) out = [['']];
    snap.getRange(1, 1, out.length, 1).setValues(out);
    snap.hideSheet();
    wrote.push('_Snapshot:' + out.length + ' chunks');
  }
  return wrote;
}
