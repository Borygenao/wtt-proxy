const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ENABLE_GOOGLE_TOKEN_STORE = process.env.ENABLE_GOOGLE_TOKEN_STORE === 'true';
const TOKEN_STORE_FILE = process.env.TOKEN_STORE_FILE || path.join(__dirname, 'token-store.json');
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://borygenao.github.io,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

function loadTokenStore() {
  if (!ENABLE_GOOGLE_TOKEN_STORE) return new Map();
  try {
    if (!fs.existsSync(TOKEN_STORE_FILE)) return new Map();
    const raw = fs.readFileSync(TOKEN_STORE_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw || '{}')));
  } catch (_) {
    return new Map();
  }
}

const tokenStore = loadTokenStore();

function persistTokenStore() {
  if (!ENABLE_GOOGLE_TOKEN_STORE) return;
  try {
    fs.writeFileSync(TOKEN_STORE_FILE, JSON.stringify(Object.fromEntries(tokenStore), null, 2));
  } catch (error) {
    console.error('Failed to persist token store:', error.message);
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function ensureAllowedOrigin(req, res) {
  if (isAllowedOrigin(req.headers.origin)) return true;
  send(res, 403, { error: 'Origin not allowed' });
  return false;
}

function ensureGoogleTokenStoreEnabled(res) {
  if (ENABLE_GOOGLE_TOKEN_STORE) return true;
  send(res, 404, { error: 'Not found' });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function httpsPost(hostname, requestPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: requestPath,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(data)
        }
      },
      res => {
        let responseBody = '';
        res.on('data', chunk => {
          responseBody += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(responseBody) });
          } catch (_) {
            resolve({ status: res.statusCode, body: responseBody });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function handleStoreAuthCode(req, res) {
  if (!ensureGoogleTokenStoreEnabled(res)) return;

  try {
    const body = await readBody(req);
    const { code, userId, redirectUri } = body;

    if (!code || !userId) {
      send(res, 400, { error: 'Missing code or userId' });
      return;
    }
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      send(res, 500, { error: 'Server not configured' });
      return;
    }

    const params = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri || 'postmessage',
      grant_type: 'authorization_code'
    });

    const result = await httpsPost(
      'oauth2.googleapis.com',
      '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      params.toString()
    );

    if (result.body.error) {
      send(res, 400, { error: result.body.error_description || result.body.error });
      return;
    }

    const { access_token, refresh_token, expires_in } = result.body;
    tokenStore.set(userId, {
      refreshToken: refresh_token,
      accessToken: access_token,
      expiry: Date.now() + expires_in * 1000
    });
    persistTokenStore();

    send(res, 200, {
      access_token,
      expires_in,
      has_refresh_token: !!refresh_token
    });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}

async function handleTokenRefresh(req, res) {
  if (!ensureGoogleTokenStoreEnabled(res)) return;

  try {
    const body = await readBody(req);
    const { userId } = body;

    if (!userId) {
      send(res, 400, { error: 'Missing userId' });
      return;
    }

    const stored = tokenStore.get(userId);
    if (!stored || !stored.refreshToken) {
      send(res, 401, { error: 'No refresh token stored. Please sign in again.' });
      return;
    }

    if (stored.accessToken && Date.now() < stored.expiry - 300000) {
      send(res, 200, {
        access_token: stored.accessToken,
        expires_in: Math.floor((stored.expiry - Date.now()) / 1000)
      });
      return;
    }

    const params = new URLSearchParams({
      refresh_token: stored.refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const result = await httpsPost(
      'oauth2.googleapis.com',
      '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      params.toString()
    );

    if (result.body.error) {
      tokenStore.delete(userId);
      persistTokenStore();
      send(res, 401, { error: 'Token refresh failed. Please sign in again.' });
      return;
    }

    const { access_token, expires_in } = result.body;
    stored.accessToken = access_token;
    stored.expiry = Date.now() + expires_in * 1000;
    tokenStore.set(userId, stored);
    persistTokenStore();

    send(res, 200, { access_token, expires_in });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}

async function handleSignOut(req, res) {
  if (!ensureGoogleTokenStoreEnabled(res)) return;

  try {
    const body = await readBody(req);
    if (body.userId) {
      tokenStore.delete(body.userId);
      persistTokenStore();
    }
    send(res, 200, { ok: true });
  } catch (_) {
    send(res, 200, { ok: true });
  }
}

async function handleClaude(req, res) {
  if (!CLAUDE_API_KEY) {
    send(res, 500, { error: 'CLAUDE_API_KEY not set.' });
    return;
  }

  try {
    const incoming = await readBody(req);
    const prompt = incoming.messages && incoming.messages[0] ? incoming.messages[0].content || '' : '';
    const maxTokens = incoming.max_tokens || 300;

    if (!prompt.trim()) {
      send(res, 400, { error: 'Prompt is required.' });
      return;
    }

    const result = await httpsPost(
      'api.anthropic.com',
      '/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      }
    );

    if (result.body.error) {
      send(res, 500, { error: `Claude: ${result.body.error.message}` });
      return;
    }

    const text = result.body.content && result.body.content[0] ? result.body.content[0].text : '';
    if (!text) {
      send(res, 500, { error: 'No text in response' });
      return;
    }

    send(res, 200, { content: [{ type: 'text', text }] });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    if (!ensureAllowedOrigin(req, res)) return;
    res.writeHead(204);
    res.end();
    return;
  }

  if (!ensureAllowedOrigin(req, res)) return;

  if (req.method === 'POST' && req.url === '/api/auth/store') {
    await handleStoreAuthCode(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/auth/token') {
    await handleTokenRefresh(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/auth/signout') {
    await handleSignOut(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/claude') {
    await handleClaude(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    send(res, 200, {
      status: 'ok',
      googleTokenStoreEnabled: ENABLE_GOOGLE_TOKEN_STORE,
      users: tokenStore.size
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
