const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('node:sqlite');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getDb(dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

function ensurePaymentsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      event_id INTEGER PRIMARY KEY,
      created_at TEXT,
      account_id TEXT,
      amount_value REAL,
      amount_currency TEXT,
      status TEXT,
      description TEXT,
      counterparty_name TEXT,
      counterparty_iban TEXT,
      my_name TEXT,
      my_iban TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_counterparty_name ON payments(counterparty_name);
  `);
}

function indexPayments(opts = {}) {
  const dbPath = expandHome(opts.output || '~/bunq/index.sqlite');
  const db = getDb(dbPath);

  try {
    ensurePaymentsSchema(db);

    const row = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS max_event_id FROM payments').get();
    const maxEventId = Number(row?.max_event_id || 0);

    const sql = `
      INSERT OR IGNORE INTO payments (
        event_id,
        created_at,
        account_id,
        amount_value,
        amount_currency,
        status,
        description,
        counterparty_name,
        counterparty_iban,
        my_name,
        my_iban
      )
      SELECT
        json_extract(content, '$.id') AS event_id,
        json_extract(content, '$.created') AS created_at,
        json_extract(content, '$.monetary_account_id') AS account_id,
        CAST(json_extract(content, '$.object.Payment.amount.value') AS REAL) AS amount_value,
        json_extract(content, '$.object.Payment.amount.currency') AS amount_currency,
        json_extract(content, '$.status') AS status,
        json_extract(content, '$.object.Payment.description') AS description,
        json_extract(content, '$.object.Payment.counterparty_alias.display_name') AS counterparty_name,
        json_extract(content, '$.object.Payment.counterparty_alias.iban') AS counterparty_iban,
        json_extract(content, '$.object.Payment.alias.display_name') AS my_name,
        json_extract(content, '$.object.Payment.alias.iban') AS my_iban
      FROM events
      WHERE json_type(content, '$.object.Payment') = 'object'
        AND CAST(json_extract(content, '$.id') AS INTEGER) > ?

      UNION ALL

      SELECT
        json_extract(content, '$.id') AS event_id,
        json_extract(content, '$.created') AS created_at,
        json_extract(content, '$.monetary_account_id') AS account_id,
        -ABS(CAST(json_extract(content, '$.object.MasterCardAction.amount_local.value') AS REAL)) AS amount_value,
        json_extract(content, '$.object.MasterCardAction.amount_local.currency') AS amount_currency,
        json_extract(content, '$.object.MasterCardAction.payment_status') AS status,
        json_extract(content, '$.object.MasterCardAction.description') AS description,
        json_extract(content, '$.object.MasterCardAction.counterparty_alias.display_name') AS counterparty_name,
        json_extract(content, '$.object.MasterCardAction.counterparty_alias.iban') AS counterparty_iban,
        json_extract(content, '$.object.MasterCardAction.alias.display_name') AS my_name,
        json_extract(content, '$.object.MasterCardAction.alias.iban') AS my_iban
      FROM events
      WHERE json_type(content, '$.object.MasterCardAction') = 'object'
        AND CAST(json_extract(content, '$.id') AS INTEGER) > ?
    `;

    const before = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
    db.prepare(sql).run(maxEventId, maxEventId);
    const after = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;

    console.log(`Indexed payments: +${after - before} (total=${after}) from events newer than event_id=${maxEventId}`);
  } finally {
    db.close();
  }
}

module.exports = { indexPayments };