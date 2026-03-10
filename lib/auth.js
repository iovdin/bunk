const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require("crypto");
const { Entry } = require("@napi-rs/keyring")

const environment = 'production'

const domains = {
  sandbox: { 
    oauthApi: "api-oauth.sandbox.bunq.com",
    oauth: "oauth.sandbox.bunq.com",
    api: "public-api.sandbox.bunq.com"
  },
  production: {
    oauthApi: "api.oauth.bunq.com",
    oauth: "oauth.bunq.com",
    api: "api.bunq.com"
  }
}


function getSecret(name) {
  try {
    return new Entry(name, 'personal').getPassword() || null;
  } catch (e) {
    console.error(e)
    return null;
  }
}

function setSecret(name, value) {
  new Entry(name, 'personal').setPassword(name, 'personal', value);
}


function question(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        process.stdin.off('data', onData);
        resolve(buf.slice(0, idx).trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

async function exchangeToken({
  grantType,
  code,
  redirectUri,
  clientId,
  clientSecret,
}) {
  const u = new URL(`https://${domains[environment].oauthApi}/v1/token`);

  u.searchParams.set('grant_type', grantType);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('client_secret', clientSecret);
  if (code) u.searchParams.set('code', code);

  // bunq's OAuth token endpoint uses query parameters
  const res = await fetch(u.toString(), { method: 'POST' });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bunq token endpoint error (${res.status}): ${text}`);
  }
  return res.json();
}


function generateBunqKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",       // ✅ required for bunq
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",      // ✅ required for bunq
      format: "pem"
    }
  });

  return {
    publicKey,
    privateKey
  };
}

function signBody(body, privateKey) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  return signer.sign(privateKey, "base64");
}

/*
async function createSession({ access_token }) {
  const res = await fetch(`https://${domains[environment].api}/v1/session-server`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bunq-Client-Authentication': access_token,
      'X-Bunq-Language': 'en_US',
      'X-Bunq-Region': 'nl_NL',
      'X-Bunq-Client-Request-Id': Date.now().toString(),
      'Cache-Control': 'no-cache'
      // Authorization: `Bearer ${access_token}`,
      // Accept: 'application/json',
      // 'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `bunq session-server error (${res.status}): ${typeof text === 'string' ? text : JSON.stringify(json)}`,
    );
  }

  const sessionToken = res.headers.get('x-bunq-client-authentication');
  if (!sessionToken) {
    throw new Error(
      `Missing x-bunq-client-authentication header from session-server response. Body: ${text}`,
    );
  }

  // Try to find user id in response payload.
  // bunq responses are typically arrays of objects like {UserPerson:{...}} wrapped in Response.
  let userId;
  try {
    const responses = Array.isArray(json.Response) ? json.Response : [];
    for (const item of responses) {
      if (!item || typeof item !== 'object') continue;
      const v = item.UserPerson || item.UserCompany || item.UserLight || item.UserApiKey;
      if (v && v.id) {
        userId = v.id;
        break;
      }
    }
  } catch {
    // ignore
  }

  return { sessionToken, session: json, userId };
}
*/

async function auth({ host = '127.0.0.1', port = 4589 }) {
  const redirectUri = `http://${host}:${port}/callback`;

  let userId = getSecret('BUNQ_USER_ID');
  let clientId = getSecret('BUNQ_CLIENT_ID');
  let clientSecret = getSecret('BUNQ_CLIENT_SECRET');
  let accessToken = getSecret('BUNQ_ACCESS_TOKEN');
  let publicKey = getSecret('BUNQ_PUBLIC_KEY');
  let privateKey = getSecret('BUNQ_PRIVATE_KEY');
  let installationToken = getSecret('BUNQ_INSTALLATION_TOKEN');
  let sessionToken = getSecret('BUNQ_SESSION_TOKEN');

  if (!publicKey || !privateKey) {
    const res = generateBunqKeyPair();
    publicKey = res.publicKey;
    privateKey = res.privateKey;
    setSecret('BUNQ_PUBLIC_KEY', publicKey);
    setSecret('BUNQ_PRIVATE_KEY', privateKey);
  }
  if (!clientId || !clientSecret) {
    console.log(`\nThis command will start a local HTTP server to capture bunq OAuth redirect.`);
    console.log(`1) In bunq Developer settings create an OAuth app (or edit existing).`);
    console.log(`2) Set Redirect URL to: ${redirectUri}`);
    console.log(`\nThen paste the OAuth credentials here (they will be stored in your keychain):\n`);

    clientId = clientId || (await question(`client_id: `));
    clientSecret = clientSecret || (await question(`client_secret: `));

    if (!clientId || !clientSecret) {
      throw new Error('client_id and client_secret are required');
    }

    setSecret('BUNQ_CLIENT_ID', clientId);
    setSecret('BUNQ_CLIENT_SECRET', clientSecret);
  }

  if (!accessToken) {
    // bunq OAuth base (common)
    const authUrl = new URL(`https://${domains[environment].oauth}/auth`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    // Keep scope optional; bunq may allow empty or require specific.
    if (existing.scope) authUrl.searchParams.set('scope', existing.scope);

    const finalAuthUrl = authUrl.toString();
    console.log(`\nAuthorization URL (open in your browser):\n${finalAuthUrl}\n`);

    // On macOS automatically open the browser.
    if (process.platform === 'darwin') {
      try {
        const { spawn } = require('child_process');
        spawn('open', [finalAuthUrl], { stdio: 'ignore', detached: true }).unref();
      } catch {
        // ignore
      }
    }

    console.log('Waiting for you to authorize in bunq...');

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, `http://${host}:${port}`);
          if (u.pathname !== '/callback') {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not found');
            return;
          }

          const err = u.searchParams.get('error');
          if (err) {
            const desc = u.searchParams.get('error_description') || '';
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end(`OAuth error: ${err} ${desc}`);
            server.close();
            reject(new Error(`OAuth error: ${err} ${desc}`));
            return;
          }

          const code = u.searchParams.get('code');
          if (!code) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('Missing ?code=');
            return;
          }

          const html = `You can return to the terminal`;
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(html);
          server.close();
          resolve(code);
        } catch (e) {
          reject(e);
        }
      });

      server.on('error', reject);
      server.listen(port, host, () => {
        // listening
      });
    });

    console.log('Received authorization code, exchanging for tokens...');

    const tokenRes = await exchangeToken({
      grantType: 'authorization_code',
      code,
      redirectUri,
      clientId,
      clientSecret,
    });

    const { access_token } = tokenRes;
    if (!access_token) {
      throw new Error(`Token response missing access_token:\n${JSON.stringify(tokenRes)}`);
    }

    accessToken = access_token;
    setSecret('BUNQ_ACCESS_TOKEN', accessToken);
  }

  if (!installationToken) {
    console.log('Creating bunq installation token...');

    let res = await fetch(
      `https://${domains[environment].api}/v1/installation`,
      {
        method: "POST",
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "bunk-app",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_public_key: publicKey
        })
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`bunq installation token error (${res.status}): ${text}`);
    }
    res = await res.json();
    console.log(JSON.stringify(res, null, "  "))
    installationToken = res.Response[1].Token.token;


    setSecret('BUNQ_INSTALLATION_TOKEN', installationToken);
    console.log('Registering bunq device');

    const body = JSON.stringify({
      description: "bunk server",
      secret: accessToken
    });

    res = await fetch(
      `https://${domains[environment].api}/v1/device-server`, {
        method: "POST",
        body,
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "bunk-app",
          "Content-Type": "application/json",
          "X-Bunq-Client-Authentication": installationToken,
          "X-Bunq-Client-Signature": signBody(body, privateKey)
        }
      });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`bunq device registration error (${res.status}): ${text}`);
    }
  }

  if (!sessionToken || !userId) {
    console.log('Creating bunq API session ...');

    const body = JSON.stringify({
      secret: accessToken
    });
    let res = await fetch(
      `https://${domains[environment].api}/v1/session-server`, {
        method: "POST",
        body,
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "bunk-app",
          "Content-Type": "application/json",
          "X-Bunq-Client-Authentication": installationToken,
          "X-Bunq-Client-Signature": signBody(body, privateKey)
        }
      });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`bunq device registration error (${res.status}): ${text}`);
    }
    res = await res.json()
    console.log(JSON.stringify(res, null, "  "))

    const response = res?.Response ?? [];

    sessionToken =
      response.find(x => x?.Token?.token != null)?.Token?.token ?? null;

    userId =
      response.find(x => x?.UserPerson?.id != null)?.UserPerson?.id ??
        response.find(x => x?.UserApiKey?.id != null)?.UserApiKey?.id ??
        null;

    setSecret('BUNQ_SESSION_TOKEN', sessionToken);
    setSecret('BUNQ_USER_ID', String(userId));

  }


  console.log(`\nSaved tokens + session to keychain`);
}

module.exports = { auth, getSecret, setSecret };
