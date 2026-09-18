require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = (process.env.TARGET_URL || 'https://vidfast.vc').replace(/\/$/, '');

app.use(cors({ origin: '*' }));

// ─── HTML iframe wrapper ───────────────────────────────────────────────────────
function iframePage(embedUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Player</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <iframe
    src="${embedUrl}"
    allowfullscreen
    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
    referrerpolicy="no-referrer"
    scrolling="no"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox allow-presentation"
  ></iframe>
</body>
</html>`;
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', target: TARGET });
});

// ─── Movie route ───────────────────────────────────────────────────────────────
// GET /movie/:tmdb_id
// Embeds: https://vidfast.vc/movie/:tmdb_id
app.get('/movie/:tmdb_id', (req, res) => {
  const { tmdb_id } = req.params;
  const embedUrl = `${TARGET}/movie/${tmdb_id}`;
  console.log(`[MOVIE] ${embedUrl}`);
  res.setHeader('Content-Type', 'text/html');
  // Allow this page itself to be iframed from anywhere
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(iframePage(embedUrl));
});

// ─── TV route ──────────────────────────────────────────────────────────────────
// GET /tv/:tmdb_id/:season/:episode
// Embeds: https://vidfast.vc/tv/:tmdb_id/:season/:episode
app.get('/tv/:tmdb_id/:season/:episode', (req, res) => {
  const { tmdb_id, season, episode } = req.params;
  const embedUrl = `${TARGET}/tv/${tmdb_id}/${season}/${episode}`;
  console.log(`[TV] ${embedUrl}`);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.send(iframePage(embedUrl));
});

// ─── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', usage: [
    'GET /movie/:tmdb_id',
    'GET /tv/:tmdb_id/:season/:episode',
  ]});
});

app.listen(PORT, () => {
  console.log(`\niframe wrapper running on http://localhost:${PORT}`);
  console.log(`Target : ${TARGET}`);
  console.log(`\nRoutes:`);
  console.log(`  http://localhost:${PORT}/movie/:tmdb_id`);
  console.log(`  http://localhost:${PORT}/tv/:tmdb_id/:season/:episode`);
  console.log(`\nExamples:`);
  console.log(`  http://localhost:${PORT}/movie/1265609`);
  console.log(`  http://localhost:${PORT}/tv/1265609/1/1\n`);
});
