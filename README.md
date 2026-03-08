# bunk — bunq CLI

A command-line tool to authenticate with [bunq](https://www.bunq.com) via OAuth2, download all your events and index payments locally into SQLite for fast offline querying.

## Installation

```bash
npm install -g bunk
```

Or for local dev:

```bash
npm i
npm link   # makes `bunk` available on your PATH
```

> **Requires Node.js >= 22** — uses the built-in `node:sqlite` module.

## Configuration

Config is stored at `~/.config/bunk/config.json` and is managed automatically by `bunk auth`.

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "accessToken": "...",
  "installationToken": "...",
  "sessionToken": "...",
  "userId": 12345678,
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
}
```

## Usage

### 1. Authenticate

```bash
bunk auth
# or specify a custom callback port/host
bunk auth --port 4589 --host 127.0.0.1
```

This will:
1. Prompt you for your **OAuth2 `client_id` and `client_secret`** (from [bunq Developer settings](https://www.bunq.com/developer))
2. Open the bunq authorization URL in your browser
3. Start a local HTTP server to capture the OAuth2 callback
4. Exchange the code for an `access_token`
5. Register an RSA key pair, an installation and a device-server with the bunq API
6. Create a session and save `sessionToken` + `userId` to config

All credentials are persisted to `~/.config/bunk/config.json` (mode `0600`) so subsequent runs skip steps already completed.

---

### 2. Fetch events

```bash
bunk fetch
# or specify a custom database path
bunk fetch --output ~/bunq/index.sqlite
# verbose output
bunk fetch --verbose
# wipe database and re-fetch everything
bunk fetch --clean
```

Downloads all bunq events (payments, card actions, etc.) from the API and stores the raw JSON in a local SQLite database.

- On the **first run** (empty database) it performs a full backfill, paginating back in time until there are no more events.
- On **subsequent runs** it only fetches events newer than the highest `id` already stored.

Events are stored in the `events` table:

```sql
CREATE TABLE events (
  id      INTEGER PRIMARY KEY,
  content TEXT NOT NULL        -- raw bunq event JSON
);
```

---

### 3. Index payments

```bash
bunk index
# or specify a custom database path
bunk index --output ~/bunq/index.sqlite
```

Extracts structured payment data from the raw `events` table into a `payments` table for easy querying. Supports both **Payment** and **MasterCardAction** event types.

```sql
CREATE TABLE payments (
  event_id          INTEGER PRIMARY KEY,
  created_at        TEXT,
  account_id        TEXT,
  amount_value      REAL,      -- negative for card payments / debits
  amount_currency   TEXT,
  status            TEXT,
  description       TEXT,
  counterparty_name TEXT,
  counterparty_iban TEXT,
  my_name           TEXT,
  my_iban           TEXT
);
```

---

## Example queries

```sql
-- Last 20 transactions
SELECT event_id, created_at, amount_value, amount_currency, counterparty_name, description
FROM payments
ORDER BY created_at DESC
LIMIT 20;

-- Total spent per counterparty (debits only)
SELECT counterparty_name, ROUND(SUM(amount_value), 2) AS total
FROM payments
WHERE amount_value < 0
GROUP BY counterparty_name
ORDER BY total ASC
LIMIT 20;

-- All card payments this month
SELECT created_at, amount_value, description, counterparty_name
FROM payments
WHERE status != 'COMPLETED'   -- MasterCardAction statuses differ
  AND created_at >= date('now', 'start of month')
ORDER BY created_at DESC;
```

---

## crontab

To keep your local database up to date automatically, add the following to your crontab (`crontab -e`).  
Adjust the Node.js path to match your environment (`node --version` to check):

```crontab
HOME=/Users/your_username
PATH=/Users/your_username/.nvm/versions/node/v22.20.0/bin:/usr/local/bin:/usr/bin:/bin

# Fetch new bunq events and index payments every 15 minutes
*/15 * * * * bunk fetch && bunk index >> $HOME/bunk.log 2>&1
```