const CSV_SOURCES = ["/api/producao-csv", "/data/latest-sheet.csv"];
const SYNC_ENDPOINT = "/api/producao-sync";
const HISTORY_ENDPOINT = "/api/production-history";
const HISTORY_ENTRY_ENDPOINT = "/api/production-history-entry";
const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const DISPLAY_YEAR = 2026;
const AUTO_REFRESH_MS = 10000;
const DAILY_STORAGE_KEY = "daily-production-progress";
const PRODUCTION_HISTORY_KEY = "production-history";

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
const COMPLETED_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;
let productionHistory = {};

function parseNumber(value) {
  const num = Number(String(value ?? "").replace(",", ".").trim());
  return Number.isFinite(num) ? num : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(value);
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
}

function saveProductionHistory() {
  try {
    localStorage.setItem(PRODUCTION_HISTORY_KEY, JSON.stringify(productionHistory));
  } catch (error) {
    // Ignora falha de persistencia.
  }
}

function toLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  const now = Date.now();
  let changed = false;

  Object.keys(dailyProgress).forEach((key) => {
    const progress = dailyProgress[key];
    if (!progress?.testedAt) return;
    const testedAtTs = new Date(progress.testedAt).getTime();
    if (!Number.isFinite(testedAtTs)) return;
    if (now - testedAtTs >= COMPLETED_HIDE_AFTER_MS) {
      delete dailyProgress[key];
      changed = true;
    }
  });

  if (changed) {
    saveDailyProgress();
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
      const totalDay = Object.values(dayData).reduce((acc, item) => acc + parseNumber(item?.done), 0);
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
      const totalDay = Object.values(dayData || {}).reduce((acc, item) => acc + parseNumber(item?.done), 0);
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
      const totalDay = Object.values(dayData || {}).reduce((acc, item) => acc + parseNumber(item?.done), 0);
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
  const doneEntries = savedEntries.filter((item) => item.productionFinalizedAt && item.testedAt);

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
          (item) => `<article class="saved-card done" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>A produzir: <strong>${formatNumber(item.target)}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong></p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      <p>Falta: <strong>${formatNumber(item.remaining)}</strong></p>
      <span class="saved-tag">Finalizado</span>
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-edit-btn" data-action="edit" data-key="${item.key}">Editar</button>
        <button type="button" class="saved-action-btn saved-delete-btn" data-action="delete" data-key="${item.key}">Excluir</button>
      </div>
    </article>`
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
      const rejected = parseNumber(progress?.rejected);
      const remaining = Math.max(target - done, 0);
      const isDone = target > 0 && remaining === 0;
      const testedAt = progress?.testedAt || null;
      const productionFinalizedAt = progress?.productionFinalizedAt || null;
      return { key, sigla, codigo, target, done, rejected, remaining, isDone, testedAt, productionFinalizedAt };
    })
    .filter((item) => item.productionFinalizedAt && !item.testedAt);

  const testedEntries = Object.entries(dailyProgress)
    .map(([key, progress]) => {
      const [sigla, codigo] = key.split("__");
      const target = parseNumber(progress?.target);
      const done = parseNumber(progress?.done);
      const rejected = parseNumber(progress?.rejected);
      const testedAt = progress?.testedAt || null;
      const productionFinalizedAt = progress?.productionFinalizedAt || null;
      return { key, sigla, codigo, target, done, rejected, testedAt, productionFinalizedAt };
    })
    .filter((item) => item.productionFinalizedAt && item.testedAt);

  elements.qualityAwaitingList.innerHTML = waitingTestEntries.length
    ? waitingTestEntries
        .map(
          (item) => `<article class="quality-card" data-key="${item.key}">
      <h4>${item.sigla}</h4>
      <p>Codigo: <strong>${item.codigo}</strong></p>
      <p>Produzido: <strong>${formatNumber(item.done)}</strong> / ${formatNumber(item.target)}</p>
      <p>Reprovado: <strong>${formatNumber(item.rejected)}</strong></p>
      <div class="saved-actions">
        <button type="button" class="saved-action-btn saved-reject-btn" data-action="quality-reject" data-key="${item.key}">Reprovado</button>
        <button type="button" class="saved-action-btn saved-save-btn" data-action="quality-complete" data-key="${item.key}">Teste concluido</button>
      </div>
    </article>`
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
      <span class="saved-tag">Teste concluido</span>
    </article>`
        )
        .join("")
    : `<div class="devices-empty">Nenhum teste concluido.</div>`;

  renderQualityRejectedIndicator();
}

function renderQualityRejectedIndicator() {
  if (!elements.qualityRejectedChart || typeof Chart === "undefined") return;
  const totalRejected = Object.values(dailyProgress).reduce(
    (sum, item) => sum + parseNumber(item?.rejected),
    0
  );
  const totalApproved = Object.values(dailyProgress).reduce((sum, item) => {
    const done = parseNumber(item?.done);
    const rejected = parseNumber(item?.rejected);
    return sum + Math.max(done - rejected, 0);
  }, 0);

  if (qualityRejectedChartInstance) {
    qualityRejectedChartInstance.destroy();
  }

  qualityRejectedChartInstance = new Chart(elements.qualityRejectedChart, {
    type: "doughnut",
    data: {
      labels: ["Reprovado", "Aprovado"],
      datasets: [
        {
          data: [totalRejected, totalApproved || 0.0001],
          backgroundColor: ["#d14d4d", "#1a9f7d"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.label}: ${formatNumber(context.parsed || 0)}`;
            },
          },
        },
      },
      cutout: "64%",
    },
  });
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
  elements.search.addEventListener("input", applyFiltersAndSort);
  elements.sort.addEventListener("change", applyFiltersAndSort);

  elements.reload.addEventListener("click", async () => {
    try {
      await forceServerSync();
      await loadDefaultCsv();
    } catch (error) {
      alert("Nao foi possivel recarregar o arquivo padrao. Use o upload manual.");
    }
  });

  elements.input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    parseCsvText(text);
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

      if (action === "quality-complete") {
        dailyProgress[key] = {
          ...dailyProgress[key],
          testedAt: new Date().toISOString(),
        };
        saveDailyProgress();
        renderSavedDevices();
        renderQualityPanel();
        return;
      }

      if (action === "quality-reject") {
        const current = dailyProgress[key] || {};
        const currentRejected = parseNumber(current.rejected);
        const raw = window.prompt("Informe a quantidade reprovada no teste:", String(currentRejected));
        if (raw === null) return;
        const rejected = Math.max(parseNumber(raw), 0);
        dailyProgress[key] = {
          ...current,
          rejected,
          testedAt: null,
        };
        saveDailyProgress();
        saveTodayHistoryForDevice(
          key,
          parseNumber(dailyProgress[key].target),
          parseNumber(dailyProgress[key].done),
          rejected
        );
        renderSavedDevices();
        renderQualityPanel();
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
      delete dailyProgress[key];
      saveDailyProgress();
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
      const target = parseNumber(targetInput?.value);
      const done = parseNumber(doneInput?.value);
      const rejected = parseNumber(dailyProgress[key]?.rejected);
      dailyProgress[key] = applyCompletionState({
        ...(dailyProgress[key] || {}),
        target,
        done,
        rejected,
      });
      saveDailyProgress();
      saveTodayHistoryForDevice(key, target, done, rejected);
      editingDeviceKey = "";
      renderSiglaButtons(allRows);
      renderSavedDevices();
      renderQualityPanel();
      updateKpis(currentChartRows.length ? currentChartRows : allRows);
    }
  };

  elements.savedDevices.addEventListener("click", handleSavedDeviceActions);
  if (elements.doneDevices) {
    elements.doneDevices.addEventListener("click", handleSavedDeviceActions);
  }
}

async function init() {
  buildTableHeader();
  loadDailyProgress();
  loadProductionHistory();
  bindEvents();

  try {
    try {
      await loadProductionHistoryFromServer();
    } catch (error) {
      // Mantem fallback local.
    }
    await loadDefaultCsv();
    setInterval(async () => {
      try {
        await loadProductionHistoryFromServer();
        await loadDefaultCsv();
      } catch (error) {
        // Mantem os dados atuais se uma atualizacao falhar.
      }
    }, AUTO_REFRESH_MS);
  } catch (error) {
    elements.tableBody.innerHTML = `<tr><td colspan="15">Nao foi possivel carregar o CSV automaticamente. Use "Carregar outro CSV".</td></tr>`;
  }
}

init();
