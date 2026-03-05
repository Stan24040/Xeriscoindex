// src/store.js — In-memory store with price simulation engine
// Swap this out for PostgreSQL later by replacing the CRUD functions

const { v4: uuidv4 } = require('uuid');

// ── SEED DATA ─────────────────────────────────────────────────────────────────
const DEXES = ['XerisSwap', 'XerisDEX', 'OmniSwap', 'VortexDEX', 'ApertureSwap'];

const SEED_TOKENS = [
  { symbol: 'XERIS',   name: 'Xeris',          color: '#00e5ff' },
  { symbol: 'XSWP',    name: 'XerisSwap',       color: '#00ff88' },
  { symbol: 'XLND',    name: 'XerisLend',       color: '#ff6b35' },
  { symbol: 'XNFT',    name: 'XerisNFT',        color: '#a855f7' },
  { symbol: 'XBET',    name: 'XerisBet',        color: '#ffd700' },
  { symbol: 'XPAD',    name: 'XerisPad',        color: '#ff3366' },
  { symbol: 'XDAO',    name: 'XerisDAO',        color: '#00b4cc' },
  { symbol: 'XVLT',    name: 'XerisVault',      color: '#39ff14' },
  { symbol: 'XPAY',    name: 'XerisPay',        color: '#ff9500' },
  { symbol: 'XGAME',   name: 'XerisGame',       color: '#e040fb' },
  { symbol: 'XBRIDGE', name: 'XerisBridge',     color: '#40c4ff' },
  { symbol: 'XSTAKE',  name: 'XerisStake',      color: '#69ff47' },
  { symbol: 'FLUX',    name: 'FluxToken',       color: '#ff4081' },
  { symbol: 'NOVA',    name: 'NovaCoin',        color: '#00e676' },
  { symbol: 'ORBIT',   name: 'OrbitFi',         color: '#ffab40' },
  { symbol: 'ECHO',    name: 'EchoProtocol',    color: '#7c4dff' },
  { symbol: 'VEIL',    name: 'VeilSwap',        color: '#18ffff' },
  { symbol: 'PRISM',   name: 'PrismDEX',        color: '#b2ff59' },
  { symbol: 'SURGE',   name: 'SurgeFinance',    color: '#ff6d00' },
  { symbol: 'PHANTOM', name: 'PhantomFi',       color: '#ea80fc' },
  { symbol: 'PULSE',   name: 'PulseChain',      color: '#82b1ff' },
  { symbol: 'DRIFT',   name: 'DriftProtocol',   color: '#ccff90' },
  { symbol: 'APEX',    name: 'ApexDEX',         color: '#ff80ab' },
  { symbol: 'HYDRA',   name: 'HydraFi',         color: '#80d8ff' },
  { symbol: 'ZEN',     name: 'ZenFinance',      color: '#f4ff81' },
];

function r(min, max) { return Math.random() * (max - min) + min; }
function ri(min, max) { return Math.floor(r(min, max)); }
function sign() { return Math.random() > 0.5 ? 1 : -1; }

function makePair(token, index) {
  const price = Math.random() < 0.3 ? r(0.0001, 0.01)
              : Math.random() < 0.5 ? r(0.01, 10)
              : r(10, 500);
  const liquidity = r(5000, 5_000_000);
  const volume24h  = r(liquidity * 0.05, liquidity * 2);
  const marketCap  = liquidity * r(2, 30);

  return {
    id:         uuidv4(),
    rank:       index + 1,
    mint:       `XERIS${token.symbol}${Date.now().toString(36).toUpperCase()}`,
    symbol:     token.symbol,
    name:       token.name,
    color:      token.color,
    quote:      'XRS',
    dex:        DEXES[ri(0, DEXES.length)],
    price,
    priceUsd:   price,
    change1h:   sign() * r(0.1, 15),
    change6h:   sign() * r(0.5, 40),
    change24h:  sign() * r(1, 120),
    volume24h,
    liquidity,
    marketCap,
    buys:       ri(20, 500),
    sells:      ri(10, 400),
    txns24h:    ri(30, 900),
    age:        ri(1, 720) * 3_600_000,        // ms since launch
    launchedAt: Date.now() - ri(1, 720) * 3_600_000,
    verified:   Math.random() > 0.5,
    boosted:    Math.random() > 0.8,
    source:     'seed',                         // 'seed' | 'launchpad' | 'manual'
    sparkline:  Array.from({ length: 24 }, () => r(0.5, 1.5)),
    createdAt:  Date.now(),
    updatedAt:  Date.now(),
  };
}

// ── IN-MEMORY DATABASE ────────────────────────────────────────────────────────
const db = {
  pairs: new Map(),     // id → pair
  byMint: new Map(),    // mint → id
  bySymbol: new Map(),  // symbol → id
};

// Seed
SEED_TOKENS.forEach((t, i) => {
  const p = makePair(t, i);
  db.pairs.set(p.id, p);
  db.byMint.set(p.mint, p.id);
  db.bySymbol.set(p.symbol, p.id);
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
function getAll() {
  return Array.from(db.pairs.values());
}

function getById(id) {
  return db.pairs.get(id) || null;
}

function getByMint(mint) {
  const id = db.byMint.get(mint);
  return id ? db.pairs.get(id) : null;
}

function upsertFromLaunchpad(data) {
  // Called when xeris-fun registers a new token
  const existing = getByMint(data.mint);
  if (existing) return existing;   // already registered

  const pair = {
    id:          uuidv4(),
    rank:        db.pairs.size + 1,
    mint:        data.mint,
    symbol:      data.symbol,
    name:        data.name,
    color:       data.color || '#00e5ff',
    quote:       'XRS',
    dex:         data.dex || 'XerisSwap',
    price:       data.initialPrice || 0.0001,
    priceUsd:    data.initialPrice || 0.0001,
    change1h:    0,
    change6h:    0,
    change24h:   0,
    volume24h:   0,
    liquidity:   data.initialLiquidity || 0,
    marketCap:   (data.initialLiquidity || 0) * 5,
    buys:        0,
    sells:       0,
    txns24h:     0,
    age:         0,
    launchedAt:  data.launchedAt || Date.now(),
    verified:    false,
    boosted:     false,
    source:      'launchpad',
    sparkline:   Array.from({ length: 24 }, () => 1),
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    creator:     data.creator || null,
    description: data.description || null,
    website:     data.website || null,
    twitter:     data.twitter || null,
    telegram:    data.telegram || null,
  };

  db.pairs.set(pair.id, pair);
  db.byMint.set(pair.mint, pair.id);
  db.bySymbol.set(pair.symbol, pair.id);
  console.log(`[Store] New pair registered from launchpad: ${pair.symbol}/XRS`);
  return pair;
}

function updatePriceData(id, updates) {
  const pair = db.pairs.get(id);
  if (!pair) return null;
  Object.assign(pair, updates, { updatedAt: Date.now() });
  return pair;
}

function getStats() {
  const pairs = getAll();
  return {
    totalPairs:    pairs.length,
    totalVolume24h: pairs.reduce((s, p) => s + p.volume24h, 0),
    totalLiquidity: pairs.reduce((s, p) => s + p.liquidity, 0),
    totalTxns24h:  pairs.reduce((s, p) => s + p.txns24h, 0),
    newPairs24h:   pairs.filter(p => Date.now() - p.launchedAt < 86_400_000).length,
    xerisPrice:    pairs.find(p => p.symbol === 'XERIS')?.price || 0.35,
  };
}

// ── PRICE ENGINE ──────────────────────────────────────────────────────────────
// Simulates live market movement on all pairs
// Replace this with real Xeris RPC data when available

let priceChangeListeners = [];

function onPriceChange(fn) {
  priceChangeListeners.push(fn);
}

function startPriceEngine() {
  console.log('[PriceEngine] Starting...');

  setInterval(() => {
    const updates = [];
    db.pairs.forEach(pair => {
      const prevPrice = pair.price;

      // Simulate realistic price movement
      const volatility = pair.liquidity < 50_000 ? 0.008 : 0.002;
      const drift      = (Math.random() - 0.49) * volatility;
      const newPrice   = Math.max(pair.price * (1 + drift), 0.000001);

      // Update sparkline
      pair.sparkline.push(newPrice / prevPrice);
      if (pair.sparkline.length > 24) pair.sparkline.shift();

      // Simulate volume ticks
      const volTick = r(pair.liquidity * 0.0001, pair.liquidity * 0.002);
      pair.volume24h += volTick;

      // Simulate buys/sells
      if (Math.random() > 0.7) {
        if (drift > 0) pair.buys++;
        else pair.sells++;
        pair.txns24h++;
      }

      // Recalculate changes (simplified)
      pair.change1h  += (newPrice - prevPrice) / prevPrice * 100;
      pair.price      = newPrice;
      pair.priceUsd   = newPrice;
      pair.marketCap  = newPrice * (pair.marketCap / prevPrice);
      pair.age        = Date.now() - pair.launchedAt;
      pair.updatedAt  = Date.now();

      updates.push({ id: pair.id, price: newPrice, change1h: pair.change1h });
    });

    // Notify WebSocket listeners
    priceChangeListeners.forEach(fn => fn(updates));
  }, 2000);

  // Reset 1h/6h/24h change accumulators periodically
  setInterval(() => {
    db.pairs.forEach(pair => {
      pair.change1h  = sign() * r(0.1, 15);
      pair.change6h  = sign() * r(0.5, 40);
      pair.change24h = sign() * r(1, 80);
    });
  }, 3_600_000); // every hour
}

module.exports = {
  getAll,
  getById,
  getByMint,
  upsertFromLaunchpad,
  updatePriceData,
  getStats,
  onPriceChange,
  startPriceEngine,
};
