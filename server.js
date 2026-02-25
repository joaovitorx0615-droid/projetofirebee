const http = require("http");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const mariadb = require("mariadb");

function loadDotEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const unquoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;

    if (!(key in process.env)) {
      process.env[key] = unquoted;
    }
  }
}

loadDotEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SHEET_CSV_URL =
  process.env.SHEET_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/1ExHgKjVBPb2IhRBBMMwGeS4E1bvPuwNc4c6yap_mhJU/export?format=csv&gid=558819420";
const SHEET_SYNC_MS = Number(process.env.SHEET_SYNC_MS) || 60_000;
const CACHE_FILE = path.join(ROOT, "data", "latest-sheet.csv");
const HISTORY_FILE = path.join(ROOT, "data", "production-history.json");
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || "dashboard_user";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "dashboard_producao";
const DB_CONNECTION_LIMIT = Math.max(2, Number(process.env.DB_CONNECTION_LIMIT) || 4);
const DB_CREATE_IF_MISSING = (process.env.DB_CREATE_IF_MISSING || "true").toLowerCase() !== "false";
const REQUIRE_DB = (process.env.REQUIRE_DB || "true").toLowerCase() !== "false";

const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || "";
const GOOGLE_SHEET_GID = process.env.GOOGLE_SHEET_GID || "";
const GOOGLE_SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || "";
const GOOGLE_SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".mht": "message/rfc822",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const sheetState = {
  csvText: "",
  updatedAt: null,
  lastError: null,
  sourceMode: "public_csv",
};
let syncPromise = null;
const historyState = {
  byDate: {},
};
let historyPool = null;
const historyRuntime = {
  mode: "mariadb",
  lastError: null,
};

function toLocalDateKey(date) {
  const d = date instanceof Date ? date : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const safePath = decoded === "/" ? "/index.html" : decoded;
  const absolutePath = path.normalize(path.join(ROOT, safePath));

  if (!absolutePath.startsWith(ROOT)) {
    return null;
  }

  return absolutePath;
}

function csvEscapeCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function valuesToCsv(values) {
  return values.map((row) => row.map(csvEscapeCell).join(",")).join("\n");
}

function isPrivateSheetsConfigReady() {
  const hasCreds = Boolean(GOOGLE_SERVICE_ACCOUNT_FILE || GOOGLE_SERVICE_ACCOUNT_JSON);
  return Boolean(GOOGLE_SPREADSHEET_ID && hasCreds);
}

function buildGoogleAuth() {
  const authConfig = {
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  };

  if (GOOGLE_SERVICE_ACCOUNT_FILE) {
    authConfig.keyFile = GOOGLE_SERVICE_ACCOUNT_FILE;
    return new google.auth.GoogleAuth(authConfig);
  }

  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    authConfig.credentials = parsed;
    return new google.auth.GoogleAuth(authConfig);
  }

  throw new Error("Credenciais Google nao configuradas.");
}

async function resolveRangeForSpreadsheet(sheetsClient) {
  if (GOOGLE_SHEET_RANGE) {
    return GOOGLE_SHEET_RANGE;
  }

  const metadata = await sheetsClient.spreadsheets.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    fields: "sheets(properties(sheetId,title))",
  });

  const sheetList = metadata.data.sheets || [];
  if (!sheetList.length) {
    throw new Error("Nenhuma aba encontrada na planilha.");
  }

  if (GOOGLE_SHEET_GID) {
    const targetId = Number(GOOGLE_SHEET_GID);
    const matched = sheetList.find((s) => Number(s.properties?.sheetId) === targetId);
    if (!matched?.properties?.title) {
      throw new Error(`Nao achei aba com gid ${GOOGLE_SHEET_GID}.`);
    }
    return `'${matched.properties.title}'!A:ZZ`;
  }

  return `'${sheetList[0].properties?.title}'!A:ZZ`;
}

async function fetchCsvFromPrivateSheet() {
  const auth = buildGoogleAuth();
  const sheetsClient = google.sheets({ version: "v4", auth });
  const range = await resolveRangeForSpreadsheet(sheetsClient);

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range,
    majorDimension: "ROWS",
  });

  const values = response.data.values || [];
  if (!values.length) {
    throw new Error("Planilha privada retornou sem linhas.");
  }

  return valuesToCsv(values);
}

async function fetchCsvFromPublicUrl() {
  const separator = SHEET_CSV_URL.includes("?") ? "&" : "?";
  const urlWithNoCache = `${SHEET_CSV_URL}${separator}_ts=${Date.now()}`;
  const response = await fetch(urlWithNoCache, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const csvText = await response.text();
  if (!csvText.trim()) {
    throw new Error("CSV vazio.");
  }
  return csvText;
}

async function loadCacheFromDisk() {
  try {
    const csv = await fs.promises.readFile(CACHE_FILE, "utf-8");
    if (csv.trim()) {
      sheetState.csvText = csv;
      sheetState.updatedAt = new Date().toISOString();
      console.log("Cache local da planilha carregado.");
    }
  } catch (error) {
    // Sem cache ainda.
  }
}

async function saveCacheToDisk(csvText) {
  await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.promises.writeFile(CACHE_FILE, csvText, "utf-8");
}

function loadLegacyHistoryJson() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function sanitizeHistoryMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input;
}

async function saveHistoryJsonToDisk() {
  await fs.promises.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.promises.writeFile(HISTORY_FILE, JSON.stringify(historyState.byDate), "utf-8");
}

function assertDbIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error("DB_NAME invalido. Use apenas letras, numeros e underscore.");
  }
}

async function createHistoryPool() {
  if (historyPool) return historyPool;
  assertDbIdentifier(DB_NAME);

  const baseConfig = {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    connectionLimit: DB_CONNECTION_LIMIT,
    acquireTimeout: 5000,
  };

  if (DB_CREATE_IF_MISSING) {
    const bootstrapPool = mariadb.createPool(baseConfig);
    let bootstrapConn;
    try {
      bootstrapConn = await bootstrapPool.getConnection();
      await bootstrapConn.query(
        `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } finally {
      if (bootstrapConn) bootstrapConn.release();
      await bootstrapPool.end();
    }
  }

  historyPool = mariadb.createPool({
    ...baseConfig,
    database: DB_NAME,
  });

  let conn;
  try {
    conn = await historyPool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS production_history (
        date_key VARCHAR(10) NOT NULL,
        item_key VARCHAR(255) NOT NULL,
        target DOUBLE NOT NULL DEFAULT 0,
        done DOUBLE NOT NULL DEFAULT 0,
        rejected DOUBLE NOT NULL DEFAULT 0,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (date_key, item_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS production_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        event_type VARCHAR(80) NOT NULL,
        item_key VARCHAR(255) NULL,
        source_ip VARCHAR(80) NULL,
        user_agent VARCHAR(255) NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_audit_created_at (created_at),
        KEY idx_audit_event_type (event_type),
        KEY idx_audit_item_key (item_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    if (conn) conn.release();
  }

  return historyPool;
}

async function importHistoryMapToDb(historyMap) {
  if (!historyMap || typeof historyMap !== "object") return 0;
  const pool = await createHistoryPool();
  let conn;
  let inserted = 0;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const [dateKey, entries] of Object.entries(historyMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) continue;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [itemKey, values] of Object.entries(entries)) {
        const key = String(itemKey || "").trim();
        if (!key) continue;
        await conn.query(
          `INSERT INTO production_history (date_key, item_key, target, done, rejected, updated_at)
           VALUES (?, ?, ?, ?, ?, NOW(3))
           ON DUPLICATE KEY UPDATE
             target = VALUES(target),
             done = VALUES(done),
             rejected = VALUES(rejected),
             updated_at = VALUES(updated_at)`,
          [
            dateKey,
            key,
            Number.isFinite(Number(values?.target)) ? Number(values.target) : 0,
            Number.isFinite(Number(values?.done)) ? Number(values.done) : 0,
            Number.isFinite(Number(values?.rejected)) ? Number(values.rejected) : 0,
          ]
        );
        inserted += 1;
      }
    }
    await conn.commit();
  } catch (error) {
    if (conn) await conn.rollback();
    throw error;
  } finally {
    if (conn) conn.release();
  }
  return inserted;
}

async function loadHistoryFromDb() {
  const pool = await createHistoryPool();
  const countRows = await pool.query("SELECT COUNT(*) AS count FROM production_history");
  const existingRows = Number(countRows?.[0]?.count) || 0;
  if (existingRows === 0) {
    const legacyMap = loadLegacyHistoryJson();
    if (legacyMap) {
      const imported = await importHistoryMapToDb(legacyMap);
      if (imported > 0) {
        console.log(`Historico migrado do JSON legado para MariaDB (${imported} registros).`);
      }
    }
  }

  const rows = await pool.query(
    "SELECT date_key, item_key, target, done, rejected FROM production_history ORDER BY date_key, item_key"
  );
  const mapped = {};
  for (const row of rows) {
    if (!mapped[row.date_key]) {
      mapped[row.date_key] = {};
    }
    mapped[row.date_key][row.item_key] = {
      target: Number(row.target) || 0,
      done: Number(row.done) || 0,
      rejected: Number(row.rejected) || 0,
    };
  }
  historyState.byDate = mapped;
  console.log("Historico de producao carregado (MariaDB).");
}

async function saveHistoryEntry(dateKey, key, target, done, rejected) {
  if (historyRuntime.mode === "json_fallback") {
    await saveHistoryJsonToDisk();
    return;
  }

  const pool = await createHistoryPool();
  try {
    await pool.query(
      `INSERT INTO production_history (date_key, item_key, target, done, rejected, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         target = VALUES(target),
         done = VALUES(done),
         rejected = VALUES(rejected),
         updated_at = VALUES(updated_at)`,
      [dateKey, key, target, done, rejected]
    );
  } catch (error) {
    historyRuntime.mode = "json_fallback";
    historyRuntime.lastError = String(error.message || error);
    console.error(`Falha ao salvar no MariaDB. Ativando fallback JSON: ${historyRuntime.lastError}`);
    await saveHistoryJsonToDisk();
  }
}

async function closeHistoryDb() {
  if (!historyPool) return;
  try {
    await historyPool.end();
  } catch (error) {
    // Ignora falhas no encerramento.
  } finally {
    historyPool = null;
  }
}

function resolveSourceIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  const remoteAddress = req?.socket?.remoteAddress;
  return typeof remoteAddress === "string" ? remoteAddress : "";
}

async function saveAuditEvent(eventType, payload, req) {
  if (!eventType || typeof eventType !== "string") return;
  if (historyRuntime.mode !== "mariadb") return;

  try {
    const pool = await createHistoryPool();
    const itemKeyRaw = String(payload?.key || payload?.itemKey || "").trim();
    const itemKey = itemKeyRaw || null;
    const sourceIp = resolveSourceIp(req) || null;
    const userAgent = String(req?.headers?.["user-agent"] || "").slice(0, 255) || null;
    const payloadJson = JSON.stringify(payload || {});

    await pool.query(
      `INSERT INTO production_audit_log (event_type, item_key, source_ip, user_agent, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))`,
      [eventType, itemKey, sourceIp, userAgent, payloadJson]
    );
  } catch (error) {
    console.error(`Falha ao registrar auditoria: ${String(error.message || error)}`);
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}

async function syncSheetCsv() {
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
  try {
    let csvText = "";
    if (isPrivateSheetsConfigReady()) {
      sheetState.sourceMode = "private_sheets_api";
      csvText = await fetchCsvFromPrivateSheet();
    } else {
      sheetState.sourceMode = "public_csv";
      csvText = await fetchCsvFromPublicUrl();
    }

    sheetState.csvText = csvText;
    sheetState.updatedAt = new Date().toISOString();
    sheetState.lastError = null;
    await saveCacheToDisk(csvText);
    console.log(`Planilha sincronizada em ${sheetState.updatedAt} (${sheetState.sourceMode})`);
  } catch (error) {
    sheetState.lastError = String(error.message || error);
    console.error(`Falha ao sincronizar planilha: ${sheetState.lastError}`);
  }
  })();

  try {
    await syncPromise;
  } finally {
    syncPromise = null;
  }
}

async function startSheetSync() {
  await loadCacheFromDisk();
  try {
    await loadHistoryFromDb();
    historyRuntime.mode = "mariadb";
    historyRuntime.lastError = null;
  } catch (error) {
    historyRuntime.lastError = String(error.message || error);
    if (REQUIRE_DB) {
      historyRuntime.mode = "db_required";
      throw new Error(`MariaDB obrigatorio e indisponivel: ${historyRuntime.lastError}`);
    }
    historyRuntime.mode = "json_fallback";
    historyState.byDate = sanitizeHistoryMap(loadLegacyHistoryJson());
    console.error(`MariaDB indisponivel. Historico em JSON local (REQUIRE_DB=false): ${historyRuntime.lastError}`);
  }
  await syncSheetCsv();
  setInterval(() => {
    syncSheetCsv();
  }, SHEET_SYNC_MS);
}

function handleApiRoutes(req, res) {
  const url = req.url || "/";
  const pathname = url.split("?")[0];

  if (pathname === "/api/producao-csv") {
    if (!sheetState.csvText) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          message: "Planilha ainda nao sincronizada.",
          lastError: sheetState.lastError,
          sourceMode: sheetState.sourceMode,
        })
      );
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Sheet-Updated-At": sheetState.updatedAt || "",
      "X-Sheet-Source": sheetState.sourceMode,
    });
    res.end(sheetState.csvText);
    return true;
  }

  if (pathname === "/api/producao-status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        hasData: Boolean(sheetState.csvText),
        updatedAt: sheetState.updatedAt,
        lastError: sheetState.lastError,
        syncIntervalMs: SHEET_SYNC_MS,
        sourceMode: sheetState.sourceMode,
        historyMode: historyRuntime.mode,
        historyLastError: historyRuntime.lastError,
        requireDb: REQUIRE_DB,
      })
    );
    return true;
  }

  if (pathname === "/api/production-history" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(historyState.byDate));
    return true;
  }

  if (pathname === "/api/production-history-entry" && req.method === "POST") {
    parseJsonBody(req)
      .then(async (body) => {
        const dateKeyRaw = String(body?.dateKey || "");
        const keyRaw = String(body?.key || "");
        const target = Number(body?.target);
        const done = Number(body?.done);
        const rejected = Number(body?.rejected);

        const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(dateKeyRaw) ? dateKeyRaw : toLocalDateKey(new Date());
        const key = keyRaw.trim();
        if (!key) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, message: "Campo key obrigatorio." }));
          return;
        }

        if (!historyState.byDate[dateKey]) {
          historyState.byDate[dateKey] = {};
        }
        historyState.byDate[dateKey][key] = {
          target: Number.isFinite(target) ? target : 0,
          done: Number.isFinite(done) ? done : 0,
          rejected: Number.isFinite(rejected) ? rejected : 0,
        };
        await saveHistoryEntry(
          dateKey,
          key,
          Number.isFinite(target) ? target : 0,
          Number.isFinite(done) ? done : 0,
          Number.isFinite(rejected) ? rejected : 0
        );
        await saveAuditEvent(
          "history_entry_upsert",
          {
            dateKey,
            key,
            target: Number.isFinite(target) ? target : 0,
            done: Number.isFinite(done) ? done : 0,
            rejected: Number.isFinite(rejected) ? rejected : 0,
          },
          req
        );

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: String(error.message || error) }));
      });
    return true;
  }

  if (pathname === "/api/producao-sync") {
    syncSheetCsv()
      .then(async () => {
        await saveAuditEvent("sheet_sync_manual", { sourceMode: sheetState.sourceMode }, req);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: Boolean(sheetState.csvText),
            updatedAt: sheetState.updatedAt,
            lastError: sheetState.lastError,
            sourceMode: sheetState.sourceMode,
          })
        );
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            message: String(error?.message || error),
          })
        );
      });
    return true;
  }

  if (pathname === "/api/audit-event" && req.method === "POST") {
    parseJsonBody(req)
      .then(async (body) => {
        const action = String(body?.action || "").trim();
        if (!action) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, message: "Campo action obrigatorio." }));
          return;
        }
        await saveAuditEvent(action, body, req);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: String(error.message || error) }));
      });
    return true;
  }

  if (pathname === "/api/audit-events" && req.method === "GET") {
    if (historyRuntime.mode !== "mariadb") {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          message: "Auditoria indisponivel sem MariaDB.",
          historyMode: historyRuntime.mode,
        })
      );
      return true;
    }

    Promise.resolve()
      .then(async () => {
        const parsedUrl = new URL(req.url || "/api/audit-events", "http://localhost");
        const rawLimit = Number(parsedUrl.searchParams.get("limit") || 100);
        const limit = Math.max(1, Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 100));
        const pool = await createHistoryPool();
        const rows = await pool.query(
          `SELECT id, event_type, item_key, source_ip, user_agent, payload_json, created_at
           FROM production_audit_log
           ORDER BY id DESC
           LIMIT ?`,
          [limit]
        );
        const normalized = (rows || []).map((row) => {
          let payload = {};
          try {
            payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {};
          } catch (error) {
            payload = {};
          }
          return {
            id: Number(row.id),
            eventType: row.event_type,
            itemKey: row.item_key,
            sourceIp: row.source_ip,
            userAgent: row.user_agent,
            payload,
            createdAt: row.created_at,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, items: normalized }));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: String(error.message || error) }));
      });
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  if (handleApiRoutes(req, res)) {
    return;
  }

  const filePath = resolvePath(req.url || "/");
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Acesso negado");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Arquivo nao encontrado");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", () => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Erro interno ao ler arquivo");
    });
  });
});

process.on("SIGINT", () => {
  closeHistoryDb().catch(() => {});
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeHistoryDb().catch(() => {});
  process.exit(0);
});
process.on("exit", () => {
  closeHistoryDb().catch(() => {});
});

async function boot() {
  await startSheetSync();
  server.listen(PORT, () => {
    console.log(`Servidor ativo em http://localhost:${PORT}`);
    console.log(`Sincronizacao ativa: ${SHEET_SYNC_MS}ms`);
  });
}

boot().catch((error) => {
  console.error(`Erro ao iniciar sincronizacao da planilha: ${error.message}`);
  process.exit(1);
});
