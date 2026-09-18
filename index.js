require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const app    = express();
const PORT   = process.env.PORT || 3000;
const TARGET = (process.env.TARGET_URL || 'https://vidfast.vc').replace(/\/$/, '');

app.use(cors({ origin: '*' }));
app.options('*', cors());

// ─── Wrapper page ─────────────────────────────────────────────────────────────
// Serves a full-viewport iframe pointing at vidfast.vc.
// The wrapper page itself mocks window.open so any pop-under calls from
// inside the iframe bubble up to THIS window and are silently swallowed —
// no new tab ever opens on the parent site.
function wrapperPage(embedUrl, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title || 'Player'}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    iframe { display: block; width: 100%; height: 100%; border: none; }
  </style>

  <!--
    Pop-under blocker + iframe-detection neutralizer.
    This runs on the wrapper page (watch.flixworld.xyz).

    The OUTER iframe (flixworld.xyz → this wrapper) has sandbox="allow-scripts
    allow-same-origin ..." which blocks window.open and top-navigation at the
    browser level — no popups can escape to flixworld.xyz.

    The INNER iframe (this wrapper → vidfast.vc) has NO sandbox, so the player
    cannot detect a sandboxed environment.

    Additionally we mock window.open and spoof window.top/parent/self here so
    that vidfast.vc (nested one level deeper) sees this wrapper as the top
    window, passing most iframe-detection checks.
  -->
  <script>
    (function () {
      var _noop = function () {};
      var _fakeWin = {
        focus: _noop, blur: _noop, close: _noop,
        closed: false,
        location: { href: 'about:blank', assign: _noop, replace: _noop },
        document: { write: _noop, close: _noop, open: _noop },
        addEventListener: _noop, removeEventListener: _noop,
      };

      // Swallow window.open — belt-and-suspenders alongside the outer sandbox
      window.open = function (url) {
        console.debug('[wrapper] blocked popup:', url);
        return _fakeWin;
      };

      // Make this wrapper window look like the top-level window so that
      // vidfast.vc's own iframe-detection (window.top !== window.self) passes
      try { Object.defineProperty(window, 'top',         { get: function () { return window; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(window, 'parent',      { get: function () { return window; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(window, 'self',        { get: function () { return window; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(window, 'frameElement',{ get: function () { return null;   }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(document, 'referrer',  { get: function () { return '';     }, configurable: true }); } catch (e) {}

      // Re-stamp window.open after any dynamically injected script tag
      new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeName === 'SCRIPT') {
              window.open = function (url) {
                console.debug('[wrapper/dynamic] blocked popup:', url);
                return _fakeWin;
              };
            }
          });
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
    })();
  </script>
</head>
<body>
  <!--
    No sandbox attribute — the player runs normally and cannot detect
    a sandboxed environment. Pop-unders are blocked by the mocked
    window.open above, not by the sandbox attribute.
  -->
  <iframe
    src="${embedUrl}"
    allowfullscreen
    allow="autoplay; fullscreen; encrypted-media; picture-in-picture; web-share"
    referrerpolicy="no-referrer"
  ></iframe>
</body>
</html>`;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', target: TARGET });
});

// ─── Movie  /movie/:tmdb_id ───────────────────────────────────────────────────
app.get('/movie/:tmdb_id', (req, res) => {
  const embedUrl = `${TARGET}/movie/${req.params.tmdb_id}`;
  console.log(`[MOVIE] ${embedUrl}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(wrapperPage(embedUrl));
});

// ─── TV  /tv/:tmdb_id/:season/:episode ───────────────────────────────────────
app.get('/tv/:tmdb_id/:season/:episode', (req, res) => {
  const { tmdb_id, season, episode } = req.params;
  const embedUrl = `${TARGET}/tv/${tmdb_id}/${season}/${episode}`;
  console.log(`[TV] ${embedUrl}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(wrapperPage(embedUrl));
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    routes: ['/movie/:tmdb_id', '/tv/:tmdb_id/:season/:episode'],
  });
});

app.listen(PORT, () => {
  console.log(`\niframe wrapper running on http://localhost:${PORT}`);
  console.log(`Target : ${TARGET}`);
  console.log(`\nRoutes:`);
  console.log(`  /movie/:tmdb_id`);
  console.log(`  /tv/:tmdb_id/:season/:episode`);
  console.log(`\nExamples:`);
  console.log(`  http://localhost:${PORT}/movie/550`);
  console.log(`  http://localhost:${PORT}/tv/1396/1/1\n`);
});
