const fs = require('fs');
const os = require('os');
const path = require('path');

// Node.js v25+ built-in SQLite
const sqlite = require('node:sqlite');

const { getSecret, configPath } = require('./auth');

const environment = 'production';
const domains = {
  sandbox: {
    oauthApi: 'api-oauth.sandbox.bunq.com',
    oauth: 'oauth.sanbox.bunq.com',
    api: 'public-api.sandbox.bunq.com',
  },
  production: {
    oauthApi: 'api.oauth.bunq.com',
    oauth: 'oauth.bunq.com',
    api: 'api.bunq.com',
  },
};

// Only fetch payments
const COLLECTIONS = [
  { name: 'payment', endpoint: 'payment' },
];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readExistingConfig() {
  try {
    const text = fs.readFileSync(configPath(), 'utf8');
    const trimmed = String(text || '').trim();
    if (!trimmed) return {};
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resolveDbPath(opts, config) {
  const fromOpts = opts && opts.output;
  const fromConfig = config && config.output;
  const p = expandHome(fromOpts || fromConfig || '~/bunq/index.sqlite');
  return p;
}

function getDb(dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new sqlite.DatabaseSync(dbPath);
  // Improve concurrency a bit and speed inserts
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

function ensureSchema(db) {
  // Create a normalized table for payments. If the table already exists with other
  // columns, attempt to add missing columns. This keeps compatibility with existing DBs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment (
      id INTEGER PRIMARY KEY,
      monetary_account_id INTEGER NOT NULL,
      created TEXT,
      amount_value TEXT,
      amount_currency TEXT,
      alias_iban TEXT,
      alias_name TEXT,
      counterparty_alias_iban TEXT,
      counterparty_alias_name TEXT,
      description TEXT,
      type TEXT,
      sub_type TEXT,
      balance_value TEXT,
      balance_currency TEXT
    );
  `);

  // Index for faster lookups by account
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payment_account ON payment (monetary_account_id);
  `);
}

function getMaxId(db, tableName) {
  const row = db.prepare(`SELECT MAX(id) AS max_id FROM ${tableName}`).get();
  return row && row.max_id ? Number(row.max_id) : 0;
}

function deleteDbFiles(dbPath) {
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

async function bunqGetJson(urlPath, { sessionToken } = {}) {
  const url = urlPath.startsWith('http')
    ? urlPath
    : `https://${domains[environment].api}${urlPath}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Bunq-Client-Authentication': sessionToken,
      'Content-Type': 'application/json',
      'User-Agent': 'bunk-cli/1.0',
      'X-Bunq-Language': 'en_US',
      'X-Bunq-Region': 'en_US',
      'X-Bunq-Geolocation': '0 0 0 0 NL',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bunq GET ${urlPath} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Extract items from response based on collection type
// bunq wraps items like { Response: [ { Payment: {...} }, ... ] }
function extractItems(payload, collectionName) {
  const out = [];
  const arr = Array.isArray(payload?.Response) ? payload.Response : [];
  for (const item of arr) {
    // The key is the singular/capitalized version of the collection name
    // e.g., 'payment' -> 'Payment'
    const key = Object.keys(item || {}).find(k => k !== 'Pagination');
    if (key && item[key] && item[key].id != null) {
      out.push(item[key]);
    }
  }
  return out;
}

function fetchMonetaryAccounts(userId, sessionToken) {
  // Keep as async wrapper that calls bunqGetJson to match original signature
  return bunqGetJson(`/v1/user/${userId}/monetary-account`, { sessionToken })
    .then(json => {
      const accounts = [];
      const arr = Array.isArray(json?.Response) ? json.Response : [];
      for (const item of arr) {
        const key = Object.keys(item || {}).find(k => k.startsWith('MonetaryAccount'));
        if (key && item[key] && item[key].id != null) {
          accounts.push({
            id: item[key].id,
            type: key,
            currency: item[key].currency,
            balance: item[key].balance,
          });
        }
      }
      return accounts;
    });
}

function normalizePayment(item, accountId) {
  const created = item.created || null;
  const amount_value = item.amount?.value ?? null;
  const amount_currency = item.amount?.currency ?? null;

  // alias: prefer top-level display_name, fallback to label_user.display_name
  const alias_iban = item.alias?.iban ?? null;
  const alias_name = item.alias?.display_name ?? item.alias?.label_user?.display_name ?? null;

  const counterparty_alias_iban = item.counterparty_alias?.iban ?? null;
  const counterparty_alias_name = item.counterparty_alias?.display_name ?? item.counterparty_alias?.label_user?.display_name ?? null;

  const description = item.description ?? null;
  const type = item.type ?? null;
  const sub_type = item.sub_type ?? null;

  const balance_value = item.balance_after_mutation?.value ?? null;
  const balance_currency = item.balance_after_mutation?.currency ?? null;

  return {
    id: Number(item.id),
    monetary_account_id: Number(accountId),
    created,
    amount_value,
    amount_currency,
    alias_iban,
    alias_name,
    counterparty_alias_iban,
    counterparty_alias_name,
    description,
    type,
    sub_type,
    balance_value,
    balance_currency,
  };
}

// Fetch items for a specific collection from a monetary account
async function fetchCollection(opts = {}) {
  const verbose = !!opts.verbose;
  const clean = !!opts.clean;

  const sessionToken = getSecret('BUNQ_SESSION_TOKEN');
  const userId = getSecret('BUNQ_USER_ID');

  if (!sessionToken) {
    throw new Error(`Missing sessionToken in keychain. Run: bunk auth`);
  }
  if (!userId) {
    throw new Error(`Missing userId in keychain. Run: bunk auth`);
  }

  const dbPath = resolveDbPath(opts);

  if (clean) {
    if (verbose) console.log(`--clean: removing ${dbPath} (and -wal/-shm)`);
    deleteDbFiles(dbPath);
  }

  const db = getDb(dbPath);
  try {
    ensureSchema(db);

    // Get monetary accounts
    if (verbose) console.log('Fetching monetary accounts...');
    const accounts = await fetchMonetaryAccounts(userId, sessionToken);
    console.log(`Found ${accounts.length} monetary account(s): ${accounts.map(a => a.id).join(', ')}`);

    const count = 200;
    let totalInserted = 0;
    let totalPages = 0;

    // Prepare insert statements for payment only
    const inserters = {};
    for (const col of COLLECTIONS) {
      if (col.name === 'payment') {
        inserters[col.name] = db.prepare(
          `INSERT OR REPLACE INTO payment (
            id, monetary_account_id, created,
            amount_value, amount_currency,
            alias_iban, alias_name,
            counterparty_alias_iban, counterparty_alias_name,
            description, type, sub_type,
            balance_value, balance_currency
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
      } else {
        inserters[col.name] = db.prepare(
          `INSERT OR REPLACE INTO ${col.name} (id, monetary_account_id, content) VALUES (?, ?, ?)`
        );
      }
    }

    const insertMany = (tableName, items, accountId) => {
      db.exec('BEGIN');
      try {
        for (const item of items) {
          if (tableName === 'payment') {
            const p = normalizePayment(item, accountId);
            inserters.payment.run(
              p.id,
              p.monetary_account_id,
              p.created,
              p.amount_value,
              p.amount_currency,
              p.alias_iban,
              p.alias_name,
              p.counterparty_alias_iban,
              p.counterparty_alias_name,
              p.description,
              p.type,
              p.sub_type,
              p.balance_value,
              p.balance_currency
            );
          } else {
            inserters[tableName].run(Number(item.id), Number(accountId), JSON.stringify(item));
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw e;
      }
    };

    // Process each monetary account
    for (const account of accounts) {
      console.log(`\nProcessing monetary account ${account.id} (${account.type})...`);

      // Process each collection for this account (only payment)
      for (const col of COLLECTIONS) {
        const isEmpty = getMaxId(db, col.name) === 0;
        const modeAll = isEmpty;

        let nextPath;
        if (modeAll) {
          nextPath = `/v1/user/${userId}/monetary-account/${account.id}/${col.endpoint}?count=${count}`;
        } else {
          const maxId = getMaxId(db, col.name);
          nextPath = `/v1/user/${userId}/monetary-account/${account.id}/${col.endpoint}?count=${count}&newer_id=${maxId}`;
        }

        if (verbose) {
          console.log(`  [${col.name}] ${modeAll ? 'full backfill' : 'incremental (since id=' + getMaxId(db, col.name) + ')'} `);
        }

        let pages = 0;
        let inserted = 0;
        let lastPath = null;

        while (nextPath) {
          if (nextPath === lastPath) {
            if (verbose) console.warn(`    Pagination did not advance. Stopping.`);
            break;
          }
          lastPath = nextPath;

          pages++;
          if (verbose) console.log(`    GET ${nextPath}`);
          const json = await bunqGetJson(nextPath, { sessionToken });

          const items = extractItems(json, col.name);
          if (items.length) {
            insertMany(col.name, items, account.id);
            inserted += items.length;
          }

          const pag = json?.Pagination || {};
          if (modeAll) {
            // Walk back in time until older_url is null
            nextPath = pag.older_url || null;
          } else {
            // Incremental: use future_url for newer items
            nextPath = pag.future_url || null;
            if (!nextPath) break;
          }

          if (!verbose) {
            process.stdout.write(`\r  [${col.name}] pages=${pages} inserted=${inserted}    `);
          }

          if (pages > 100_000) throw new Error(`Too many pages for ${col.name}; aborting`);
        }

        if (!verbose) process.stdout.write('\n');
        if (verbose || inserted > 0) {
          console.log(`  [${col.name}] Done: ${inserted} items in ${pages} pages`);
        }
        totalInserted += inserted;
        totalPages += pages;
      }
    }

    console.log(`\nAll done. Total inserted: ${totalInserted} items across ${accounts.length} account(s)`);
  } finally {
    db.close();
  }
}

// For backwards compatibility, alias fetchEvents to fetchCollection
const fetchEvents = fetchCollection;

module.exports = { fetchEvents, fetchCollection, COLLECTIONS };
