const fs = require('fs');
const os = require('os');
const path = require('path');

// Node.js v25+ built-in SQLite
const sqlite = require('node:sqlite');

const { configPath } = require('./auth');

const environment = 'production';
const domains = {
  sandbox: {
    oauthApi: 'api-oauth.sandbox.bunq.com',
    oauth: 'oauth.sandbox.bunq.com',
    api: 'public-api.sandbox.bunq.com',
  },
  production: {
    oauthApi: 'api.oauth.bunq.com',
    oauth: 'oauth.bunq.com',
    api: 'api.bunq.com',
  },
};

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL
    );
  `);
}

function getMaxId(db) {
  const row = db.prepare('SELECT MAX(id) AS max_id FROM events').get();
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

function extractEvents(payload) {
  const out = [];
  const arr = Array.isArray(payload?.Response) ? payload.Response : [];
  for (const item of arr) {
    const ev = item?.Event;
    if (ev && ev.id != null) out.push(ev);
  }
  return out;
}

async function fetchEvents(opts = {}) {
  const verbose = !!opts.verbose;
  const clean = !!opts.clean;

  const cfg = readExistingConfig();
  const sessionToken = cfg.sessionToken;
  const userId = cfg.userId;

  if (!sessionToken) {
    throw new Error(`Missing sessionToken in ${configPath()}. Run: bunk auth`);
  }
  if (!userId) {
    throw new Error(`Missing userId in ${configPath()}. Run: bunk auth`);
  }

  const dbPath = resolveDbPath(opts, cfg);

  if (clean) {
    if (verbose) console.log(`--clean: removing ${dbPath} (and -wal/-shm)`);
    deleteDbFiles(dbPath);
  }

  const db = getDb(dbPath);
  try {
    ensureSchema(db);

    const maxId = getMaxId(db);
    const isEmpty = maxId === 0;

    // per your comment: if collection is empty behave like --all
    const modeAll = isEmpty;

    // Insert/upsert (node:sqlite does not provide db.transaction like better-sqlite3)
    const ins = db.prepare('INSERT OR REPLACE INTO events (id, content) VALUES (?, ?)');
    const insertMany = (events) => {
      db.exec('BEGIN');
      try {
        for (const ev of events) {
          ins.run(Number(ev.id), JSON.stringify(ev));
        }
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw e;
      }
    };

    const count = 200;

    let nextPath;
    if (modeAll) {
      nextPath = `/v1/user/${userId}/event?count=${count}`;
      console.log(`Database: ${dbPath}`);
      console.log(`events table empty -> full backfill mode (count=${count})`);
    } else {
      // Only fetch newer than current max id
      nextPath = `/v1/user/${userId}/event?count=${count}&newer_id=${encodeURIComponent(String(maxId))}`;
      console.log(`Database: ${dbPath}`);
      console.log(`Fetching newer events since id=${maxId} (count=${count})`);
    }

    let pages = 0;
    let inserted = 0;

    let lastPath = null;
    while (nextPath) {
      // Detect non-advancing pagination
      if (nextPath === lastPath) {
        if (verbose) console.warn(`Pagination did not advance (stuck on ${nextPath}). Stopping.`);
        break;
      }
      lastPath = nextPath;

      pages++;
      if (verbose) console.log(`GET ${nextPath}`);
      const json = await bunqGetJson(nextPath, { sessionToken });

      const events = extractEvents(json);
      if (events.length) {
        insertMany(events);
        inserted += events.length;
      }

      const pag = json?.Pagination || {};
      if (modeAll) {
        // walk back in time until older_url is null
        nextPath = pag.older_url || null;
      } else {
        // When using newer_id, bunq may keep returning future_url=null.
        // In that case, stop after the first page.
        nextPath = pag.future_url || null;
        if (!nextPath) {
          break;
        }
      }

      if (!verbose) {
        process.stdout.write(`\rpages=${pages} inserted=${inserted}`);
      }

      // Safety: prevent infinite loops if API misbehaves
      if (pages > 1_000_000) throw new Error('too many pages; aborting');
    }

    if (!verbose) process.stdout.write('\n');
    console.log(`Done. pages=${pages}, inserted=${inserted}, maxId(now)=${getMaxId(db)}`);
  } finally {
    db.close();
  }
}

module.exports = { fetchEvents };
