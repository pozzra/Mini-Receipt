'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = path.join(__dirname, 'data', 'mini_receipt.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  invoice_date TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paid',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  delivery REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts (invoice_date);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts (status);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_created ON telegram_messages (created_at);
`);

function nowISO() {
  return new Date().toISOString();
}

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function getSetting(key, fallback = '') {
  const stmt = db.prepare('SELECT value FROM admin_settings WHERE key = ?');
  const row = stmt.get(key);
  return row ? String(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare('DELETE FROM admin_settings WHERE key = ?').run(key);
  db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAdminUser() {
  const stmt = db.prepare('SELECT * FROM admin_users WHERE id = 1');
  return stmt.get();
}

function adminUserExists() {
  const stmt = db.prepare('SELECT COUNT(*) AS count FROM admin_users WHERE id = 1');
  const row = stmt.get();
  return Number(row.count) > 0;
}

function createAdminUser(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  const stmt = db.prepare('INSERT INTO admin_users (id, username, password_hash, salt, created_at) VALUES (1, ?, ?, ?, ?)');
  stmt.run('admin', hash, salt, nowISO());
}

function updateAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  db.prepare('UPDATE admin_users SET password_hash = ?, salt = ? WHERE id = 1').run(hash, salt);
}

function hashPassword(password, salt, hash) {
  const candidateSalt = Buffer.from(String(salt || ''), 'hex');
  const candidateHash = Buffer.from(String(hash || ''), 'hex');
  const candidate = crypto.scryptSync(String(password), candidateSalt, candidateHash.length);
  const expected = crypto.scryptSync(String(password), Buffer.from(String(salt || ''), 'hex'), candidateHash.length);
  return crypto.timingSafeEqual(candidate, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const stmt = db.prepare('INSERT INTO admin_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
  stmt.run(token, userId, expiresAt, nowISO());
  return token;
}

function destroySession(token) {
  if (token) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  }
}

function getSessionUser(req) {
  const cookieHeader = String(req.headers.cookie || '');
  const cookies = Object.fromEntries(cookieHeader.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part.trim(), ''];
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    return [key, value];
  }).filter(([key]) => key));
  const token = cookies.admin_session;
  if (!token) return null;
  const stmt = db.prepare('SELECT * FROM admin_sessions WHERE token = ?');
  const session = stmt.get(token);
  if (!session) return null;
  if (Number(session.expires_at) < Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  const userStmt = db.prepare('SELECT id, username FROM admin_users WHERE id = 1');
  const user = userStmt.get();
  return user || null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return user;
}

function publicAuthState(req) {
  const user = getSessionUser(req);
  return {
    authenticated: Boolean(user),
    needsSetup: !adminUserExists(),
    user: user ? { id: user.id, username: user.username } : null,
    shopName: getSetting('shop_name', 'Mini Receipt'),
    currency: getSetting('currency', '$')
  };
}

function computeTotals(items, discountPct, taxPct, delivery) {
  const subtotal = (items || []).reduce((sum, item) => {
    const qty = Number(item.qty) || 0;
    const price = Number(item.price) || 0;
    return sum + qty * price;
  }, 0);
  const discount = subtotal * (Number(discountPct) || 0) / 100;
  const taxBase = subtotal - discount;
  const tax = taxBase * (Number(taxPct) || 0) / 100;
  const total = taxBase + tax + (Number(delivery) || 0);
  return { subtotal, discount, tax, total };
}

function getReceiptById(id) {
  const stmt = db.prepare('SELECT * FROM receipts WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  return mapReceipt(row);
}

function mapReceipt(row) {
  const items = Array.isArray(row.items_json) ? row.items_json : [];
  let parsed = [];
  try { parsed = JSON.parse(String(row.items_json || '[]')); } catch (error) { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  return {
    id: Number(row.id),
    invoiceNo: String(row.invoice_no || ''),
    customerName: String(row.customer_name || ''),
    customerPhone: String(row.customer_phone || ''),
    shopName: String(row.shop_name || ''),
    invoiceDate: String(row.invoice_date || ''),
    paymentMethod: String(row.payment_method || ''),
    status: String(row.status || 'paid'),
    subtotal: Number(row.subtotal || 0),
    discountPct: Number(row.discount_pct || 0),
    taxPct: Number(row.tax_pct || 0),
    delivery: Number(row.delivery || 0),
    total: Number(row.total || 0),
    note: String(row.note || ''),
    items: parsed,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || '')
  };
}

function insertReceipt(data) {
  const totals = computeTotals(data.items, data.discountPct, data.taxPct, data.delivery);
  const createdAt = nowISO();
  const stmt = db.prepare(`
    INSERT INTO receipts (invoice_no, customer_name, customer_phone, shop_name, invoice_date, payment_method, status, subtotal, discount_pct, tax_pct, delivery, total, note, items_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(data.invoiceNo || ''),
    String(data.customerName || ''),
    String(data.customerPhone || ''),
    String(data.shopName || ''),
    String(data.invoiceDate || todayStr()),
    String(data.paymentMethod || ''),
    String(data.status || 'paid'),
    Number(totals.subtotal || 0),
    Number(data.discountPct || 0),
    Number(data.taxPct || 0),
    Number(data.delivery || 0),
    Number(totals.total || 0),
    String(data.note || ''),
    JSON.stringify(data.items || []),
    createdAt,
    createdAt
  );
  return getReceiptById(Number(info.lastInsertRowid));
}

function updateReceipt(id, data) {
  const totals = computeTotals(data.items, data.discountPct, data.taxPct, data.delivery);
  db.prepare(`
    UPDATE receipts
    SET invoice_no = ?, customer_name = ?, customer_phone = ?, shop_name = ?, invoice_date = ?, payment_method = ?, status = ?, subtotal = ?, discount_pct = ?, tax_pct = ?, delivery = ?, total = ?, note = ?, items_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(data.invoiceNo || ''),
    String(data.customerName || ''),
    String(data.customerPhone || ''),
    String(data.shopName || ''),
    String(data.invoiceDate || todayStr()),
    String(data.paymentMethod || ''),
    String(data.status || 'paid'),
    Number(totals.subtotal || 0),
    Number(data.discountPct || 0),
    Number(data.taxPct || 0),
    Number(data.delivery || 0),
    Number(totals.total || 0),
    String(data.note || ''),
    JSON.stringify(data.items || []),
    nowISO(),
    Number(id)
  );
  return getReceiptById(Number(id));
}

function listReceipts({ from = '', to = '', status = '', search = '', limit = 200, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (from) { conditions.push('invoice_date >= ?'); params.push(from); }
  if (to) { conditions.push('invoice_date <= ?'); params.push(to); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (search) {
    conditions.push('(customer_name LIKE ? OR customer_phone LIKE ? OR invoice_no LIKE ? OR note LIKE ? OR shop_name LIKE ?)');
    const like = `%${String(search)}%`;
    params.push(like, like, like, like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT * FROM receipts
    ${where}
    ORDER BY invoice_date DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(...params, Number(limit), Number(offset));
  return rows.map((row) => mapReceipt(row));
}

function deleteReceipt(id) {
  db.prepare('DELETE FROM receipts WHERE id = ?').run(Number(id));
}

function getReportSummary(from, to) {
  const effectiveFrom = from || todayStr(-30);
  const effectiveTo = to || todayStr();
  const stmt = db.prepare(`
    SELECT * FROM receipts
    WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'
  `);
  const rows = stmt.all(effectiveFrom, effectiveTo);
  let revenue = 0;
  let paidRevenue = 0;
  let pendingRevenue = 0;
  let deliveryTotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let itemCount = 0;
  const byDateMap = new Map();
  for (const row of rows) {
    revenue += Number(row.total || 0);
    deliveryTotal += Number(row.delivery || 0);
    discountTotal += row.discount_pct ? Number(row.subtotal || 0) * Number(row.discount_pct) / 100 : 0;
    taxTotal += Number(row.tax_pct ? Number(row.subtotal || 0) * Number(row.tax_pct) / 100 : 0);
    itemCount += Array.isArray(JSON.parse(String(row.items_json || '[]'))) ? JSON.parse(String(row.items_json || '[]')).length : 0;
    if (String(row.status) === 'paid') paidRevenue += Number(row.total || 0);
    if (String(row.status) === 'pending') pendingRevenue += Number(row.total || 0);
    const date = String(row.invoice_date || '');
    if (!byDateMap.has(date)) byDateMap.set(date, { date, revenue: 0, orders: 0 });
    const bucket = byDateMap.get(date);
    bucket.revenue += Number(row.total || 0);
    bucket.orders += 1;
  }
  const byDay = Array.from(byDateMap.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const summary = {
    from: effectiveFrom,
    to: effectiveTo,
    orders: rows.length,
    revenue: round2(revenue),
    paidRevenue: round2(paidRevenue),
    pendingRevenue: round2(pendingRevenue),
    avgOrderValue: rows.length ? round2(revenue / rows.length) : 0,
    deliveryTotal: round2(deliveryTotal),
    discountTotal: round2(discountTotal),
    taxTotal: round2(taxTotal),
    itemCount
  };
  return summary;
}

function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }

function getTopItems(from, to, limit = 10) {
  const effectiveFrom = from || todayStr(-30);
  const effectiveTo = to || todayStr();
  const stmt = db.prepare("SELECT * FROM receipts WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'");
  const rows = stmt.all(effectiveFrom, effectiveTo);
  const map = new Map();
  for (const row of rows) {
    let items = [];
    try { items = JSON.parse(String(row.items_json || '[]')); } catch (error) { items = []; }
    for (const item of items) {
      const name = String(item.name || 'Item');
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      const amount = qty * price;
      const existing = map.get(name) || { name, qty: 0, revenue: 0 };
      existing.qty += qty;
      existing.revenue += amount;
      map.set(name, existing);
    }
  }
  const items = Array.from(map.values()).sort((a, b) => (b.revenue - a.revenue) || (b.qty - a.qty));
  return items.slice(0, Number(limit) || 10);
}

function getTopCustomers(from, to, limit = 10) {
  const effectiveFrom = from || todayStr(-30);
  const effectiveTo = to || todayStr();
  const stmt = db.prepare("SELECT * FROM receipts WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'");
  const rows = stmt.all(effectiveFrom, effectiveTo);
  const map = new Map();
  for (const row of rows) {
    const name = String(row.customer_name || 'Unknown');
    const existing = map.get(name) || { customerName: name, orders: 0, revenue: 0 };
    existing.orders += 1;
    existing.revenue += Number(row.total || 0);
    map.set(name, existing);
  }
  const list = Array.from(map.values()).sort((a, b) => (b.revenue - a.revenue));
  return list.slice(0, Number(limit) || 10);
}

async function telegramRequest(token, method, payload) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data.description || `Telegram API error ${response.status}`));
  return data;
}

async function sendTelegramMessage(token, chatId, text) {
  return telegramRequest(token, 'sendMessage', { chat_id: chatId, text });
}

async function getTelegramBot(token) {
  return telegramRequest(token, 'getMe', {});
}

async function sendTelegramReport(token, chatId, summary) {
  const text = [
    '📊 Mini Receipt Report',
    `Period: ${summary.from} to ${summary.to}`,
    `Orders: ${summary.orders}`,
    `Revenue: ${summary.revenue}`,
    `Paid: ${summary.paidRevenue}`,
    `Pending: ${summary.pendingRevenue}`,
    `Average Order: ${summary.avgOrderValue}`,
    `Items Sold: ${summary.itemCount}`
  ].join('\n');
  return sendTelegramMessage(token, chatId, text);
}

function formatReceiptForTelegram(receipt) {
  const lines = [
    '🧾 Mini Receipt',
    `Invoice: ${receipt.invoiceNo}`,
    `Date: ${receipt.invoiceDate}`,
    `Customer: ${receipt.customerName || '-'}`,
    `Status: ${receipt.status}`,
    `Total: ${receipt.total}`
  ];
  if (Array.isArray(receipt.items) && receipt.items.length) {
    lines.push('Items:');
    for (const item of receipt.items) {
      lines.push(`- ${item.name} x${item.qty} = ${item.qty * item.price}`);
    }
  }
  return lines.join('\n');
}

async function handleTelegramNotification(receipt) {
  const token = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (!token || !chatId) return false;
  const text = formatReceiptForTelegram(receipt);
  const result = await sendTelegramMessage(token, chatId, text);
  db.prepare('INSERT INTO telegram_messages (chat_id, text, status, response, created_at) VALUES (?, ?, ?, ?, ?)').run(chatId, text, 'sent', JSON.stringify(result), nowISO());
  return true;
}

async function saveInvoiceToSupabase(invoice) {
  const url = String(getSetting('supabase_url') || '').trim().replace(/\/+$/, '');
  const anonKey = String(getSetting('supabase_anonKey') || '').trim();
  const table = String(getSetting('supabase_table') || 'invoices').trim() || 'invoices';
  if (!url || !anonKey) throw new Error('Supabase is not configured');
  const response = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      invoice_no: invoice.invoiceNo,
      customer_name: invoice.customerName,
      customer_phone: invoice.customerPhone,
      shop_name: invoice.shopName,
      invoice_date: invoice.invoiceDate,
      payment_method: invoice.paymentMethod,
      status: invoice.status,
      subtotal: invoice.subtotal,
      discount_pct: invoice.discountPct,
      tax_pct: invoice.taxPct,
      delivery: invoice.delivery,
      total: invoice.total,
      note: invoice.note,
      items: invoice.items
    }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(data?.message || data?.error_description || `Supabase error ${response.status}`));
  return data;
}

const telegramTimer = setInterval(() => {
  try {
    const enabled = getSetting('telegram_daily_enabled') === '1';
    const dailyTime = getSetting('telegram_daily_time') || '21:00';
    const lastDailyDate = getSetting('telegram_daily_last_date') || '';
    const nowDate = new Date();
    const nowHHMM = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
    const today = todayStr();
    if (!enabled || nowHHMM !== dailyTime) return;
    if (lastDailyDate === today) return;
    void (async () => {
      const summary = getReportSummary(today, today);
      const token = getSetting('telegram_bot_token');
      const chatId = getSetting('telegram_chat_id');
      if (token && chatId) {
        const result = await sendTelegramReport(token, chatId, summary);
        db.prepare('INSERT INTO telegram_messages (chat_id, text, status, response, created_at) VALUES (?, ?, ?, ?, ?)').run(chatId, `Daily report ${today}`, 'sent', JSON.stringify(result), nowISO());
      }
      setSetting('telegram_daily_last_date', today);
    })();
  } catch (error) {
    // Ignore scheduling errors; next interval will retry.
  }
}, 60 * 1000);

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function setAdminSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [`admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`]);
}

function getRequestUser(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  return user;
}

async function apiHandler(req, res, parts) {
  const method = req.method;
  const path = parts[0] || '';
  const route = parts[1] || '';

  if (method === 'GET' && path === 'api' && route === 'auth') {
    return sendJson(res, 200, publicAuthState(req));
  }

  if (method === 'POST' && path === 'api' && route === 'setup') {
    const body = await readJsonBody(req);
    if (adminUserExists()) return sendJson(res, 400, { error: 'Setup already completed' });
    const password = String(body.password || '');
    if (password.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters' });
    createAdminUser(password);
    const user = getAdminUser();
    const token = createSession(Number(user.id));
    setAdminSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, authenticated: true, needsSetup: false });
  }

  if (method === 'POST' && path === 'api' && route === 'login') {
    const body = await readJsonBody(req);
    const user = getAdminUser();
    if (!user || !hashPassword(body.password || '', user.salt, user.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid password' });
    }
    const token = createSession(Number(user.id));
    setAdminSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, authenticated: true, needsSetup: false });
  }

  if (method === 'POST' && path === 'api' && route === 'logout') {
    const cookies = String(req.headers.cookie || '');
    const token = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith('admin_session=')) || '';
    destroySession(token.split('=')[1]);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const user = getRequestUser(req, res);
  if (!user) return;

  if (method === 'GET' && path === 'api' && route === 'settings') {
    return sendJson(res, 200, {
      shopName: getSetting('shop_name', 'Mini Receipt'),
      currency: getSetting('currency', '$'),
      supabaseUrl: getSetting('supabase_url', ''),
      supabaseAnonKey: getSetting('supabase_anonKey', ''),
      supabaseTable: getSetting('supabase_table', 'invoices')
    });
  }

  if (method === 'PUT' && path === 'api' && route === 'settings') {
    const body = await readJsonBody(req);
    setSetting('shop_name', String(body.shopName || 'Mini Receipt'));
    setSetting('currency', String(body.currency || '$'));
    setSetting('supabase_url', String(body.supabaseUrl || ''));
    setSetting('supabase_anonKey', String(body.supabaseAnonKey || ''));
    setSetting('supabase_table', String(body.supabaseTable || 'invoices'));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && path === 'api' && route === 'supabase' && parts[2] === 'save') {
    const body = await readJsonBody(req);
    const saved = await saveInvoiceToSupabase(body.invoice || body);
    return sendJson(res, 200, { ok: true, saved });
  }

  if (method === 'POST' && path === 'api' && route === 'receipts' && method === 'POST') {
    const body = await readJsonBody(req);
    const receipt = insertReceipt({
      invoiceNo: body.invoiceNo,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      shopName: body.shopName,
      invoiceDate: body.invoiceDate,
      paymentMethod: body.paymentMethod,
      status: body.status,
      discountPct: body.discountPct,
      taxPct: body.taxPct,
      delivery: body.delivery,
      note: body.note,
      items: body.items
    });
    void handleTelegramNotification(receipt);
    return sendJson(res, 201, receipt);
  }

  if (method === 'PUT' && path === 'api' && route === 'receipts') {
    const id = Number(parts[2] || 0);
    const body = await readJsonBody(req);
    const receipt = updateReceipt(id, body);
    void handleTelegramNotification(receipt);
    return sendJson(res, 200, receipt);
  }

  if (method === 'DELETE' && path === 'api' && route === 'receipts') {
    const id = Number(parts[2] || 0);
    deleteReceipt(id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && path === 'api' && route === 'receipts') {
    const url = new URL(req.url, 'http://localhost');
    const result = listReceipts({
      from: url.searchParams.get('from') || '',
      to: url.searchParams.get('to') || '',
      status: url.searchParams.get('status') || '',
      search: url.searchParams.get('search') || '',
      limit: Number(url.searchParams.get('limit') || 200),
      offset: Number(url.searchParams.get('offset') || 0)
    });
    return sendJson(res, 200, { receipts: result, count: result.length });
  }

  if (method === 'GET' && path === 'api' && route === 'receipts' && parts[2]) {
    const receipt = getReceiptById(Number(parts[2]));
    if (!receipt) return sendJson(res, 404, { error: 'Receipt not found' });
    return sendJson(res, 200, { receipt });
  }

  const reportsMatch = path === 'api' && route === 'reports';
  if (method === 'GET' && reportsMatch) {
    const reportType = String(parts[2] || '');
    const url = new URL(req.url, 'http://localhost');
    const from = url.searchParams.get('from') || todayStr(-30);
    const to = url.searchParams.get('to') || todayStr();
    if (reportType === 'summary') return sendJson(res, 200, getReportSummary(from, to));
    if (reportType === 'daily') {
      const summary = getReportSummary(from, to);
      const stmt = db.prepare("SELECT * FROM receipts WHERE invoice_date BETWEEN ? AND ? AND status != 'cancelled'");
      const rows = stmt.all(from, to);
      const grouped = new Map();
      for (const row of rows) grouped.set(String(row.invoice_date), Number(row.total || 0));
      const daily = [];
      const start = new Date(`${from}T00:00:00`);
      const end = new Date(`${to}T00:00:00`);
      for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
        const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        daily.push({ date, revenue: round2(grouped.get(date) || 0), orders: 0 });
      }
      const orderMap = new Map();
      for (const row of rows) {
        const date = String(row.invoice_date || '');
        orderMap.set(date, (orderMap.get(date) || 0) + 1);
      }
      for (const entry of daily) entry.orders = orderMap.get(entry.date) || 0;
      return sendJson(res, 200, { daily });
    }
    if (reportType === 'top-items') {
      const limit = Number(url.searchParams.get('limit') || 10);
      return sendJson(res, 200, { items: getTopItems(from, to, limit) });
    }
    if (reportType === 'top-customers') {
      const limit = Number(url.searchParams.get('limit') || 10);
      return sendJson(res, 200, { customers: getTopCustomers(from, to, limit) });
    }
    return sendJson(res, 404, { error: 'Report not found' });
  }

  const exportMatch = method === 'GET' && path === 'api' && route === 'reports' && parts[2] === 'export';
  if (exportMatch) {
    const url = new URL(req.url, 'http://localhost');
    const from = url.searchParams.get('from') || todayStr(-30);
    const to = url.searchParams.get('to') || todayStr();
    const rows = listReceipts({ from, to, limit: 10000 });
    const header = 'id,invoice_no,customer_name,customer_phone,invoice_date,payment_method,status,subtotal,discount_pct,tax_pct,delivery,total,note,items_json,created_at,updated_at';
    const lines = [header];
    for (const row of rows) lines.push([row.id, row.invoiceNo, row.customerName, row.customerPhone, row.invoiceDate, row.paymentMethod, row.status, row.subtotal, row.discountPct, row.taxPct, row.delivery, row.total, row.note, JSON.stringify(row.items), row.createdAt, row.updatedAt].join(','));
    return sendText(res, 200, `${lines.join('\n')}\n`, 'text/csv; charset=utf-8');
  }

  if (method === 'GET' && path === 'api' && route === 'telegram') {
    const token = getSetting('telegram_bot_token');
    const chatId = getSetting('telegram_chat_id');
    return sendJson(res, 200, {
      configured: Boolean(token && chatId),
      token: Boolean(token),
      chatId: Boolean(chatId),
      botUsername: getSetting('telegram_bot_username') || '',
      notifyReceipts: getSetting('telegram_notify_receipts') === '1',
      dailyEnabled: getSetting('telegram_daily_enabled') === '1',
      dailyTime: getSetting('telegram_daily_time') || '21:00',
      lastDailyDate: getSetting('telegram_daily_last_date') || '',
      messages: db.prepare('SELECT id, chat_id, text, status, response, created_at FROM telegram_messages ORDER BY id DESC LIMIT 50').all()
    });
  }

  if (method === 'POST' && path === 'api' && route === 'telegram') {
    const body = await readJsonBody(req);
    const token = String(body.token || getSetting('telegram_bot_token'));
    const chatId = String(body.chatId || getSetting('telegram_chat_id'));
    if (!token || !chatId) return sendJson(res, 400, { error: 'Bot token and chat ID are required' });
    const me = await getTelegramBot(token);
    setSetting('telegram_bot_token', token);
    setSetting('telegram_chat_id', chatId);
    setSetting('telegram_bot_username', String(me.result?.username || ''));
    setSetting('telegram_notify_receipts', body.notifyReceipts === undefined ? getSetting('telegram_notify_receipts') : String(body.notifyReceipts ? '1' : '0'));
    setSetting('telegram_daily_enabled', body.dailyEnabled === undefined ? getSetting('telegram_daily_enabled') : String(body.dailyEnabled ? '1' : '0'));
    setSetting('telegram_daily_time', String(body.dailyTime || '21:00'));
    return sendJson(res, 200, { ok: true, botUsername: String(me.result?.username || '') });
  }

  if (method === 'POST' && path === 'api' && route === 'telegram' && parts[2] === 'test') {
    const body = await readJsonBody(req);
    const token = String(getSetting('telegram_bot_token') || body.token || '');
    const chatId = String(getSetting('telegram_chat_id') || body.chatId || '');
    if (!token || !chatId) return sendJson(res, 400, { error: 'Bot token and chat ID are required' });
    const result = await sendTelegramMessage(token, chatId, '✅ Mini Receipt Telegram test message');
    db.prepare('INSERT INTO telegram_messages (chat_id, text, status, response, created_at) VALUES (?, ?, ?, ?, ?)').run(chatId, 'Telegram test message', 'sent', JSON.stringify(result), nowISO());
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && path === 'api' && route === 'telegram' && parts[2] === 'send') {
    const body = await readJsonBody(req);
    const token = String(getSetting('telegram_bot_token') || '');
    const chatId = String(getSetting('telegram_chat_id') || '');
    const text = String(body.text || '');
    if (!token || !chatId || !text) return sendJson(res, 400, { error: 'Bot token, chat ID, and message text are required' });
    const result = await sendTelegramMessage(token, chatId, text);
    db.prepare('INSERT INTO telegram_messages (chat_id, text, status, response, created_at) VALUES (?, ?, ?, ?, ?)').run(chatId, text, 'sent', JSON.stringify(result), nowISO());
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && path === 'api' && route === 'telegram' && parts[2] === 'report') {
    const body = await readJsonBody(req);
    const token = String(getSetting('telegram_bot_token') || '');
    const chatId = String(getSetting('telegram_chat_id') || '');
    const from = String(body.from || todayStr(-30));
    const to = String(body.to || todayStr());
    if (!token || !chatId) return sendJson(res, 400, { error: 'Bot token and chat ID are required' });
    const summary = getReportSummary(from, to);
    const result = await sendTelegramReport(token, chatId, summary);
    db.prepare('INSERT INTO telegram_messages (chat_id, text, status, response, created_at) VALUES (?, ?, ?, ?, ?)').run(chatId, `Report ${from} to ${to}`, 'sent', JSON.stringify(result), nowISO());
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && path === 'api' && route === 'telegram' && parts[2] === 'messages') {
    const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 50);
    const messages = db.prepare('SELECT id, chat_id, text, status, response, created_at FROM telegram_messages ORDER BY id DESC LIMIT ?').all(Number(limit));
    return sendJson(res, 200, { messages });
  }

  if (method === 'PUT' && path === 'api' && route === 'password') {
    const body = await readJsonBody(req);
    const user = getAdminUser();
    if (!user || !hashPassword(body.currentPassword || '', user.salt, user.password_hash)) {
      return sendJson(res, 401, { error: 'Current password is incorrect' });
    }
    if (String(body.newPassword || '').length < 6) return sendJson(res, 400, { error: 'New password must be at least 6 characters' });
    updateAdminPassword(String(body.newPassword));
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(path.join(__dirname))) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  const type = types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  let data;
  try { data = fs.readFileSync(filePath); } catch (error) { sendText(res, 404, 'Not found'); return; }
  res.writeHead(200, { 'Content-Type': type });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
      await apiHandler(req, res, parts);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') return serveStatic(req, res, '/index.html');
    if (pathname === '/admin') return serveStatic(req, res, '/admin.html');
    if (pathname === '/admin/' || pathname.startsWith('/admin/')) return serveStatic(req, res, pathname);
    if (pathname === '/script.js') return serveStatic(req, res, '/script.js');
    if (pathname === '/admin.js') return serveStatic(req, res, '/admin.js');
    if (pathname === '/admin.css') return serveStatic(req, res, '/admin.css');

    return sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: String(error && error.message || error) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mini Receipt admin server listening on http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
