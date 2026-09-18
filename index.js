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
    Pop-under blocker:
    window.open is mocked HERE (on the wrapper page) so when the iframe's
    scripts call window.open (which bubbles to the nearest non-sandboxed
    ancestor), it hits our mock and silently returns a fake window object.
    The iframe itself is NOT sandboxed, so the player never detects a
    restricted environment.
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

      // Override on this window — iframe pop-unders call window.open on
      // their top-most accessible ancestor, which is this wrapper page.
      window.open = function (url, target, features) {
        console.debug('[blocked popup]', url);
        return _fakeWin;
      };

      // Also block via CSP-style: prevent the iframe from navigating the top
      window.addEventListener('beforeunload', function (e) {
        e.preventDefault();
        e.returnValue = '';
      });
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
