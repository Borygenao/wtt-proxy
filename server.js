const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const server = http.createServer((req, res) => {
  // CORS headers — allow your GitHub Pages URL
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/claude') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (!GEMINI_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not set on server.' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let incoming;
    try { incoming = JSON.parse(body); } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const prompt = incoming.messages?.[0]?.content || '';
    const maxTokens = incoming.max_tokens || 300;

    const geminiBody = JSON.stringify({
      systemInstruction: {
        parts: [{ text: 'You are a precise assistant. Follow output format instructions exactly. Never add extra explanation, preamble, or markdown unless explicitly asked.' }]
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(geminiBody)
      }
    };

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Parse failed: ' + data.substring(0, 100) }));
          return;
        }

        if (parsed.error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gemini: ' + parsed.error.message }));
          return;
        }

        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          const reason = parsed.candidates?.[0]?.finishReason || 'unknown';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No text. finishReason=${reason}` }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
      });
    });

    proxyReq.on('error', err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Network: ' + err.message }));
    });

    proxyReq.write(geminiBody);
    proxyReq.end();
  });
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
