const CSV_SOURCES = ["/api/producao-csv", "/data/latest-sheet.csv"];
const SYNC_ENDPOINT = "/api/producao-sync";
const STATUS_ENDPOINT = "/api/producao-status";
const HISTORY_ENDPOINT = "/api/production-history";
const HISTORY_ENTRY_ENDPOINT = "/api/production-history-entry";
const AUDIT_ENDPOINT = "/api/audit-event";
const DAILY_PROGRESS_ENDPOINT = "/api/daily-progress";
const FINAL_PRODUCTS_HISTORY_ENDPOINT = "/api/final-products-history";
const EXCLUDED_PRODUCTS_HISTORY_ENDPOINT = "/api/excluded-products-history";
const EVENTS_ENDPOINT = "/api/events";
const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const DISPLAY_YEAR = 2026;
const AUTO_REFRESH_MS = 5000;
const DAILY_STORAGE_KEY = "daily-production-progress";
const PRODUCTION_HISTORY_KEY = "production-history";
const FINAL_PRODUCTS_STORAGE_KEY = "final-products-history";
const EXCLUDED_PRODUCTS_STORAGE_KEY = "excluded-products-history";
const QUALITY_REJECTION_CATEGORIES = [
  { value: "montagem", label: "Montagem" },
  { value: "fabrica", label: "Defeito da fabrica" },
];
const QUALITY_DIVERSE_REASON = "DIVERSO";
const QUALITY_REJECTION_REASONS = [
  "LED VERMELHO",
  "LED AZUL",
  "LED AMARELO",
  "CAMARA SUJA",
  "SENSOR REMOVIDO",
  "DISPARO",
  "SINAL",
  "NAO LIGA",
  "PINOS TAMPA-RIF",
  "BATERIA",
  "MODO BATERIA",
  "TEMPERATURA",
  "BASE QUEBRADA",
  "ROSCA ESPANADA",
  "ACRILICO INVERTIDO - TAMPA RIF",
  "PLACA INVERTIDA - TAMPA RIF",
  "REDE AC",
  "SEM PLACA",
  "ADESIVO",
  "RADIO",
  QUALITY_DIVERSE_REASON,
];
const QUALITY_REJECTION_REASONS_BY_CATEGORY = {
  montagem: QUALITY_REJECTION_REASONS,
  fabrica: QUALITY_REJECTION_REASONS,
};

const elements = {
  tableHead: document.querySelector("#data-table thead"),
  tableBody: document.querySelector("#data-table tbody"),
  search: document.querySelector("#search-input"),
  sort: document.querySelector("#sort-select"),
  reload: document.querySelector("#reload-btn"),
  input: document.querySelector("#csv-input"),
  weeklyProducedChart: document.querySelector("#weekly-produced-chart"),
  monthlyProducedChart: document.querySelector("#monthly-produced-chart"),
  annualProducedChart: document.querySelector("#annual-produced-chart"),
  qualityToggleBtn: document.querySelector("#quality-toggle-btn"),
  qualityPanel: document.querySelector("#quality-panel"),
  qualityCloseBtn: document.querySelector("#quality-close-btn"),
  qualityAwaitingList: document.querySelector("#quality-awaiting-list"),
  qualityDoneList: document.querySelector("#quality-done-list"),
  qualityRejectedChart: document.querySelector("#quality-rejected-chart"),
  siglaButtons: document.querySelector("#sigla-buttons"),
  devicePickerTools: document.querySelector("#device-picker-tools"),
  devicePickerSearch: document.querySelector("#device-picker-search"),
  modal: document.querySelector("#chart-modal"),
  modalClose: document.querySelector("#modal-close"),
  modalTitle: document.querySelector("#modal-title"),
  modalChart: document.querySelector("#modal-chart"),
  targetInput: document.querySelector("#target-input"),
  doneInput: document.querySelector("#done-input"),
  remainingOutput: document.querySelector("#remaining-output"),
  calcOutput: document.querySelector("#calc-output"),
  saveProductionBtn: document.querySelector("#save-production-btn"),
  savedDevices: document.querySelector("#saved-devices"),
  doneDevices: document.querySelector("#done-devices"),
  systemAlert: document.querySelector("#system-alert"),
  systemNote: document.querySelector("#system-note"),
};

let allRows = [];
let modalChartInstance = null;
let weeklyProducedChartInstance = null;
let monthlyProducedChartInstance = null;
let annualProducedChartInstance = null;
let qualityRejectedChartInstance = null;
let currentChartRows = [];
let devicePickerOpen = true;
let devicePickerSearchTerm = "";
let selectedRowKey = "";
let selectedRow = null;
let dailyProgress = {};
let editingDeviceKey = "";
let qualityPanelOpen = false;
let qualityRejectEditorKey = "";
const COMPLETED_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;
let productionHistory = {};
let finalProductsHistory = {};
let excludedProductsHistory = [];
let autoRefreshInFlight = false;
let lastUserInteractionAt = Date.now();
let dailyProgressSyncTimer = null;
let finalProductsSyncTimer = null;
let excludedProductsSyncTimer = null;
let realtimeEventSource = null;
let realtimeRefreshTimer = null;

function parseNumber(value) {
  const num = Number(String(value ?? "").replace(",", ".").trim());
  return Number.isFinite(num) ? num : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeRejectionReason(progress) {
  const category = String(progress?.rejectionCategory || "").trim().toLowerCase();
  const reason = String(progress?.rejectionReason || "").trim();
  const isValidCategory = QUALITY_REJECTION_CATEGORIES.some((item) => item.value === category);
  const resolvedCategory = isValidCategory ? category : QUALITY_REJECTION_CATEGORIES[0].value;
  const categoryReasons = QUALITY_REJECTION_REASONS_BY_CATEGORY[resolvedCategory] || [];
  const isValidReason = categoryReasons.includes(reason);
  const observation = String(progress?.rejectionObservation || "").trim();
  return {
    category: resolvedCategory,
    reason: isValidReason ? reason : categoryReasons[0] || "",
    observation,
  };
}

function getRejectionCategoryLabel(value) {
  const found = QUALITY_REJECTION_CATEGORIES.find((item) => item.value === value);
  return found ? found.label : "Nao informado";
}

function buildRejectionReasonOptions(category, selectedReason) {
  const reasons = QUALITY_REJECTION_REASONS_BY_CATEGORY[category] || [];
  return reasons
    .map(
      (reason) =>
        `<option value="${escapeHtml(reason)}"${selectedReason === reason ? " selected" : ""}>${escapeHtml(reason)}</option>`
    )
    .join("");
}

function isObservationRequired(reason) {
  return String(reason || "").trim() === QUALITY_DIVERSE_REASON;
}

function normalizeRejectionEntries(progress) {
  const rawEntries = Array.isArray(progress?.rejectionEntries) ? progress.rejectionEntries : [];
  const entries = rawEntries
    .map((entry) => {
      const normalized = normalizeRejectionReason({
        rejectionCategory: entry?.category,
        rejectionReason: entry?.reason,
        rejectionObservation: entry?.observation,
      });
      const count = Math.max(parseNumber(entry?.count), 0);
      if (!count) return null;
      return {
        category: normalized.category,
        reason: normalized.reason,
        observation: normalized.observation,
        count,
      };
    })
    .filter(Boolean);

  if (entries.length) return entries;

  const legacy = normalizeRejectionReason(progress);
  const legacyCount = Math.max(parseNumber(progress?.rejected), 0);
  if (!legacyCount) return [];
  return [
    {
      category: legacy.category,
      reason: legacy.reason,
      observation: legacy.observation,
      count: legacyCount,
    },
  ];
}

function getRejectedTotalFromEntries(entries) {
  return (entries || []).reduce((sum, entry) => sum + Math.max(parseNumber(entry?.count), 0), 0);
}

function getProgressRejectedTotal(progress) {
  return getRejectedTotalFromEntries(normalizeRejectionEntries(progress));
}

function buildDeviceQualityHistoryStats() {
  const aggregate = {};
  Object.entries(productionHistory || {}).forEach(([dateKey, dayData]) => {
    if (!dayData || typeof dayData !== "object") return;
    Object.entries(dayData).forEach(([deviceKey, values]) => {
      if (isHistoryEntryExcluded(dateKey, deviceKey)) return;
      if (!aggregate[deviceKey]) {
        aggregate[deviceKey] = {
          done: 0,
          rejected: 0,
          days: 0,
        };
      }
      const done = Math.max(parseNumber(values?.done), 0);
      const rejected = Math.max(parseNumber(values?.rejected), 0);
      aggregate[deviceKey].done += done;
      aggregate[deviceKey].rejected += rejected;
      aggregate[deviceKey].days += 1;
    });
  });

  return Object.entries(aggregate)
    .map(([deviceKey, item]) => {
      const [sigla, codigo] = deviceKey.split("__");
      const avgErrorPercent = item.done > 0 ? (item.rejected / item.done) * 100 : 0;
      const avgRejectedPerDay = item.days > 0 ? item.rejected / item.days : 0;
      return {
        deviceKey,
        label: `${sigla}`,
        avgErrorPercent,
        avgRejectedPerDay,
        rejectedTotal: item.rejected,
        doneTotal: item.done,
        days: item.days,
      };
    })
    .filter((item) => item.rejectedTotal > 0)
    .sort((a, b) => b.avgErrorPercent - a.avgErrorPercent || b.rejectedTotal - a.rejectedTotal);
}

function buildRejectionEntriesHtml(entries) {
  if (!entries.length) return "<p>Motivos: <strong>Nenhum</strong></p>";
  const items = entries
    .map((entry) => {
      const obs = entry.observation ? ` (${escapeHtml(entry.observation)})` : "";
      return `<li>${escapeHtml(getRejectionCategoryLabel(entry.category))} - ${escapeHtml(entry.reason)}: <strong>${formatNumber(
        entry.count
      )}</strong>${obs}</li>`;
    })
    .join("");
  return `<p>Motivos registrados:</p><ul class="quality-rejection-list">${items}</ul>`;
}

function buildRowKey(row) {
  return `${row.sigla}__${row.codigo}`;
}

function loadDailyProgress() {
  try {
    const raw = localStorage.getItem(DAILY_STORAGE_KEY);
    dailyProgress = raw ? JSON.parse(raw) : {};
  } catch (error) {
    dailyProgress = {};
  }
}

function loadProductionHistory() {
  try {
    const raw = localStorage.getItem(PRODUCTION_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    productionHistory = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    productionHistory = {};
  }
}

function saveDailyProgress() {
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(dailyProgress));
  } catch (error) {
    // Ignora falha de persistencia.
  }
  scheduleDailyProgressSync();
}

function saveProductionHistory() {
  try {
    localStorage.setItem(PRODUCTION_HISTORY_KEY, JSON.stringify(productionHistory));
  } catch (error) {
    // Ignora falha de persistencia.
  }
}

function loadFinalProductsHistory() {
  try {
    const raw = localStorage.getItem(FINAL_PRODUCTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    finalProductsHistory = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    finalProductsHistory = {};
  }
}

function saveFinalProductsHistory() {
  try {
    localStorage.setItem(FINAL_PRODUCTS_STORAGE_KEY, JSON.stringify(finalProductsHistory));
  } catch (error) {
    // Ignora falha de persistencia.
  }
  scheduleFinalProductsSync();
}

function loadExcludedProductsHistory() {
  try {
    const raw = localStorage.getItem(EXCLUDED_PRODUCTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    excludedProductsHistory = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    excludedProductsHistory = [];
  }
}

function saveExcludedProductsHistory() {
  try {
    localStorage.setItem(EXCLUDED_PRODUCTS_STORAGE_KEY, JSON.stringify(excludedProductsHistory));
  } catch (error) {
    // Ignora falha de persistencia.
  }
  scheduleExcludedProductsSync();
}

async function loadDailyProgressFromServer() {
  const response = await fetch(encodeURI(DAILY_PROGRESS_ENDPOINT), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Daily progress invalido.");
  }
  dailyProgress = data;
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify(dailyProgress));
  } catch (error) {
    // Ignora falha de persistencia local.
  }
}

async function loadFinalProductsHistoryFromServer() {
  const response = await fetch(encodeURI(FINAL_PRODUCTS_HISTORY_ENDPOINT), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Historico final invalido.");
  }
  finalProductsHistory = data;
  try {
    localStorage.setItem(FINAL_PRODUCTS_STORAGE_KEY, JSON.stringify(finalProductsHistory));
  } catch (error) {
    // Ignora falha de persistencia local.
  }
}

async function loadExcludedProductsHistoryFromServer() {
  const response = await fetch(encodeURI(EXCLUDED_PRODUCTS_HISTORY_ENDPOINT), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Historico de exclusao invalido.");
  }
  excludedProductsHistory = data;
  try {
    localStorage.setItem(EXCLUDED_PRODUCTS_STORAGE_KEY, JSON.stringify(excludedProductsHistory));
  } catch (error) {
    // Ignora falha de persistencia local.
  }
}

function scheduleDailyProgressSync() {
  if (dailyProgressSyncTimer) {
    clearTimeout(dailyProgressSyncTimer);
  }
  dailyProgressSyncTimer = setTimeout(async () => {
    dailyProgressSyncTimer = null;
    try {
      await fetch(encodeURI(DAILY_PROGRESS_ENDPOINT), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dailyProgress || {}),
      });
    } catch (error) {
      // Mantem local se sincronizacao falhar.
    }
  }, 250);
}

function scheduleFinalProductsSync() {
  if (finalProductsSyncTimer) {
    clearTimeout(finalProductsSyncTimer);
  }
  finalProductsSyncTimer = setTimeout(async () => {
    finalProductsSyncTimer = null;
    try {
      await fetch(encodeURI(FINAL_PRODUCTS_HISTORY_ENDPOINT), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalProductsHistory || {}),
      });
    } catch (error) {
      // Mantem local se sincronizacao falhar.
    }
  }, 250);
}

function scheduleExcludedProductsSync() {
  if (excludedProductsSyncTimer) {
    clearTimeout(excludedProductsSyncTimer);
  }
  excludedProductsSyncTimer = setTimeout(async () => {
    excludedProductsSyncTimer = null;
    try {
      await fetch(encodeURI(EXCLUDED_PRODUCTS_HISTORY_ENDPOINT), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(excludedProductsHistory || []),
      });
    } catch (error) {
      // Mantem local se sincronizacao falhar.
    }
  }, 250);
}

function buildExcludedEntryKey(dateKey, deviceKey) {
  return `${String(dateKey || "").trim()}__${String(deviceKey || "").trim()}`;
}

function isHistoryEntryExcluded(dateKey, deviceKey) {
  const key = buildExcludedEntryKey(dateKey, deviceKey);
  return excludedProductsHistory.some((item) => buildExcludedEntryKey(item?.dateKey, item?.key) === key);
}

function registerExcludedProductRecord(key, progress, origin) {
  if (!key) return;
  const [sigla, codigo] = String(key).split("__");
  const now = new Date();
  const sourceDate = progress?.testedAt || progress?.completedAt || progress?.productionFinalizedAt || now.toISOString();
  const dateKey = toLocalDateKey(new Date(sourceDate));
  const record = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key,
    sigla: String(sigla || ""),
    codigo: String(codigo || ""),
    target: parseNumber(progress?.target),
    done: parseNumber(progress?.done),
    rejected: getProgressRejectedTotal(progress),
    dateKey,
    origin: String(origin || "manual_delete"),
    excludedAt: now.toISOString(),
  };
  excludedProductsHistory.push(record);
  saveExcludedProductsHistory();

  if (productionHistory[dateKey] && productionHistory[dateKey][key]) {
    delete productionHistory[dateKey][key];
    if (Object.keys(productionHistory[dateKey]).length === 0) {
      delete productionHistory[dateKey];
    }
    saveProductionHistory();
  }
}

function toLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function showSystemAlert(message, tone = "warn") {
  if (!elements.systemAlert) return;
  elements.systemAlert.textContent = String(message || "");
  elements.systemAlert.classList.remove("hidden", "warn", "danger");
  elements.systemAlert.classList.add(tone === "danger" ? "danger" : "warn");
}

function hideSystemAlert() {
  if (!elements.systemAlert) return;
  elements.systemAlert.classList.add("hidden");
}

function showSystemNote(message) {
  if (!elements.systemNote) return;
  const text = String(message || "").trim();
  if (!text) {
    elements.systemNote.classList.add("hidden");
    elements.systemNote.textContent = "";
    return;
  }
  elements.systemNote.textContent = text;
  elements.systemNote.classList.remove("hidden");
}

function hideSystemNote() {
  if (!elements.systemNote) return;
  elements.systemNote.classList.add("hidden");
  elements.systemNote.textContent = "";
}

async function sendAuditEvent(action, payload = {}) {
  if (!action) return;
  try {
    await fetch(encodeURI(AUDIT_ENDPOINT), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (error) {
    // Nao bloqueia a UX quando o log remoto falhar.
  }
}

async function loadServerStatus() {
  try {
    const response = await fetch(encodeURI(STATUS_ENDPOINT), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const status = await response.json();
    const historyMode = String(status?.historyMode || "");
    const historyLastError = String(status?.historyLastError || "").trim();
    const sheetLastError = String(status?.lastError || "").trim();

    if (historyMode === "mariadb") {
      hideSystemAlert();
    } else if (historyMode === "json_fallback") {
      const detail = historyLastError ? ` Detalhe: ${historyLastError}` : "";
      showSystemAlert(`ALERTA: Servidor rodando sem banco de dados (modo fallback).${detail}`, "danger");
    } else if (historyMode === "db_required") {
      const detail = historyLastError ? ` Detalhe: ${historyLastError}` : "";
      showSystemAlert(`ALERTA: Banco de dados obrigatorio indisponivel.${detail}`, "danger");
    } else {
      const detail = historyLastError ? ` Detalhe: ${historyLastError}` : "";
      showSystemAlert(`ALERTA: Estado do banco nao confirmado.${detail}`, "danger");
    }

    if (sheetLastError) {
      showSystemNote(`Aviso (planilha): ${sheetLastError}`);
    } else {
      hideSystemNote();
    }
  } catch (error) {
    hideSystemAlert();
    showSystemNote("Aviso: nao foi possivel consultar o status do servidor.");
  }
}

async function loadProductionHistoryFromServer() {
  const response = await fetch(encodeURI(HISTORY_ENDPOINT), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Historico invalido.");
  }
  productionHistory = data;
  saveProductionHistory();
}

async function saveHistoryEntryToServer(dateKey, key, target, done, rejected) {
  const response = await fetch(encodeURI(HISTORY_ENTRY_ENDPOINT), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dateKey, key, target, done, rejected }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function saveTodayHistoryForDevice(key, target, done, rejected) {
  const today = toLocalDateKey();
  if (!productionHistory[today]) {
    productionHistory[today] = {};
  }
  productionHistory[today][key] = { target, done, rejected };
  saveProductionHistory();
  saveHistoryEntryToServer(today, key, target, done, rejected).catch(() => {
    // Mantem historico local caso a gravacao remota falhe.
  });
}

function updateRemainingOutput() {
  const target = parseNumber(elements.targetInput.value);
  const done = parseNumber(elements.doneInput.value);
  const remaining = Math.max(target - done, 0);
  elements.remainingOutput.textContent = formatNumber(remaining);
  elements.calcOutput.textContent = `Calculo: ${formatNumber(target)} - ${formatNumber(done)} = ${formatNumber(remaining)}`;
}

function applyCompletionState(progress) {
  const target = parseNumber(progress?.target);
  const done = parseNumber(progress?.done);
  const remaining = Math.max(target - done, 0);
  const reachedTarget = target > 0 && remaining === 0;
  return {
    ...progress,
    productionFinalizedAt: reachedTarget ? progress?.productionFinalizedAt || null : null,
    completedAt: reachedTarget ? progress?.completedAt || null : null,
    testedAt: reachedTarget ? progress?.testedAt || null : null,
  };
}

function pruneExpiredCompletedDevices() {
  // Mantem historico de finalizados sem expurgo automatico.
}

function buildFinalProductRecord(key, progress) {
  const [sigla, codigo] = String(key || "").split("__");
  const target = parseNumber(progress?.target);
  const done = parseNumber(progress?.done);
  const rejected = getProgressRejectedTotal(progress);
  const remaining = Math.max(target - done, 0);
  return {
    key,
    sigla: String(sigla || ""),
    codigo: String(codigo || ""),
    target,
    done,
    rejected,
    remaining,
    productionFinalizedAt: progress?.productionFinalizedAt || null,
    testedAt: progress?.testedAt || null,
    completedAt: progress?.completedAt || null,
    updatedAt: new Date().toISOString(),
  };
}

function syncFinalProductsFromDailyProgress() {
  let changed = false;
  Object.entries(dailyProgress || {}).forEach(([key, progress]) => {
    if (!progress?.productionFinalizedAt || !progress?.testedAt) return;
    const nextRecord = buildFinalProductRecord(key, progress);
    const prevRecord = finalProductsHistory[key];
    const prevSignature = JSON.stringify(prevRecord || {});
    const nextSignature = JSON.stringify(nextRecord);
    if (prevSignature !== nextSignature) {
      finalProductsHistory[key] = nextRecord;
      changed = true;
    }
  });

  if (changed) {
    saveFinalProductsHistory();
  }
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function formatMonthWithWeekday(monthIndex) {
  const date = new Date(DISPLAY_YEAR, monthIndex, 1);
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short" })
    .format(date)
    .replace(".", "");
  const dayMonth = `01/${String(monthIndex + 1).padStart(2, "0")}`;
  return `${weekday}, ${dayMonth}`;
}

function findHeaderIndex(rows) {
  return rows.findIndex((row) => row.some((cell) => normalizeKey(cell) === "SIGLA"));
}

function normalizeRows(rows) {
  const headerIndex = findHeaderIndex(rows);
  if (headerIndex === -1) return [];

  const header = rows[headerIndex].map((h) => String(h).trim());
  const siglaIndex = header.findIndex((h) => normalizeKey(h) === "SIGLA");
  const codigoIndex = header.findIndex((h) => normalizeKey(h) === "CODIGO");
  const totalIndex = header.findIndex((h) => normalizeKey(h).includes("TOTAL"));
  const monthIndexes = MONTHS.map((m) => header.findIndex((h) => normalizeKey(h) === normalizeKey(m)));

  return rows
    .slice(headerIndex + 1)
    .map((row) => {
      const sigla = String(row[siglaIndex] ?? "").trim();
      const codigo = String(row[codigoIndex] ?? "").trim();
      const months = monthIndexes.map((idx) => parseNumber(row[idx]));
      const totalFromMonths = months.reduce((acc, n) => acc + n, 0);
      const total = totalIndex >= 0 ? parseNumber(row[totalIndex]) || totalFromMonths : totalFromMonths;
      return { sigla, codigo, months, total };
    })
    .filter((item) => item.sigla && item.codigo)
    .filter((item) => /^\d+$/.test(item.codigo))
    .filter((item) => normalizeKey(item.sigla) !== "TOTAL MENSAL" && normalizeKey(item.sigla) !== "TOTAL GERAL");
}

function buildTableHeader() {
  const monthCols = MONTHS.map((m, idx) => `<th class="num month-head"><span>${m}</span><small>${formatMonthWithWeekday(idx)}</small></th>`).join("");
  elements.tableHead.innerHTML = `<tr><th>Sigla</th><th>Codigo</th>${monthCols}<th class="num">Total</th></tr>`;
}

function renderTable(rows) {
  elements.tableBody.innerHTML = rows
    .map((row) => {
      const months = row.months.map((v) => `<td class="num">${formatNumber(v)}</td>`).join("");
      return `<tr>
        <td>${row.sigla}</td>
        <td>${row.codigo}</td>
        ${months}
        <td class="num"><strong>${formatNumber(row.total)}</strong></td>
      </tr>`;
    })
    .join("");
}

function updateKpis(rows) {
  const totalAnual = rows.reduce((acc, row) => acc + row.total, 0);
  const monthlyTotals = MONTHS.map((_, idx) => rows.reduce((acc, row) => acc + row.months[idx], 0));
  const peakValue = Math.max(...monthlyTotals, 0);
  renderProducedCharts(rows, monthlyTotals, totalAnual, peakValue);
}

function renderProducedCharts(rows, monthlyTotals, totalAnual, peakValue) {
  if (typeof Chart === "undefined") return;
  currentChartRows = rows;

  // Semanal (ultimos 7 dias no historico local)
  if (elements.weeklyProducedChart) {
    const labels = [];
    const values = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = toLocalDateKey(d);
      const dayData = productionHistory[key] || {};
      const totalDay = Object.entries(dayData).reduce((acc, [deviceKey, item]) => {
        if (isHistoryEntryExcluded(key, deviceKey)) return acc;
        return acc + parseNumber(item?.done);
      }, 0);
      labels.push(`${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`);
      values.push(totalDay);
    }

    if (weeklyProducedChartInstance) weeklyProducedChartInstance.destroy();
    weeklyProducedChartInstance = new Chart(elements.weeklyProducedChart, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: "#1fbec8",
            backgroundColor: "rgba(31, 190, 200, 0.2)",
            fill: true,
            tension: 0.35,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback(value) {
                return formatNumber(value);
              },
            },
          },
        },
      },
    });
  }

  // Mensal (meses do ano atual no historico local)
  if (elements.monthlyProducedChart) {
    const currentYear = new Date().getFullYear();
    const monthlyProduced = Array.from({ length: 12 }, () => 0);
    Object.entries(productionHistory).forEach(([dateKey, dayData]) => {
      if (!dateKey.startsWith(String(currentYear))) return;
      const month = Number(dateKey.slice(5, 7)) - 1;
      if (month < 0 || month > 11) return;
      const totalDay = Object.entries(dayData || {}).reduce((acc, [deviceKey, item]) => {
        if (isHistoryEntryExcluded(dateKey, deviceKey)) return acc;
        return acc + parseNumber(item?.done);
      }, 0);
      monthlyProduced[month] += totalDay;
    });

    if (monthlyProducedChartInstance) monthlyProducedChartInstance.destroy();
    monthlyProducedChartInstance = new Chart(elements.monthlyProducedChart, {
      type: "bar",
      data: {
        labels: MONTHS,
        datasets: [
          {
            data: monthlyProduced,
            backgroundColor: "#1bc494",
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback(value) {
                return formatNumber(value);
              },
            },
          },
        },
      },
    });
  }

  // Anual (historico por ano)
  if (elements.annualProducedChart) {
    const annualTotals = {};
    Object.entries(productionHistory).forEach(([dateKey, dayData]) => {
      const year = dateKey.slice(0, 4);
      const totalDay = Object.entries(dayData || {}).reduce((acc, [deviceKey, item]) => {
        if (isHistoryEntryExcluded(dateKey, deviceKey)) return acc;
        return acc + parseNumber(item?.done);
      }, 0);
      annualTotals[year] = (annualTotals[year] || 0) + totalDay;
    });
    const years = Object.keys(annualTotals).sort();
    const yearValues = years.map((year) => annualTotals[year]);

    if (annualProducedChartInstance) annualProducedChartInstance.destroy();
    annualProducedChartInstance = new Chart(elements.annualProducedChart, {
      type: "bar",
      data: {
        labels: years.length ? years : [String(new Date().getFullYear())],
        datasets: [
          {
            data: years.length ? yearValues : [0],
            backgroundColor: "#4ca7d3",
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback(value) {
                return formatNumber(value);
              },
            },
          },
        },
      },
    });
  }
}

function openSiglaModal(row) {
  if (!elements.modal || !elements.modalChart || typeof Chart === "undefined") return;

  elements.modalTitle.textContent = `${row.sigla} (${row.codigo})`;
  selectedRowKey = buildRowKey(row);
  selectedRow = row;

  const currentMonthIndex = new Date().getMonth();
  const suggestedTarget = row.months[currentMonthIndex] || 0;
  const saved = dailyProgress[selectedRowKey] || {};
  elements.targetInput.value = String(saved.target ?? suggestedTarget);
  elements.doneInput.value = String(saved.done ?? 0);
  updateRemainingOutput();

  if (modalChartInstance) {
    modalChartInstance.destroy();
  }

  modalChartInstance = new Chart(elements.modalChart, {
    type: "bar",
    data: {
      labels: MONTHS,
      datasets: [
        {
          label: "Producao mensal",
          data: row.months,
          backgroundColor: "rgba(8, 145, 178, 0.7)",
          borderColor: "rgba(15, 118, 110, 1)",
          borderWidth: 1.2,
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return `Total: ${formatNumber(context.parsed.y || 0)}`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatNumber(value);
            },
          },
        },
      },
    },
  });

  elements.modal.showModal();
}

function renderSiglaButtons(rows) {
  if (!elements.siglaButtons) return;
  const normalizedSearch = devicePickerSearchTerm.trim().toLowerCase();
  const rowsToShow = rows.filter((row) => {
    const key = buildRowKey(row);
    const progress = dailyProgress[key] || {};
    const started = parseNumber(progress.target) > 0 || parseNumber(progress.done) > 0 || parseNumber(progress.rejected) > 0;
    if (started) return false;
    if (!normalizedSearch) return true;
    return row.sigla.toLowerCase().includes(normalizedSearch) || row.codigo.toLowerCase().includes(normalizedSearch);
  });

  if (elements.devicePickerTools) {
    elements.devicePickerTools.classList.toggle("collapsed", !devicePickerOpen);
  }
  elements.siglaButtons.classList.toggle("collapsed", !devicePickerOpen);
  elements.siglaButtons.innerHTML = rowsToShow
    .map((row) => {
      const key = buildRowKey(row);
      const progress = dailyProgress[key] || {};
      const target = parseNumber(progress.target);
      const done = parseNumber(progress.done);
      const remaining = Math.max(target - done, 0);
      return `<button type="button" class="sigla-btn" data-sigla="${row.sigla}" data-codigo="${row.codigo}">
        <span class="sigla-name">${row.sigla}</span>
        <span class="sigla-meta">Falta: ${formatNumber(remaining)}</span>
      </button>`;
    })
    .join("");

  if (!rowsToShow.length) {
    const emptyMessage = normalizedSearch
      ? "Nenhum dispositivo encontrado para a pesquisa."
      : "Nenhum dispositivo selecionado para hoje.";
    elements.siglaButtons.innerHTML = `<div class="devices-empty">${emptyMessage}</div>`;
  }

}

function renderSavedDevices() {
  if (!elements.savedDevices && !elements.doneDevices) return;
  pruneExpiredCompletedDevices();
  syncFinalProductsFromDailyProgress();

  const savedEntries = Object.entries(dailyProgress)
    .map(([key, progress]) => {
      const [sigla, codigo] = key.split("__");
      const target = parseNumber(progress?.target);
      const done = parseNumber(progress?.done);
      const rejected = parseNumber(progress?.rejected);
      const remaining = Math.max(target - done, 0);
      const isDone = target > 0 && remaining === 0;
      const completedAt = progress?.completedAt || null;
      const testedAt = progress?.testedAt || null;
      const productionFinalizedAt = progress?.productionFinalizedAt || null;
      return { key, sigla, codigo, target, done, rejected, remaining, isDone, completedAt, testedAt, productionFinalizedAt };
    })
    .filter((item) => item.target > 0 || item.done > 0);

  const inProgressEntries = savedEntries.filter((item) => !item.productionFinalizedAt);
  const doneEntries = Object.values(finalProductsHistory)
    .filter((item) => item && item.productionFinalizedAt && item.testedAt)
    .sort((a, b) => {
      const aTime = new Date(a.testedAt || a.updatedAt || 0).getTime();
      const bTime = new Date(b.testedAt || b.updatedAt || 0).getTime();
      return bTime - aTime;
    });

  elements.savedDevices.innerHTML = inProgressEntries.length
    ? inProgressEntries
    .map((item) => {
      const isEditing = editingDeviceKey === item.key;
      if (isEditing) {
        return `<article class="saved-card${item.isDone ? " done" : ""}" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <label class="saved-label">A produzir</label>
      <input class="saved-input saved-target-input" type="number" min="0" step="1" value="${item.target}" />
      <label class="saved-label">Produzido</label>
      <input class="saved-input saved-done-input" type="number" min="0" step="1" value="${item.done}" />
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-cancel-btn" data-action="cancel" data-key="${item.key}">Cancelar</button>
        <button type="button" class="saved-action-btn saved-save-btn" data-action="save" data-key="${item.key}">Salvar</button>
      </div>
    </article>`;
      }

      return `<article class="saved-card${item.isDone ? " done" : ""}" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>A produzir: <strong>${formatNumber(item.target)}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong></p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      <p>Falta: <strong>${formatNumber(item.remaining)}</strong></p>
      <span class="saved-tag">${item.isDone ? "Pronto para finalizar" : "Em andamento"}</span>
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-edit-btn" data-action="edit" data-key="${item.key}">Editar</button>
        <button type="button" class="saved-action-btn saved-complete-btn" data-action="complete" data-key="${item.key}">Concluido</button>
        <button type="button" class="saved-action-btn saved-delete-btn" data-action="delete" data-key="${item.key}">Excluir</button>
      </div>
    </article>`;
    })
    .join("")
    : `<div class="devices-empty">Nenhum dispositivo em andamento.</div>`;

  if (!elements.doneDevices) return;
  elements.doneDevices.innerHTML = doneEntries.length
    ? doneEntries
        .map(
          (item) => {
            const isEditing = editingDeviceKey === item.key;
            if (isEditing) {
              return `<article class="saved-card done" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <label class="saved-label">A produzir</label>
      <input class="saved-input saved-target-input" type="number" min="0" step="1" value="${item.target}" />
      <label class="saved-label">Produzido</label>
      <input class="saved-input saved-done-input" type="number" min="0" step="1" value="${item.done}" />
      <label class="saved-label">Reprovado</label>
      <input class="saved-input saved-rejected-input" type="number" min="0" step="1" value="${item.rejected}" />
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-cancel-btn" data-action="cancel" data-key="${item.key}">Cancelar</button>
        <button type="button" class="saved-action-btn saved-save-btn" data-action="save" data-key="${item.key}">Salvar</button>
      </div>
    </article>`;
            }
            return `<article class="saved-card done" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>A produzir: <strong>${formatNumber(item.target)}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong></p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      <p>Falta: <strong>${formatNumber(item.remaining)}</strong></p>
      <span class="saved-tag">Finalizado</span>
    </article>`;
          }
        )
        .join("")
    : `<div class="devices-empty">Nenhum item finalizado.</div>`;
}

function renderQualityPanel() {
  if (!elements.qualityAwaitingList) return;
  const waitingTestEntries = Object.entries(dailyProgress)
    .map(([key, progress]) => {
      const [sigla, codigo] = key.split("__");
      const target = parseNumber(progress?.target);
      const done = parseNumber(progress?.done);
      const rejectionEntries = normalizeRejectionEntries(progress);
      const rejected = getRejectedTotalFromEntries(rejectionEntries);
      const remaining = Math.max(target - done, 0);
      const isDone = target > 0 && remaining === 0;
      const testedAt = progress?.testedAt || null;
      const productionFinalizedAt = progress?.productionFinalizedAt || null;
      const rejectionReason = normalizeRejectionReason(progress);
      return {
        key,
        sigla,
        codigo,
        target,
        done,
        rejected,
        remaining,
        isDone,
        testedAt,
        productionFinalizedAt,
        rejectionReason,
        rejectionEntries,
      };
    })
    .filter((item) => item.productionFinalizedAt && !item.testedAt);

  const testedEntries = Object.entries(dailyProgress)
    .map(([key, progress]) => {
      const [sigla, codigo] = key.split("__");
      const target = parseNumber(progress?.target);
      const done = parseNumber(progress?.done);
      const rejectionEntries = normalizeRejectionEntries(progress);
      const rejected = getRejectedTotalFromEntries(rejectionEntries);
      const testedAt = progress?.testedAt || null;
      const productionFinalizedAt = progress?.productionFinalizedAt || null;
      const rejectionReason = normalizeRejectionReason(progress);
      return { key, sigla, codigo, target, done, rejected, testedAt, productionFinalizedAt, rejectionReason, rejectionEntries };
    })
    .filter((item) => item.productionFinalizedAt && item.testedAt);

  if (elements.qualityToggleBtn) {
    elements.qualityToggleBtn.classList.toggle("attention-blink", waitingTestEntries.length > 0);
  }

  elements.qualityAwaitingList.innerHTML = waitingTestEntries.length
    ? waitingTestEntries
        .map(
          (item) => {
            const isEditingReject = qualityRejectEditorKey === item.key;
            const reasonOptions = buildRejectionReasonOptions(item.rejectionReason.category, item.rejectionReason.reason);
            return `<article class="quality-card" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>Codigo: <strong>${item.codigo}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong> / ${formatNumber(item.target)}</p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      ${buildRejectionEntriesHtml(item.rejectionEntries)}
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-reject-btn" data-action="quality-reject-open" data-key="${item.key}">Reprovado</button>
        <button type="button" class="saved-action-btn saved-save-btn" data-action="quality-complete" data-key="${item.key}">Teste concluido</button>
      </div>
      <div class="quality-reject-editor${isEditingReject ? "" : " hidden"}" data-reject-editor-for="${item.key}">
        <div class="quality-reject-grid">
          <label class="quality-field">
            <span>Categoria</span>
            <select class="quality-category-select">
              ${QUALITY_REJECTION_CATEGORIES.map(
                (category) =>
                  `<option value="${category.value}"${
                    item.rejectionReason.category === category.value ? " selected" : ""
                  }>${escapeHtml(category.label)}</option>`
              ).join("")}
            </select>
          </label>
          <label class="quality-field">
            <span>Motivo</span>
            <select class="quality-reason-select">
              ${reasonOptions}
            </select>
          </label>
          <label class="quality-field">
            <span>Qtd. deste motivo</span>
            <input class="quality-reject-count-input" type="number" min="0" step="1" value="1" />
          </label>
          <label class="quality-field quality-observation-wrap${isObservationRequired(item.rejectionReason.reason) ? "" : " hidden"}">
            <span>Observacao (obrigatoria para Diverso)</span>
            <textarea class="quality-observation-input" rows="2" placeholder="Descreva o motivo diverso...">${escapeHtml(
              item.rejectionReason.observation
            )}</textarea>
          </label>
        </div>
        <div class="saved-actions">
          <button type="button" class="saved-action-btn saved-cancel-btn" data-action="quality-reject-cancel" data-key="${item.key}">Cancelar</button>
          <button type="button" class="saved-action-btn saved-save-btn" data-action="quality-reject-save" data-key="${item.key}">Adicionar motivo</button>
        </div>
      </div>
    </article>`;
          }
        )
    .join("")
    : `<div class="devices-empty">Nenhum item aguardando teste.</div>`;

  if (!elements.qualityDoneList) return;
  elements.qualityDoneList.innerHTML = testedEntries.length
    ? testedEntries
        .map(
          (item) => `<article class="quality-card done" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>Codigo: <strong>${item.codigo}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong> / ${formatNumber(item.target)}</p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      ${buildRejectionEntriesHtml(item.rejectionEntries)}
      <span class="saved-tag">Teste concluido</span>
    </article>`
        )
        .join("")
    : `<div class="devices-empty">Nenhum teste concluido.</div>`;

  renderQualityRejectedIndicator();
}

function renderQualityRejectedIndicator() {
  if (!elements.qualityRejectedChart || typeof Chart === "undefined") return;
  const deviceStats = buildDeviceQualityHistoryStats();
  const labels = deviceStats.length ? deviceStats.map((item) => item.label) : ["Sem dados"];
  const errorPercentValues = deviceStats.length ? deviceStats.map((item) => Number(item.avgErrorPercent.toFixed(2))) : [0];

  if (qualityRejectedChartInstance) {
    qualityRejectedChartInstance.destroy();
  }

  qualityRejectedChartInstance = new Chart(elements.qualityRejectedChart, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Erro medio (%)",
          data: errorPercentValues,
          backgroundColor: "#d14d4d",
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const item = deviceStats[context.dataIndex];
              if (!item) return `Erro medio: ${formatNumber(context.parsed.y || context.parsed.x || 0)}%`;
              return `Erro medio: ${item.avgErrorPercent.toFixed(2)}%`;
            },
            afterLabel(context) {
              const item = deviceStats[context.dataIndex];
              if (!item) return "";
              return `Reprovado total: ${formatNumber(item.rejectedTotal)} | Produzido total: ${formatNumber(
                item.doneTotal
              )} | Dias: ${formatNumber(item.days)} | Reprovado medio/dia: ${item.avgRejectedPerDay.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: false,
          ticks: {
            maxRotation: 35,
            minRotation: 0,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return `${value}%`;
            },
          },
        },
      },
    },
  });
}

function isUserActivelyEditing() {
  if (editingDeviceKey) return true;
  if (qualityRejectEditorKey) return true;
  if (elements.modal?.open) return true;

  const active = document.activeElement;
  if (!active) return false;
  const tagName = String(active.tagName || "").toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return false;
}

function markUserInteraction() {
  lastUserInteractionAt = Date.now();
}

async function refreshSharedStateFromServer({ includeCsv = true } = {}) {
  await loadServerStatus();
  await loadDailyProgressFromServer();
  await loadProductionHistoryFromServer();
  await loadFinalProductsHistoryFromServer();
  await loadExcludedProductsHistoryFromServer();

  if (!isUserActivelyEditing()) {
    if (includeCsv) {
      await loadDefaultCsv();
    }
    renderSavedDevices();
    renderQualityPanel();
  }
}

function scheduleRealtimeRefresh() {
  if (realtimeRefreshTimer) {
    clearTimeout(realtimeRefreshTimer);
  }
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    if (autoRefreshInFlight) return;
    autoRefreshInFlight = true;
    try {
      await refreshSharedStateFromServer({ includeCsv: false });
    } catch (error) {
      // Mantem estado atual se houver falha de rede.
    } finally {
      autoRefreshInFlight = false;
    }
  }, 250);
}

function setupRealtimeUpdates() {
  if (typeof EventSource === "undefined") return;
  if (realtimeEventSource) return;
  try {
    realtimeEventSource = new EventSource(encodeURI(EVENTS_ENDPOINT));
    realtimeEventSource.onmessage = () => {
      scheduleRealtimeRefresh();
    };
    realtimeEventSource.addEventListener("state_updated", () => {
      scheduleRealtimeRefresh();
    });
    realtimeEventSource.onerror = () => {
      // O EventSource reconecta automaticamente.
    };
  } catch (error) {
    // Sem suporte/erro local: segue com polling normal.
  }
}

function renderQualityPanelState() {
  if (!elements.qualityPanel || !elements.qualityToggleBtn) return;
  elements.qualityPanel.classList.toggle("hidden", !qualityPanelOpen);
  elements.qualityToggleBtn.classList.toggle("active", qualityPanelOpen);
}

function applyFiltersAndSort() {
  const searchTerm = elements.search.value.trim().toLowerCase();
  const sortMode = elements.sort.value;

  let filtered = allRows.filter((row) => {
    if (!searchTerm) return true;
    return row.sigla.toLowerCase().includes(searchTerm) || row.codigo.toLowerCase().includes(searchTerm);
  });

  filtered = filtered.sort((a, b) => {
    if (sortMode === "total-asc") return a.total - b.total;
    if (sortMode === "sigla-asc") return a.sigla.localeCompare(b.sigla, "pt-BR");
    if (sortMode === "sigla-desc") return b.sigla.localeCompare(a.sigla, "pt-BR");
    return b.total - a.total;
  });

  updateKpis(filtered);
  renderTable(filtered);
  renderSiglaButtons(allRows);
  renderSavedDevices();
  renderQualityPanel();
}

function parseCsvText(csvText) {
  const result = Papa.parse(csvText, {
    header: false,
    skipEmptyLines: true,
  });

  allRows = normalizeRows(result.data);
  applyFiltersAndSort();
}

async function loadDefaultCsv() {
  let lastError = null;

  for (const csvFile of CSV_SOURCES) {
    try {
      const response = await fetch(encodeURI(csvFile), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const csvText = await response.text();
      if (!csvText.trim()) {
        throw new Error("CSV vazio.");
      }
      parseCsvText(csvText);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Falha ao carregar CSV.");
}

async function forceServerSync() {
  try {
    const response = await fetch(encodeURI(SYNC_ENDPOINT), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    // Em modo estatico/local, segue para carregar o CSV disponivel.
  }
}

function bindEvents() {
  document.addEventListener("pointerdown", markUserInteraction, true);
  document.addEventListener("keydown", markUserInteraction, true);
  document.addEventListener("input", markUserInteraction, true);
  document.addEventListener("focusin", markUserInteraction, true);

  elements.search.addEventListener("input", applyFiltersAndSort);
  elements.sort.addEventListener("change", applyFiltersAndSort);

  elements.reload.addEventListener("click", async () => {
    try {
      await forceServerSync();
      await loadDefaultCsv();
      await sendAuditEvent("dashboard_reload_csv", { source: "api" });
      hideSystemNote();
    } catch (error) {
      alert("Nao foi possivel recarregar o arquivo padrao. Use o upload manual.");
      showSystemNote("Aviso: recarga automatica falhou. Use o upload manual.");
    }
  });

  elements.input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    parseCsvText(text);
    hideSystemNote();
    await sendAuditEvent("dashboard_csv_manual_import", {
      fileName: String(file.name || ""),
      fileSize: Number(file.size || 0),
    });
  });

  elements.siglaButtons.addEventListener("click", (event) => {
    const button = event.target.closest(".sigla-btn");
    if (!button) return;
    const sigla = button.dataset.sigla;
    const codigo = button.dataset.codigo;
    const row = allRows.find((item) => item.sigla === sigla && item.codigo === codigo);
    if (!row) return;
    openSiglaModal(row);
  });

  elements.modalClose.addEventListener("click", () => {
    elements.modal.close();
  });

  elements.modal.addEventListener("click", (event) => {
    if (event.target === elements.modal) {
      elements.modal.close();
    }
  });

  if (elements.devicePickerSearch) {
    elements.devicePickerSearch.addEventListener("input", (event) => {
      devicePickerSearchTerm = event.target.value || "";
      renderSiglaButtons(allRows);
    });
  }

  elements.targetInput.addEventListener("input", updateRemainingOutput);
  elements.doneInput.addEventListener("input", updateRemainingOutput);
  elements.saveProductionBtn.addEventListener("click", () => {
    if (!selectedRowKey || !selectedRow) return;
    const target = parseNumber(elements.targetInput.value);
    const done = parseNumber(elements.doneInput.value);
    const rejected = parseNumber(dailyProgress[selectedRowKey]?.rejected);
    dailyProgress[selectedRowKey] = applyCompletionState({
      ...(dailyProgress[selectedRowKey] || {}),
      target,
      done,
      rejected,
    });
    saveDailyProgress();
    saveTodayHistoryForDevice(selectedRowKey, target, done, rejected);
    sendAuditEvent("production_saved", {
      key: selectedRowKey,
      sigla: selectedRow.sigla,
      codigo: selectedRow.codigo,
      target,
      done,
      rejected,
    });
    renderSiglaButtons(allRows);
    renderSavedDevices();
    renderQualityPanel();
    updateKpis(currentChartRows.length ? currentChartRows : allRows);
    elements.modal.close();
  });

  if (elements.qualityToggleBtn) {
    elements.qualityToggleBtn.addEventListener("click", () => {
      qualityPanelOpen = !qualityPanelOpen;
      renderQualityPanelState();
    });
  }
  if (elements.qualityCloseBtn) {
    elements.qualityCloseBtn.addEventListener("click", () => {
      qualityPanelOpen = false;
      renderQualityPanelState();
    });
  }
  if (elements.qualityAwaitingList) {
    elements.qualityAwaitingList.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-action]");
      if (!actionBtn) return;
      const action = actionBtn.dataset.action;
      const key = actionBtn.dataset.key;
      if (!key || !dailyProgress[key]) return;
      const card = actionBtn.closest(".quality-card");

      if (action === "quality-complete") {
        dailyProgress[key] = {
          ...dailyProgress[key],
          testedAt: new Date().toISOString(),
        };
        saveDailyProgress();
        sendAuditEvent("quality_test_complete", {
          key,
          target: parseNumber(dailyProgress[key]?.target),
          done: parseNumber(dailyProgress[key]?.done),
          rejected: parseNumber(dailyProgress[key]?.rejected),
        });
        renderSavedDevices();
        renderQualityPanel();
        return;
      }

      if (action === "quality-reject-open") {
        qualityRejectEditorKey = key;
        renderQualityPanel();
        return;
      }

      if (action === "quality-reject-cancel") {
        qualityRejectEditorKey = "";
        renderQualityPanel();
        return;
      }

      if (action === "quality-reject-save") {
        if (!card) return;
        const categorySelect = card.querySelector(".quality-category-select");
        const reasonSelect = card.querySelector(".quality-reason-select");
        const rejectedInput = card.querySelector(".quality-reject-count-input");
        const observationInput = card.querySelector(".quality-observation-input");
        const category = String(categorySelect?.value || "").trim().toLowerCase();
        const reason = String(reasonSelect?.value || "").trim();
        const observation = String(observationInput?.value || "").trim();
        const allowedReasons = QUALITY_REJECTION_REASONS_BY_CATEGORY[category] || [];

        if (!QUALITY_REJECTION_CATEGORIES.some((item) => item.value === category)) {
          window.alert("Selecione uma categoria valida para a reprovacao.");
          return;
        }
        if (!allowedReasons.includes(reason)) {
          window.alert("Selecione um motivo valido para a reprovacao.");
          return;
        }
        if (isObservationRequired(reason) && !observation) {
          window.alert("Informe a observacao para motivo diverso.");
          return;
        }

        const current = dailyProgress[key] || {};
        const newRejectedCount = Math.max(parseNumber(rejectedInput?.value), 0);
        if (!newRejectedCount) {
          window.alert("Informe uma quantidade maior que zero.");
          return;
        }
        const rejectionEntries = normalizeRejectionEntries(current);
        rejectionEntries.push({
          category,
          reason,
          observation,
          count: newRejectedCount,
        });
        const rejected = getRejectedTotalFromEntries(rejectionEntries);
        dailyProgress[key] = {
          ...current,
          rejected,
          rejectionEntries,
          rejectionCategory: category,
          rejectionReason: reason,
          rejectionObservation: observation,
          testedAt: null,
        };
        saveDailyProgress();
        saveTodayHistoryForDevice(
          key,
          parseNumber(dailyProgress[key].target),
          parseNumber(dailyProgress[key].done),
          rejected
        );
        sendAuditEvent("quality_rejected_set", {
          key,
          target: parseNumber(dailyProgress[key]?.target),
          done: parseNumber(dailyProgress[key]?.done),
          rejected,
          rejectionCategory: category,
          rejectionReason: reason,
          rejectionObservation: observation,
          rejectionAddedCount: newRejectedCount,
        });
        if (rejectedInput) rejectedInput.value = "1";
        if (observationInput) observationInput.value = "";
        qualityRejectEditorKey = key;
        renderSavedDevices();
        renderQualityPanel();
      }
    });
    elements.qualityAwaitingList.addEventListener("change", (event) => {
      const categorySelect = event.target.closest(".quality-category-select");
      const reasonSelectChanged = event.target.closest(".quality-reason-select");

      if (categorySelect) {
        const card = categorySelect.closest(".quality-card");
        if (!card) return;
        const reasonSelect = card.querySelector(".quality-reason-select");
        const observationWrap = card.querySelector(".quality-observation-wrap");
        if (!reasonSelect || !observationWrap) return;
        const category = String(categorySelect.value || "").trim().toLowerCase();
        const currentReason = String(reasonSelect.value || "").trim();
        const reasons = QUALITY_REJECTION_REASONS_BY_CATEGORY[category] || [];
        const selectedReason = reasons.includes(currentReason) ? currentReason : reasons[0] || "";
        reasonSelect.innerHTML = buildRejectionReasonOptions(category, selectedReason);
        reasonSelect.value = selectedReason;
        observationWrap.classList.toggle("hidden", !isObservationRequired(selectedReason));
        return;
      }

      if (reasonSelectChanged) {
        const card = reasonSelectChanged.closest(".quality-card");
        if (!card) return;
        const observationWrap = card.querySelector(".quality-observation-wrap");
        if (!observationWrap) return;
        const selectedReason = String(reasonSelectChanged.value || "").trim();
        observationWrap.classList.toggle("hidden", !isObservationRequired(selectedReason));
      }
    });
  }

  const handleSavedDeviceActions = (event) => {
    const actionBtn = event.target.closest("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    const key = actionBtn.dataset.key;
    if (!key) return;

    if (action === "edit") {
      if (!dailyProgress[key] && finalProductsHistory[key]) {
        const fromFinal = finalProductsHistory[key];
        dailyProgress[key] = {
          target: parseNumber(fromFinal.target),
          done: parseNumber(fromFinal.done),
          rejected: parseNumber(fromFinal.rejected),
          productionFinalizedAt: fromFinal.productionFinalizedAt || new Date().toISOString(),
          testedAt: fromFinal.testedAt || new Date().toISOString(),
          completedAt: fromFinal.completedAt || fromFinal.productionFinalizedAt || new Date().toISOString(),
        };
        saveDailyProgress();
      }
      editingDeviceKey = key;
      renderSavedDevices();
      return;
    }

    if (action === "cancel") {
      editingDeviceKey = "";
      renderSavedDevices();
      return;
    }

    if (action === "delete") {
      const shouldDelete = window.confirm("Tem certeza que deseja excluir este dispositivo?");
      if (!shouldDelete) return;
      const previous = dailyProgress[key] || finalProductsHistory[key];
      if (previous) {
        registerExcludedProductRecord(key, previous, "manual_delete");
      }
      delete dailyProgress[key];
      if (finalProductsHistory[key]) {
        delete finalProductsHistory[key];
        saveFinalProductsHistory();
      }
      saveDailyProgress();
      sendAuditEvent("production_deleted", { key });
      editingDeviceKey = "";
      renderSiglaButtons(allRows);
      renderSavedDevices();
      renderQualityPanel();
      updateKpis(currentChartRows.length ? currentChartRows : allRows);
      return;
    }

    if (action === "complete") {
      const current = dailyProgress[key] || {};
      const currentTarget = parseNumber(current.target);
      const currentDone = parseNumber(current.done);
      const currentRejected = parseNumber(current.rejected);
      const target = currentTarget > 0 ? currentTarget : (currentDone > 0 ? currentDone : 1);
      const done = target;
      dailyProgress[key] = applyCompletionState({
        ...current,
        target,
        done,
        rejected: currentRejected,
      });
      dailyProgress[key] = {
        ...dailyProgress[key],
        productionFinalizedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        testedAt: null,
      };
      saveDailyProgress();
      saveTodayHistoryForDevice(key, target, done, currentRejected);
      sendAuditEvent("production_marked_complete", {
        key,
        target,
        done,
        rejected: currentRejected,
      });
      renderSiglaButtons(allRows);
      renderSavedDevices();
      renderQualityPanel();
      updateKpis(currentChartRows.length ? currentChartRows : allRows);
      return;
    }

    if (action === "save") {
      const card = actionBtn.closest(".saved-card");
      if (!card) return;
      const targetInput = card.querySelector(".saved-target-input");
      const doneInput = card.querySelector(".saved-done-input");
      const rejectedInput = card.querySelector(".saved-rejected-input");
      const target = parseNumber(targetInput?.value);
      const done = parseNumber(doneInput?.value);
      const rejected = rejectedInput ? parseNumber(rejectedInput?.value) : parseNumber(dailyProgress[key]?.rejected);
      dailyProgress[key] = applyCompletionState({
        ...(dailyProgress[key] || {}),
        target,
        done,
        rejected,
      });
      saveDailyProgress();
      saveTodayHistoryForDevice(key, target, done, rejected);
      sendAuditEvent("production_updated", {
        key,
        target,
        done,
        rejected,
      });
      editingDeviceKey = "";
      renderSiglaButtons(allRows);
      renderSavedDevices();
      renderQualityPanel();
      updateKpis(currentChartRows.length ? currentChartRows : allRows);
    }
  };

  elements.savedDevices.addEventListener("click", handleSavedDeviceActions);
}

async function init() {
  buildTableHeader();
  loadDailyProgress();
  loadProductionHistory();
  loadFinalProductsHistory();
  loadExcludedProductsHistory();
  bindEvents();
  setupRealtimeUpdates();

  try {
    await loadServerStatus();
    try {
      await refreshSharedStateFromServer({ includeCsv: false });
    } catch (error) {
      // Mantem fallback local.
    }
    await loadDefaultCsv();
    renderSavedDevices();
    renderQualityPanel();
    setInterval(async () => {
      if (autoRefreshInFlight) return;
      autoRefreshInFlight = true;
      try {
        await refreshSharedStateFromServer({ includeCsv: !isUserActivelyEditing() });
      } catch (error) {
        // Mantem os dados atuais se uma atualizacao falhar.
      } finally {
        autoRefreshInFlight = false;
      }
    }, AUTO_REFRESH_MS);
  } catch (error) {
    elements.tableBody.innerHTML = `<tr><td colspan="15">Nao foi possivel carregar o CSV automaticamente. Use "Carregar outro CSV".</td></tr>`;
    showSystemNote("Aviso: o CSV padrao nao carregou automaticamente.");
  }
}

init();
