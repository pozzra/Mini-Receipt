'use strict';

const state = {
    auth: { authenticated: false, needsSetup: false, user: null, shopName: 'Mini Receipt', currency: '$' },
    settings: { shopName: 'Mini Receipt', currency: '$' },
    telegram: {
        configured: false,
        token: false,
        chatId: false,
        botUsername: '',
        notifyReceipts: false,
        dailyEnabled: false,
        dailyTime: '21:00',
        lastDailyDate: '',
        messages: []
    },
    summary: { orders: 0, revenue: 0, paidRevenue: 0, pendingRevenue: 0, avgOrderValue: 0, itemCount: 0 },
    reports: { from: '', to: '', daily: [], topItems: [], topCustomers: [] }
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
    const response = await fetch(path, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

function showToast(message, isError = false) {
    let toast = $('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-xs font-semibold ${isError ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`;
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 2600);
}

async function init() {
    state.auth = await api('/api/auth');
    if (state.auth.needsSetup) {
        $('setupSection').classList.remove('hidden');
        $('loginSection').classList.add('hidden');
    } else {
        $('setupSection').classList.add('hidden');
        $('loginSection').classList.remove('hidden');
    }
    if (state.auth.authenticated) {
        $('authView').classList.add('hidden');
        $('adminApp').classList.remove('hidden');
        await Promise.all([loadSettings(), loadTelegram(), loadReports()]);
        switchTab('dashboard');
    } else {
        $('adminApp').classList.add('hidden');
        $('loginSection').classList.remove('hidden');
    }
    updateAuthScreen();
}

function updateAuthScreen() {
    const needsSetup = state.auth.needsSetup;
    $('setupSection').classList.toggle('hidden', !needsSetup);
    $('loginSection').classList.toggle('hidden', needsSetup);
}

async function setupSubmit() {
    const password = $('setupPassword').value;
    await api('/api/setup', { method: 'POST', body: { password } });
    state.auth = await api('/api/auth');
    updateAuthScreen();
    if (state.auth.authenticated) await openApp();
}

async function loginSubmit() {
    const password = $('loginPassword').value;
    await api('/api/login', { method: 'POST', body: { password } });
    state.auth = await api('/api/auth');
    updateAuthScreen();
    if (state.auth.authenticated) await openApp();
}

async function logout() {
    await api('/api/logout', { method: 'POST' });
    state.auth = { authenticated: false, needsSetup: false, user: null, shopName: 'Mini Receipt', currency: '$' };
    $('adminApp').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('loginSection').classList.remove('hidden');
    $('setupSection').classList.add('hidden');
}

async function openApp() {
    $('authView').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    await Promise.all([loadSettings(), loadTelegram(), loadReports()]);
    switchTab('dashboard');
}

function switchTab(tab) {
    document.querySelectorAll('[data-tab]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.tab === tab);
    });
    document.querySelectorAll('section').forEach((section) => {
        if (section.id && section.id.startsWith('tab-')) section.classList.toggle('hidden', section.id !== `tab-${tab}`);
    });
}

async function loadSettings() {
    state.settings = await api('/api/settings');
    $('settingShopName').value = state.settings.shopName;
    $('settingCurrency').value = state.settings.currency;
    $('settingSupabaseUrl').value = state.settings.supabaseUrl || '';
    $('settingSupabaseAnonKey').value = state.settings.supabaseAnonKey || '';
    $('settingSupabaseTable').value = state.settings.supabaseTable || 'invoices';
    $('shopNameText').textContent = state.settings.shopName;
}

async function saveSettings() {
    await api('/api/settings', { method: 'PUT', body: { shopName: $('settingShopName').value, currency: $('settingCurrency').value, supabaseUrl: $('settingSupabaseUrl').value, supabaseAnonKey: $('settingSupabaseAnonKey').value, supabaseTable: $('settingSupabaseTable').value } });
    await loadSettings();
    showToast('Settings saved');
}

async function loadTelegram() {
    state.telegram = await api('/api/telegram');
    $('telegramToken').value = state.telegram.token ? '••••••••••••••••' : '';
    $('telegramChatId').value = state.telegram.chatId ? String(state.telegram.chatId) : '';
    $('telegramNotifyReceipts').checked = state.telegram.notifyReceipts;
    $('telegramDailyEnabled').checked = state.telegram.dailyEnabled;
    $('telegramDailyTime').value = state.telegram.dailyTime;
    renderTelegramLogs();
}

async function loadReports() {
    const from = state.reports.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const to = state.reports.to || new Date().toISOString().slice(0, 10);
    state.reports.from = from;
    state.reports.to = to;
    $('reportFrom').value = from;
    $('reportTo').value = to;
    await Promise.all([
        api(`/api/reports/summary?from=${from}&to=${to}`).then((data) => { state.summary = data; renderSummary(); }),
        api(`/api/reports/daily?from=${from}&to=${to}`).then((data) => { state.reports.daily = data.daily || []; renderDailyChart(); }),
        api(`/api/reports/top-items?from=${from}&to=${to}&limit=10`).then((data) => { state.reports.topItems = data.items || []; renderTopItems(); }),
        api(`/api/reports/top-customers?from=${from}&to=${to}&limit=10`).then((data) => { state.reports.topCustomers = data.customers || []; renderTopCustomers(); })
    ]);
}

function renderSummary() {
    $('statTodayRevenue').textContent = fmtMoney(state.summary.revenue);
    $('statMonthRevenue').textContent = fmtMoney(state.summary.revenue);
    $('statOrders').textContent = String(state.summary.orders);
    $('statAvgOrder').textContent = fmtMoney(state.summary.avgOrderValue);
    $('reportRevenue').textContent = fmtMoney(state.summary.revenue);
    $('reportOrders').textContent = String(state.summary.orders);
    $('reportPaid').textContent = fmtMoney(state.summary.paidRevenue);
    $('reportPending').textContent = fmtMoney(state.summary.pendingRevenue);
}

function renderDailyChart() {
    const container = $('dailyChart');
    container.innerHTML = '';
    const max = Math.max(1, ...state.reports.daily.map((d) => d.revenue));
    for (const day of state.reports.daily) {
        const height = Math.max(2, (day.revenue / max) * 100);
        const bar = document.createElement('div');
        bar.className = 'flex-1';
        bar.title = `${day.date}: ${fmtMoney(day.revenue)} (${day.orders} orders)`;
        bar.innerHTML = `<div class="w-full bg-blue-500 rounded-t" style="height:${height}%"></div>`;
        container.appendChild(bar);
    }
}

function renderTopItems() {
    const container = $('topItems');
    container.innerHTML = '';
    if (!state.reports.topItems.length) { container.innerHTML = '<div class="text-slate-400">No data.</div>'; return; }
    for (const item of state.reports.topItems) {
        const row = document.createElement('div');
        row.className = 'flex justify-between gap-2';
        row.innerHTML = `<span class="text-slate-300">${escapeHtml(item.name)}</span><span class="text-white">${item.qty} sold · ${fmtMoney(item.revenue)}</span>`;
        container.appendChild(row);
    }
}

function renderTopCustomers() {
    const container = $('topCustomers');
    container.innerHTML = '';
    if (!state.reports.topCustomers.length) { container.innerHTML = '<div class="text-slate-400">No data.</div>'; return; }
    for (const customer of state.reports.topCustomers) {
        const row = document.createElement('div');
        row.className = 'flex justify-between gap-2';
        row.innerHTML = `<span class="text-slate-300">${escapeHtml(customer.customerName)}</span><span class="text-white">${customer.orders} orders · ${fmtMoney(customer.revenue)}</span>`;
        container.appendChild(row);
    }
}

function fmtMoney(value) {
    const amount = Number(value || 0);
    return `$${amount.toFixed(2)}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderTelegramLogs() {
    const container = $('telegramLogs');
    container.innerHTML = '';
    if (!state.telegram.messages.length) { container.innerHTML = '<div class="text-slate-400">No messages sent yet.</div>'; return; }
    for (const message of state.telegram.messages.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2';
        row.innerHTML = `<div class="flex justify-between gap-2"><span class="text-slate-300">${escapeHtml(message.chatId)}</span><span class="text-[10px] text-slate-500">${escapeHtml(message.createdAt)}</span></div><div class="text-slate-200 mt-1 whitespace-pre-wrap">${escapeHtml(message.text)}</div><div class="text-[10px] text-slate-500 mt-1">${escapeHtml(message.status)}</div>`;
        container.appendChild(row);
    }
}

/* Dashboard */
async function loadDashboard() {
    const today = new Date().toISOString().slice(0, 10);
    const monthFrom = new Date(new Date().setDate(new Date().getDate() - 29)).toISOString().slice(0, 10);
    const data = await api(`/api/reports/summary?from=${monthFrom}&to=${today}`);
    Object.assign(state.summary, data);
    renderSummary();
    const recent = await api(`/api/receipts?from=&to=${today}&limit=10`);
    const container = $('recentReceipts');
    container.innerHTML = '';
    for (const receipt of recent.receipts || []) {
        const row = document.createElement('div');
        row.className = 'flex justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2';
        row.innerHTML = `<span>${escapeHtml(receipt.invoiceNo)} · ${escapeHtml(receipt.customerName || '-')}</span><span class="text-white">${fmtMoney(receipt.total)}</span>`;
        container.appendChild(row);
    }
}

/* Receipts */
async function loadReceipts() {
    const params = new URLSearchParams();
    const search = $('receiptSearch').value.trim();
    const status = $('receiptStatusFilter').value;
    const from = $('receiptFrom').value;
    const to = $('receiptTo').value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', '200');
    const data = await api(`/api/receipts?${params.toString()}`);
    renderReceipts(data.receipts || []);
}

function renderReceipts(receipts) {
    const tbody = $('receiptTableBody');
    tbody.innerHTML = '';
    for (const receipt of receipts) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${receipt.id}</td>
            <td>${escapeHtml(receipt.invoiceNo)}</td>
            <td>${escapeHtml(receipt.customerName || '-')}</td>
            <td>${escapeHtml(receipt.invoiceDate)}</td>
            <td>${escapeHtml(receipt.status)}</td>
            <td class="text-right">${fmtMoney(receipt.total)}</td>
            <td class="text-right">
                <button class="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 mr-1" data-action="edit" data-id="${receipt.id}">Edit</button>
                <button class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300" data-action="delete" data-id="${receipt.id}">Delete</button>
            </td>
        `;
        tbody.appendChild(row);
    }
}

async function saveReceipt() {
    const items = readReceiptItems();
    const payload = {
        invoiceNo: $('receiptInvoiceNo').value.trim(),
        customerName: $('receiptCustomerName').value.trim(),
        customerPhone: $('receiptCustomerPhone').value.trim(),
        shopName: $('receiptShopName').value.trim(),
        invoiceDate: $('receiptInvoiceDate').value,
        paymentMethod: $('receiptPaymentMethod').value.trim(),
        status: $('receiptStatus').value,
        discountPct: Number($('receiptDiscountPct').value) || 0,
        taxPct: Number($('receiptTaxPct').value) || 0,
        delivery: Number($('receiptDelivery').value) || 0,
        note: $('receiptNote').value.trim(),
        items
    };
    const totals = computeTotals(items, payload.discountPct, payload.taxPct, payload.delivery);
    payload.subtotal = totals.subtotal;
    payload.total = totals.total;
    if (editingId) {
        await api(`/api/receipts/${editingId}`, { method: 'PUT', body: payload });
        showToast('Receipt updated');
    } else {
        await api('/api/receipts', { method: 'POST', body: payload });
        showToast('Receipt saved');
    }
    editingId = null;
    resetReceiptForm();
    await Promise.all([loadReceipts(), loadDashboard(), loadReports()]);
}

async function deleteReceipt(id) {
    await api(`/api/receipts/${id}`, { method: 'DELETE' });
    showToast('Receipt deleted');
    await Promise.all([loadReceipts(), loadDashboard(), loadReports()]);
}

function resetReceiptForm() {
    editingId = null;
    $('receiptInvoiceNo').value = '';
    $('receiptCustomerName').value = '';
    $('receiptCustomerPhone').value = '';
    $('receiptShopName').value = '';
    $('receiptInvoiceDate').value = new Date().toISOString().slice(0, 10);
    $('receiptPaymentMethod').value = '';
    $('receiptStatus').value = 'paid';
    $('receiptDiscountPct').value = '0';
    $('receiptTaxPct').value = '0';
    $('receiptDelivery').value = '0';
    $('receiptNote').value = '';
    renderItems();
    updateReceiptTotals();
    $('cancelEditBtn').classList.add('hidden');
}

function startEdit(receipt) {
    editingId = receipt.id;
    $('receiptInvoiceNo').value = receipt.invoiceNo;
    $('receiptCustomerName').value = receipt.customerName;
    $('receiptCustomerPhone').value = receipt.customerPhone;
    $('receiptShopName').value = receipt.shopName;
    $('receiptInvoiceDate').value = receipt.invoiceDate;
    $('receiptPaymentMethod').value = receipt.paymentMethod;
    $('receiptStatus').value = receipt.status;
    $('receiptDiscountPct').value = String(receipt.discountPct);
    $('receiptTaxPct').value = String(receipt.taxPct);
    $('receiptDelivery').value = String(receipt.delivery);
    $('receiptNote').value = receipt.note;
    renderItems(receipt.items || []);
    updateReceiptTotals();
    $('cancelEditBtn').classList.remove('hidden');
    $('receiptFormCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function readReceiptItems() {
    const items = [];
    document.querySelectorAll('#receiptItems [data-item]').forEach((row) => {
        const name = row.querySelector('[data-field="name"]').value.trim();
        const qty = Number(row.querySelector('[data-field="qty"]').value) || 0;
        const price = Number(row.querySelector('[data-field="price"]').value) || 0;
        if (name || qty || price) items.push({ name, qty, price });
    });
    return items;
}

function renderItems(items = []) {
    const container = $('receiptItems');
    container.innerHTML = '';
    if (!items.length) items = [{ name: '', qty: 1, price: 0 }];
    items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-2 md:grid-cols-12 gap-2 items-center mb-2';
        row.dataset.item = '';
        row.innerHTML = `
            <input class="admin-input md:col-span-6" data-field="name" placeholder="Item name" value="${escapeHtml(item.name)}">
            <input class="admin-input md:col-span-2" data-field="qty" type="number" min="0" step="1" value="${item.qty}">
            <input class="admin-input md:col-span-2" data-field="price" type="number" min="0" step="0.01" value="${item.price}">
            <button type="button" class="md:col-span-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300" data-remove-item="${index}">Remove</button>
        `;
        container.appendChild(row);
    });
}

function readReceiptItemsFromDom() {
    const items = [];
    document.querySelectorAll('#receiptItems [data-item]').forEach((row) => {
        const name = row.querySelector('[data-field="name"]').value.trim();
        const qty = Number(row.querySelector('[data-field="qty"]').value) || 0;
        const price = Number(row.querySelector('[data-field="price"]').value) || 0;
        if (name || qty || price) items.push({ name, qty, price });
    });
    return items;
}

function updateReceiptTotals() {
    const items = readReceiptItemsFromDom();
    const totals = computeTotals(items, Number($('receiptDiscountPct').value) || 0, Number($('receiptTaxPct').value) || 0, Number($('receiptDelivery').value) || 0);
    $('receiptTotalsText').textContent = `subtotal ${fmtMoney(totals.subtotal)} · discount ${fmtMoney(totals.discount)} · tax ${fmtMoney(totals.tax)}`;
    $('receiptTotalValue').textContent = fmtMoney(totals.total);
}

function computeTotals(items, discountPct, taxPct, delivery) {
    const subtotal = (items || []).reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0), 0);
    const discount = subtotal * (Number(discountPct) || 0) / 100;
    const taxBase = subtotal - discount;
    const tax = taxBase * (Number(taxPct) || 0) / 100;
    const total = taxBase + tax + (Number(delivery) || 0);
    return { subtotal, discount, tax, total };
}

/* Telegram */
async function saveTelegram() {
    const payload = {
        token: $('telegramToken').value,
        chatId: $('telegramChatId').value,
        notifyReceipts: $('telegramNotifyReceipts').checked,
        dailyEnabled: $('telegramDailyEnabled').checked,
        dailyTime: $('telegramDailyTime').value
    };
    const data = await api('/api/telegram', { method: 'POST', body: payload });
    await loadTelegram();
    showToast(`Telegram bot saved${data.botUsername ? ` (@${data.botUsername})` : ''}`);
}

async function sendCustomTelegram() {
    const text = $('customTelegramText').value.trim();
    await api('/api/telegram/send', { method: 'POST', body: { text } });
    await loadTelegram();
    showToast('Telegram message sent');
}

async function sendTelegramReportNow() {
    const from = $('reportFrom').value;
    const to = $('reportTo').value;
    await api('/api/telegram/report', { method: 'POST', body: { from, to } });
    await loadTelegram();
    showToast('Telegram report sent');
}

async function testTelegram() {
    await api('/api/telegram/test', { method: 'POST', body: {} });
    await loadTelegram();
    showToast('Telegram test sent');
}

/* Settings */
async function changePassword() {
    const current = $('currentPassword').value;
    const next = $('newPassword').value;
    await api('/api/password', { method: 'PUT', body: { currentPassword: current, newPassword: next } });
    showToast('Password changed');
}

/* Camera barcode / QR scanner */
let scannerStream = null;
let scannerTimer = null;
let scannerActive = false;
let scannerStatusText = 'Idle';
let scanResultValue = '';
let scanResultPayload = null;

async function startScanner() {
    if (scannerActive) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        $('scannerStatus').textContent = 'Camera API is not supported on this browser.';
        return;
    }
    try {
        scannerActive = true;
        $('scannerStatus').textContent = 'Starting camera...';
        scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const video = $('scannerVideo');
        video.srcObject = scannerStream;
        await video.play();
        const canvas = $('scannerCanvas');
        const context = canvas.getContext('2d');
        if (!window.BarcodeDetector) {
            $('scannerStatus').textContent = 'BarcodeDetector is not supported on this browser.';
            stopScanner();
            return;
        }
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
        scannerTimer = setInterval(async () => {
            if (scannerActive && video.readyState >= 2 && video.videoWidth > 0) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const detections = await detector.detect(canvas);
                if (detections.length) {
                    const value = String(detections[0].rawValue || '');
                    handleScanResult(value);
                }
            }
        }, 300);
        $('scannerStatus').textContent = 'Scanning...';
    } catch (error) {
        scannerActive = false;
        if (scannerStream) {
            scannerStream.getTracks().forEach((track) => track.stop());
            scannerStream = null;
        }
        $('scannerStatus').textContent = 'Camera error: ' + (error && error.message ? error.message : 'Unable to start camera');
    }
}

function stopScanner() {
    scannerActive = false;
    if (scannerTimer) {
        clearInterval(scannerTimer);
        scannerTimer = null;
    }
    if (scannerStream) {
        scannerStream.getTracks().forEach((track) => track.stop());
        scannerStream = null;
    }
    const video = $('scannerVideo');
    if (video) video.srcObject = null;
}

window.addEventListener('beforeunload', () => {
    stopScanner();
});

function handleScanResult(value) {
    scanResultValue = value;
    let parsed = null;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch (error) { parsed = null; }
    scanResultPayload = parsed;
    const invoiceNo = String(parsed?.invoiceNo || parsed?.invoice_no || `SCAN-${Date.now()}`);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const subtotal = items.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0), 0);
    const discountPct = Number(parsed?.discountPct ?? parsed?.discount_pct ?? 0);
    const taxPct = Number(parsed?.taxPct ?? parsed?.tax_pct ?? 0);
    const delivery = Number(parsed?.delivery ?? 0);
    const discount = subtotal * discountPct / 100;
    const taxBase = subtotal - discount;
    const tax = taxBase * taxPct / 100;
    const total = taxBase + tax + delivery;
    const invoice = {
        invoiceNo,
        customerName: String(parsed?.customerName || parsed?.customer_name || ''),
        customerPhone: String(parsed?.customerPhone || parsed?.customer_phone || ''),
        shopName: String(parsed?.shopName || parsed?.shop_name || state.settings.shopName || 'Mini Receipt'),
        invoiceDate: String(parsed?.invoiceDate || parsed?.invoice_date || new Date().toISOString().slice(0, 10)),
        paymentMethod: String(parsed?.paymentMethod || parsed?.payment_method || 'QR Scan'),
        status: String(parsed?.status || 'paid'),
        subtotal,
        discountPct,
        taxPct,
        delivery,
        total,
        note: String(parsed?.note || ''),
        items
    };
    $('scanResult').classList.remove('hidden');
    $('scanResultText').textContent = JSON.stringify(invoice, null, 2);
}

async function saveScannedInvoice() {
    if (!scanResultPayload) return;
    const invoice = {
        invoiceNo: String(scanResultPayload.invoiceNo || scanResultPayload.invoice_no || `SCAN-${Date.now()}`),
        customerName: String(scanResultPayload.customerName || scanResultPayload.customer_name || ''),
        customerPhone: String(scanResultPayload.customerPhone || scanResultPayload.customer_phone || ''),
        shopName: String(scanResultPayload.shopName || scanResultPayload.shop_name || state.settings.shopName || 'Mini Receipt'),
        invoiceDate: String(scanResultPayload.invoiceDate || scanResultPayload.invoice_date || new Date().toISOString().slice(0, 10)),
        paymentMethod: String(scanResultPayload.paymentMethod || scanResultPayload.payment_method || 'QR Scan'),
        status: String(scanResultPayload.status || 'paid'),
        subtotal: Number(scanResultPayload.subtotal || 0),
        discountPct: Number(scanResultPayload.discountPct || scanResultPayload.discount_pct || 0),
        taxPct: Number(scanResultPayload.taxPct || scanResultPayload.tax_pct || 0),
        delivery: Number(scanResultPayload.delivery || 0),
        total: Number(scanResultPayload.total || 0),
        note: String(scanResultPayload.note || ''),
        items: Array.isArray(scanResultPayload.items) ? scanResultPayload.items : []
    };
    await api('/api/supabase/save', { method: 'POST', body: { invoice } });
    showToast('Invoice saved to Supabase');
}

function clearScan() {
    scanResultValue = '';
    scanResultPayload = null;
    $('scanResult').classList.add('hidden');
    $('scanResultText').textContent = '';
}

/* Event wiring */
document.addEventListener('DOMContentLoaded', async () => {
    await init();

    $('loginSubmit').addEventListener('click', async () => {
        try {
            await loginSubmit();
        } catch (error) {
            showToast(error.message, true);
        }
    });

    $('setupSubmit').addEventListener('click', async () => {
        try {
            await setupSubmit();
        } catch (error) {
            showToast(error.message, true);
        }
    });

    $('logoutBtn').addEventListener('click', async () => {
        await logout();
    });

    document.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    $('newReceiptBtn').addEventListener('click', resetReceiptForm);
    $('saveReceiptBtn').addEventListener('click', saveReceipt);
    $('cancelEditBtn').addEventListener('click', resetReceiptForm);
    $('addReceiptItemBtn').addEventListener('click', () => {
        const items = readReceiptItemsFromDom();
        items.push({ name: '', qty: 1, price: 0 });
        renderItems(items);
        updateReceiptTotals();
    });
    $('receiptItems').addEventListener('click', (event) => {
        const button = event.target.closest('[data-remove-item]');
        if (!button) return;
        const items = readReceiptItemsFromDom();
        items.splice(Number(button.dataset.removeItem), 1);
        renderItems(items);
        updateReceiptTotals();
    });
    ['receiptInvoiceNo','receiptCustomerName','receiptCustomerPhone','receiptShopName','receiptInvoiceDate','receiptPaymentMethod','receiptStatus','receiptDiscountPct','receiptTaxPct','receiptDelivery','receiptNote','receiptItems'].forEach((id) => {
        const element = $(id);
        if (!element) return;
        element.addEventListener('input', updateReceiptTotals);
        element.addEventListener('change', updateReceiptTotals);
    });

    $('receiptTableBody').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const id = Number(button.dataset.id);
        if (button.dataset.action === 'edit') {
            const data = await api(`/api/receipts/${id}`);
            startEdit(data.receipt);
        } else if (button.dataset.action === 'delete') {
            if (confirm('Delete this receipt?')) await deleteReceipt(id);
        }
    });

    let searchTimer;
    $('receiptSearch').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadReceipts, 300);
    });
    $('receiptStatusFilter').addEventListener('change', loadReceipts);
    $('receiptFrom').addEventListener('change', loadReceipts);
    $('receiptTo').addEventListener('change', loadReceipts);

    $('loadReportsBtn').addEventListener('click', async () => {
        await loadReports();
        showToast('Reports loaded');
    });
    $('sendReportBtn').addEventListener('click', sendTelegramReportNow);

    $('saveTelegramBtn').addEventListener('click', saveTelegram);
    $('testTelegramBtn').addEventListener('click', testTelegram);
    $('sendCustomTelegramBtn').addEventListener('click', sendCustomTelegram);
    $('saveScannedInvoiceBtn').addEventListener('click', saveScannedInvoice);
    $('clearScanBtn').addEventListener('click', clearScan);
    $('startScannerBtn').addEventListener('click', startScanner);
    $('stopScannerBtn').addEventListener('click', stopScanner);
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('changePasswordBtn').addEventListener('click', changePassword);
});

let editingId = null;

document.addEventListener('DOMContentLoaded', () => {
    // Keep the wiring idempotent.
});

async function start() {
    try {
        await init();
    } catch (error) {
        showToast(error.message, true);
        $('authMessage').textContent = error.message;
    }
}

start();
