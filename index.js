require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app    = express();
const PORT   = process.env.PORT || 3000;
const TARGET = (process.env.TARGET_URL || 'https://vidfast.vc').replace(/\/$/, '');

// Public base URL of this proxy — used to rewrite asset URLs in HTML.
// Set PUBLIC_URL in .env when deployed (e.g. https://watch.flixworld.xyz)
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── Browser-like headers ──────────────────────────────────────────────────────
function browserHeaders(referer) {
  return {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         referer || TARGET + '/',
    'Origin':          TARGET,
  };
}

// ─── Ad / detection script src patterns to strip ──────────────────────────────
const STRIP_SRC_PATTERNS = [
  /popunder/i, /popcash/i, /propellerads/i, /adsterra/i, /exoclick/i,
  /trafficjunky/i, /juicyads/i, /hilltopads/i, /realsrv/i, /adspyglass/i,
  /adskeeper/i, /bidvertiser/i, /plugrush/i, /clickadu/i, /revenuehits/i,
  /adnium/i, /yllix/i, /ad\.fly/i, /adf\.ly/i, /sh\.st/i, /ouo\.io/i,
  /linkvertise/i, /popads/i, /popcpm/i, /popup/i, /popwindow/i,
  /detect.*sandbox/i, /sandbox.*detect/i, /iframe.*detect/i, /detect.*iframe/i,
];

// ─── Inline script content patterns to strip ──────────────────────────────────
const STRIP_INLINE_PATTERNS = [
  /popunder/i, /pop_under/i, /detectSandbox/i, /checkSandbox/i, /isSandboxed/i,
  /window\.top\s*!==?\s*window\.self/, /window\.self\s*!==?\s*window\.top/,
  /top\s*!==?\s*self/, /self\s*!==?\s*top/,
  /document\.referrer.*about:blank/, /about:blank/,
];

// ─── Neutralizer injected before all page scripts ─────────────────────────────
const NEUTRALIZER_SCRIPT = `<script>
(function() {
  'use strict';
  var _noop = function() {};
  var _fakeWin = {
    focus: _noop, blur: _noop, close: _noop, closed: false,
    location: { href: '' }, document: { write: _noop, close: _noop },
  };
  // Mock window.open — pop-unders silently succeed without opening anything
  window.open = function() { return _fakeWin; };

  // Make the page believe it is the top-level window
  try { Object.defineProperty(window, 'top',         { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'parent',      { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'self',        { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'frameElement',{ get: function() { return null;   }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(document, 'referrer',  { get: function() { return '';     }, configurable: true }); } catch(e) {}

  // Stub ad-network globals
  window.__popunder = window.PopUnder = window.createPopunder = _noop;

  // Re-stamp window.open after every dynamically inserted script
  new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.nodeName === 'SCRIPT') window.open = function() { return _fakeWin; };
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;

// ─── Resolve a URL that may be relative to a base ─────────────────────────────
function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// ─── Rewrite all external asset URLs to route through /asset?url= ─────────────
function rewriteAssetUrls($, pageUrl) {
  const proxyAsset = (url) => {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
    const absolute = resolveUrl(url, pageUrl);
    if (!absolute) return url;
    // Only rewrite URLs that are NOT already on our proxy
    if (absolute.startsWith(PUBLIC_URL)) return url;
    return `${PUBLIC_URL}/asset?url=${encodeURIComponent(absolute)}`;
  };

  // <script src>
  $('script[src]').each(function() {
    const src = $(this).attr('src');
    if (src) $(this).attr('src', proxyAsset(src));
  });

  // <link href> (CSS, fonts, preloads)
  $('link[href]').each(function() {
    const href = $(this).attr('href');
    if (href) $(this).attr('href', proxyAsset(href));
  });

  // <img src> and srcset
  $('img[src]').each(function() {
    const src = $(this).attr('src');
    if (src) $(this).attr('src', proxyAsset(src));
  });

  // inline style background-image / url()
  $('[style]').each(function() {
    const style = $(this).attr('style') || '';
    const rewritten = style.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (_, u) => {
      return `url('${proxyAsset(u)}')`;
    });
    $(this).attr('style', rewritten);
  });
}

// ─── Sanitize fetched HTML ─────────────────────────────────────────────────────
function sanitizeHtml(html, pageUrl) {
  const $ = cheerio.load(html);

  // 1. Strip ad/detection <script src>
  $('script[src]').each(function() {
    const src = $(this).attr('src') || '';
    if (STRIP_SRC_PATTERNS.some(p => p.test(src))) {
      console.log(`[STRIP src] ${src}`);
      $(this).remove();
    }
  });

  // 2. Strip ad/detection inline scripts
  $('script:not([src])').each(function() {
    const code = $(this).html() || '';
    if (STRIP_INLINE_PATTERNS.some(p => p.test(code))) {
      console.log(`[STRIP inline] ${code.substring(0, 80).replace(/\n/g, ' ')}...`);
      $(this).remove();
    }
  });

  // 3. Remove ad container elements
  $('ins.adsbygoogle, [id*="ad-"], [class*="ad-wrap"], [class*="popunder"], [id*="popunder"]').remove();

  // 4. Rewrite all asset URLs through the proxy (fixes cross-origin CORS issues)
  rewriteAssetUrls($, pageUrl);

  // 5. Inject neutralizer as the very first thing in <head>
  $('head').prepend(NEUTRALIZER_SCRIPT);

  // 6. Remove any <base> the page set — we manage URLs ourselves
  $('base').remove();

  // 7. Strip meta X-Frame-Options / CSP
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  return $.html();
}

// ─── Fetch helper ──────────────────────────────────────────────────────────────
async function fetchUpstream(url, referer) {
  return fetch(url, {
    headers: browserHeaders(referer),
    redirect: 'follow',
  });
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.options('*', cors());

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', target: TARGET, public_url: PUBLIC_URL });
});

// ─── /asset?url= — generic asset proxy for any external URL ───────────────────
// Handles JS, CSS, fonts, images from any domain (e.g. vidsrc.ru)
app.get('/asset', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    return res.status(400).send('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).send('Only http/https allowed');
  }

  console.log(`[ASSET] ${targetUrl}`);

  let response;
  try {
    response = await fetchUpstream(targetUrl, TARGET + '/');
  } catch (err) {
    console.error(`[ASSET ERROR] ${err.message}`);
    return res.status(502).send(err.message);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.removeHeader('x-frame-options');
  res.removeHeader('content-security-policy');

  // For JS files: also rewrite any fetch/XHR URLs inside them that might
  // point back to the origin — pipe as-is for now (binary-safe)
  response.body.pipe(res);
});

// ─── Core HTML proxy ──────────────────────────────────────────────────────────
async function proxyPage(req, res, path) {
  const targetUrl = `${TARGET}${path}`;
  console.log(`[PAGE] ${targetUrl}`);

  let response;
  try {
    response = await fetchUpstream(targetUrl, TARGET + '/');
  } catch (err) {
    console.error(`[PAGE ERROR] ${err.message}`);
    return res.status(502).send(`<h1>Upstream fetch failed</h1><pre>${err.message}</pre>`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    res.setHeader('content-type', contentType);
    res.setHeader('access-control-allow-origin', '*');
    return response.body.pipe(res);
  }

  const html  = await response.text();
  const clean = sanitizeHtml(html, targetUrl);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(clean);
}

// ─── Movie route ───────────────────────────────────────────────────────────────
app.get('/movie/:tmdb_id', async (req, res) => {
  await proxyPage(req, res, `/movie/${req.params.tmdb_id}`);
});

// ─── TV route ──────────────────────────────────────────────────────────────────
app.get('/tv/:tmdb_id/:season/:episode', async (req, res) => {
  const { tmdb_id, season, episode } = req.params;
  await proxyPage(req, res, `/tv/${tmdb_id}/${season}/${episode}`);
});

// ─── Catch-all: proxy remaining paths relative to TARGET ──────────────────────
app.use(async (req, res) => {
  const qs = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
  const targetUrl = `${TARGET}${req.path}${qs}`;
  console.log(`[PASS] ${targetUrl}`);

  let response;
  try {
    response = await fetchUpstream(targetUrl, TARGET + '/');
  } catch (err) {
    return res.status(502).send(err.message);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('content-type', contentType);
  res.setHeader('access-control-allow-origin', '*');
  res.removeHeader('x-frame-options');
  res.removeHeader('content-security-policy');
  response.body.pipe(res);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSanitizing proxy running on http://localhost:${PORT}`);
  console.log(`Target     : ${TARGET}`);
  console.log(`Public URL : ${PUBLIC_URL}`);
  console.log(`\nRoutes:`);
  console.log(`  /movie/:tmdb_id`);
  console.log(`  /tv/:tmdb_id/:season/:episode`);
  console.log(`  /asset?url=<encoded>   (generic asset proxy)`);
  console.log(`\nExamples:`);
  console.log(`  http://localhost:${PORT}/movie/1265609`);
  console.log(`  http://localhost:${PORT}/tv/1265609/1/1\n`);
});
