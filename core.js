/**
 * core.js — the computation, shared by the app and the tests.
 *
 * Nothing in here touches the DOM or the network, so test.js can run the exact
 * code the UI runs. That matters most for `balances()`: it rebuilds every
 * account from its carry row plus every transaction, and the test asserts the
 * result against the numbers your own Total tab arrives at independently. If
 * those agree to the cent, the importer read the sheet correctly - a far
 * stronger statement than any internal consistency check.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCore = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {

  let D = null;
  /* The pristine account list, as the importer produced it. Declared here,
     above init(), because init() resets it. */
  let BASE = null;
  /* `init` means "here is a different dataset". The registry snapshot below is
     taken from whatever D held at the time, so it MUST be dropped here.

     Not doing that was a real bug and a nasty one: the app boots on an empty
     store, takes the snapshot (empty), then swaps in the real data from
     IndexedDB and calls applyRegistry again — which restored accounts from the
     empty snapshot and re-created them with no `years`. balances() walks
     `a.years`, so every cash account summed to zero, while savings and
     property (read straight off positions/properties) looked fine. Editing
     any entry called touch(), which recomputed `years`, and the cash
     reappeared — which is exactly how it was reported. */
  const init = (data) => { D = data; BASE = null; return API; };

  /* ------------------------------------------------------------- registry --

     The editable facts about an account - bank, display key, owners, whether
     it is closed - arrive from accounts.js and from whatever the app has
     overridden on this device. Both are folded onto the generated account list
     here, in one place, so no screen has to know there are three layers.

     An entry with no matching generated account is a NEW account: it has no
     transactions yet, which is exactly the state a freshly created one is in.  */


  function applyRegistry(reg, names) {
    if (!reg) return API;
    /* Snapshot what build.js produced, then rebuild from it every time. Merging
       in place would make an edit permanent: clearing a bank name you had set
       would leave the old one, because "undefined" means "not overridden"
       rather than "blank". Reset has to actually reset. */
    if (!BASE) BASE = D.accounts.map((a) => ({ ...a }));
    D.accounts = BASE.map((a) => ({ ...a }));
    const own = names || (D.owners || {});
    const EDITABLE = ['bank', 'key', 'type', 'subtype', 'category', 'owners',
      'currency', 'closed', 'inWealth', 'inSheet', 'note'];
    const fill = (a, r) => {
      for (const f of EDITABLE) if (r[f] !== undefined) a[f] = r[f];
      a.owners = a.owners || [a.owner || 'JE'];
      a.owner = a.owners[0];
      a.ownerName = a.owners.map((o) => own[o] || o).join(' & ');
      a.key = a.key || a.code;
      if (a.inWealth === undefined) a.inWealth = true;
    };
    for (const a of D.accounts) { const r = reg[a.code]; if (r) fill(a, r); else fill(a, {}); }
    for (const [code, r] of Object.entries(reg)) {
      if (D.accounts.some((a) => a.code === code)) continue;
      const a = { code, currency: 'USD', years: [], rows: 0, opening: {}, created: true };
      fill(a, r);
      D.accounts.push(a);
    }
    return API;
  }

  /* An account leaves your roll-up only when EVERY owner is excluded. A joint
     account you hold with one of the girls is still half yours, and dropping it
     whole would be a bigger lie than keeping it whole. */
  const ownerExcluded = (a, excl) =>
    !!excl.length && (a.owners || [a.owner]).every((o) => excl.includes(o));

  /* ---------------------------------------------------------------- money --

     The rate is stored per month on the data, never a converted amount. That
     is what makes the currency switch arithmetic on data already in memory,
     and what stops a rate change from rewriting history.                    */

  /* A brand-new app has no exchange rates at all, and this used to reach into
     an empty object and throw. That took down every screen that converts
     anything: creating an account rendered nothing and the Accounts tab
     stayed broken afterwards, because the crash happened during render.

     One rate is not a sensible guess, so it is a LAST resort and the UI says
     so where it matters; the point is that a missing rate degrades to a
     wrong-but-visible number rather than a dead screen. */
  function rate(month) {
    const f = D.fx[month];
    if (f && f.usdPerEur) return f.usdPerEur;
    const keys = Object.keys(D.fx).sort();
    if (!keys.length) return 1;
    let best = keys[0];
    for (const kk of keys) if (kk <= month) best = kk;
    const r = D.fx[best];
    return (r && r.usdPerEur) || 1;
  }
  /* Whether any of this is real, so a screen can say "no rates loaded"
     instead of quietly showing euros and dollars as interchangeable. */
  const hasRates = () => Object.keys(D.fx || {}).length > 0;

  function conv(amount, currency, month, to) {
    if (currency === to) return amount;
    const r = rate(month);
    const usd = currency === 'USD' ? amount
      : currency === 'EUR' ? amount * r
      : amount * ((D.fx[month] || {}).audUsd || 0.7);
    return to === 'USD' ? usd : usd / r;
  }

  /* ------------------------------------------------------------ selectors --*/

  const acct = (code) => D.accounts.find((a) => a.code === code);

  function rows(opts = {}) {
    let out = opts.synthetic ? D.ledger.concat(D.synthetic) : D.ledger;
    if (opts.owners && opts.owners.length) {
      out = out.filter((r) => { const a = acct(r.account); return !a || opts.owners.includes(a.owner); });
    }
    /* Restrict to one availability class. The Year tab's cash table has to be
       the cash accounts only, or "in and out" quietly includes an IRA
       contribution arriving in a fund. */
    if (opts.onlyCategory) {
      out = out.filter((r) => { const a = acct(r.account); return a && a.category === opts.onlyCategory; });
    }
    return out;
  }

  /* Which accounts a category-restricted view is actually showing. The screens
     put this behind a "?" so the reader can check rather than assume. */
  function accountsIn(category, opts = {}) {
    const excl = (opts.excludeOwners || []);
    return D.accounts.filter((a) => a.category === category && !ownerExcluded(a, excl))
      .sort((x, y) => (x.key || x.code).localeCompare(y.key || y.code));
  }

  /* Savings, month by month: what went in, what the market did, where it left
     you. Contributions and interest are recorded CUMULATIVELY on the position
     tabs, so the month's own figure is the step between two months - summed
     across every savings account. */
  function savingsMonths(year, opts = {}) {
    const cur = opts.cur || 'USD';
    const excl = opts.excludeOwners || [];
    /* `onlyCurrency` answers "what are the euro savings doing" without the
       dollar ones drowning them out. Everything is still converted to the
       display currency, so the column headings never lie. */
    const codes = D.accounts
      .filter((a) => a.category === 'savings' && !ownerExcluded(a, excl)
        && (!opts.onlyCurrency || a.currency === opts.onlyCurrency))
      .map((a) => a.code);
    const out = {};
    for (let mi = 1; mi <= 12; mi++) {
      out[`${year}-${String(mi).padStart(2, '0')}`] =
        { paidIn: 0, growth: 0, balance: 0, paidInTotal: 0, growthTotal: 0, seen: false };
    }
    for (const code of codes) {
      const a = acct(code); if (!a) continue;
      const hist = D.positions.filter((p) => p.code === code)
        .sort((x, y) => (x.month < y.month ? -1 : 1));
      for (let i = 0; i < hist.length; i++) {
        const p = hist[i], b = out[p.month];
        if (!b) continue;
        const prev = hist[i - 1];
        b.seen = true;
        b.balance += conv(p.balance, a.currency, p.month, cur);
        /* The sheet's Contributions and Interest columns are CUMULATIVE from
           the day the account opened, and contributions + interest = balance
           in 997 of 998 rows. So the lifetime figures are read straight off,
           not accumulated here - and the ratio between them is then a real
           return rather than this year's growth over this year's deposits. */
        if (p.contributions !== null) b.paidInTotal += conv(p.contributions, a.currency, p.month, cur);
        if (p.interest !== null) b.growthTotal += conv(p.interest, a.currency, p.month, cur);
        if (prev && p.contributions !== null && prev.contributions !== null) {
          b.paidIn += conv(p.contributions - prev.contributions, a.currency, p.month, cur);
        }
        if (prev && p.interest !== null && prev.interest !== null) {
          b.growth += conv(p.interest - prev.interest, a.currency, p.month, cur);
        }
      }
    }
    return out;
  }

  /* `livingOnly` drops the rows the checker flagged as a large inflow parked in
     an expense category. Without it a category comparison reads "Home up 468%"
     when what happened is a house sale, and the Spend chart is one enormous
     bar. Reconciliation never uses it — it is a reporting choice, stated in the
     UI wherever it is applied. */
  const spend = (opts = {}) => rows(opts)
    .filter((r) => r.type === 'spend' && !(opts.livingOnly && r.oneoff));
  const months = (opts) => [...new Set(rows(opts).map((r) => r.month))].sort();
  const years = (opts) => [...new Set(rows(opts).map((r) => r.month.slice(0, 4)))].sort();

  /* Top N categories, everything else folded into Other. The validated palette
     carries eight adjacent-safe slots, so a ninth hue is not available and the
     fold is a hard rule rather than a preference. */
  function topCategories(n, opts) {
    const t = {};
    for (const r of spend(opts)) {
      t[r.group] = (t[r.group] || 0) + Math.abs(conv(r.amount, r.currency, r.month, opts.cur));
    }
    const ranked = Object.entries(t).sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, n).map(([g]) => g);
    return { top, hasOther: ranked.length > n, list: ranked.length > n ? [...top, 'Other'] : top, totals: t };
  }

  const catOf = (g, list) => (list.includes(g) ? g : 'Other');

  /* ------------------------------------------------------------ tag parents --

     An entry carries one tag; a tag belongs to one parent. Taxi is Commute,
     Mortgage is Home. Sixteen parents is a picture where thirty-eight tags is
     a list, and the parents are the columns your own Report already uses.
     Overrides from the Settings screen land on top of tags.js exactly the way
     account overrides land on top of accounts.js.                            */

  let TAGS = null;
  const useTags = (t) => { TAGS = t; return API; };
  const parentOf = (tag) => (TAGS ? (TAGS.OF[tag] || 'Misc') : tag);
  const parentLabel = (id) => (TAGS && TAGS.byId[id] ? TAGS.byId[id].label : id);

  /* What CLASS a tag belongs to - income, tax, savings, essential, optional,
     other. The summary is built on this rather than on the row's `type`,
     because the two answer different questions: `type` is how the importer
     read the sheet, class is how you have decided to think about it. */
  const classOf = (tag) => {
    if (!TAGS) return 'other';
    const p = TAGS.byId[TAGS.OF[tag] || 'Misc'];
    return (p && p.cls) || 'other';
  };

  /* The year in five figures, by class.

       in       everything classed income — which includes Interest
       out      essential + optional + other
       taxes    the tax class only, so property tax (filed under Home) is a
                cost of the house and not a tax line
       savings  everything tagged Savings
       left     in − (out + taxes + savings)

     Signs are normalised: every one of these is reported positive, because
     "out" being negative and "in" positive made every screen carry its own
     Math.abs and one of them was always wrong. */
  function yearSummary(year, opts = {}) {
    const cur = opts.cur || 'USD';
    const cap = opts.upto || (year + '-12');
    const t = { in: 0, out: 0, taxes: 0, savings: 0 };
    for (const r of rows(opts)) {
      if (!r.month.startsWith(String(year)) || r.month > cap) continue;
      if (opts.livingOnly && r.oneoff) continue;
      const cls = classOf(r.group);
      if (cls === 'transfer') continue;
      const v = conv(r.amount, r.currency, r.month, cur);
      /* Summed SIGNED, then presented positive. A tax refund is a negative
         tax and a reimbursement is a negative cost; adding their magnitudes
         would report money you got back as money you spent. */
      if (cls === 'income') t.in += v;
      else if (cls === 'tax') t.taxes += v;
      else if (cls === 'savings') t.savings += v;
      else if (cls === 'essential' || cls === 'optional' || cls === 'other') t.out += v;
    }
    t.out = Math.abs(t.out); t.taxes = Math.abs(t.taxes); t.savings = Math.abs(t.savings);
    t.left = t.in - (t.out + t.taxes + t.savings);
    return t;
  }

  /* Spending rolled up to parents, then each parent's own tags beneath it, for
     one set of options. Both levels come from one pass so they cannot drift. */
  function byParent(opts = {}) {
    const out = {};
    for (const r of spend(opts)) {
      const v = conv(r.amount, r.currency, r.month, opts.cur || 'USD');
      const p = parentOf(r.group);
      const b = out[p] || (out[p] = { id: p, label: parentLabel(p), total: 0, tags: {}, months: {} });
      b.total += v;
      b.tags[r.group] = (b.tags[r.group] || 0) + v;
      b.months[r.month] = (b.months[r.month] || 0) + v;
    }
    return Object.values(out)
      .map((b) => ({ ...b, tagList: Object.entries(b.tags).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }

  /* Every tag that appears in the data, with where it is filed and how often.
     A tag with no parent declared falls to Misc and is reported as unfiled,
     so one you invent next year asks to be placed instead of vanishing. */
  function tagCensus(opts = {}) {
    const seen = {};
    for (const r of rows(opts)) {
      const s = seen[r.group] || (seen[r.group] = { tag: r.group, n: 0, total: 0, type: r.type,
        parent: parentOf(r.group), filed: !!(TAGS && TAGS.OF[r.group]) });
      s.n++; s.total += Math.abs(conv(r.amount, r.currency, r.month, opts.cur || 'USD'));
    }
    return Object.values(seen).sort((a, b) => b.total - a.total);
  }

  function monthlyByCategory(list, opts) {
    const out = {};
    for (const m of months(opts)) { out[m] = {}; for (const c of list) out[m][c] = 0; }
    for (const r of spend(opts)) {
      if (!out[r.month]) continue;
      const c = catOf(r.group, list);
      out[r.month][c] = (out[r.month][c] || 0) + conv(r.amount, r.currency, r.month, opts.cur);
    }
    return out;
  }

  /* --------------------------------------------------------- balance sheet --

     Ledger accounts are rebuilt: carry row for the year, then every
     transaction in month order. Funds, bonds, insurance and property do not
     keep transactions - they record a month-end balance directly - so they are
     read rather than accumulated.                                            */

  function balances() {
    const byMonth = {};
    const acctRows = {};
    for (const r of D.ledger) (acctRows[r.account] || (acctRows[r.account] = [])).push(r);

    for (const a of D.accounts) {
      if (a.type !== 'ledger') continue;
      for (const year of a.years) {
        /* Rows belong to the BOOK they were entered in, not to the year their
           date claims. One row in a 2026 book was dated 2025-01-30 - a
           typo for 2026 - and the money really did move. Filtering by date
           dropped it and left the rebuilt balance 45.00 above the sheet's.
           So bucket by document, and clamp a stray date into the book's year;
           the Check tab reports the typo separately. */
        const mine = (acctRows[a.code] || []).filter((r) => r.docYear === year);
        const bucket = (r) => {
          const y = +r.month.slice(0, 4);
          if (y === year) return r.month;
          return y < year ? `${year}-01` : `${year}-12`;
        };
        let bal = (a.opening || {})[year] || 0;
        /* The carry row IS the previous year-end balance, so publish it as
           that month. Without this, December of the year before a loaded book
           had positions and property but zero cash, which drew a false
           collapse on the chart. Seeded, those months reconcile too. */
        const carryMonth = `${year - 1}-12`;
        if (!(byMonth[carryMonth] || {})[a.code]) {
          (byMonth[carryMonth] || (byMonth[carryMonth] = {}))[a.code] = bal;
        }
        for (let mi = 1; mi <= 12; mi++) {
          const m = `${year}-${String(mi).padStart(2, '0')}`;
          for (const r of mine) if (bucket(r) === m) bal += r.amount;
          (byMonth[m] || (byMonth[m] = {}))[a.code] = bal;
        }
      }
    }
    return byMonth;
  }

  /* Cash / savings / estate per month-end, in the display currency, honouring
     which owners count toward your wealth. */
  function wealth(opts = {}) {
    const cur = opts.cur || 'USD';
    const excl = opts.excludeOwners || [];
    const bal = balances();
    /* Two different reasons to leave something out, kept apart because they
       are not the same statement: "this is my daughter's money" and "my Total
       tab has never counted this asset". */
    const why = (code) => {
      const a = acct(code);
      if (!a) return 'skip';
      if (ownerExcluded(a, excl)) return 'owner';
      if (a.inWealth === false) return 'asset';
      return null;
    };

    /* Stop at the last month that actually saw a transaction. The spreadsheet
       fills the rest of the year with the current figure so its formulas have
       something to chew on, which would otherwise show here as four flat
       months of "the future" and put the headline on a month that has not
       happened. */
    const lastReal = D.ledger.reduce((m, r) => (r.month > m ? r.month : m), '0000-00');

    const ms = [...new Set([
      ...Object.keys(bal),
      ...D.positions.map((p) => p.month),
      ...D.properties.map((p) => p.month),
    ])].filter((m) => m <= lastReal).sort();

    const out = [];
    for (const m of ms) {
      const bucket = { month: m, cash: 0, savings: 0, estate: 0,
        excluded: 0, excludedOwner: 0, excludedAsset: 0 };
      for (const [code, v] of Object.entries(bal[m] || {})) {
        const a = acct(code); if (!a) continue;
        const amt = conv(v, a.currency, m, cur);
        const w = why(code);
        if (w) { if (w !== 'skip') { bucket.excluded += amt; bucket['excluded' + (w === 'owner' ? 'Owner' : 'Asset')] += amt; } continue; }
        bucket[a.category === 'cash' ? 'cash' : a.category === 'savings' ? 'savings' : 'estate'] += amt;
      }
      for (const p of D.positions) {
        if (p.month !== m) continue;
        const a = acct(p.code); if (!a) continue;
        const amt = conv(p.balance, a.currency, m, cur);
        const w = why(p.code);
        if (w) { if (w !== 'skip') { bucket.excluded += amt; bucket['excluded' + (w === 'owner' ? 'Owner' : 'Asset')] += amt; } continue; }
        bucket.savings += amt;
      }
      for (const p of D.properties) {
        if (p.month !== m || !p.capital) continue;
        const a = acct(p.code); if (!a) continue;
        const amt = conv(p.capital, a.currency, m, cur);
        const w = why(p.code);
        if (w) { if (w !== 'skip') { bucket.excluded += amt; bucket['excluded' + (w === 'owner' ? 'Owner' : 'Asset')] += amt; } continue; }
        bucket.estate += amt;
      }
      bucket.total = bucket.cash + bucket.savings + bucket.estate;
      if (bucket.total || bucket.excluded) out.push(bucket);
    }
    return out;
  }

  /* ------------------------------------------------------------- the bills --

     Recurring household costs. Two sources that should agree: the hand-kept
     Bills grid, and the ledger itself. Disagreement means one of them is wrong,
     which is worth knowing - so both are returned rather than merged. */

  const BILL_GROUPS = {
    Electricity: 'Power', Internet: 'Internet', Phone: 'Phone',
    CarIns: 'Car insurance', HomeIns: 'Home insurance', HOA: 'HOA',
    Mortgage: 'Mortgage', Bills: 'Other bills',
  };
  const GRID_MAP = {
    'Power Bill': 'Power', 'Internet Bill': 'Internet', 'Phone Bill': 'Phone',
    'Car Insurance': 'Car insurance', 'Home Insurance': 'Home insurance',
  };

  function billsFromLedger(opts = {}) {
    const cur = opts.cur || 'USD';
    const out = {};
    for (const r of rows(opts)) {
      const kind = BILL_GROUPS[r.group];
      if (!kind) continue;
      const y = r.month.slice(0, 4);
      ((out[kind] || (out[kind] = {}))[y] || (out[kind][y] = { total: 0, months: {} }));
      const v = -conv(r.amount, r.currency, r.month, cur);   // costs shown positive
      out[kind][y].total += v;
      out[kind][y].months[r.month] = (out[kind][y].months[r.month] || 0) + v;
    }
    return out;
  }

  function billsFromGrid(opts = {}) {
    const cur = opts.cur || 'USD';
    const out = {};
    for (const b of (D.bills || [])) {
      const kind = GRID_MAP[b.kind] || b.kind;
      const y = String(b.year);
      ((out[kind] || (out[kind] = {}))[y] || (out[kind][y] = { total: 0, months: {} }));
      const v = conv(b.amount, 'USD', b.month || `${y}-06`, cur);
      out[kind][y].total += v;
      if (b.month) out[kind][y].months[b.month] = v;
    }
    return out;
  }

  /* ------------------------------------------------- what the phone needs --*/

  /* Latest known balance for every account, in its own currency. Ledger
     accounts come from the rebuild, everything else records a balance. */
  function latest(opts = {}) {
    const bal = balances();
    const ms = Object.keys(bal).sort();
    const out = [];
    /* An account that last appears in an older book is closed, not current.
       Without this, five accounts closed a decade ago came back and
       put today's cash 12,292 over what the Total tab says. The most recent
       book is the list of accounts that still exist. */
    const lastBook = Math.max(...D.accounts.flatMap((a) => a.years));
    /* "Latest" has to mean latest as of now, not latest in the file. The sheet
       pads the rest of the year with formula values, and a property's capital only
       appears in October to December - so an uncapped read showed a house not
       yet bought and put the headline 750k over the truth. */
    /* `asOf` lets a past year be shown as it stood at its own year end rather
       than as it stands today - which is what the Year tab needs the moment
       it can look backwards. */
    const now = opts.asOf || D.ledger.reduce((m, r) => (r.month > m ? r.month : m), '0000-00');
    for (const a of D.accounts) {
      /* Derived by default - an account last seen in an older book is closed -
         but the registry wins, because you know and the sheet doesn't. A
         brand-new account has no books at all and is open, not closed. */
      const closed = a.closed !== undefined ? !!a.closed
        : a.created ? false : !a.years.includes(lastBook);
      if (closed && !opts.includeClosed) continue;
      let native = null, asOf = null;
      if (a.type === 'ledger') {
        for (const m of ms) if (m <= now && bal[m][a.code] !== undefined) { native = bal[m][a.code]; asOf = m; }
      } else {
        const upto = (xs) => xs.filter((p) => p.month <= now).sort((x, y) => (x.month < y.month ? -1 : 1));
        const ps = upto(D.positions.filter((p) => p.code === a.code));
        if (ps.length) { native = ps[ps.length - 1].balance; asOf = ps[ps.length - 1].month; }
        /* Not `&& p.capital` — a sold house records capital 0, and skipping zeros
           made a sold house look still-owned long after the sale. */
        const pr = upto(D.properties.filter((p) => p.code === a.code && p.capital !== null));
        if (pr.length) { native = pr[pr.length - 1].capital; asOf = pr[pr.length - 1].month; }
      }
      /* A just-created account has no rows yet. Showing it at zero is the
         truth; dropping it would mean you create one and nothing appears. */
      if (native === null) { if (!a.created) continue; native = 0; asOf = now; }
      out.push({
        ...a, native, asOf, closed,
        shown: conv(native, a.currency, asOf, opts.cur || 'USD'),
      });
    }
    return out.sort((x, y) => Math.abs(y.shown) - Math.abs(x.shown));
  }

  /* The two splits the Today tab wants. Returned as parts so the UI can draw
     them without knowing the arithmetic. */
  function splits(opts = {}) {
    const cur = opts.cur || 'USD';
    const excl = opts.excludeOwners || [];
    const mine = latest(opts).filter((a) => a.inWealth !== false && !ownerExcluded(a, excl));

    const byCur = {};
    for (const a of mine) byCur[a.currency] = (byCur[a.currency] || 0) + a.shown;

    const byCat = { cash: 0, savings: 0, estate: 0 };
    for (const a of mine) if (byCat[a.category] !== undefined) byCat[a.category] += a.shown;

    return {
      total: mine.reduce((s, a) => s + a.shown, 0),
      currency: Object.entries(byCur).map(([k, v]) => ({ label: k, value: v })).sort((x, y) => y.value - x.value),
      /* `key` so the UI can look the label and colour up in the registry
         instead of the two files drifting apart. */
      category: [
        { key: 'cash', label: 'Cash', value: byCat.cash, note: 'reachable today' },
        { key: 'savings', label: 'Savings', value: byCat.savings, note: 'locked up or invested' },
        { key: 'estate', label: 'Property', value: byCat.estate, note: 'net of the loan' },
      ].filter((p) => Math.abs(p.value) > 0.5),
      accounts: mine,
    };
  }

  /* Money in, money out and what stayed, per month. Transfers and the balancing
     half of a savings contribution are excluded, otherwise the same euro is
     counted twice. */
  function flows(year, opts = {}) {
    const cur = opts.cur || 'USD';
    const out = {};
    for (let mi = 1; mi <= 12; mi++) {
      out[`${year}-${String(mi).padStart(2, '0')}`] =
        { income: 0, spend: 0, tax: 0, saved: 0, oneoff: 0, net: 0 };
    }
    /* `oneoff` holds the rows the checker flagged as a large inflow parked in
       an expense category - the house sale, the car sale, a school refund.
       Leaving them inside `spend` made a month's cost read as an inflow, and
       the absolute value then relabelled it a cost. Held apart, `spend` means
       living costs and stays negative. */
    for (const r of rows(opts)) {
      const b = out[r.month]; if (!b) continue;
      const v = conv(r.amount, r.currency, r.month, cur);
      if (r.type === 'income') b.income += v;
      else if (r.type === 'spend') { if (r.oneoff) b.oneoff += v; else b.spend += v; }
      else if (r.type === 'tax') b.tax += v;
      else if (r.type === 'savings') b.saved += v;
    }
    for (const m of Object.keys(out)) {
      const b = out[m];
      b.net = b.income + b.tax + b.spend + b.saved + b.oneoff;
    }
    return out;
  }

  /* Month by month for an investment account. The books record Contributions,
     Interest and Solde - what you put in, what the market did, and the
     balance. They do NOT record a unit count or a unit price anywhere, in any
     year, so a shares-and-price view cannot be built from them; separating
     contributions from growth is the same question answered with the columns
     that exist. `delta` is the month's own movement. */
  function positionHistory(code) {
    const rows = D.positions.filter((p) => p.code === code)
      .sort((a, b) => (a.month < b.month ? -1 : 1));
    let prev = null;
    return rows.map((p) => {
      const out = { ...p, delta: prev === null ? null : cents2(p.balance - prev) };
      prev = p.balance;
      return out;
    });
  }
  const cents2 = (v) => Math.round(v * 100) / 100;

  /* Who actually moved, and by how much, in one year. The savings table is a
     sum; this is the list behind it. */
  function savingsByAccount(year, opts = {}) {
    const cur = opts.cur || 'USD';
    const excl = opts.excludeOwners || [];
    const cap = opts.upto || (year + '-12');
    const out = [];
    for (const a of D.accounts) {
      if (a.category !== 'savings' || ownerExcluded(a, excl)) continue;
      if (opts.onlyCurrency && a.currency !== opts.onlyCurrency) continue;
      const hist = D.positions.filter((p) => p.code === a.code)
        .sort((x, y) => (x.month < y.month ? -1 : 1));
      let paidIn = 0, growth = 0, balance = null;
      for (let i = 1; i < hist.length; i++) {
        const p = hist[i], q = hist[i - 1];
        if (!p.month.startsWith(String(year)) || p.month > cap) continue;
        if (p.contributions !== null && q.contributions !== null) {
          paidIn += conv(p.contributions - q.contributions, a.currency, p.month, cur);
        }
        if (p.interest !== null && q.interest !== null) {
          growth += conv(p.interest - q.interest, a.currency, p.month, cur);
        }
      }
      const last = hist.filter((p) => p.month <= cap).pop();
      if (last) balance = conv(last.balance, a.currency, last.month, cur);
      if (Math.abs(paidIn) > 0.5 || Math.abs(growth) > 0.5 || balance) {
        out.push({ code: a.code, key: a.key || a.code, currency: a.currency,
          paidIn, growth, balance });
      }
    }
    return out.sort((x, y) => Math.abs(y.balance || 0) - Math.abs(x.balance || 0));
  }

  /* Every operation on one account, newest first, in the account's own
     currency - which is how you read a statement. */
  function operations(code, limit = 400) {
    return D.ledger.filter((r) => r.account === code)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit);
  }

  /* Total wealth per year-end, for the history view. */
  function byYearEnd(opts = {}) {
    const w = wealth(opts);
    const out = {};
    for (const p of w) out[p.month.slice(0, 4)] = p;   // later months overwrite
    return Object.entries(out).map(([y, p]) => ({ year: y, ...p }));
  }

  /* The newest date actually written into the sheet, and the newest month with
     activity. Everything after `now` in the file is the spreadsheet padding
     its own formulas, not fact. */
  const lastEntry = () => D.lastEntry
    || D.ledger.reduce((d, r) => (r.date > d ? r.date : d), '0000-00-00');
  const lastMonth = () => D.ledger.reduce((m, r) => (r.month > m ? r.month : m), '0000-00');

  const API = {
    init, applyRegistry, ownerExcluded, lastEntry, lastMonth, hasRates,
    useTags, parentOf, parentLabel, classOf, byParent, tagCensus, yearSummary,
    rate, conv, acct, rows, spend, months, years,
    latest, splits, flows, operations, byYearEnd, positionHistory,
    accountsIn, savingsMonths, savingsByAccount,
    topCategories, catOf, monthlyByCategory,
    balances, wealth, billsFromLedger, billsFromGrid,
    BILL_GROUPS, GRID_MAP,
    get data() { return D; },
  };
  return API;
}));
