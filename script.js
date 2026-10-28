'use strict';

/* ==========================================================================
   Mini Receipt Canvas Studio
   Fix: complete rewrite of the truncated UI/script with working canvas
   rendering, sample data, PNG export and thermal/A4 printing.
   ========================================================================== */

const SANS = "'Nokora', 'Kantumruy Pro', 'Noto Sans Khmer', sans-serif";
const MOUL = "'Moul', 'Nokora', serif";
const MONO = "'Courier New', monospace";

const MODES = {
    mini80: { width: 576, label: '80mm Thermal Receipt', maxPreview: 430 },
    mini58: { width: 384, label: '58mm Thermal Receipt', maxPreview: 320 },
    standard: { width: 1200, height: 680, label: 'Standard Voucher', maxPreview: 1100 }
};

const DEFAULT_ITEMS = [
    { name: 'បោកគក់ និងសម្ងួត (5kg)', qty: 1, price: 7 }
];

const SAMPLE_ITEMS = [
    { name: 'បោកគក់ និងសម្ងួត (5kg)', qty: 1, price: 7 },
    { name: 'សម្អាតភួយ (Queen)', qty: 2, price: 4.5 },
    { name: 'អ៊ុតសម្លៀកបំពាក់', qty: 8, price: 0.75 }
];

const DEFAULTS = {
    shopName: 'ម៉ាស៊ីនបោកគក់ សំណាងល្អ',
    shopPhone: '012 345 678',
    shopAddress: 'ផ្ទះលេខ 12, ផ្លូវ 271, សង្កាត់ទឹកថ្លា, ភ្នំពេញ',
    invoiceNo: 'INV-1001',
    customerName: '',
    customerPhone: '',
    discount: 0,
    tax: 0,
    delivery: 0,
    payment: 'សាច់ប្រាក់ (Cash)',
    status: 'paid',
    note: '',
    footerNote: 'សូមអរគុណ! Thank you for your business.'
};

const moneyFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

let mode = 'standard';
let renderQueued = false;

let canvas = null;
let form = null;
let itemsList = null;
let modeSelect = null;

/* Common BLE printer services. Web Bluetooth only exposes services that are
   listed up front, so this list covers the most common thermal printer chips. */
const PRINTER_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ffe5-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb',
    '0000ffb0-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '0000ae30-0000-1000-8000-00805f9b34fb'
];

const PRINTER_STORAGE_KEY = 'receipt.printer.v1';
const PAPER_STORAGE_KEY = 'receipt.paperWidth.v1';
const SERVICE_STORAGE_KEY = 'receipt.serviceUuid.v1';
const AUTO_RECONNECT_COOLDOWN = 10000;

let bluetoothDevice = null;
let printerCharacteristic = null;
let printerDeviceName = '';
let savedPrinter = null;
let lastKnownDevice = null;
let autoReconnectInFlight = false;
let autoReconnectPaused = false;
let autoPromptUsed = false;
let lastAutoConnectAttempt = 0;
let printerState = 'idle';
let printerMessage = '';
let printingInProgress = false;
let printerProgressTimer = null;
let mobileTab = 'edit';

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

function init() {
    canvas = document.getElementById('receiptCanvas');
    form = document.getElementById('receiptForm');
    itemsList = document.getElementById('itemsList');
    modeSelect = document.getElementById('canvasMode');

    if (!canvas || !form || !itemsList) return;

    form.addEventListener('submit', (event) => event.preventDefault());
    form.addEventListener('input', scheduleRender);
    form.addEventListener('change', scheduleRender);
    itemsList.addEventListener('click', onItemsClick);

    const addButton = document.getElementById('addItemBtn');
    if (addButton) {
        addButton.addEventListener('click', () => addItem({ name: '', qty: 1, price: 0 }, true));
    }

    if (modeSelect) {
        mode = MODES[modeSelect.value] ? modeSelect.value : 'standard';
        modeSelect.value = mode;
    }

    initMobileNavigation();
    initPrinterControls();

    resetToDefaults(true);
    render();

    loadFonts().then(() => render());
}

async function loadFonts() {
    if (!document.fonts) return;
    try {
        await Promise.all([
            document.fonts.load('400 16px Nokora'),
            document.fonts.load('600 16px Nokora'),
            document.fonts.load('700 16px Nokora'),
            document.fonts.load('400 20px Moul')
        ]);
        await document.fonts.ready;
    } catch (error) {
        console.warn('Custom fonts could not be loaded; fallback fonts will be used.', error);
    }
}

/* -------------------------------------------------------------------------- */
/* Rendering pipeline                                                         */
/* -------------------------------------------------------------------------- */

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
}

function render() {
    if (!canvas) return;
    updateItemCount();

    const data = readForm();
    if (mode === 'standard') {
        renderStandard(data);
    } else {
        renderThermal(data, MODES[mode].width);
    }
    updatePreviewMeta();
}

function toggleCanvasMode() {
    if (!modeSelect) return;
    const nextMode = modeSelect.value;
    if (!MODES[nextMode]) return;
    mode = nextMode;

    const paperSelect = document.getElementById('btPaper');
    if (paperSelect) {
        if (nextMode === 'mini58') paperSelect.value = '58';
        else if (nextMode === 'mini80') paperSelect.value = '80';
        savePaperWidth(paperSelect.value);
    }

    render();
}

function updatePreviewMeta() {
    const modeName = document.getElementById('modeName');
    const size = document.getElementById('canvasSize');
    if (modeName) modeName.textContent = MODES[mode].label;
    if (size && canvas) size.textContent = `${canvas.width} × ${canvas.height} px`;
}

/* -------------------------------------------------------------------------- */
/* Mobile navigation                                                          */
/* -------------------------------------------------------------------------- */

function initMobileNavigation() {
    document.querySelectorAll('[data-mobile-tab-target]').forEach((button) => {
        button.addEventListener('click', () => setMobileTab(button.dataset.mobileTabTarget));
    });
    setMobileTab(mobileTab, false);
}

function setMobileTab(tab, scroll = true) {
    if (tab !== 'edit' && tab !== 'preview') return;
    mobileTab = tab;
    document.body.dataset.mobileTab = tab;

    document.querySelectorAll('[data-mobile-tab-target]').forEach((button) => {
        const active = button.dataset.mobileTabTarget === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (scroll) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

/* -------------------------------------------------------------------------- */
/* Form data                                                                  */
/* -------------------------------------------------------------------------- */

function readForm() {
    const items = Array.from(itemsList.querySelectorAll('[data-row]'))
        .map((row) => ({
            name: row.querySelector('[data-field="name"]').value.trim(),
            qty: Math.max(0, toNumber(row.querySelector('[data-field="qty"]').value)),
            price: Math.max(0, toNumber(row.querySelector('[data-field="price"]').value))
        }))
        .filter((item) => item.name !== '' || item.qty > 0 || item.price > 0);

    return {
        shopName: fieldValue('shopName') || 'ម៉ាស៊ីនបោកគក់',
        shopPhone: fieldValue('shopPhone'),
        shopAddress: fieldValue('shopAddress'),
        invoiceNo: fieldValue('invoiceNo') || 'INV-0001',
        invoiceDate: fieldValue('invoiceDate'),
        customerName: fieldValue('customerName'),
        customerPhone: fieldValue('customerPhone'),
        discountPct: clamp(toNumber(fieldValue('discount')), 0, 100),
        taxPct: clamp(toNumber(fieldValue('tax')), 0, 100),
        delivery: Math.max(0, toNumber(fieldValue('delivery'))),
        payment: fieldValue('payment') || 'សាច់ប្រាក់ (Cash)',
        status: fieldValue('status') === 'unpaid' ? 'unpaid' : 'paid',
        note: fieldValue('note'),
        footer: fieldValue('footerNote') || 'សូមអរគុណ!',
        items
    };
}

function fieldValue(id) {
    const element = document.getElementById(id);
    return element ? element.value.trim() : '';
}

function setField(id, value) {
    const element = document.getElementById(id);
    if (element) element.value = value;
}

function fillSampleData() {
    if (!itemsList) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    setField('shopName', 'ម៉ាស៊ីនបោកគក់ សំណាងល្អ');
    setField('shopPhone', '012 345 678');
    setField('shopAddress', 'ផ្ទះលេខ 12, ផ្លូវ 271, សង្កាត់ទឹកថ្លា, ភ្នំពេញ');
    setField('invoiceNo', `INV-${stamp}-01`);
    setField('invoiceDate', todayISO());
    setField('customerName', 'លោក សុខ វិចិត្រ');
    setField('customerPhone', '098 765 432');
    setField('discount', '5');
    setField('tax', '0');
    setField('delivery', '1.5');
    setField('payment', 'ABA Pay');
    setField('status', 'paid');
    setField('note', 'សូមមកយកនៅម៉ោង 5:00 ល្ងាច។ អរគុណ!');
    setField('footerNote', 'សូមអរគុណ! Thank you for your business.');

    setItems(SAMPLE_ITEMS);
    render();
}

function resetToDefaults(silent = false) {
    if (!itemsList) return;

    setField('shopName', DEFAULTS.shopName);
    setField('shopPhone', DEFAULTS.shopPhone);
    setField('shopAddress', DEFAULTS.shopAddress);
    setField('invoiceNo', DEFAULTS.invoiceNo);
    setField('invoiceDate', todayISO());
    setField('customerName', DEFAULTS.customerName);
    setField('customerPhone', DEFAULTS.customerPhone);
    setField('discount', DEFAULTS.discount);
    setField('tax', DEFAULTS.tax);
    setField('delivery', DEFAULTS.delivery);
    setField('payment', DEFAULTS.payment);
    setField('status', DEFAULTS.status);
    setField('note', DEFAULTS.note);
    setField('footerNote', DEFAULTS.footerNote);

    setItems(DEFAULT_ITEMS);
    if (!silent) render();
}

/* -------------------------------------------------------------------------- */
/* Item rows                                                                  */
/* -------------------------------------------------------------------------- */

function setItems(items) {
    if (!itemsList) return;
    itemsList.innerHTML = '';

    const list = Array.isArray(items) && items.length ? items : DEFAULT_ITEMS;
    list.forEach((item) => itemsList.appendChild(createItemRow(item)));
    updateItemCount();
}

function createItemRow(item = {}) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.row = '';

    const name = escapeAttr(item.name ?? '');
    const qty = escapeAttr(formatQty(item.qty ?? 1));
    const price = escapeAttr(item.price ?? 0);

    row.innerHTML = `
        <div class="item-cell item-name">
            <input class="input input-sm" type="text" data-field="name" value="${name}"
                placeholder="សេវា / ទំនិញ" aria-label="សេវា ឬទំនិញ">
        </div>
        <div class="item-cell item-qty">
            <span class="item-mini-label">ចំនួន</span>
            <input class="input input-sm text-center" type="number" data-field="qty" value="${qty}"
                min="0" step="1" inputmode="decimal" aria-label="ចំនួន">
        </div>
        <div class="item-cell item-price">
            <span class="item-mini-label">តម្លៃ</span>
            <input class="input input-sm text-right" type="number" data-field="price" value="${price}"
                min="0" step="0.25" inputmode="decimal" aria-label="តម្លៃឯកតា">
        </div>
        <button type="button" class="icon-btn" data-remove aria-label="លុបទំនិញ" title="លុប">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16">
                </path>
            </svg>
        </button>`;

    return row;
}

function addItem(item, focus = false) {
    if (!itemsList) return;

    const row = createItemRow(item);
    itemsList.appendChild(row);
    updateItemCount();

    if (focus) {
        const input = row.querySelector('[data-field="name"]');
        if (input) input.focus();
    }
    scheduleRender();
}

function onItemsClick(event) {
    const removeButton = event.target.closest('[data-remove]');
    if (!removeButton || !itemsList) return;

    const row = removeButton.closest('[data-row]');
    if (!row) return;

    row.remove();
    if (!itemsList.querySelector('[data-row]')) {
        itemsList.appendChild(createItemRow({ name: '', qty: 1, price: 0 }));
    }

    updateItemCount();
    scheduleRender();
}

function updateItemCount() {
    const badge = document.getElementById('itemCount');
    if (!badge || !itemsList) return;

    const count = Array.from(itemsList.querySelectorAll('[data-row]')).filter((row) => {
        const name = row.querySelector('[data-field="name"]').value.trim();
        const qty = toNumber(row.querySelector('[data-field="qty"]').value);
        const price = toNumber(row.querySelector('[data-field="price"]').value);
        return name !== '' || qty > 0 || price > 0;
    }).length;

    badge.textContent = `${count} ទំនិញ`;
}

/* -------------------------------------------------------------------------- */
/* Export / print                                                             */
/* -------------------------------------------------------------------------- */

function downloadCanvas(format = 'png') {
    if (!canvas) return;
    render();
    closePrintSheet();

    const isJpeg = String(format).toLowerCase() === 'jpg' || String(format).toLowerCase() === 'jpeg';
    const mime = isJpeg ? 'image/jpeg' : 'image/png';
    const extension = isJpeg ? 'jpg' : 'png';
    const invoice = fieldValue('invoiceNo') || 'receipt';
    const safeName = invoice.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'receipt';

    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${safeName}-${mode}.${extension}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, mime, isJpeg ? 0.95 : undefined);
}

function printCanvas() {
    if (!canvas) return;
    render();
    closePrintSheet();

    const dataUrl = canvas.toDataURL('image/png');
    let pageStyle = '@page { size: A4 landscape; margin: 8mm; }';
    let imgWidth = '100%';

    if (mode === 'mini80') {
        pageStyle = '@page { size: 80mm auto; margin: 0; }';
        imgWidth = '72mm';
    } else if (mode === 'mini58') {
        pageStyle = '@page { size: 58mm auto; margin: 0; }';
        imgWidth = '48mm';
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        window.alert('សូមអនុញ្ញាត pop-up សម្រាប់ការបោះពុម្ព។');
        return;
    }

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Print Receipt</title>
    <style>
        ${pageStyle}
        html, body {
            margin: 0;
            padding: 0;
            background: #ffffff;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            width: 100%;
        }
        img {
            width: ${imgWidth};
            max-width: 100%;
            height: auto;
            display: block;
            margin: 0 auto;
        }
        @media print {
            html, body { width: auto; }
        }
    </style>
</head>
<body onload="setTimeout(() => { window.print(); window.close(); }, 300);">
    <img src="${dataUrl}" alt="Receipt">
</body>
</html>`);
    printWindow.document.close();
}

/* -------------------------------------------------------------------------- */
/* Print sheet + Bluetooth (ESC/POS) printer                                  */
/* -------------------------------------------------------------------------- */

function readStoredValue(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (error) {
        return null;
    }
}

function writeStoredValue(key, value) {
    try {
        if (value) window.localStorage.setItem(key, value);
        else window.localStorage.removeItem(key);
    } catch (error) {
        // Storage can be unavailable in private mode; printing still works.
    }
}

function loadSavedPrinterPreference() {
    const raw = readStoredValue(PRINTER_STORAGE_KEY);
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.id || parsed.name)) {
            return {
                id: String(parsed.id || ''),
                name: String(parsed.name || '')
            };
        }
    } catch (error) {
        // Ignore malformed saved data.
    }

    return null;
}

function saveSavedPrinterPreference(device) {
    const name = (device && device.name) || printerDeviceName || '';
    const id = device && device.id ? device.id : '';

    if (!id && !name) return;

    savedPrinter = { id, name };
    writeStoredValue(PRINTER_STORAGE_KEY, JSON.stringify(savedPrinter));
}

function restorePrinterPreferences() {
    savedPrinter = loadSavedPrinterPreference();
    if (savedPrinter) {
        printerDeviceName = savedPrinter.name || '';
    }

    const paperSelect = document.getElementById('btPaper');
    if (paperSelect) {
        const paper = readStoredValue(PAPER_STORAGE_KEY);
        if (paper === '58' || paper === '80') paperSelect.value = paper;
    }

    const serviceInput = document.getElementById('btServiceUuid');
    if (serviceInput) {
        const service = readStoredValue(SERVICE_STORAGE_KEY);
        if (service && !serviceInput.value) serviceInput.value = service;
    }
}

function savePaperWidth(value) {
    writeStoredValue(PAPER_STORAGE_KEY, value === '58' ? '58' : '80');
}

function saveServiceUuid(value) {
    writeStoredValue(SERVICE_STORAGE_KEY, String(value || '').trim());
}

function findSavedPrinterDevice(devices) {
    if (!savedPrinter) return null;

    const list = Array.isArray(devices) ? devices : [];
    const byId = savedPrinter.id
        ? list.find((device) => device.id === savedPrinter.id)
        : null;
    if (byId) return byId;

    const savedName = savedPrinter.name.toLowerCase();
    if (!savedName) return null;

    return list.find((device) => (
        device.name && device.name.toLowerCase() === savedName
    )) || null;
}

function disconnectDeviceQuietly(device) {
    if (!device || !device.gatt || !device.gatt.connected) return;

    try {
        device.gatt.disconnect();
    } catch (error) {
        // The connection may already be gone.
    }
}

function clearActivePrinter() {
    const device = bluetoothDevice;

    bluetoothDevice = null;
    printerCharacteristic = null;
    printingInProgress = false;
    hidePrinterProgress();

    disconnectDeviceQuietly(device);

    printerDeviceName = savedPrinter && savedPrinter.name ? savedPrinter.name : '';
}

async function setupPrinterConnection(device) {
    if (!device || !device.gatt) {
        throw new Error('ព្រីនមិនគាំទ្រ Bluetooth GATT');
    }

    const name = device.name || printerDeviceName || 'Bluetooth Printer';
    printerDeviceName = name;

    try {
        device.removeEventListener('gattserverdisconnected', handlePrinterDisconnected);
    } catch (error) {
        // Ignore listener cleanup errors on older browsers.
    }
    device.addEventListener('gattserverdisconnected', handlePrinterDisconnected);

    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();

    let writableCharacteristic = null;

    for (const service of services) {
        let characteristics = [];
        try {
            characteristics = await service.getCharacteristics();
        } catch (error) {
            continue;
        }

        const candidates = characteristics.filter((characteristic) => (
            characteristic.properties.write || characteristic.properties.writeWithoutResponse
        ));

        if (candidates.length) {
            writableCharacteristic = candidates.find((characteristic) => characteristic.properties.write)
                || candidates[0];
            break;
        }
    }

    if (!writableCharacteristic) {
        throw new Error('រកមិនឃើញច្រកសរសេរទៅព្រីន — សូមបញ្ចូល Custom Service UUID');
    }

    bluetoothDevice = device;
    printerCharacteristic = writableCharacteristic;
    printerDeviceName = name;
    lastKnownDevice = device;
    saveSavedPrinterPreference(device);

    return true;
}

async function autoConnectSavedPrinter({ promptIfNeeded = false } = {}) {
    if (autoReconnectInFlight || autoReconnectPaused || printingInProgress) return false;
    if (printerState === 'connecting') return false;
    if (!savedPrinter || (!savedPrinter.id && !savedPrinter.name)) return false;
    if (printerCharacteristic) return true;
    if (!window.isSecureContext || !('bluetooth' in navigator)) return false;

    const canReconnectSilently = Boolean(lastKnownDevice && lastKnownDevice.gatt)
        || typeof navigator.bluetooth.getDevices === 'function';

    if (!canReconnectSilently) {
        // After a full reload the browser usually requires one tap before it
        // will show the Bluetooth picker again. Do that only when the print
        // sheet was opened, and only once per page load.
        if (promptIfNeeded && !autoPromptUsed) {
            autoPromptUsed = true;
            await connectPrinter();
        }
        return false;
    }

    const now = Date.now();
    if (now - lastAutoConnectAttempt < AUTO_RECONNECT_COOLDOWN) return false;
    lastAutoConnectAttempt = now;
    autoReconnectInFlight = true;

    const fallbackName = (savedPrinter && savedPrinter.name) || printerDeviceName || '';
    setPrinterState('connecting', 'កំពុងភ្ជាប់ព្រីនដែលបានរក្សាទុក...');

    let device = null;
    try {
        if (lastKnownDevice && lastKnownDevice.gatt) {
            try {
                await setupPrinterConnection(lastKnownDevice);
                autoReconnectPaused = false;
                setPrinterState('connected', 'បានភ្ជាប់ព្រីនឡើងវិញ');
                return true;
            } catch (knownDeviceError) {
                disconnectDeviceQuietly(lastKnownDevice);
                console.warn('Reconnect to known printer failed:', knownDeviceError);
            }
        }

        if (typeof navigator.bluetooth.getDevices === 'function') {
            const devices = await navigator.bluetooth.getDevices();
            device = findSavedPrinterDevice(devices);
        }

        if (!device) {
            printerDeviceName = fallbackName;
            setPrinterState('idle', 'សូមបើកព្រីន រួចចុច “ភ្ជាប់ព្រីន”');
            return false;
        }

        await setupPrinterConnection(device);
        autoReconnectPaused = false;
        setPrinterState('connected', 'បានភ្ជាប់ព្រីនដោយស្វ័យប្រវត្តិ');
        return true;
    } catch (error) {
        disconnectDeviceQuietly(device);

        bluetoothDevice = null;
        printerCharacteristic = null;
        printerDeviceName = fallbackName;
        setPrinterState('idle', 'មិនអាចភ្ជាប់ស្វ័យប្រវត្តិ — សូមបើកព្រីន រួចចុច “ភ្ជាប់ព្រីន”');
        console.warn('Auto printer connection failed:', error);
        return false;
    } finally {
        autoReconnectInFlight = false;
        updatePrinterUI();
    }
}

function initPrinterControls() {
    const connectButton = document.getElementById('connectPrinterBtn');
    const disconnectButton = document.getElementById('disconnectPrinterBtn');
    const bluetoothPrintButton = document.getElementById('bluetoothPrintBtn');
    const closeButton = document.getElementById('closePrintSheetBtn');
    const backdrop = document.getElementById('printSheetBackdrop');
    const wrapper = document.getElementById('printSheetWrapper');
    const hint = document.getElementById('printerHint');
    const paperSelect = document.getElementById('btPaper');
    const serviceInput = document.getElementById('btServiceUuid');

    restorePrinterPreferences();

    if (connectButton) connectButton.addEventListener('click', connectPrinter);
    if (disconnectButton) disconnectButton.addEventListener('click', disconnectPrinter);
    if (bluetoothPrintButton) bluetoothPrintButton.addEventListener('click', bluetoothPrintReceipt);
    if (closeButton) closeButton.addEventListener('click', closePrintSheet);
    if (backdrop) backdrop.addEventListener('click', closePrintSheet);
    if (wrapper) {
        wrapper.addEventListener('click', (event) => {
            if (event.target === wrapper) closePrintSheet();
        });
    }
    if (paperSelect) {
        paperSelect.addEventListener('change', () => savePaperWidth(paperSelect.value));
    }
    if (serviceInput) {
        serviceInput.addEventListener('change', () => saveServiceUuid(serviceInput.value));
    }

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const sheet = document.getElementById('printSheet');
        if (sheet && !sheet.classList.contains('hidden')) closePrintSheet();
    });

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (!window.isSecureContext) {
        printerState = 'insecure';
        printerMessage = 'Web Bluetooth ត្រូវការ HTTPS';
        if (hint) hint.textContent = 'សូមបើកគេហទំព័រនេះតាម https:// ដើម្បីភ្ជាប់ព្រីន Bluetooth។ សម្រាប់ពេលនេះ អ្នកអាចប្រើ System Print / AirPrint បាន។';
    } else if (!('bluetooth' in navigator)) {
        printerState = 'unsupported';
        printerMessage = 'Browser នេះមិនគាំទ្រ Web Bluetooth';
        if (hint) {
            hint.textContent = isIOS
                ? 'iPhone/iPad មិនគាំទ្រ Web Bluetooth ទេ។ សូមប្រើ System Print / AirPrint ជំនួស។'
                : 'សូមប្រើ Android Chrome/Edge សម្រាប់ការភ្ជាប់ព្រីន Bluetooth។';
        }
    } else {
        printerState = 'idle';
        printerMessage = '';
        if (hint) {
            const canAutoReconnect = Boolean(lastKnownDevice)
                || typeof navigator.bluetooth.getDevices === 'function';

            if (!savedPrinter) {
                hint.textContent = 'Android Chrome/Edge · ត្រូវការ HTTPS · ព្រីននឹងត្រូវចងចាំសម្រាប់ការភ្ជាប់លើកក្រោយ។';
            } else if (canAutoReconnect) {
                hint.textContent = 'ព្រីនបានចងចាំ។ វានឹងព្យាយាមភ្ជាប់ស្វ័យប្រវត្តិ — បើព្រីនបិទ សូមបើកវា រួចចុច “ភ្ជាប់ព្រីន”។';
            } else {
                hint.textContent = 'ព្រីនបានចងចាំ។ ចុច “ភ្ជាប់ព្រីន” ដើម្បីភ្ជាប់ឡើងវិញ។';
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!savedPrinter || printerCharacteristic || autoReconnectInFlight || autoReconnectPaused) return;
        autoConnectSavedPrinter();
    });

    updatePrinterUI();

    if (savedPrinter) {
        setTimeout(() => autoConnectSavedPrinter(), 500);
    }
}

function openPrintSheet() {
    const sheet = document.getElementById('printSheet');
    if (!sheet) return;

    updatePrinterUI();
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('overflow-hidden');

    if (savedPrinter && !printerCharacteristic && !autoReconnectPaused) {
        autoConnectSavedPrinter({ promptIfNeeded: true });
    }

    const closeButton = document.getElementById('closePrintSheetBtn');
    if (closeButton) {
        setTimeout(() => closeButton.focus(), 60);
    }
}

function closePrintSheet() {
    const sheet = document.getElementById('printSheet');
    if (!sheet || sheet.classList.contains('hidden')) return;

    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('overflow-hidden');
}

function updatePrinterUI() {
    const status = document.getElementById('printerStatus');
    const dot = document.getElementById('printerStatusDot');
    const device = document.getElementById('printerDeviceName');
    const connectButton = document.getElementById('connectPrinterBtn');
    const disconnectButton = document.getElementById('disconnectPrinterBtn');
    const printButton = document.getElementById('bluetoothPrintBtn');
    const paperSelect = document.getElementById('btPaper');

    const connected = Boolean(printerCharacteristic);
    const busy = printerState === 'connecting';
    const blocked = printerState === 'unsupported' || printerState === 'insecure';
    const busyPrinting = printerState === 'printing' || printingInProgress;

    if (status) {
        if (printerState === 'connecting') status.textContent = printerMessage || 'កំពុងស្វែងរកព្រីន...';
        else if (busyPrinting) status.textContent = printerMessage || 'កំពុងបញ្ជូនទៅព្រីន...';
        else if (connected) status.textContent = printerMessage || 'បានភ្ជាប់ព្រីន';
        else status.textContent = printerMessage || 'មិនទាន់ភ្ជាប់ព្រីន';
    }

    if (dot) {
        const colors = {
            idle: 'bg-slate-500',
            connecting: 'bg-amber-400 animate-pulse',
            connected: 'bg-emerald-400',
            printing: 'bg-blue-400 animate-pulse',
            error: 'bg-rose-400',
            unsupported: 'bg-slate-600',
            insecure: 'bg-amber-400'
        };
        dot.className = `mt-1.5 h-2 w-2 shrink-0 rounded-full ${colors[printerState] || 'bg-slate-500'}`;
    }

    if (device) {
        const savedSuffix = !connected && savedPrinter && printerDeviceName ? ' · បានរក្សាទុក' : '';
        device.textContent = printerDeviceName
            ? `${printerDeviceName}${savedSuffix}`
            : (connected ? 'Bluetooth thermal printer' : '');
    }

    if (connectButton) {
        connectButton.classList.toggle('hidden', connected);
        connectButton.disabled = blocked || busy || busyPrinting;
        connectButton.textContent = printerState === 'error' ? 'ព្យាយាមម្ដងទៀត' : 'ភ្ជាប់ព្រីន';
    }

    if (disconnectButton) {
        disconnectButton.classList.toggle('hidden', !connected);
        disconnectButton.disabled = busy || busyPrinting;
    }

    if (printButton) {
        printButton.disabled = !connected || busy || busyPrinting;
    }

    if (paperSelect) {
        paperSelect.disabled = busy || busyPrinting;
    }
}

function setPrinterState(state, message = '') {
    printerState = state;
    printerMessage = message;
    updatePrinterUI();
}

async function connectPrinter() {
    if (printingInProgress || printerState === 'connecting') return;

    if (!window.isSecureContext) {
        setPrinterState('insecure', 'Web Bluetooth ត្រូវការ HTTPS');
        return;
    }

    if (!('bluetooth' in navigator)) {
        setPrinterState('unsupported', 'Browser នេះមិនគាំទ្រ Web Bluetooth');
        return;
    }

    if (bluetoothDevice || printerCharacteristic) {
        clearActivePrinter();
    }

    autoReconnectPaused = false;
    setPrinterState('connecting', 'កំពុងស្វែងរកព្រីន...');

    let device = null;
    try {
        const optionalServices = [...PRINTER_SERVICES];
        const customService = getCustomServiceUuid();
        if (customService && !optionalServices.includes(customService)) {
            optionalServices.push(customService);
        }

        device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices
        });

        printerDeviceName = device.name || 'Bluetooth Printer';
        await setupPrinterConnection(device);
        autoReconnectPaused = false;
        setPrinterState('connected', 'បានភ្ជាប់ព្រីន');
    } catch (error) {
        disconnectDeviceQuietly(device);

        bluetoothDevice = null;
        printerCharacteristic = null;
        printerDeviceName = savedPrinter && savedPrinter.name ? savedPrinter.name : '';

        if (error && error.name === 'NotFoundError') {
            setPrinterState('idle', 'បានបោះបង់ការជ្រើសរើសព្រីន');
        } else if (error && error.name === 'SecurityError') {
            setPrinterState('error', 'សិទ្ធិ Bluetooth ត្រូវបានបដិសេធ');
        } else {
            setPrinterState('error', error && error.message ? error.message : 'មិនអាចភ្ជាប់ព្រីនបានទេ');
        }

        console.warn('Printer connection failed:', error);
    }
}

function disconnectPrinter() {
    autoReconnectPaused = true;
    clearActivePrinter();
    setPrinterState('idle', 'បានផ្តាច់ព្រីន — ព្រីននៅរក្សាទុក');
}

function handlePrinterDisconnected() {
    if (!bluetoothDevice && !printerCharacteristic) {
        return;
    }

    const wasPrinting = printingInProgress;
    clearActivePrinter();

    setPrinterState(
        wasPrinting ? 'error' : 'idle',
        wasPrinting ? 'ការភ្ជាប់ព្រីនដាច់អំឡុងពេលបោះពុម្ព' : 'ព្រីនបានផ្តាច់'
    );

    if (!wasPrinting && document.visibilityState === 'visible') {
        setTimeout(() => autoConnectSavedPrinter(), 1500);
    }
}

function normalizeUuid(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (/^[0-9a-f]{4}$/.test(raw)) return `0000${raw}-0000-1000-8000-00805f9b34fb`;
    if (/^[0-9a-f]{8}$/.test(raw)) return `${raw}-0000-1000-8000-00805f9b34fb`;
    return raw;
}

function getCustomServiceUuid() {
    const input = document.getElementById('btServiceUuid');
    const value = normalizeUuid(input ? input.value : '');
    if (!value) return '';

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
        throw new Error('Custom Service UUID មិនត្រឹមត្រូវ');
    }

    return value;
}

async function bluetoothPrintReceipt() {
    if (!printerCharacteristic || printingInProgress) return;

    const paperSelect = document.getElementById('btPaper');
    const paper = paperSelect && paperSelect.value === '58' ? '58' : '80';
    const printMode = paper === '58' ? 'mini58' : 'mini80';

    const printable = document.createElement('canvas');
    paintThermal(printable, readForm(), MODES[printMode].width);

    const initCommand = new Uint8Array([0x1b, 0x40]);           // ESC @
    const rasterCommand = canvasToEscPosRaster(printable);       // GS v 0
    const feedCommand = new Uint8Array([0x1b, 0x64, 0x04]);      // ESC d 4
    const payload = concatBytes([initCommand, rasterCommand, feedCommand]);

    printingInProgress = true;
    setPrinterState('printing', 'កំពុងបញ្ជូនទៅព្រីន...');
    showPrinterProgress(0, 'កំពុងរៀបចំទិន្នន័យ...');

    try {
        await sendPrinterBytes(payload);
        setPrinterState('connected', 'បានបញ្ជូនវិក្កយបត្រទៅព្រីនរួចរាល់');
        showPrinterProgress(100, 'បានបញ្ជូនរួចរាល់ ✓');
        printerProgressTimer = setTimeout(hidePrinterProgress, 4000);
    } catch (error) {
        setPrinterState(
            'error',
            `បរាជ័យ: ${error && error.message ? error.message : 'ការបញ្ជូនមានបញ្ហា'}`
        );
        showPrinterProgress(0, 'ការបញ្ជូនបរាជ័យ');
        console.warn('Bluetooth print failed:', error);
    } finally {
        printingInProgress = false;
        updatePrinterUI();
    }
}

function canvasToEscPosRaster(sourceCanvas) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const context = sourceCanvas.getContext('2d');
    const pixels = context.getImageData(0, 0, width, height).data;
    const bytesPerRow = Math.ceil(width / 8);
    const bitmap = new Uint8Array(bytesPerRow * height);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * bytesPerRow;
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const alpha = pixels[index + 3] / 255;
            const gray = (pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114);
            const onWhite = gray * alpha + 255 * (1 - alpha);

            if (onWhite < 170) {
                bitmap[rowOffset + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }

    const header = new Uint8Array([
        0x1d, 0x76, 0x30, 0x00,
        bytesPerRow & 0xff,
        (bytesPerRow >> 8) & 0xff,
        height & 0xff,
        (height >> 8) & 0xff
    ]);

    return concatBytes([header, bitmap]);
}

async function sendPrinterBytes(bytes) {
    const characteristic = printerCharacteristic;
    if (!characteristic) throw new Error('ព្រីនមិនបានភ្ជាប់');

    const chunkSize = 20;
    const useNoResponse = Boolean(
        characteristic.properties.writeWithoutResponse
        && typeof characteristic.writeValueWithoutResponse === 'function'
    );

    let lastPercent = -1;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        if (!printerCharacteristic) throw new Error('ការភ្ជាប់ព្រីនបានដាច់');

        const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));

        try {
            if (useNoResponse) {
                await characteristic.writeValueWithoutResponse(chunk);
            } else {
                await characteristic.writeValue(chunk);
            }
        } catch (error) {
            await sleep(80);
            if (useNoResponse) {
                await characteristic.writeValueWithoutResponse(chunk);
            } else {
                await characteristic.writeValue(chunk);
            }
        }

        const percent = Math.floor(((offset + chunk.length) / bytes.length) * 100);
        if (percent !== lastPercent) {
            lastPercent = percent;
            showPrinterProgress(percent, `កំពុងបញ្ជូន... ${percent}%`);
        }

        await sleep(useNoResponse ? 6 : 2);
    }

    await sleep(120);
}

function concatBytes(chunks) {
    const totalLength = chunks.reduce((length, chunk) => length + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }

    return output;
}

function showPrinterProgress(percent, text) {
    const wrap = document.getElementById('printerProgressWrap');
    const bar = document.getElementById('printerProgressBar');
    const label = document.getElementById('printerProgressText');

    if (printerProgressTimer) {
        clearTimeout(printerProgressTimer);
        printerProgressTimer = null;
    }

    if (wrap) wrap.classList.remove('hidden');
    if (bar) bar.style.width = `${clamp(percent, 0, 100)}%`;
    if (label) label.textContent = text || `${percent}%`;
}

function hidePrinterProgress() {
    const wrap = document.getElementById('printerProgressWrap');
    const bar = document.getElementById('printerProgressBar');
    const label = document.getElementById('printerProgressText');

    if (printerProgressTimer) {
        clearTimeout(printerProgressTimer);
        printerProgressTimer = null;
    }

    if (wrap) wrap.classList.add('hidden');
    if (bar) bar.style.width = '0%';
    if (label) label.textContent = '';
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function computeTotals(data) {
    const subtotal = data.items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const discount = subtotal * (data.discountPct / 100);
    const taxBase = subtotal - discount;
    const tax = taxBase * (data.taxPct / 100);
    const total = taxBase + tax + data.delivery;

    return { subtotal, discount, tax, total };
}

function fmt(value) {
    return '$' + moneyFormatter.format(Number(value) || 0);
}

function formatQty(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return Number.isInteger(number) ? String(number) : String(parseFloat(number.toFixed(2)));
}

function formatDate(value) {
    if (!value) return '—';
    const parts = String(value).split('-');
    if (parts.length !== 3) return value;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function todayISO() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

function toNumber(value) {
    const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------------- */
/* Canvas drawing helpers                                                     */
/* -------------------------------------------------------------------------- */

function font(weight, size, family = SANS) {
    return `${weight} ${size}px ${family}`;
}

function drawFitted(c, text, maxWidth, weight, size, family, color, x, y, align = 'left') {
    const value = String(text ?? '');
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.fillStyle = color;

    let current = size;
    do {
        c.font = font(weight, current, family);
        if (c.measureText(value).width <= maxWidth || current <= 8) break;
        current -= 0.5;
    } while (current > 8);

    c.font = font(weight, current, family);
    const output = c.measureText(value).width <= maxWidth ? value : truncate(c, value, maxWidth);
    c.fillText(output, x, y);
}

function truncate(c, text, maxWidth) {
    const value = String(text ?? '');
    if (!value) return '';
    if (c.measureText(value).width <= maxWidth) return value;

    let cut = value;
    while (cut.length && c.measureText(cut + '…').width > maxWidth) {
        cut = cut.slice(0, -1);
    }
    return cut ? cut + '…' : '…';
}

function wrapText(c, text, maxWidth) {
    const source = String(text ?? '').replace(/\r/g, '');
    if (!source.trim()) return [];

    const lines = [];
    const paragraphs = source.split('\n');
    const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' })
        : null;

    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) {
            lines.push('');
            continue;
        }

        const segments = segmenter
            ? Array.from(segmenter.segment(paragraph), (part) => part.segment)
            : paragraph.split(/(\s+)/).filter(Boolean);

        let line = '';
        for (const segment of segments) {
            const candidate = line + segment;
            if (c.measureText(candidate).width <= maxWidth) {
                line = candidate;
                continue;
            }

            if (line.trim()) {
                lines.push(line.trimEnd());
                line = '';
            }

            if (c.measureText(segment).width > maxWidth) {
                for (const character of segment) {
                    if (line && c.measureText(line + character).width > maxWidth) {
                        lines.push(line);
                        line = '';
                    }
                    line += character;
                }
            } else {
                line = segment.trimStart();
            }
        }

        if (line.trim()) lines.push(line.trimEnd());
    }

    return lines;
}

function dashLine(c, x1, y, x2, color = '#cbd5e1', dash = [4, 4], width = 1) {
    c.save();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(x1, y);
    c.lineTo(x2, y);
    c.stroke();
    c.restore();
}

function roundRect(c, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + width, y, x + width, y + height, r);
    c.arcTo(x + width, y + height, x, y + height, r);
    c.arcTo(x, y + height, x, y, r);
    c.arcTo(x, y, x + width, y, r);
    c.closePath();
}

function drawWasherIcon(c, centerX, centerY, size, foreground, background) {
    const x = centerX - size / 2;
    const y = centerY - size / 2;

    c.save();
    c.fillStyle = background;
    roundRect(c, x, y, size, size, size * 0.24);
    c.fill();

    c.strokeStyle = foreground;
    c.lineWidth = Math.max(1.2, size * 0.045);

    const doorRadius = size * 0.235;
    c.beginPath();
    c.arc(centerX, centerY + size * 0.055, doorRadius, 0, Math.PI * 2);
    c.stroke();

    c.beginPath();
    c.arc(centerX, centerY + size * 0.055, doorRadius * 0.55, Math.PI * 1.08, Math.PI * 1.92);
    c.stroke();

    c.fillStyle = foreground;
    c.beginPath();
    c.arc(centerX + size * 0.24, centerY - size * 0.26, Math.max(1, size * 0.034), 0, Math.PI * 2);
    c.fill();

    c.fillRect(centerX - size * 0.29, centerY - size * 0.29, size * 0.18, Math.max(1, size * 0.035));
    c.restore();
}

function drawBarcode(c, centerX, top, width, height, value) {
    const text = String(value || 'RECEIPT');
    let hash = 2166136261;

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    let seed = hash >>> 0;
    let x = centerX - width / 2;
    const end = centerX + width / 2;

    c.save();
    c.fillStyle = '#0f172a';

    while (x < end) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const barWidth = 1 + (seed % 3);
        const gap = 1 + ((seed >>> 3) % 2);
        const drawWidth = Math.min(barWidth, end - x);

        if (drawWidth > 0 && seed % 7 !== 0) {
            c.fillRect(x, top, drawWidth, height);
        }
        x += barWidth + gap;
    }

    c.restore();
}

/* -------------------------------------------------------------------------- */
/* Thermal receipt renderer (58mm / 80mm)                                     */
/* -------------------------------------------------------------------------- */

function renderThermal(data, width) {
    paintThermal(canvas, data, width);
    canvas.style.maxWidth = `${MODES[mode].maxPreview}px`;
}

function paintThermal(target, data, width) {
    const measureCanvas = document.createElement('canvas');
    measureCanvas.width = width;
    measureCanvas.height = 16;
    const measureContext = measureCanvas.getContext('2d');
    const height = drawThermal(measureContext, data, width);

    target.width = width;
    target.height = Math.max(120, Math.ceil(height));

    const context = target.getContext('2d', { alpha: false });
    drawThermal(context, data, width);
}

function drawThermal(c, data, width) {
    const compact = width < 450;
    const pad = compact ? 18 : 30;
    const inner = width - pad * 2;
    const ink = '#0f172a';
    const muted = '#64748b';
    const soft = '#94a3b8';
    const line = '#d8e0ea';
    const accent = '#1d4ed8';

    const sizes = {
        tiny: compact ? 9 : 10,
        small: compact ? 10 : 11,
        body: compact ? 11.5 : 13,
        item: compact ? 12 : 14,
        title: compact ? 20 : 26,
        total: compact ? 16 : 19
    };

    const totals = computeTotals(data);
    let y = 0;

    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, width, c.canvas.height);

    c.fillStyle = accent;
    c.fillRect(0, 0, width, compact ? 5 : 7);
    y = compact ? 5 : 7;

    const iconSize = compact ? 30 : 40;
    const iconCenterY = y + (compact ? 19 : 25);
    drawWasherIcon(c, width / 2, iconCenterY, iconSize, '#ffffff', accent);
    y = iconCenterY + iconSize / 2 + (compact ? 23 : 29);

    drawFitted(c, data.shopName, inner, 400, sizes.title, MOUL, ink, width / 2, y, 'center');
    y += compact ? 15 : 19;

    if (data.shopAddress) {
        c.textAlign = 'center';
        c.font = font(600, sizes.small);
        c.fillStyle = '#334155';
        c.fillText(truncate(c, data.shopAddress, inner), width / 2, y);
        y += compact ? 14 : 17;
    }

    if (data.shopPhone) {
        c.textAlign = 'center';
        c.font = font(400, sizes.small);
        c.fillStyle = muted;
        c.fillText(truncate(c, data.shopPhone, inner), width / 2, y);
        y += compact ? 12 : 15;
    }

    y += compact ? 4 : 6;
    dashLine(c, pad, y, width - pad, line);
    y += compact ? 13 : 16;

    c.textAlign = 'center';
    c.font = font(700, sizes.tiny);
    c.fillStyle = accent;
    c.fillText('វិក្កយបត្រ / RECEIPT', width / 2, y);
    y += compact ? 16 : 20;

    const metaRows = [
        ['លេខវិក្កយបត្រ', data.invoiceNo || '—'],
        ['កាលបរិច្ឆេទ', formatDate(data.invoiceDate)],
        ['អតិថិជន', data.customerName || 'ភ្ញៀវទូទៅ']
    ];
    if (data.customerPhone) metaRows.push(['ទូរស័ព្ទ', data.customerPhone]);

    const metaStep = compact ? 17 : 20;
    for (const [label, value] of metaRows) {
        c.textAlign = 'left';
        c.font = font(400, sizes.small);
        c.fillStyle = muted;
        c.fillText(label, pad, y);

        c.textAlign = 'right';
        c.font = font(600, sizes.small);
        c.fillStyle = ink;
        c.fillText(truncate(c, value, inner * 0.62), width - pad, y);
        y += metaStep;
    }

    y += compact ? 4 : 6;
    dashLine(c, pad, y, width - pad, line);
    y += compact ? 14 : 17;

    c.font = font(700, sizes.tiny);
    c.fillStyle = soft;
    c.textAlign = 'left';
    c.fillText('ទំនិញ / សេវា', pad, y);
    c.textAlign = 'right';
    c.fillText('តម្លៃ', width - pad, y);
    y += compact ? 15 : 18;

    if (!data.items.length) {
        c.textAlign = 'center';
        c.fillStyle = muted;
        c.font = font(400, sizes.body);
        c.fillText('មិនមានទំនិញ', width / 2, y);
        y += compact ? 26 : 30;
    } else {
        for (const item of data.items) {
            c.textAlign = 'left';
            c.fillStyle = ink;
            c.font = font(600, sizes.item);
            c.fillText(truncate(c, item.name || 'សេវា', inner - (compact ? 72 : 92)), pad, y);

            c.textAlign = 'right';
            c.font = font(700, sizes.item);
            c.fillText(fmt(item.qty * item.price), width - pad, y);
            y += compact ? 15 : 18;

            c.textAlign = 'left';
            c.fillStyle = muted;
            c.font = font(400, sizes.small);
            c.fillText(`${formatQty(item.qty)} × ${fmt(item.price)}`, pad, y);
            y += compact ? 18 : 22;
        }
    }

    y += compact ? 3 : 5;
    dashLine(c, pad, y, width - pad, line);
    y += compact ? 15 : 18;

    const totalStep = compact ? 19 : 22;
    const totalRow = (label, value, options = {}) => {
        c.textAlign = 'left';
        c.fillStyle = options.muted ? muted : '#334155';
        c.font = font(options.bold ? 700 : 400, sizes.body);
        c.fillText(label, pad, y);

        c.textAlign = 'right';
        c.fillStyle = options.accent ? accent : ink;
        c.font = font(options.bold ? 700 : 600, options.bold ? sizes.total : sizes.body);
        c.fillText(value, width - pad, y);
        y += options.bold ? (compact ? 30 : 36) : totalStep;
    };

    totalRow('សរុបរង', fmt(totals.subtotal), { muted: true });
    if (totals.discount > 0) {
        totalRow(`បញ្ចុះតម្លៃ (${formatQty(data.discountPct)}%)`, '−' + fmt(totals.discount), { muted: true });
    }
    if (totals.tax > 0) {
        totalRow(`ពន្ធ (${formatQty(data.taxPct)}%)`, fmt(totals.tax), { muted: true });
    }
    if (data.delivery > 0) {
        totalRow('សេវាដឹកជញ្ជូន', fmt(data.delivery), { muted: true });
    }

    dashLine(c, pad, y - (compact ? 10 : 12), width - pad, line);
    y += compact ? 4 : 5;
    totalRow('សរុបទូទាត់', fmt(totals.total), { bold: true, accent: true });

    const paymentStep = compact ? 16 : 19;
    c.textAlign = 'left';
    c.font = font(400, sizes.small);
    c.fillStyle = muted;
    c.fillText('ការទូទាត់', pad, y);

    c.textAlign = 'right';
    c.font = font(600, sizes.small);
    c.fillStyle = ink;
    c.fillText(truncate(c, data.payment, inner * 0.55), width - pad, y);
    y += paymentStep;

    c.textAlign = 'left';
    c.font = font(400, sizes.small);
    c.fillStyle = muted;
    c.fillText('ស្ថានភាព', pad, y);

    c.textAlign = 'right';
    c.font = font(700, sizes.small);
    c.fillStyle = data.status === 'paid' ? '#047857' : '#b45309';
    c.fillText(data.status === 'paid' ? 'បានបង់ប្រាក់' : 'មិនទាន់បង់ប្រាក់', width - pad, y);
    y += compact ? 14 : 16;

    if (data.note) {
        y += compact ? 7 : 9;
        dashLine(c, pad, y, width - pad, line);
        y += compact ? 13 : 15;

        c.textAlign = 'left';
        c.font = font(700, sizes.tiny);
        c.fillStyle = soft;
        c.fillText('កំណត់សម្គាល់', pad, y);
        y += compact ? 13 : 15;

        c.font = font(400, sizes.small);
        c.fillStyle = '#334155';
        const noteLines = wrapText(c, data.note, inner).slice(0, 3);
        for (const noteLine of noteLines) {
            c.fillText(noteLine, pad, y);
            y += compact ? 14 : 16;
        }
    }

    y += compact ? 14 : 18;
    c.textAlign = 'center';
    c.fillStyle = accent;
    c.font = font(400, compact ? 12 : 14, MOUL);
    c.fillText(truncate(c, data.footer || 'សូមអរគុណ!', inner), width / 2, y);
    y += compact ? 10 : 13;

    const barcodeWidth = Math.min(inner, compact ? 160 : 230);
    const barcodeHeight = compact ? 30 : 40;
    drawBarcode(c, width / 2, y, barcodeWidth, barcodeHeight, data.invoiceNo);
    y += barcodeHeight + (compact ? 14 : 18);

    c.textAlign = 'center';
    c.font = font(400, sizes.tiny, MONO);
    c.fillStyle = muted;
    c.fillText(data.invoiceNo || 'RECEIPT', width / 2, y);
    y += compact ? 16 : 20;

    c.font = font(400, sizes.tiny);
    c.fillStyle = soft;
    c.fillText('Mini Receipt Canvas Studio', width / 2, y);
    y += compact ? 20 : 28;

    return Math.ceil(y);
}

/* -------------------------------------------------------------------------- */
/* Standard voucher renderer (1200 × 680)                                     */
/* -------------------------------------------------------------------------- */

function renderStandard(data) {
    canvas.width = MODES.standard.width;
    canvas.height = MODES.standard.height;
    canvas.style.maxWidth = `${MODES.standard.maxPreview}px`;

    const context = canvas.getContext('2d', { alpha: false });
    drawStandard(context, data);
}

function drawStandard(c, data) {
    const width = 1200;
    const height = 680;
    const pad = 56;
    const right = width - pad;
    const ink = '#0f172a';
    const muted = '#64748b';
    const soft = '#94a3b8';
    const accent = '#1d4ed8';

    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, width, height);

    c.save();
    c.globalAlpha = 0.055;
    c.fillStyle = '#2563eb';
    c.beginPath();
    c.arc(1040, 20, 220, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(1220, 240, 150, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.fillStyle = accent;
    c.fillRect(0, 0, width, 9);

    drawWasherIcon(c, pad + 26, 76, 52, '#ffffff', accent);
    drawFitted(c, data.shopName, 600, 400, 29, MOUL, ink, pad + 72, 84, 'left');

    c.textAlign = 'left';
    c.font = font(600, 12);
    c.fillStyle = '#475569';
    c.fillText(truncate(c, data.shopAddress, 560), pad + 72, 108);

    c.font = font(400, 12);
    c.fillStyle = muted;
    c.fillText(truncate(c, data.shopPhone, 560), pad + 72, 128);

    c.textAlign = 'right';
    c.font = font(700, 28);
    c.fillStyle = accent;
    c.fillText('INVOICE', right, 86);

    c.font = font(600, 12.5);
    c.fillStyle = ink;
    c.fillText(data.invoiceNo || '—', right, 111);

    c.font = font(400, 12);
    c.fillStyle = muted;
    c.fillText(formatDate(data.invoiceDate), right, 131);

    c.strokeStyle = '#e2e8f0';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(pad, 160);
    c.lineTo(right, 160);
    c.stroke();

    c.textAlign = 'left';
    c.font = font(700, 10.5);
    c.fillStyle = soft;
    c.fillText('វិក្កយបត្រទៅកាន់ / BILL TO', pad, 190);

    c.font = font(700, 18);
    c.fillStyle = ink;
    c.fillText(truncate(c, data.customerName || 'ភ្ញៀវទូទៅ', 520), pad, 217);

    c.font = font(400, 12);
    c.fillStyle = muted;
    c.fillText(data.customerPhone || '—', pad, 239);

    c.textAlign = 'right';
    c.font = font(700, 10.5);
    c.fillStyle = soft;
    c.fillText('ការទូទាត់ / PAYMENT', right, 190);

    c.font = font(600, 14);
    c.fillStyle = ink;
    c.fillText(data.payment, right, 217);

    const statusText = data.status === 'paid' ? 'បានបង់ប្រាក់' : 'មិនទាន់បង់ប្រាក់';
    c.font = font(700, 11);
    const pillWidth = c.measureText(statusText).width + 28;
    const pillHeight = 24;
    const pillX = right - pillWidth;
    const pillY = 226;

    c.fillStyle = data.status === 'paid' ? '#d1fae5' : '#fef3c7';
    roundRect(c, pillX, pillY, pillWidth, pillHeight, 12);
    c.fill();

    c.fillStyle = data.status === 'paid' ? '#047857' : '#b45309';
    c.textAlign = 'center';
    c.fillText(statusText, pillX + pillWidth / 2, pillY + 16);

    const tableTop = 266;
    const headerHeight = 38;
    const rowHeight = 32;
    const columns = {
        index: pad + 14,
        name: pad + 50,
        qty: 790,
        price: 930,
        amount: right - 14
    };

    c.fillStyle = '#f1f5f9';
    roundRect(c, pad, tableTop, right - pad, headerHeight, 8);
    c.fill();

    c.fillStyle = '#475569';
    c.font = font(700, 10.5);
    c.textAlign = 'left';
    c.fillText('#', columns.index, tableTop + 24);
    c.fillText('សេវា / ទំនិញ', columns.name, tableTop + 24);
    c.textAlign = 'right';
    c.fillText('ចំនួន', columns.qty, tableTop + 24);
    c.fillText('តម្លៃឯកតា', columns.price, tableTop + 24);
    c.fillText('សរុប', columns.amount, tableTop + 24);

    let rowY = tableTop + headerHeight;
    const maxRows = 6;
    const displayItems = data.items.slice(0, maxRows);
    if (data.items.length > maxRows) {
        displayItems[maxRows - 1] = null;
    }

    if (!data.items.length) {
        c.textAlign = 'center';
        c.font = font(400, 12);
        c.fillStyle = soft;
        c.fillText('មិនមានទំនិញ', (pad + right) / 2, rowY + 21);
        rowY += rowHeight;
    } else {
        for (let index = 0; index < displayItems.length; index++) {
            const item = displayItems[index];

            if (index % 2 === 0) {
                c.fillStyle = '#fbfdff';
                c.fillRect(pad, rowY, right - pad, rowHeight);
            }

            c.strokeStyle = '#eef2f7';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(pad, rowY + rowHeight);
            c.lineTo(right, rowY + rowHeight);
            c.stroke();

            if (item) {
                c.textAlign = 'left';
                c.font = font(600, 11);
                c.fillStyle = soft;
                c.fillText(String(index + 1), columns.index, rowY + 21);

                c.font = font(600, 13);
                c.fillStyle = ink;
                c.fillText(truncate(c, item.name || 'សេវា', 600), columns.name, rowY + 21);

                c.textAlign = 'right';
                c.font = font(400, 13);
                c.fillStyle = '#334155';
                c.fillText(formatQty(item.qty), columns.qty, rowY + 21);
                c.fillText(fmt(item.price), columns.price, rowY + 21);

                c.font = font(700, 13);
                c.fillStyle = ink;
                c.fillText(fmt(item.qty * item.price), columns.amount, rowY + 21);
            } else {
                const hiddenItems = data.items.length - (maxRows - 1);
                c.textAlign = 'left';
                c.font = font(600, 12);
                c.fillStyle = muted;
                c.fillText(`+ ទំនិញផ្សេងទៀត ${hiddenItems} មុខ`, columns.name, rowY + 21);
            }

            rowY += rowHeight;
        }
    }

    const totals = computeTotals(data);
    const boxWidth = 300;
    const boxHeight = 150;
    const boxX = right - boxWidth;
    const boxY = 500;

    c.fillStyle = '#f8fafc';
    roundRect(c, boxX, boxY, boxWidth, boxHeight, 10);
    c.fill();

    c.strokeStyle = '#e2e8f0';
    c.lineWidth = 1;
    roundRect(c, boxX, boxY, boxWidth, boxHeight, 10);
    c.stroke();

    let totalY = boxY + 25;
    const totalLine = (label, value) => {
        c.textAlign = 'left';
        c.font = font(400, 12.5);
        c.fillStyle = muted;
        c.fillText(label, boxX + 22, totalY);

        c.textAlign = 'right';
        c.font = font(600, 12.5);
        c.fillStyle = ink;
        c.fillText(value, boxX + boxWidth - 22, totalY);
        totalY += 21;
    };

    totalLine('សរុបរង', fmt(totals.subtotal));
    if (totals.discount > 0) {
        totalLine(`បញ្ចុះតម្លៃ (${formatQty(data.discountPct)}%)`, '−' + fmt(totals.discount));
    }
    if (totals.tax > 0) {
        totalLine(`ពន្ធ (${formatQty(data.taxPct)}%)`, fmt(totals.tax));
    }
    if (data.delivery > 0) {
        totalLine('សេវាដឹកជញ្ជូន', fmt(data.delivery));
    }

    c.save();
    roundRect(c, boxX, boxY + boxHeight - 44, boxWidth, 44, 10);
    c.clip();
    c.fillStyle = '#eff6ff';
    c.fillRect(boxX, boxY + boxHeight - 44, boxWidth, 44);
    c.restore();

    c.textAlign = 'left';
    c.font = font(700, 13);
    c.fillStyle = accent;
    c.fillText('សរុបទូទាត់', boxX + 22, boxY + boxHeight - 16);

    c.textAlign = 'right';
    c.font = font(700, 22);
    c.fillText(fmt(totals.total), boxX + boxWidth - 22, boxY + boxHeight - 13);

    c.textAlign = 'left';
    c.font = font(700, 10.5);
    c.fillStyle = soft;
    c.fillText('កំណត់សម្គាល់ / NOTES', pad, 523);

    c.font = font(400, 12);
    c.fillStyle = '#334155';
    const noteLines = wrapText(c, data.note || '—', 560).slice(0, 2);
    let noteY = 545;
    for (const noteLine of noteLines) {
        c.fillText(noteLine, pad, noteY);
        noteY += 18;
    }

    c.font = font(700, 10.5);
    c.fillStyle = soft;
    c.fillText('ការទូទាត់ / PAYMENT', pad, 600);

    c.font = font(600, 12.5);
    c.fillStyle = ink;
    c.fillText(truncate(c, data.payment, 300), pad, 620);

    const signatureX = 620;
    const signatureWidth = 190;
    c.strokeStyle = '#cbd5e1';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(signatureX, 638);
    c.lineTo(signatureX + signatureWidth, 638);
    c.stroke();

    c.textAlign = 'center';
    c.font = font(400, 10.5);
    c.fillStyle = soft;
    c.fillText('ហត្ថលេខា / Authorized signature', signatureX + signatureWidth / 2, 654);

    c.textAlign = 'left';
    c.font = font(500, 11);
    c.fillStyle = soft;
    c.fillText(truncate(c, data.footer || 'សូមអរគុណ!', 520), pad, 666);

    c.fillStyle = accent;
    c.fillRect(0, height - 6, width, 6);
}
