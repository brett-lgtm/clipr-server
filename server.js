const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ─── In-memory store with disk persistence ───────────────────────────────────
const recordings = new Map();
const METADATA_FILE = 'metadata.json';

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')).forEach(r => recordings.set(r.id, r));
      console.log(`Loaded ${recordings.size} recordings from disk`);
    }
  } catch (e) {
    console.error('metadata load error:', e.message);
  }
}

function saveMetadata() {
  fs.writeFileSync(METADATA_FILE, JSON.stringify([...recordings.values()], null, 2));
}

loadMetadata();

// ─── Dirs ─────────────────────────────────────────────────────────────────────
['uploads', 'thumbnails'].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use('/thumbnails', express.static('thumbnails'));

// ─── Upload ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${req.cliprId}.webm`),
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 GB

app.post('/upload', (req, res) => {
  req.cliprId = uuidv4();
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const id = req.cliprId;
    const title = req.body.title || 'Untitled Recording';
    const duration = parseInt(req.body.duration, 10) || 0;
    const videoPath = `uploads/${id}.webm`;
    const thumbPath = `thumbnails/${id}.jpg`;

    // Generate thumbnail from first frame
    let hasThumbnail = false;
    try {
      execSync(
        `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf scale=1280:-1 "${thumbPath}" -y`,
        { stdio: 'pipe', timeout: 30000 }
      );
      hasThumbnail = fs.existsSync(thumbPath);
    } catch (e) {
      // Try at 0 seconds
      try {
        execSync(
          `ffmpeg -i "${videoPath}" -vframes 1 -vf scale=1280:-1 "${thumbPath}" -y`,
          { stdio: 'pipe', timeout: 30000 }
        );
        hasThumbnail = fs.existsSync(thumbPath);
      } catch (_) {
        console.warn('ffmpeg thumbnail generation failed, continuing without thumbnail');
      }
    }

    const record = {
      id,
      title,
      duration,
      filename: `${id}.webm`,
      thumbnail: hasThumbnail ? `${id}.jpg` : null,
      createdAt: new Date().toISOString(),
      views: 0,
    };

    recordings.set(id, record);
    saveMetadata();

    res.json({ id, shareUrl: `${BASE_URL}/v/${id}` });
  });
});

// ─── Share page ───────────────────────────────────────────────────────────────
app.get('/v/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).send(notFoundPage());

  rec.views++;
  saveMetadata();

  const thumbUrl = rec.thumbnail
    ? `${BASE_URL}/thumbnails/${rec.thumbnail}`
    : null;
  const videoUrl = `${BASE_URL}/uploads/${rec.filename}`;
  const shareUrl = `${BASE_URL}/v/${rec.id}`;
  const dateStr = new Date(rec.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const mins = Math.floor(rec.duration / 60);
  const secs = rec.duration % 60;
  const durStr = rec.duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : null;
  const views = rec.views;
  const safeTitle = rec.title.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  res.send(sharePage({ safeTitle, thumbUrl, videoUrl, shareUrl, dateStr, durStr, views }));
});

// ─── API metadata ─────────────────────────────────────────────────────────────
app.get('/api/v/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json({ ...rec, videoUrl: `${BASE_URL}/uploads/${rec.filename}` });
});

// ─── Root ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const count = recordings.size;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Clipr</title>
  <style>body{background:#0a0a0f;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .c{text-align:center}.logo{font-size:48px;font-weight:800;letter-spacing:-2px;margin-bottom:8px}
  .logo span{color:#7c6ef0}.sub{color:#666;font-size:18px;margin-bottom:32px}
  .stat{background:#111;border:1px solid #222;padding:16px 32px;border-radius:12px;display:inline-block;font-size:14px;color:#888}
  .stat b{color:#fff;font-size:24px;display:block}</style></head>
  <body><div class="c"><div class="logo">Cli<span>p</span>r</div>
  <div class="sub">Record. Share. Instantly.</div>
  <div class="stat"><b>${count}</b>recordings hosted</div></div></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Clipr server on :${PORT}  BASE_URL=${BASE_URL}`);
});

// ─── Share page HTML ──────────────────────────────────────────────────────────
function sharePage({ safeTitle, thumbUrl, videoUrl, shareUrl, dateStr, durStr, views }) {
  const ogImage = thumbUrl || '';
  const thumbStyle = thumbUrl
    ? `background-image:url('${thumbUrl}');background-size:cover;background-position:center`
    : 'background:linear-gradient(135deg,#1a1a3e,#0a0a1f)';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle} — Clipr</title>

  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="Watch this recording on Clipr">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:url" content="${shareUrl}">
  <meta property="og:type" content="video.other">
  <meta property="og:video" content="${videoUrl}">
  <meta property="og:video:type" content="video/webm">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:image" content="${ogImage}">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0a0a0f;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
      min-height: 100vh;
    }

    .header {
      padding: 20px 32px;
      display: flex;
      align-items: center;
    }
    .logo {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      text-decoration: none;
      color: #fff;
    }
    .logo span { color: #7c6ef0; }

    .wrap {
      max-width: 920px;
      margin: 0 auto;
      padding: 8px 24px 80px;
    }

    .title {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 10px;
      line-height: 1.3;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 20px;
      color: #666;
      font-size: 13px;
      margin-bottom: 18px;
      align-items: center;
    }
    .meta-item { display: flex; align-items: center; gap: 5px; }
    .meta-dot { color: #333; }

    /* Video container */
    .video-wrap {
      position: relative;
      width: 100%;
      border-radius: 14px;
      overflow: hidden;
      background: #111;
      margin-bottom: 20px;
      cursor: pointer;
      box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .video-wrap::before {
      content: '';
      display: block;
      padding-top: 56.25%; /* 16:9 */
    }

    .thumb-layer {
      position: absolute;
      inset: 0;
      ${thumbStyle};
    }

    .thumb-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s ease;
    }
    .thumb-overlay:hover { background: rgba(0,0,0,0.1); }

    .play-ring {
      width: 76px;
      height: 76px;
      background: rgba(255,255,255,0.96);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      backdrop-filter: blur(4px);
    }
    .thumb-overlay:hover .play-ring {
      transform: scale(1.1);
      box-shadow: 0 0 0 12px rgba(124,110,240,0.2), 0 8px 40px rgba(124,110,240,0.35);
    }
    .play-triangle {
      width: 0; height: 0;
      border-style: solid;
      border-width: 11px 0 11px 20px;
      border-color: transparent transparent transparent #0a0a0f;
      margin-left: 4px;
    }

    .video-el {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: none;
      object-fit: contain;
      background: #000;
    }

    /* Duration badge */
    .dur-badge {
      position: absolute;
      bottom: 12px;
      right: 14px;
      background: rgba(0,0,0,0.72);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 5px;
      letter-spacing: 0.3px;
      pointer-events: none;
    }

    /* Actions */
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 11px 22px;
      border-radius: 9px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: transform 0.15s, box-shadow 0.15s, background 0.15s;
      text-decoration: none;
      letter-spacing: -0.1px;
    }
    .btn:active { transform: scale(0.97); }

    .btn-copy {
      background: #7c6ef0;
      color: #fff;
    }
    .btn-copy:hover {
      background: #6a5ce6;
      box-shadow: 0 4px 20px rgba(124,110,240,0.4);
      transform: translateY(-1px);
    }

    .btn-dl {
      background: #1c1c2e;
      color: #ccc;
      border: 1px solid #2a2a3e;
    }
    .btn-dl:hover {
      background: #242438;
      color: #fff;
      transform: translateY(-1px);
    }

    .copy-feedback {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: #7c6ef0;
      font-weight: 600;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; } }

    footer {
      margin-top: 48px;
      padding: 0 24px 24px;
      text-align: center;
      color: #333;
      font-size: 12px;
    }
    footer a { color: #444; text-decoration: none; }
    footer a:hover { color: #7c6ef0; }
  </style>
</head>
<body>

<header class="header">
  <a class="logo" href="/">Cli<span>p</span>r</a>
</header>

<main class="wrap">
  <h1 class="title">${safeTitle}</h1>

  <div class="meta">
    <span class="meta-item">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="#666" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" stroke="#666" stroke-width="1.4" stroke-linecap="round"/></svg>
      ${dateStr}
    </span>
    ${durStr ? `<span class="meta-dot">·</span><span class="meta-item">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l5 5-5 5" stroke="#666" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      ${durStr}
    </span>` : ''}
    <span class="meta-dot">·</span>
    <span class="meta-item">
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none"><path d="M1 5C2.5 2 4.5 1 7 1s4.5 1 6 4c-1.5 3-3.5 4-6 4S2.5 8 1 5Z" stroke="#666" stroke-width="1.3"/><circle cx="7" cy="5" r="1.8" stroke="#666" stroke-width="1.3"/></svg>
      ${views.toLocaleString()} view${views !== 1 ? 's' : ''}
    </span>
  </div>

  <div class="video-wrap" id="videoWrap">
    <div class="thumb-layer"></div>
    <div class="thumb-overlay" id="thumbOverlay">
      <div class="play-ring">
        <div class="play-triangle"></div>
      </div>
    </div>
    ${durStr ? `<div class="dur-badge" id="durBadge">${durStr}</div>` : ''}
    <video class="video-el" id="videoEl" src="${videoUrl}" controls preload="metadata"></video>
  </div>

  <div class="actions">
    <button class="btn btn-copy" id="copyBtn" onclick="copyLink()">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 5.5V3a.5.5 0 0 0-.5-.5H3A.5.5 0 0 0 2.5 3v7a.5.5 0 0 0 .5.5h2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      Copy Link
    </button>
    <a class="btn btn-dl" href="${videoUrl}" download="${safeTitle}.webm">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0-3-3m3 3 3-3M3 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Download
    </a>
    <span class="copy-feedback" id="copyFeedback">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 4.5" stroke="#7c6ef0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Copied!
    </span>
  </div>
</main>

<footer>Powered by <a href="/">Clipr</a></footer>

<script>
  const thumbOverlay = document.getElementById('thumbOverlay');
  const videoEl = document.getElementById('videoEl');
  const durBadge = document.getElementById('durBadge');

  thumbOverlay.addEventListener('click', () => {
    thumbOverlay.style.display = 'none';
    if (durBadge) durBadge.style.display = 'none';
    videoEl.style.display = 'block';
    videoEl.play().catch(() => {});
  });

  function copyLink() {
    const url = '${shareUrl}';
    navigator.clipboard.writeText(url).then(() => {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline-flex';
      setTimeout(() => (fb.style.display = 'none'), 2500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }
</script>
</body>
</html>`;
}

function notFoundPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found — Clipr</title>
  <style>body{background:#0a0a0f;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .c{text-align:center}.logo{font-size:36px;font-weight:800;margin-bottom:16px}.logo span{color:#7c6ef0}
  p{color:#555;margin-bottom:24px}a{color:#7c6ef0;text-decoration:none;font-weight:600}</style></head>
  <body><div class="c"><div class="logo">Cli<span>p</span>r</div>
  <p>This recording doesn't exist or may have been deleted.</p>
  <a href="/">← Back to Clipr</a></div></body></html>`;
}
