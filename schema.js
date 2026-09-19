/**
 * schema.js — the STRUCTURE the app is built on. No data.
 *
 * What kinds of account exist, what the availability categories mean, what a
 * person can be. None of it says anything about your money, so all of it can
 * be public.
 *
 * The account list used to live next door in accounts.js and the app seeded
 * itself from it. It does not any more: bank names and account codes are your
 * records, so accounts.js stays on your machine for the importer and the
 * shipped app starts with nothing. You create accounts, or import them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LEDGER_SCHEMA = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {

  /* No seed people. Who owns what is data, entered under the gear; a shipped
     "Me" collided with the first real person anyone created. */
  const OWNERS = {};

  /* Whether you consider the money available. This is the axis the whole app
     reports on, and it is NOT the same as the kind of account: an instant
     savings account is cash, a locked-up one is savings. */
  const CATEGORY = {
    cash:     { label: 'Cash',     color: '--c1', note: 'reachable today' },
    savings:  { label: 'Savings',  color: '--c3', note: 'locked up or invested' },
    estate:   { label: 'Property', color: '--c4', note: 'net of the loan' },
    excluded: { label: 'Excluded', color: '--c6', note: 'not money yet' },
  };

  /* The SHAPE of the record, which decides how an account is displayed and
     what can be entered against it. */
  const TYPE_LABEL = {
    ledger: 'Bank account',
    fund: 'Fund (IRA, 401k)',
    portfolio: 'Portfolio',
    bond: 'Bonds',
    insurance: 'Life insurance',
    options: 'Stock options',
    property: 'Property',
  };

  const TYPE_NOTE = {
    ledger: 'Debits and credits — current, savings, card, livret',
    fund: 'Units at a moving price, with contributions and fees',
    portfolio: 'Several instruments, each with its own terms',
    bond: 'Fixed plus variable rate',
    insurance: 'Premium, cash value and death benefit',
    options: 'Grants with a strike, a vesting schedule and an expiry',
    property: 'Value, loan balance, and the capital in between',
  };

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CHF', 'CAD'];

  /* What a category IS to the arithmetic. This is structure, not data: the
     categories themselves live in the dataset and start empty, but each one
     has to be one of these, because Income and Optional are added up
     differently and there is no sensible default. */
  const CLASSES = {
    income:    { label: 'Income',    kind: 'income',   order: 0 },
    tax:       { label: 'Tax',       kind: 'tax',      order: 1 },
    savings:   { label: 'Savings',   kind: 'savings',  order: 2 },
    essential: { label: 'Necessary', kind: 'spend',    order: 3 },
    optional:  { label: 'Optional',  kind: 'spend',    order: 4 },
    other:     { label: 'Other',     kind: 'spend',    order: 5 },
    transfer:  { label: 'Between accounts', kind: 'transfer', order: 6, internal: true },
  };

  /* Free-form labels you can put on an entry as a SECOND axis, independent of
     its category: a sofa is Home and also "Pessac furnishing". Empty to start. */
  const TAGS = [];

  /* Misspellings of an account code seen in a source sheet. Empty here; the
     private importer carries the real ones. */
  const CODE_ALIAS = {};
  const NOT_IN_SHEET = [];
  const NOT_MINE = [];
  const ACCOUNTS = {};      // deliberately empty — the app is not seeded

  return { OWNERS, CATEGORY, TYPE_LABEL, TYPE_NOTE, CURRENCIES, CLASSES, TAGS,
    ACCOUNTS, CODE_ALIAS, NOT_IN_SHEET, NOT_MINE };
}));
