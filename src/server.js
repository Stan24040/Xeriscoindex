// src/server.js — XeriscoIndex Production Server
'use strict';
require('dotenv').config();

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const store        = require('./store');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

const PORT    = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const API_KEY = process.env.API_KEY;

if (!API_KEY && IS_PROD) {
  console.error('FATAL: API_KEY env var must be set in production!');
  process.exit(1);
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

const corsOptions = {
  origin: (IS_PROD && ALLOWED_ORIGINS.length)
    ? (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
        else cb(new Error('Origin not allowed: ' + origin));
      }
    : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
};

// ── SECURITY & PERF MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      connectSrc:  ["'self'", 'https://api.dexscreener.com', 'https://corsproxy.io',
                    'https://api.allorigins.win', 'wss:', 'ws:'],
      imgSrc:      ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.set('trust proxy', 1);

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — try again in 60 seconds' },
});
const boostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many boost requests — try again later' },
});
const launchpadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Too many launchpad requests' },
});
app.use('/api/', apiLimiter);

// ── STATIC FILES ──────────────────────────────────────────────────────────────
// Serve all static assets except index.html (we inject env vars into that)
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  index: false,   // Don't auto-serve index.html — we handle it below
}));

// Cache + inject env vars into index.html
const fs = require('fs');
let indexHtml = '';
function getIndexHtml() {
  if (!indexHtml || !IS_PROD) {
    try {
      indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
      const boostWallet = process.env.BOOST_WALLET || '';
      indexHtml = indexHtml.replace('__BOOST_WALLET__', boostWallet);
    } catch(e) { console.error('Failed to read index.html:', e.message); }
  }
  return indexHtml;
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  const valid = API_KEY || 'xeris-dev-key';
  if (key !== valid) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  clients.add(ws);
  ws.isAlive = true;
  console.log(`[WS] Client connected (${ip}) — total: ${clients.size}`);

  try {
    ws.send(JSON.stringify({
      type: 'SNAPSHOT', pairs: store.getAll(), stats: store.getStats(), ts: Date.now(),
    }));
  } catch(e) {}

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg);
      if (d.type === 'PING') ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
    } catch(e) {}
  });
  ws.on('close', () => { clients.delete(ws); console.log(`[WS] Disconnected — total: ${clients.size}`); });
  ws.on('error', (e) => { console.warn('[WS] Error:', e.message); clients.delete(ws); });
});

// Ping/pong heartbeat — drop dead connections
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { clients.delete(ws); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch(e) { clients.delete(ws); }
    }
  });
}

store.onPriceChange((updates) => {
  broadcast({ type: 'PRICE_UPDATE', updates, ts: Date.now() });
});

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', chain: 'XERIS/SOLANA',
    pairs: store.getAll().length,
    uptime: Math.floor(process.uptime()),
    mode: process.env.USE_XERIS_RPC === 'true' ? 'xeris-rpc'
        : process.env.USE_SIMULATION === 'true' ? 'simulation' : 'dexscreener',
    ts: Date.now(),
  });
});

app.get('/api/pairs', (req, res) => {
  let pairs = store.getAll();
  const { q, dex, sort, dir, page = 1, limit = 50 } = req.query;
  if (q) {
    const lq = q.toLowerCase();
    pairs = pairs.filter(p =>
      (p.symbol||'').toLowerCase().includes(lq) ||
      (p.name||'').toLowerCase().includes(lq) ||
      (p.mint||'').toLowerCase().includes(lq)
    );
  }
  if (dex) pairs = pairs.filter(p => p.dex === dex);
  const sortMap = { price:'price', vol:'volume24h', liq:'liquidity', mcap:'marketCap', h1:'change1h', h24:'change24h', age:'launchedAt' };
  if (sort && sortMap[sort]) {
    const key = sortMap[sort], d = dir === 'asc' ? 1 : -1;
    pairs = [...pairs].sort((a,b) => ((a[key]||0)-(b[key]||0))*d);
  }
  const total = pairs.length;
  const pageNum  = Math.max(1, parseInt(page)||1);
  const pageSize = Math.min(100, parseInt(limit)||50);
  const start    = (pageNum-1)*pageSize;
  res.json({ pairs: pairs.slice(start, start+pageSize), meta: { total, page:pageNum, pageSize, pages:Math.ceil(total/pageSize) } });
});

app.get('/api/pairs/:id', (req, res) => {
  const pair = store.getById(req.params.id) || store.getByMint(req.params.id);
  if (!pair) return res.status(404).json({ error: 'Pair not found' });
  res.json(pair);
});

app.get('/api/stats',    (req, res) => res.json(store.getStats()));
app.get('/api/trending', (req, res) => {
  const n = Math.min(50, parseInt(req.query.limit)||10);
  res.json(store.getAll().sort((a,b)=>(b.volume24h||0)-(a.volume24h||0)).slice(0,n));
});
app.get('/api/new',      (req, res) => {
  const n = Math.min(50, parseInt(req.query.limit)||10);
  res.json(store.getAll().sort((a,b)=>(b.launchedAt||0)-(a.launchedAt||0)).slice(0,n));
});
app.get('/api/gainers',  (req, res) => {
  const n = Math.min(50, parseInt(req.query.limit)||10);
  res.json(store.getAll().filter(p=>(p.change24h||0)>0).sort((a,b)=>(b.change24h||0)-(a.change24h||0)).slice(0,n));
});
app.get('/api/losers',   (req, res) => {
  const n = Math.min(50, parseInt(req.query.limit)||10);
  res.json(store.getAll().filter(p=>(p.change24h||0)<0).sort((a,b)=>(a.change24h||0)-(b.change24h||0)).slice(0,n));
});

// Boost submission endpoint
app.post('/api/boost', boostLimiter, (req, res) => {
  const { pairAddress, website, twitter, telegram, description, logo, txHash, plan } = req.body;
  if (!pairAddress || !txHash) return res.status(400).json({ error: 'pairAddress and txHash are required' });
  if (!/^[A-Za-z0-9]{40,90}$/.test(txHash)) return res.status(400).json({ error: 'Invalid transaction hash format' });
  console.log(`[Boost] pair:${pairAddress} plan:${plan||'basic'} tx:${txHash.slice(0,16)}...`);
  res.json({ success:true, status:'pending_verification', message:'Boost received — goes live within 24h after TX verification.', ref: txHash.slice(0,16)+'...' });
});

// Launchpad webhook
app.post('/api/launchpad/register', launchpadLimiter, requireApiKey, (req, res) => {
  const { mint, symbol, name, color, initialPrice, initialLiquidity, creator, dex,
          description, website, twitter, telegram, launchedAt } = req.body;
  if (!mint || !symbol || !name) return res.status(400).json({ error: 'mint, symbol, name required' });
  if (!/^[A-Za-z0-9]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint address' });
  const pair = store.upsertFromLaunchpad({ mint, symbol, name, color,
    initialPrice: parseFloat(initialPrice)||0.0001, initialLiquidity: parseFloat(initialLiquidity)||0,
    creator, dex, description, website, twitter, telegram, launchedAt: launchedAt||Date.now() });
  broadcast({ type: 'NEW_PAIR', pair, ts: Date.now() });
  res.json({ success: true, pair });
});

// ── ERROR HANDLERS ────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route not found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status||500).json({ error: IS_PROD ? 'Internal server error' : err.message });
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Graceful shutdown...`);
  clearInterval(wsHeartbeat);
  wss.clients.forEach(ws => ws.terminate());
  server.close(() => { console.log('Server closed.'); process.exit(0); });
  setTimeout(() => { console.warn('Force exit'); process.exit(1); }, 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

// ── START ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nXeriscoIndex starting...');
  console.log('Mode:', IS_PROD ? 'production' : 'development', '| Node:', process.version);

  // Safety timeout so Railway healthcheck isn't blocked
  const startupTimeout = setTimeout(() => {
    console.warn('[Store] Startup taking long — proceeding anyway');
  }, 8000);

  try { await store.startPriceEngine(); }
  catch(err) { console.error('[Store] Engine error:', err.message); }
  finally { clearTimeout(startupTimeout); }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nReady on port ${PORT}`);
    console.log(`REST  http://0.0.0.0:${PORT}/api`);
    console.log(`WS    ws://0.0.0.0:${PORT}/ws`);
    console.log(`Pairs ${store.getAll().length}\n`);
  });
})();
