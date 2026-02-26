const fs = require("fs");
const path = require("path");
const mariadb = require("mariadb");

function loadDotEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
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

async function main() {
  loadDotEnvFile();

  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT) || 3306;
  const user = process.env.DB_USER || "dashboard_user";
  const password = process.env.DB_PASSWORD || "";
  const database = process.env.DB_NAME || "dashboard_producao";

  const connectionHint = `DB_HOST=${host} DB_PORT=${port} DB_USER=${user} DB_NAME=${database}`;
  let pool;
  let conn;
  try {
    pool = mariadb.createPool({
      host,
      port,
      user,
      password,
      database,
      connectionLimit: 1,
      acquireTimeout: 5000,
    });
    conn = await pool.getConnection();
    const rows = await conn.query("SELECT 1 AS ok");
    const ok = Number(rows?.[0]?.ok) === 1;
    if (!ok) {
      throw new Error("Consulta de validacao retornou valor inesperado.");
    }
    console.log(`Conexao MariaDB OK. ${connectionHint}`);
  } catch (error) {
    console.error(`Falha na conexao MariaDB. ${connectionHint}`);
    console.error(String(error.message || error));
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    if (pool) {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
