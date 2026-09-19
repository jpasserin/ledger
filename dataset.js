/**
 * dataset.js — where the app's data lives now.
 *
 * Until now the numbers were baked into a generated data.js and the app could
 * only read them. That file is thirteen years of your financial history and it
 * is never going near GitHub, so the shipped app starts EMPTY and fills up
 * from one of three places:
 *
 *   1. an import file you carry to the phone   (Settings > Data > Import)
 *   2. things you type in                      (accounts, entries, owners...)
 *   3. the spreadsheet backend, once connected
 *
 * Everything is kept in localStorage under one key. The shape is exactly the
 * shape build.js produced, so every screen written against the old baked data
 * keeps working without knowing anything changed.
 *
 * SAFETY: no network code in this file. The only way data leaves the phone is
 * an export you ask for.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerData = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {

  const KEY = 'ledger-dataset-v1';
  const FORMAT = 1;

  /* An empty dataset that every screen can render without special-casing. The
     arrays being present and empty is what stops "no data yet" turning into a
     hundred null checks scattered through the views. */
  function empty() {
    return {
      format: FORMAT,
      builtAt: new Date().toISOString(),
      lastEntry: null,
      realYears: [],
      syntheticYears: [],
      accounts: [],
      categories: [],
      taxonomyNotes: [], rareGroups: [], skipped: [],
      owners: {},
      ownerKind: {},          // code -> 'parent' | 'kid'
      accountTypes: {},
      fx: {},
      positions: [], properties: [], bills: [], options: [], sheetTotals: [],
      merchants: [],
      findings: [],
      ledger: [], synthetic: [],
      taxonomy: { parents: [], of: {}, labels: {} },
    };
  }

  /* Only rows whose date agrees with the book they were entered in. Thirteen
     years of records contain a handful of mistyped years - a December row
     dated next December - and letting one of those set "today" moves every
     headline a year into the future. build.js applies the same rule; this has
     to match it or importing would quietly undo it. */
  const honest = (rows) => rows.filter((r) => !r.rawMonth || r.rawMonth === r.month);
  const newest = (rows) => honest(rows).reduce((x, r) => (r.date > x ? r.date : x), '0000-00-00');

  /* A dataset from an older or partial file still has to render. Anything
     missing becomes the empty version of itself rather than undefined. */
  function normalise(d) {
    const base = empty();
    const out = Object.assign(base, d || {});
    for (const k of Object.keys(base)) {
      if (Array.isArray(base[k]) && !Array.isArray(out[k])) out[k] = [];
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        && (!out[k] || typeof out[k] !== 'object')) out[k] = {};
    }
    if (!out.taxonomy || typeof out.taxonomy !== 'object') out.taxonomy = { parents: [], of: {}, labels: {} };
    out.taxonomy.parents = Array.isArray(out.taxonomy.parents) ? out.taxonomy.parents : [];
    out.taxonomy.of = out.taxonomy.of || {};
    out.taxonomy.labels = out.taxonomy.labels || {};
    out.realYears = [...new Set(out.ledger.map((r) => r.docYear)
      .concat(out.realYears))].filter(Boolean).sort((a, b) => a - b);
    out.lastEntry = newest(out.ledger);
    if (out.lastEntry === '0000-00-00') out.lastEntry = null;
    return out;
  }

  /* WHY INDEXEDDB AND NOT localStorage.
     localStorage caps at about 5 MB per origin. A real export of thirteen
     years is 6.2 MB, so setItem threw QuotaExceededError and the import
     "succeeded" into a session that was never written down. IndexedDB has no
     such cap - it is bounded by disk, with a quota in the hundreds of MB.

     localStorage is still used for PREFERENCES, which are tiny. Only the
     dataset moved. */

  const DB = 'ledger', STORE = 'kv';

  function idb() {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('indexedDB refused to open'));
    });
  }
  function idbDo(mode, fn) {
    return idb().then((db) => new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('storage transaction aborted'));
    }));
  }

  let persistent = true;
  let lastError = null;

  /* Asynchronous, because IndexedDB is. The app boots on an empty dataset and
     swaps this in when it arrives - a tenth of a second on a phone, and the
     alternative is a blank screen while 6 MB is parsed. */
  async function loadAsync() {
    try {
      const got = await idbDo('readonly', (st) => st.get(KEY));
      if (got) return normalise(got);
    } catch (e) { lastError = e.message; }
    /* Anything written before the move, or a dataset small enough that an
       older version fitted it in localStorage. Migrated on first save. */
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return normalise(JSON.parse(raw));
    } catch (e) { /* no localStorage either */ }
    return empty();
  }

  async function saveAsync(d) {
    try {
      await idbDo('readwrite', (st) => st.put(d, KEY));
      persistent = true; lastError = null;
      /* Once it is safely in IndexedDB, drop any legacy localStorage copy so
         the two cannot disagree. */
      try { localStorage.removeItem(KEY); } catch (e) {}
      return true;
    } catch (e) {
      persistent = false; lastError = e.message;
      return false;
    }
  }

  /* Kept for the preference store and for tests, which are synchronous. */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return empty();
      return normalise(JSON.parse(raw));
    } catch (e) { return empty(); }
  }
  function save(d) {
    /* Fire and forget: nothing in the UI can wait on a disk write, and
       saveAsync reports failure through canPersist(). */
    saveAsync(d);
    return true;
  }
  const canPersist = () => persistent;
  const storageError = () => lastError;

  const isEmpty = (d) => !d.ledger.length && !d.accounts.length
    && !d.positions.length && !d.properties.length;

  /* --------------------------------------------------------------- import --*/

  /* Accepts either a full export or the raw payload build.js writes. Refuses
     anything it cannot recognise rather than silently producing an empty app
     and letting you think the import worked. */
  function parseImport(text) {
    let j;
    try { j = JSON.parse(text); }
    catch (e) { throw new Error('That is not JSON. Pick the .json file the export produced.'); }
    const d = j && j.dataset ? j.dataset : j;
    if (!d || typeof d !== 'object') throw new Error('No dataset inside that file.');
    if (!Array.isArray(d.ledger) && !Array.isArray(d.accounts)) {
      throw new Error('That JSON has no accounts and no entries — it is not a Ledger export.');
    }
    return normalise(d);
  }

  function exportBlob(d) {
    return JSON.stringify({
      kind: 'ledger-export', format: FORMAT,
      exportedAt: new Date().toISOString(),
      counts: {
        entries: d.ledger.length, accounts: d.accounts.length,
        positions: d.positions.length, findings: d.findings.length,
      },
      dataset: d,
    });
  }

  /* ------------------------------------------------------------ mutations --

     Every one of these returns the dataset so a caller can chain, and none of
     them persist by themselves - the app saves once per interaction. Keeping
     the write explicit is what makes a half-finished edit discardable.      */

  const uid = (p) => p + Math.random().toString(36).slice(2, 9);

  /* A split. The entry keeps its total; `parts` names the OTHER tags and how
     much of the total is theirs, positive, in the entry's currency. The
     entry's own tag gets what is left - so the parts must come to less than
     the whole. Equal would leave the own tag with nothing, and that is a
     re-tag, not a split. Returns the cleaned list, or undefined for none. */
  function checkParts(amount, parts) {
    const list = (parts || []).map((p) => ({
      group: String(p.group || '').trim(),
      amount: Math.round(Math.abs(+p.amount || 0) * 100) / 100,
    }));
    if (!list.length) return undefined;
    for (const p of list) {
      if (!p.group) throw new Error('Every part needs a tag.');
      if (!(p.amount > 0)) throw new Error('Every part needs an amount.');
    }
    const sum = Math.round(list.reduce((t, p) => t + p.amount, 0) * 100);
    if (sum >= Math.round(Math.abs(+amount || 0) * 100)) {
      throw new Error('The parts must add up to less than the amount.');
    }
    return list;
  }

  function addEntry(d, e) {
    const month = String(e.date).slice(0, 7);
    d.ledger.push({
      date: e.date,
      month,
      rawMonth: month,
      docYear: +String(e.date).slice(0, 4),
      account: e.account,
      currency: e.currency,
      party: e.party || '',
      amount: Math.round((+e.amount || 0) * 100) / 100,
      solde: null,
      group: e.group || '(untagged)',
      rawGroup: e.group || '',
      type: e.type || 'spend',
      method: e.method || '',
      note: e.note || '',
      tag: e.tag || undefined,
      oneoff: e.oneoff || undefined,
      budget: e.budget || undefined,
      parts: checkParts(e.amount, e.parts),
      src: e.src || uid('m!'),
      manual: true,
    });
    return touch(d);
  }

  function updateEntry(d, src, patch) {
    const r = d.ledger.find((x) => x.src === src);
    if (!r) return d;
    /* Validate the split BEFORE touching the row, so a refused save leaves
       the entry exactly as it was. */
    const { parts, ...rest } = patch;
    if ('parts' in patch) {
      const ok = checkParts(patch.amount !== undefined ? patch.amount : r.amount, parts);
      if (ok) r.parts = ok; else delete r.parts;
    }
    Object.assign(r, rest);
    if (patch.date) {
      r.month = String(patch.date).slice(0, 7);
      r.rawMonth = r.month;
      r.docYear = +String(patch.date).slice(0, 4);
    }
    if (patch.amount !== undefined) r.amount = Math.round((+patch.amount || 0) * 100) / 100;
    return touch(d);
  }

  function deleteEntry(d, src) {
    const i = d.ledger.findIndex((x) => x.src === src);
    if (i >= 0) d.ledger.splice(i, 1);
    return touch(d);
  }

  function addAccount(d, a) {
    if (d.accounts.some((x) => x.code === a.code)) throw new Error(a.code + ' already exists.');
    d.accounts.push(Object.assign({
      code: a.code, key: a.key || a.code, bank: '', type: 'ledger', subtype: '',
      category: 'cash', currency: 'USD', owners: ['JE'], years: [], rows: 0,
      opening: {}, inWealth: true, inSheet: true, created: true,
    }, a));
    return touch(d);
  }

  function removeAccount(d, code) {
    const used = d.ledger.some((r) => r.account === code)
      || d.positions.some((p) => p.code === code)
      || d.properties.some((p) => p.code === code);
    if (used) throw new Error('That account has entries. Close it instead of deleting it.');
    d.accounts = d.accounts.filter((a) => a.code !== code);
    return touch(d);
  }

  /* Owners are people, and the app needs to know which of them are children -
     that is the whole basis of the Kids tab and of leaving their money out of
     your own total. */
  function setOwner(d, code, name, kind) {
    d.owners[code] = name;
    d.ownerKind[code] = kind === 'kid' ? 'kid' : 'parent';
    return touch(d);
  }

  function removeOwner(d, code) {
    const used = d.accounts.some((a) => (a.owners || []).includes(code));
    if (used) throw new Error('Some accounts still belong to them.');
    delete d.owners[code]; delete d.ownerKind[code];
    return touch(d);
  }

  const kidsOf = (d) => Object.keys(d.owners).filter((o) => d.ownerKind[o] === 'kid');

  /* --------------------------------------------------------- categories --

     A category ("parent") and the tags filed under it are DATA, kept here and
     exported with everything else. They used to be a shipped file with six
     layers of per-device override on top, which meant a new install started
     with someone else's Report-tab columns and every edit had to be reasoned
     about across seven sources. Now: one list, in the dataset, empty on a
     new install.

       parents  [{ id, label, cls }]   cls: income|tax|savings|essential|optional|other|transfer
       of       { tag -> parent id }
       labels   { tag -> display name }  the tag's KEY is what entries carry
                                          and never changes; only the label does
  */
  const tax = (d) => (d.taxonomy || (d.taxonomy = { parents: [], of: {}, labels: {} }));
  const slug = (label) => String(label).replace(/[^A-Za-z0-9]/g, '') || ('C' + Date.now());

  function addCategory(d, label, cls) {
    const t = tax(d);
    const id = slug(label);
    if (t.parents.some((p) => p.id === id)) throw new Error(label + ' already exists.');
    t.parents.push({ id, label: String(label).trim(), cls: cls || 'optional' });
    return d;
  }
  function renameCategory(d, id, label) {
    const p = tax(d).parents.find((x) => x.id === id);
    if (p) p.label = String(label).trim();
    return d;
  }
  function setCategoryClass(d, id, cls) {
    const p = tax(d).parents.find((x) => x.id === id);
    if (p) p.cls = cls;
    return d;
  }
  function removeCategory(d, id) {
    const t = tax(d);
    if (Object.values(t.of).includes(id)) throw new Error('Move its tags out first.');
    t.parents = t.parents.filter((p) => p.id !== id);
    return d;
  }
  function addTag(d, tag, parentId) {
    const t = tax(d);
    tag = String(tag).trim();
    if (t.of[tag]) throw new Error('"' + tag + '" already exists.');
    if (!t.parents.some((p) => p.id === parentId)) throw new Error('No such category.');
    t.of[tag] = parentId;
    return d;
  }
  function moveTag(d, tag, parentId) {
    const t = tax(d);
    if (!t.parents.some((p) => p.id === parentId)) throw new Error('No such category.');
    t.of[tag] = parentId;
    return d;
  }
  function renameTag(d, tag, label) {
    const t = tax(d);
    label = String(label).trim();
    if (label === tag) delete t.labels[tag]; else t.labels[tag] = label;
    return d;
  }
  /* Removing a tag unfiles it. It cannot remove the entries that carry it -
     they are records - and they fall back to "unfiled" on the Categories
     screen rather than vanishing. */
  function removeTag(d, tag) {
    const t = tax(d);
    delete t.of[tag]; delete t.labels[tag];
    return d;
  }
  const tagsUsed = (d) => [...new Set(d.ledger.map((r) => r.group).filter(Boolean))].sort();

  function touch(d) {
    tax(d);
    d.lastEntry = newest(d.ledger);
    if (d.lastEntry === '0000-00-00') d.lastEntry = null;
    d.realYears = [...new Set(d.ledger.map((r) => r.docYear)
      .concat(d.positions.map((p) => +p.month.slice(0, 4)))
      .concat(d.properties.map((p) => +p.month.slice(0, 4))))]
      .filter(Boolean).sort((a, b) => a - b);
    /* An account's years follow its entries, which is what makes a new
       account appear in the year you first use it without being told. */
    for (const a of d.accounts) {
      const ys = [...new Set(d.ledger.filter((r) => r.account === a.code).map((r) => r.docYear)
        .concat(d.positions.filter((p) => p.code === a.code).map((p) => +p.month.slice(0, 4)))
        .concat(d.properties.filter((p) => p.code === a.code).map((p) => +p.month.slice(0, 4))))]
        .filter(Boolean).sort((x, y) => x - y);
      if (ys.length) a.years = ys;
      a.rows = d.ledger.filter((r) => r.account === a.code).length;
    }
    return d;
  }

  /* ------------------------------------------------------ categories file --

     Categories travel on their own too: a small file with the parents, which
     tag is filed where, and the display labels. Importing one MERGES - it adds
     what is missing and never moves, renames or removes what is already there,
     so pulling a list in cannot re-file the tags your entries already carry.
     A full export is accepted as well; it has the same taxonomy inside.     */
  function categoriesBlob(d) {
    const t = tax(d);
    return JSON.stringify({
      kind: 'ledger-categories', format: FORMAT,
      exportedAt: new Date().toISOString(),
      counts: { categories: t.parents.length, tags: Object.keys(t.of).length },
      taxonomy: { parents: t.parents, of: t.of, labels: t.labels || {} },
    });
  }
  function parseCategories(text) {
    let j;
    try { j = JSON.parse(text); }
    catch (e) { throw new Error('That is not JSON.'); }
    const t = j && (j.taxonomy || (j.dataset && j.dataset.taxonomy) || (Array.isArray(j.parents) && j));
    if (!t || !Array.isArray(t.parents)) throw new Error('No categories in that file.');
    return {
      parents: t.parents.filter((p) => p && p.id && p.label)
        .map((p) => ({ id: String(p.id), label: String(p.label), cls: p.cls || 'other' })),
      of: Object.fromEntries(Object.entries(t.of || {}).filter(([k, v]) => k && v)),
      labels: { ...(t.labels || {}) },
    };
  }
  /* Returns what WOULD be added; with dry:true adds nothing. */
  function mergeTaxonomy(d, inc, opts) {
    const dry = !!(opts && opts.dry);
    const t = tax(d);
    t.labels = t.labels || {};
    const have = new Set(t.parents.map((p) => p.id));
    let parents = 0, tags = 0;
    for (const p of inc.parents) {
      if (have.has(p.id)) continue;
      have.add(p.id); parents++;
      if (!dry) t.parents.push({ id: p.id, label: p.label, cls: p.cls });
    }
    for (const [tag, pid] of Object.entries(inc.of)) {
      if (t.of[tag] || !have.has(pid)) continue;
      tags++;
      if (!dry) t.of[tag] = pid;
    }
    if (!dry) {
      for (const [tag, label] of Object.entries(inc.labels)) {
        if (!t.labels[tag] && t.of[tag] && label !== tag) t.labels[tag] = label;
      }
    }
    return { parents, tags };
  }

  return {
    KEY, FORMAT, empty, normalise, load, save, loadAsync, saveAsync,
    canPersist, storageError, isEmpty,
    parseImport, exportBlob, categoriesBlob, parseCategories, mergeTaxonomy, touch, uid,
    addEntry, updateEntry, deleteEntry,
    addAccount, removeAccount, setOwner, removeOwner, kidsOf,
    addCategory, renameCategory, setCategoryClass, removeCategory,
    addTag, moveTag, renameTag, removeTag, tagsUsed,
  };
}));
