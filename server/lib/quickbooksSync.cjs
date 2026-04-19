'use strict';

/**
 * server/lib/quickbooksSync.cjs — QuickBooks P1 sync worker.
 *
 * Per-connection sync flow:
 *   1. Refresh access token if expired (withFreshAccessToken).
 *   2. Pull Account list → derive Cash / AR / AP balances by AccountType.
 *   3. Pull recent Invoices + Bills (last 90 days) → upsert qb_transactions
 *      and aggregate revenue_30d / expenses_30d.
 *   4. Compute runway_months and a 0–100 health_score from those signals.
 *   5. Upsert today's qb_snapshots row (UNIQUE on (connection_id, as_of_date)
 *      so re-syncs on the same day overwrite).
 *
 * HARD CONTRACT:
 *   - Never throws past the per-connection boundary; per-connection
 *     errors are logged and the next connection is attempted.
 *   - Read-only against QuickBooks (P0 OAuth scope is com.intuit.quickbooks.accounting).
 *   - Writes only to qb_snapshots + qb_transactions; never touches the
 *     existing manual-entry `transactions` table.
 *
 * Cron schedule: piggybacks the existing *​/15 Outlook tick in
 * proxy-server.cjs to avoid scheduler proliferation. QB API rate limit
 * is ~60 req/min per realm — well within budget at 4 calls/connection
 * every 15 minutes.
 */

const logger = require('../../guardrails/logger.cjs');
const { withFreshAccessToken, qbQuery } = require('../utils/quickbooks.cjs');

const ACCOUNT_TYPE_CASH = new Set(['Bank', 'Other Current Asset']); // Bank covers checking/savings; OCA is a softer fallback
const ACCOUNT_TYPE_AR   = new Set(['Accounts Receivable']);
const ACCOUNT_TYPE_AP   = new Set(['Accounts Payable']);

const TXN_WINDOW_DAYS = 90;
const REVENUE_WINDOW_DAYS = 30;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return isoDate(d);
}

/**
 * Walk an Account[] array (from QB Query response) and return summed
 * CurrentBalance per account category. CurrentBalance is the running
 * balance — for Bank/AR/AP that's exactly what we want for a snapshot.
 */
function aggregateAccounts(accounts) {
  const totals = { cash: 0, ar: 0, ap: 0 };
  for (const a of accounts || []) {
    if (!a?.Active) continue;
    const bal = parseFloat(a.CurrentBalance) || 0;
    if (ACCOUNT_TYPE_CASH.has(a.AccountType)) {
      // Only "Bank" reliably represents cash. OCA is heterogeneous (prepaid
      // expenses, undeposited funds, etc.) — include only if classified as
      // a sub-account of cash. Conservative: use Bank only.
      if (a.AccountType === 'Bank') totals.cash += bal;
    } else if (ACCOUNT_TYPE_AR.has(a.AccountType)) {
      totals.ar += bal;
    } else if (ACCOUNT_TYPE_AP.has(a.AccountType)) {
      // QB stores AP balances as negative liabilities. Flip sign so the
      // snapshot reads "you owe X" as a positive number.
      totals.ap += Math.abs(bal);
    }
  }
  return totals;
}

/** Sum invoice amounts within the last N days. */
function sumInvoicesInWindow(invoices, sinceIso) {
  let total = 0;
  for (const inv of invoices || []) {
    if (!inv?.TxnDate || inv.TxnDate < sinceIso) continue;
    total += parseFloat(inv.TotalAmt) || 0;
  }
  return total;
}

/** Sum bill amounts within the last N days. */
function sumBillsInWindow(bills, sinceIso) {
  let total = 0;
  for (const b of bills || []) {
    if (!b?.TxnDate || b.TxnDate < sinceIso) continue;
    total += parseFloat(b.TotalAmt) || 0;
  }
  return total;
}

/**
 * Health score (0–100) — quick heuristic for the dashboard pill.
 * 50 = neutral; >70 healthy; <30 needs attention.
 *
 * Inputs scaled into [0,1] sub-scores then blended:
 *   - runway: 1.0 if ≥12 months, 0 if ≤1 month, linear between
 *   - profitability: net_income_30d / max(revenue_30d, 1)  → clamped [-1,1]
 *   - ar_age: weighted toward zero if AR > 30d revenue (placeholder; needs
 *     ACL-aware aging in P2). For now: 1.0 if AR <= 1mo revenue, decays.
 */
function computeHealthScore({ cashBalance, expenses30d, revenue30d, accountsReceivable }) {
  const monthlyBurn = expenses30d > 0 ? expenses30d : 0.01;
  const runwayMonths = cashBalance > 0 ? cashBalance / monthlyBurn : 0;
  const runwaySub = Math.max(0, Math.min(1, (runwayMonths - 1) / 11)); // 1mo → 0, 12mo → 1
  const profitSub = (() => {
    if (revenue30d <= 0) return 0.5; // no signal
    const margin = (revenue30d - expenses30d) / revenue30d;
    return Math.max(0, Math.min(1, (margin + 1) / 2)); // map [-1,1] to [0,1]
  })();
  const arSub = (() => {
    if (revenue30d <= 0) return 0.5;
    const ratio = accountsReceivable / revenue30d;
    return Math.max(0, Math.min(1, 1 - (ratio - 1) / 2)); // ratio<=1 → 1.0; ratio=3 → 0
  })();
  const score = 100 * (0.5 * runwaySub + 0.3 * profitSub + 0.2 * arSub);
  return Math.round(score);
}

/**
 * Sync one QB connection. Returns { ok, snapshotId, transactionsCount }
 * on success or { ok: false, reason } on failure. Never throws.
 */
async function syncOneQbConnection(connection, db) {
  const ctx = { userId: connection.userId, connectionId: connection.id, realmId: connection.realmId };
  try {
    const tokens = await withFreshAccessToken(connection, db);
    const baseArgs = {
      realmId: connection.realmId,
      environment: connection.environment,
      accessToken: tokens.access_token,
    };

    // Account balances → cash / AR / AP. MAXRESULTS 1000 covers typical
    // chart-of-accounts sizes; capped intentionally to avoid pagination
    // for P1 (revisit if anyone trips it).
    const accountResp = await qbQuery({ ...baseArgs, query: "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000" });
    const accounts = accountResp.Account || [];
    const balances = aggregateAccounts(accounts);

    // Recent invoices + bills (90d window — sumInvoicesInWindow then
    // narrows to 30d for the snapshot metric).
    const sinceIso = daysAgo(TXN_WINDOW_DAYS);
    const since30 = daysAgo(REVENUE_WINDOW_DAYS);
    const invoiceResp = await qbQuery({ ...baseArgs, query: `SELECT * FROM Invoice WHERE TxnDate >= '${sinceIso}' MAXRESULTS 500` });
    const billResp    = await qbQuery({ ...baseArgs, query: `SELECT * FROM Bill    WHERE TxnDate >= '${sinceIso}' MAXRESULTS 500` });
    const invoices = invoiceResp.Invoice || [];
    const bills    = billResp.Bill || [];

    const revenue30d  = sumInvoicesInWindow(invoices, since30);
    const expenses30d = sumBillsInWindow(bills, since30);
    const netIncome30d = revenue30d - expenses30d;
    const runwayMonths = balances.cash > 0 && expenses30d > 0
      ? Math.round((balances.cash / expenses30d) * 100) / 100
      : null;
    const healthScore = computeHealthScore({
      cashBalance: balances.cash,
      expenses30d,
      revenue30d,
      accountsReceivable: balances.ar,
    });

    const snapshotId = await db.upsertQbSnapshot({
      connectionId: connection.id,
      userId: connection.userId,
      entityId: connection.entityId,
      asOfDate: isoDate(new Date()),
      cashBalance: balances.cash,
      accountsReceivable: balances.ar,
      accountsPayable: balances.ap,
      revenue30d,
      expenses30d,
      netIncome30d,
      runwayMonths,
      healthScore,
      rawJson: {
        accountCount: accounts.length,
        invoiceCount: invoices.length,
        billCount: bills.length,
        environment: connection.environment,
      },
    });

    // Persist raw transactions — keeps a paper trail decoupled from the
    // snapshot rollup so future detail views don't have to re-call QB.
    const txnRows = [
      ...invoices.map((inv) => ({
        connectionId: connection.id,
        userId: connection.userId,
        entityId: connection.entityId,
        txnQbId: String(inv.Id),
        txnType: 'invoice',
        txnDate: inv.TxnDate,
        amount: parseFloat(inv.TotalAmt) || 0,
        currency: inv.CurrencyRef?.value || 'USD',
        counterparty: inv.CustomerRef?.name || '',
        memo: inv.PrivateNote || '',
        status: inv.Balance > 0 ? 'open' : 'paid',
        dueDate: inv.DueDate || null,
        rawJson: { docNumber: inv.DocNumber, balance: inv.Balance },
      })),
      ...bills.map((b) => ({
        connectionId: connection.id,
        userId: connection.userId,
        entityId: connection.entityId,
        txnQbId: String(b.Id),
        txnType: 'bill',
        txnDate: b.TxnDate,
        amount: parseFloat(b.TotalAmt) || 0,
        currency: b.CurrencyRef?.value || 'USD',
        counterparty: b.VendorRef?.name || '',
        memo: b.PrivateNote || '',
        status: b.Balance > 0 ? 'open' : 'paid',
        dueDate: b.DueDate || null,
        rawJson: { docNumber: b.DocNumber, balance: b.Balance },
      })),
    ];
    const txnCount = await db.upsertQbTransactions(txnRows);

    logger.info('quickbooks.sync.success', {
      ...ctx, snapshotId, transactionsCount: txnCount,
      revenue30d, expenses30d, runwayMonths, healthScore,
    });
    return { ok: true, snapshotId, transactionsCount: txnCount };
  } catch (err) {
    logger.warn('quickbooks.sync.connection.failed', {
      ...ctx, status: err.status || null, error: err.message,
    });
    return { ok: false, reason: err.message };
  }
}

/**
 * Sync every QB connection in the system. Iterates sequentially per
 * connection (each is a distinct realm; concurrency would risk hitting
 * QB's per-realm rate limit). Failures are isolated per connection.
 */
async function syncAllQbConnections(db) {
  let connections;
  try {
    connections = await db.getAllQbConnections();
  } catch (err) {
    logger.error('quickbooks.sync.list.failed', { error: err.message });
    return { ok: false, reason: err.message };
  }
  if (!connections.length) return { ok: true, processed: 0 };

  let succeeded = 0;
  let failed = 0;
  for (const conn of connections) {
    const result = await syncOneQbConnection(conn, db);
    if (result.ok) succeeded++; else failed++;
  }
  logger.info('quickbooks.sync.complete', {
    processed: connections.length, succeeded, failed,
  });
  return { ok: true, processed: connections.length, succeeded, failed };
}

module.exports = {
  syncOneQbConnection,
  syncAllQbConnections,
  // Exported for unit tests / manual /test endpoint extensions.
  aggregateAccounts,
  sumInvoicesInWindow,
  sumBillsInWindow,
  computeHealthScore,
};
