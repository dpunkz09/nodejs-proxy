require('dotenv').config();

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = process.env.TARGET_URL || 'https://vidfast.vc';

// Browser-like User-Agent
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Enable CORS for all origins
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['*'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
    credentials: false,
  })
);

// Pre-flight OPTIONS handled by cors() above, but be explicit
app.options('*', cors());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy_target: TARGET, public_url: PUBLIC_URL });
});

// ─── Generic URL proxy  (/proxy?url=https://...) ──────────────────────────────
// Handles HLS master manifests, variant playlists, .ts segments, and .key files.
// All URLs inside m3u8 files are rewritten to also route through this endpoint.
app.use('/proxy', (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= query parameter' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Accept, Referer');
    return res.sendStatus(204);
  }

  console.log(`[PROXY] ${req.method} ${targetUrl}`);

  const transport = parsed.protocol === 'https:' ? https : http;

  // Forward Range header if present (needed for seeking)
  const extraHeaders = {};
  if (req.headers['range']) {
    extraHeaders['Range'] = req.headers['range'];
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      // Always spoof referer as vidfast.vc — that's what the CDN validates
      Referer: 'https://vidfast.vc/',
      Origin: 'https://vidfast.vc',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
      ...extraHeaders,
    },
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode || 502;
    console.log(`[PROXY] ${statusCode} <- ${targetUrl}`);

    res.status(statusCode);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    // Forward useful response headers
    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'expires',
      'last-modified',
      'etag',
    ];
    for (const h of forwardHeaders) {
      if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
    }

    // HEAD request — no body
    if (req.method === 'HEAD') {
      return res.end();
    }

    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isM3u8 =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl') ||
      targetUrl.includes('.m3u8');

    if (isM3u8) {
      // Stream the manifest back as-is — the player handles fetching
      // segments and keys directly, so no URL rewriting is needed.
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.removeHeader('content-length');
      proxyRes.pipe(res);
    } else {
      // Binary — pipe directly (.ts segments, .key files, etc.)
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY ERROR] ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream request failed', message: err.message });
    }
  });

  proxyReq.end();
});

// ─── Main target proxy  (everything else → vidfast.vc) ────────────────────────
app.use(
  '/',
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('Referer', TARGET + '/');
        proxyReq.setHeader('Origin', TARGET);
        proxyReq.setHeader('User-Agent', BROWSER_UA);
        console.log(`[MAIN] ${req.method} ${req.url} -> ${TARGET}${req.url}`);
      },
      proxyRes: (proxyRes, req) => {
        proxyRes.headers['access-control-allow-origin'] = '*';
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        console.log(`[MAIN] ${proxyRes.statusCode} <- ${req.url}`);
      },
      error: (err, req, res) => {
        console.error(`[MAIN ERROR] ${err.message}`);
        res.status(502).json({ error: 'Proxy error', message: err.message });
      },
    },
  })
);

app.listen(PORT, () => {
  console.log(`\nProxy server running on port ${PORT}`);
  console.log(`Main target : ${TARGET}`);
  console.log(`\nURL proxy usage:`);
  console.log(`  http://localhost:${PORT}/proxy?url=<encoded-url>`);
  console.log(`\nTest m3u8:`);
  const testUrl = 'https://moon.peakstorm.top/vd/R1pYUjUyeXVESEs2VHp3ajdtSlVJZzpFLWU5YTIzWEszV2gxcEJGcXBURXpJRDdyc245TkROTk4zekFTc3JnR0sw/master.m3u8';
  console.log(`  http://localhost:${PORT}/proxy?url=${encodeURIComponent(testUrl)}\n`);
});
