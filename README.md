# bunk — bunq CLI

A command-line tool to authenticate with [bunq](https://www.bunq.com) via OAuth2 and index Payments locally into SQLite for fast offline querying.

## Installation

```bash
npm install -g @iovdin/bunk
```

Or for local dev:

```bash
npm i
npm link   # makes `bunk` available on your PATH
```

> **Requires Node.js >= 22** — uses the built-in `node:sqlite` module.

## Configuration

Credentials are stored securely in the system keychain (macOS Keychain, GNOME Keyring, KWallet, Windows Credential Manager) and are managed automatically by `bunk auth`. The following items are stored under the service name `bunk`:

| Item | Description |
|------|-------------|
| `BUNQ_CLIENT_ID` | OAuth2 client ID from bunq Developer settings |
| `BUNQ_CLIENT_SECRET` | OAuth2 client secret |
| `BUNQ_ACCESS_TOKEN` | OAuth2 access token |
| `BUNQ_INSTALLATION_TOKEN` | bunq installation token |
| `BUNQ_SESSION_TOKEN` | bunq session token |
| `BUNQ_USER_ID` | Your bunq user ID |
| `BUNQ_PUBLIC_KEY` | RSA public key for bunq API |
| `BUNQ_PRIVATE_KEY` | RSA private key for bunq API |

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
6. Create a session and save `sessionToken` + `userId` to keychain

All credentials are persisted to your system keychain so subsequent runs skip steps already completed.

---

### 2. Fetch payments

```bash
bunk fetch
# or specify a custom database path
bunk fetch --output ~/bunq/index.sqlite
# verbose output
bunk fetch --verbose
# wipe database and re-fetch everything
bunk fetch --clean
```

Downloads Payments for each monetary account and stores a normalized row per payment in a local SQLite database. The tool only fetches the `payment` collection (no other event types).

On the **first run** (empty database) it performs a full backfill, paginating back in time until there are no more payments. On **subsequent runs** it only fetches payments newer than the highest `id` already stored.

Payments are stored in the `payment` table with a normalized schema:

```sql
CREATE TABLE payment (
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

CREATE INDEX IF NOT EXISTS idx_payment_account ON payment (monetary_account_id);
```

---

## Example queries

```sql
-- Last 20 payments
SELECT id, created, amount_value, amount_currency, counterparty_alias_name AS counterparty_name, description
FROM payment
ORDER BY created DESC
LIMIT 20;

-- Total spent per counterparty (outgoing payments have negative amounts relative to the account)
SELECT counterparty_alias_name AS counterparty_name, ROUND(SUM(CAST(amount_value AS REAL)), 2) AS total
FROM payment
WHERE CAST(amount_value AS REAL) < 0
GROUP BY counterparty_alias_name
ORDER BY total ASC
LIMIT 20;

-- Payments this month
SELECT created, amount_value, description, counterparty_alias_name
FROM payment
WHERE created >= date('now', 'start of month')
ORDER BY created DESC;
```

---

## crontab

To keep your local database up to date automatically, add the following to your crontab (`crontab -e`).  Adjust the Node.js path to match your environment (`node --version` to check):

```crontab
HOME=/Users/your_username
PATH=/Users/your_username/.nvm/versions/node/v22.20.0/bin:/usr/local/bin:/usr/bin:/bin

# Fetch new bunq payments every 15 minutes
*/15 * * * * bunk fetch >> $HOME/bunk.log 2>&1
```