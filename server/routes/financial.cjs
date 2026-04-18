'use strict';

const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');
const logger = require('../../guardrails/logger.cjs');

// ── CSV/Excel/PDF parsing helpers ─────────────────────────────────────────────

function splitCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function isValidDateField(val) {
  if (!val) return false;
  const s = String(val).trim();
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s);
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Scan for the real header row: first row containing both "date" and "description" (case-insensitive)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date') && lower.includes('description')) {
      headerIdx = i;
      break;
    }
  }

  const headers = splitCSVRow(lines[headerIdx]);
  const rows = lines.slice(headerIdx + 1)
    .map(splitCSVRow)
    .filter((r) => r.length >= 2)
    // Skip rows where the first column is not a valid date (summary/footer rows)
    .filter((r) => isValidDateField(r[0]));
  return { headers, rows };
}

function detectCSVFormat(headers) {
  const h = headers.map((s) => s.toLowerCase().replace(/[^a-z]/g, ''));
  if (h.includes('transactiondate') || (h.includes('date') && h.includes('description') && h.includes('amount'))) {
    return 'chase';
  }
  if (h.some((x) => x.includes('runningbal'))) return 'boa';
  if (h.includes('date') && h.includes('amount')) return 'amex';
  return 'generic';
}

function mapCSVRow(format, headers, row) {
  const h = headers.map((s) => s.toLowerCase().replace(/[^a-z]/g, ''));
  const get = (key) => {
    const idx = h.findIndex((x) => x.includes(key));
    return idx >= 0 ? row[idx] : '';
  };

  let date = get('date') || get('transactiondate');
  let description = get('description') || get('memo') || '';
  let amountStr = get('amount') || '0';
  let category = get('category') || 'Uncategorized';

  if (date && !date.match(/^\d{4}-/)) {
    const parts = date.split('/');
    if (parts.length === 3) {
      const [m, d, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      date = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  // Strip commas from dollar amounts (e.g. "23,110.70" → "23110.70") before parsing
  const cleanedAmount = amountStr.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  const amount = Math.abs(parseFloat(cleanedAmount) || 0);
  const isCredit = parseFloat(cleanedAmount) > 0;

  return { date, description, amount, type: isCredit ? 'credit' : 'debit', category };
}

function excelSerialToDate(serial) {
  if (typeof serial === 'number' && serial > 25000 && serial < 60000) {
    const utcDays = Math.floor(serial - 25569);
    const d = new Date(utcDays * 86400 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

function looksLikeDate(val) {
  if (!val) return false;
  const s = String(val).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  // MM/DD/YYYY or MM/DD/YY
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return true;
  // Excel serial number
  const n = Number(s);
  if (!isNaN(n) && n > 25000 && n < 60000) return true;
  return false;
}

function parseExcelToRows(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (jsonRows.length < 2) return { headers: [], rows: [] };

  // Find the header row — first row where at least 2 cells look like headers
  let headerIdx = 0;
  for (let i = 0; i < Math.min(jsonRows.length, 10); i++) {
    const row = jsonRows[i].map((c) => String(c).toLowerCase().replace(/[^a-z]/g, ''));
    const headerish = row.filter((c) => ['date', 'description', 'amount', 'balance', 'runningbal', 'memo', 'category', 'type', 'transactiondate', 'postdate', 'reference'].some((h) => c.includes(h)));
    if (headerish.length >= 2) { headerIdx = i; break; }
  }

  const headers = jsonRows[headerIdx].map(String);
  const dataRows = jsonRows.slice(headerIdx + 1);

  // Convert rows, handling Excel serial dates and filtering non-data rows
  const rows = dataRows
    .map((r) => {
      return r.map((cell, colIdx) => {
        // Check if this column is the date column
        const hdr = headers[colIdx]?.toLowerCase().replace(/[^a-z]/g, '') || '';
        if (hdr.includes('date') && typeof cell === 'number') {
          const converted = excelSerialToDate(cell);
          if (converted) return converted;
        }
        return String(cell);
      });
    })
    .filter((r) => {
      // Filter: must have at least a date-like value in the row
      return r.some((c) => looksLikeDate(c)) && r.some((c) => c.trim());
    });

  return { headers, rows };
}

function parsePDFTextLocally(text) {
  // Split PDF text into lines and find the header row containing "Date" and "Description"
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const transactions = [];

  // Strategy 1: Look for tabular data with a header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date') && lower.includes('description')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx >= 0) {
    // Parse rows after the header using CSV-style splitting
    const headers = splitCSVRow(lines[headerIdx]);
    const format = detectCSVFormat(headers);
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const row = splitCSVRow(lines[i]);
      if (row.length < 2) continue;
      if (!isValidDateField(row[0])) continue;
      const mapped = mapCSVRow(format, headers, row);
      if (mapped.date && mapped.amount > 0) {
        transactions.push(mapped);
      }
    }
    if (transactions.length > 0) return transactions;
  }

  // Strategy 2: Scan every line for date-prefixed transaction patterns
  // Matches lines like: "01/15/2025  AMAZON.COM   -45.99" or "01/15/2025  DEPOSIT  1,234.56"
  const txnPattern = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+([-]?\$?[\d,]+\.\d{2})\s*$/;
  for (const line of lines) {
    const match = line.trim().match(txnPattern);
    if (!match) continue;
    let [, dateStr, description, amountStr] = match;
    // Normalize date
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const [m, d, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      dateStr = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const cleanedAmt = amountStr.replace(/[$,]/g, '');
    const amount = Math.abs(parseFloat(cleanedAmt) || 0);
    if (amount > 0) {
      transactions.push({
        date: dateStr,
        description: description.trim(),
        amount,
        type: parseFloat(cleanedAmt) > 0 ? 'credit' : 'debit',
        category: 'Uncategorized',
      });
    }
  }

  return transactions;
}

async function parsePDFWithClaude(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;

  if (!text || text.trim().length < 20) {
    throw new Error('Could not extract readable text from PDF. The file may be image-based or empty.');
  }

  // Try local text-based parsing first (no API key needed)
  const localResults = parsePDFTextLocally(text);
  if (localResults.length > 0) {
    return localResults;
  }

  // Fall back to Claude API if local parsing found nothing
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('No transactions could be parsed from the PDF text locally, and CLAUDE_API_KEY is not set for AI-assisted parsing. Please try a CSV or Excel export instead.');
  }

  // Truncate to ~12k chars to stay within token limits
  const truncatedText = text.slice(0, 12000);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are a bank statement parser. Extract ALL transactions from this bank statement text into a JSON array.

Each transaction object must have exactly these fields:
- "date": string in YYYY-MM-DD format
- "description": string with the transaction description/payee
- "amount": number (positive value, no currency symbols)
- "type": either "debit" or "credit"
- "category": your best guess category (e.g. "Food", "Shopping", "Transfer", "Income", "Utilities", "Entertainment", "Transportation", "Healthcare", "Subscription", "Other")

Return ONLY a valid JSON array, no other text. If you cannot find any transactions, return an empty array [].

Bank statement text:
${truncatedText}`,
      }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60_000,
    },
  );

  const content = response.data?.content?.[0]?.text || '[]';
  // Extract JSON array from response (handle markdown code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    // Validate and normalize each transaction
    return parsed
      .filter((t) => t.date && t.amount !== undefined)
      .map((t) => ({
        date: String(t.date),
        description: String(t.description || ''),
        amount: Math.abs(parseFloat(t.amount) || 0),
        type: t.type === 'credit' ? 'credit' : 'debit',
        category: String(t.category || 'Uncategorized'),
      }))
      .filter((t) => t.amount > 0);
  } catch {
    return [];
  }
}

// ── Router factory ────────────────────────────────────────────────────────────

module.exports = function createFinancialRouter({ authenticateToken, requireOwnership, db }) {
  const router = express.Router();

  // ── Financial Accounts ────────────────────────────────────────────────────────

  router.get('/api/financial/accounts', authenticateToken, async (req, res) => {
    try {
      const accounts = await db.getFinancialAccounts(req.user.id);
      return res.json(accounts);
    } catch (err) {
      logger.error('financial.accounts.readFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/financial/accounts', authenticateToken, async (req, res) => {
    try {
      const { name, type, institution, currency, entityId, accountClass } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const id = `fa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const account = await db.createFinancialAccount({
        id, userId: req.user.id, name, type, institution, currency, entityId, accountClass,
      });
      return res.json(account);
    } catch (err) {
      logger.error('financial.account.createFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/financial/accounts/:id', authenticateToken, async (req, res) => {
    try {
      const record = await db.pool.query(
        `SELECT id, user_id AS "userId", entity_id AS "entityId" FROM financial_accounts WHERE id = $1`,
        [req.params.id]
      ).then(r => r.rows[0]);
      if (!record) return res.status(404).json({ error: 'Account not found' });
      if (!requireOwnership(record, req)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const updated = await db.updateFinancialAccount(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Account not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('financial.account.updateFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/financial/accounts/:id', authenticateToken, async (req, res) => {
    try {
      const record = await db.pool.query(
        `SELECT id, user_id AS "userId", entity_id AS "entityId" FROM financial_accounts WHERE id = $1`,
        [req.params.id]
      ).then(r => r.rows[0]);
      if (!record) return res.status(404).json({ error: 'Account not found' });
      if (!requireOwnership(record, req)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      await db.deleteFinancialAccount(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('financial.account.deleteFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Financial Transactions ────────────────────────────────────────────────────

  router.get('/api/financial/transactions', authenticateToken, async (req, res) => {
    try {
      const filters = {};
      if (req.query.accountId) filters.accountId = req.query.accountId;
      if (req.query.entityId) filters.entityId = req.query.entityId;
      if (req.query.accountClass) filters.accountClass = req.query.accountClass;
      if (req.query.category) filters.category = req.query.category;
      if (req.query.startDate) filters.startDate = req.query.startDate;
      if (req.query.endDate) filters.endDate = req.query.endDate;
      const txns = await db.getTransactions(req.user.id, filters);
      return res.json(txns);
    } catch (err) {
      logger.error('financial.transactions.readFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/financial/transactions', authenticateToken, async (req, res) => {
    try {
      const { accountId, date, description, amount, type, category, entityId, accountClass, notes } = req.body;
      if (!accountId || !date || amount === undefined) {
        return res.status(400).json({ error: 'accountId, date, and amount are required' });
      }
      const id = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const txn = await db.createTransaction({
        id, accountId, userId: req.user.id, date, description, amount: Math.abs(amount),
        type: type || (amount < 0 ? 'debit' : 'credit'), category, entityId, accountClass, notes,
      });
      return res.json(txn);
    } catch (err) {
      logger.error('financial.transaction.createFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/financial/transactions/:id', authenticateToken, async (req, res) => {
    try {
      const { rows } = await db.pool.query(
        `SELECT id, user_id AS "userId", entity_id AS "entityId" FROM financial_transactions WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
      if (!requireOwnership(rows[0], req)) return res.status(403).json({ error: 'Access denied' });
      const updated = await db.updateTransaction(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Transaction not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('financial.transaction.updateFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/financial/transactions/:id', authenticateToken, async (req, res) => {
    try {
      const { rows } = await db.pool.query(
        `SELECT id, user_id AS "userId", entity_id AS "entityId" FROM financial_transactions WHERE id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
      if (!requireOwnership(rows[0], req)) return res.status(403).json({ error: 'Access denied' });
      await db.deleteTransaction(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('financial.transaction.deleteFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── File Import (CSV, Excel, PDF) ─────────────────────────────────────────────

  router.post('/api/financial/import-csv', authenticateToken, async (req, res) => {
    try {
      const { csvText, fileData, fileType, accountId, entityId, accountClass } = req.body;
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }

      let mappedRows = [];
      let format = 'csv';

      if (fileType === 'pdf') {
        // ── PDF: extract text with pdf-parse, then parse with Claude AI ──
        if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required for PDF import' });
        format = 'pdf';
        const pdfTransactions = await parsePDFWithClaude(fileData);
        if (pdfTransactions.length === 0) {
          return res.status(400).json({ error: 'No transactions could be extracted from the PDF. Ensure it contains readable bank statement data.' });
        }
        mappedRows = pdfTransactions;

      } else if (fileType === 'xlsx' || fileType === 'xls') {
        // ── Excel: parse with xlsx package ──
        if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required for Excel import' });
        format = 'xlsx';
        const { headers, rows } = parseExcelToRows(fileData);
        if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in Excel file' });
        const csvFormat = detectCSVFormat(headers);
        format = `xlsx (${csvFormat})`;
        mappedRows = rows.map((row) => mapCSVRow(csvFormat, headers, row)).filter((r) => r.date && r.amount > 0);

      } else {
        // ── CSV: parse text directly ──
        if (!csvText) return res.status(400).json({ error: 'csvText is required for CSV import' });
        const { headers, rows } = parseCSV(csvText);
        if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in CSV' });
        const csvFormat = detectCSVFormat(headers);
        format = `csv (${csvFormat})`;
        mappedRows = rows.map((row) => mapCSVRow(csvFormat, headers, row)).filter((r) => r.date && r.amount > 0);
      }

      if (mappedRows.length === 0) {
        return res.status(400).json({ error: 'No valid transactions found in file' });
      }

      const txns = mappedRows.map((mapped) => ({
        id: `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        userId: req.user.id,
        date: mapped.date,
        description: mapped.description,
        amount: mapped.amount,
        type: mapped.type,
        category: mapped.category,
        entityId: entityId || '',
        accountClass: accountClass || 'personal',
        notes: `Imported from ${format}`,
      }));

      const created = await db.bulkCreateTransactions(txns);
      return res.json({ success: true, count: created.length, format, transactions: created });
    } catch (err) {
      logger.error('financial.import.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Financial Summary ─────────────────────────────────────────────────────────

  router.get('/api/financial/summary', authenticateToken, async (req, res) => {
    try {
      const summary = await db.getFinancialSummary(req.user.id);
      return res.json(summary);
    } catch (err) {
      logger.error('financial.summary.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
