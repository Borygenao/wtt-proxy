const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// In-memory token store (persists as long as Render instance is up)
// Key: userId (email), Value: { refreshToken, accessToken, expiry }
const tokenStore = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Route: Store refresh token ─────────────────────────────────
  // Called once after user signs in — we exchange auth code for refresh token
  if (req.method === 'POST' && req.url === '/api/auth/store') {
    try {
      const body = await readBody(req);
      const { code, userId, redirectUri } = body;
      if (!code || !userId) return send(res, 400, { error: 'Missing code or userId' });
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return send(res, 500, { error: 'Server not configured' });

      // Exchange code for tokens
      const params = new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri || 'postmessage',
        grant_type: 'authorization_code'
      });

      const result = await httpsPost(
        'oauth2.googleapis.com', '/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        params.toString()
      );

      if (result.body.error) return send(res, 400, { error: result.body.error_description || result.body.error });

      const { access_token, refresh_token, expires_in } = result.body;
      tokenStore.set(userId, {
        refreshToken: refresh_token,
        accessToken: access_token,
        expiry: Date.now() + (expires_in * 1000)
      });

      send(res, 200, {
        access_token,
        expires_in,
        has_refresh_token: !!refresh_token
      });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── Route: Get fresh access token ─────────────────────────────
  if (req.method === 'POST' && req.url === '/api/auth/token') {
    try {
      const body = await readBody(req);
      const { userId } = body;
      if (!userId) return send(res, 400, { error: 'Missing userId' });

      const stored = tokenStore.get(userId);
      if (!stored?.refreshToken) return send(res, 401, { error: 'No refresh token stored. Please sign in again.' });

      // Return cached token if still valid (5 min buffer)
      if (stored.accessToken && Date.now() < stored.expiry - 300000) {
        return send(res, 200, { access_token: stored.accessToken, expires_in: Math.floor((stored.expiry - Date.now()) / 1000) });
      }

      // Refresh using stored refresh token
      const params = new URLSearchParams({
        refresh_token: stored.refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token'
      });

      const result = await httpsPost(
        'oauth2.googleapis.com', '/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        params.toString()
      );

      if (result.body.error) {
        tokenStore.delete(userId);
        return send(res, 401, { error: 'Token refresh failed. Please sign in again.' });
      }

      const { access_token, expires_in } = result.body;
      stored.accessToken = access_token;
      stored.expiry = Date.now() + (expires_in * 1000);
      tokenStore.set(userId, stored);

      send(res, 200, { access_token, expires_in });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── Route: Sign out — clear stored token ──────────────────────
  if (req.method === 'POST' && req.url === '/api/auth/signout') {
    try {
      const body = await readBody(req);
      if (body.userId) tokenStore.delete(body.userId);
      send(res, 200, { ok: true });
    } catch(e) {
      send(res, 200, { ok: true });
    }
    return;
  }

  // ── Route: Claude AI proxy ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/claude') {
    if (!CLAUDE_API_KEY) return send(res, 500, { error: 'CLAUDE_API_KEY not set.' });
    try {
      const incoming = await readBody(req);
      const prompt = incoming.messages?.[0]?.content || '';
      const maxTokens = incoming.max_tokens || 300;

      const claudeBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });

      const result = await httpsPost(
        'api.anthropic.com', '/v1/messages',
        { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        claudeBody
      );

      if (result.body.error) return send(res, 500, { error: 'Claude: ' + result.body.error.message });
      const text = result.body.content?.[0]?.text;
      if (!text) return send(res, 500, { error: 'No text in response' });
      send(res, 200, { content: [{ type: 'text', text }] });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── Health check ───────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    return send(res, 200, { status: 'ok', users: tokenStore.size });
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
