require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app    = express();
const PORT   = process.env.PORT || 3000;
const TARGET = (process.env.TARGET_URL || 'https://vidfast.vc').replace(/\/$/, '');

// Browser-like headers so vidfast.vc doesn't reject the server-side fetch
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Referer':         TARGET + '/',
  'Origin':          TARGET,
};

// ─── Ad / detection script patterns to strip entirely ─────────────────────────
// These match known ad networks, pop-under loaders, and sandbox-detection libs.
const STRIP_SRC_PATTERNS = [
  /popunder/i,
  /popcash/i,
  /propellerads/i,
  /adsterra/i,
  /exoclick/i,
  /trafficjunky/i,
  /juicyads/i,
  /hilltopads/i,
  /realsrv/i,
  /adspyglass/i,
  /adskeeper/i,
  /bidvertiser/i,
  /plugrush/i,
  /clickadu/i,
  /revenuehits/i,
  /adnium/i,
  /yllix/i,
  /ad\.fly/i,
  /adf\.ly/i,
  /sh\.st/i,
  /ouo\.io/i,
  /linkvertise/i,
  /popads/i,
  /popcpm/i,
  /popup/i,
  /popwindow/i,
  /detect.*sandbox/i,
  /sandbox.*detect/i,
  /iframe.*detect/i,
  /detect.*iframe/i,
];

// Inline script content patterns to strip
const STRIP_INLINE_PATTERNS = [
  /window\.open\s*\(/,
  /popunder/i,
  /pop_under/i,
  /detectSandbox/i,
  /checkSandbox/i,
  /isSandboxed/i,
  /window\.top\s*!==?\s*window\.self/,
  /window\.self\s*!==?\s*window\.top/,
  /top\s*!==?\s*self/,
  /self\s*!==?\s*top/,
  /frameElement/,
  /document\.referrer.*about:blank/,
  /about:blank/,
];

// ─── Injection: runs before any page script ────────────────────────────────────
// Mocks the APIs that ad/detection scripts probe so they silently succeed
// without actually opening windows or detecting the iframe environment.
const NEUTRALIZER_SCRIPT = `<script>
(function() {
  'use strict';

  // ── Mock window.open so pop-under attempts silently succeed ──────────────
  var _noop = function() {};
  var _fakeWin = {
    focus:    _noop,
    blur:     _noop,
    close:    _noop,
    closed:   false,
    location: { href: '' },
    document: { write: _noop, close: _noop },
  };
  window.open = function() { return _fakeWin; };

  // ── Make the page believe it is the top-level window ────────────────────
  try { Object.defineProperty(window, 'top',    { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'parent', { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'self',   { get: function() { return window; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(window, 'frameElement', { get: function() { return null; }, configurable: true }); } catch(e) {}

  // ── Neutralize document.referrer (some scripts check for about:blank) ───
  try { Object.defineProperty(document, 'referrer', { get: function() { return ''; }, configurable: true }); } catch(e) {}

  // ── Stub common ad-network globals so their init code doesn't throw ──────
  window.__popunder    = _noop;
  window.PopUnder      = _noop;
  window.createPopunder = _noop;

  // ── Block any runtime window.open calls from dynamically loaded scripts ──
  // Re-apply after every script by observing DOM mutations
  var _mo = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.tagName === 'SCRIPT') {
          // Re-stamp window.open after each new script tag is inserted
          window.open = function() { return _fakeWin; };
        }
      });
    });
  });
  _mo.observe(document.documentElement, { childList: true, subtree: true });

})();
</script>`;

// ─── Sanitize fetched HTML ─────────────────────────────────────────────────────
function sanitizeHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const baseOrigin = new URL(pageUrl).origin;

  // 1. Strip <script src="..."> matching ad/detection patterns
  $('script[src]').each(function() {
    const src = $(this).attr('src') || '';
    const shouldStrip = STRIP_SRC_PATTERNS.some(p => p.test(src));
    if (shouldStrip) {
      console.log(`[STRIP src] ${src}`);
      $(this).remove();
    }
  });

  // 2. Strip inline <script> blocks matching ad/detection patterns
  $('script:not([src])').each(function() {
    const code = $(this).html() || '';
    const shouldStrip = STRIP_INLINE_PATTERNS.some(p => p.test(code));
    if (shouldStrip) {
      console.log(`[STRIP inline] ${code.substring(0, 80).replace(/\n/g, ' ')}...`);
      $(this).remove();
    }
  });

  // 3. Remove known ad container elements
  $('ins.adsbygoogle, [id*="ad-"], [class*="ad-wrap"], [class*="popunder"], [id*="popunder"]').remove();

  // 4. Inject neutralizer as the very first script in <head>
  //    This runs before any remaining page scripts
  $('head').prepend(NEUTRALIZER_SCRIPT);

  // 5. Add <base> tag so relative URLs resolve against the original origin
  if (!$('base').length) {
    $('head').prepend(`<base href="${baseOrigin}/">`);
  }

  // 6. Strip X-Frame-Options / CSP meta tags that would block our iframe
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  return $.html();
}

// ─── Core proxy handler ────────────────────────────────────────────────────────
async function proxyPage(req, res, path) {
  const targetUrl = `${TARGET}${path}`;
  console.log(`[FETCH] ${targetUrl}`);

  let response;
  try {
    response = await fetch(targetUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
  } catch (err) {
    console.error(`[FETCH ERROR] ${err.message}`);
    return res.status(502).send(`<h1>Upstream fetch failed</h1><pre>${err.message}</pre>`);
  }

  const contentType = response.headers.get('content-type') || '';

  // Non-HTML responses (JS, CSS, images) — pass through as-is
  if (!contentType.includes('text/html')) {
    res.setHeader('content-type', contentType);
    res.setHeader('access-control-allow-origin', '*');
    return response.body.pipe(res);
  }

  const html = await response.text();
  const clean = sanitizeHtml(html, targetUrl);

  // Serve the sanitized page — strip headers that would block framing
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(clean);
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', target: TARGET });
});

// ─── Movie route ───────────────────────────────────────────────────────────────
app.get('/movie/:tmdb_id', async (req, res) => {
  await proxyPage(req, res, `/movie/${req.params.tmdb_id}`);
});

// ─── TV route ──────────────────────────────────────────────────────────────────
app.get('/tv/:tmdb_id/:season/:episode', async (req, res) => {
  const { tmdb_id, season, episode } = req.params;
  await proxyPage(req, res, `/tv/${tmdb_id}/${season}/${episode}`);
});

// ─── Pass-through for all other assets (JS, CSS, API calls from the player) ───
app.use(async (req, res) => {
  const targetUrl = `${TARGET}${req.path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
  console.log(`[ASSET] ${targetUrl}`);

  let response;
  try {
    response = await fetch(targetUrl, { headers: BROWSER_HEADERS, redirect: 'follow' });
  } catch (err) {
    return res.status(502).send(err.message);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('content-type', contentType);
  res.setHeader('access-control-allow-origin', '*');
  // Strip framing-block headers on all responses
  res.removeHeader('x-frame-options');
  res.removeHeader('content-security-policy');
  response.body.pipe(res);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSanitizing proxy running on http://localhost:${PORT}`);
  console.log(`Target  : ${TARGET}`);
  console.log(`\nRoutes:`);
  console.log(`  /movie/:tmdb_id`);
  console.log(`  /tv/:tmdb_id/:season/:episode`);
  console.log(`\nExamples:`);
  console.log(`  http://localhost:${PORT}/movie/1265609`);
  console.log(`  http://localhost:${PORT}/tv/1265609/1/1\n`);
});
