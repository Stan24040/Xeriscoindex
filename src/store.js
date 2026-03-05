// src/store.js

const { v4: uuidv4 } = require('uuid');
const dexscreener   = require('./adapters/dexscreener');
const xerisRpc      = require('./adapters/xeris-rpc');

const USE_XERIS_RPC  = process.env.USE_XERIS_RPC   === 'true';
const USE_SIMULATION = process.env.USE_SIMULATION  === 'true';

console.log(`[Store] Mode: ${USE_XERIS_RPC ? '🔷 XERIS RPC' : USE_SIMULATION ? '🔧 SIMULATION' : '📡 DexScreener (live)'}`);

// ── IN-MEMORY DATABASE ────────────────────────────────────────────────────────
const db = {
  pairs:    new Map(),
  byMint:   new Map(),
  bySymbol: new Map(),
};

// ── CRUD ──────────────────────────────────────────────────────────────────────
function getAll()        { return Array.from(db.pairs.values()); }
function getById(id)     { return db.pairs.get(id) || null; }
function getByMint(mint) { const id = db.byMint.get(mint); return id ? db.pairs.get(id) : null; }

function upsertPair(pair) {
  const existingId = db.byMint.get(pair.mint);
  if (existingId) {
    const p = db.pairs.get(existingId);
    Object.assign(p, pair, { id: p.id, createdAt: p.createdAt, updatedAt: Date.now() });
    return p;
  }
  if (!pair.id) pair.id = uuidv4();
  pair.createdAt = Date.now();
  pair.updatedAt = Date.now();
  pair.sparkline  = pair.sparkline || [];
  db.pairs.set(pair.id, pair);
  db.byMint.set(pair.mint, pair.id);
  if (!db.bySymbol.has(pair.symbol)) db.bySymbol.set(pair.symbol, pair.id);
  return pair;
}

// Called by xeris-fun launchpad webhook
function upsertFromLaunchpad(data) {
  const existing = getByMint(data.mint);
  if (existing) return existing;

  const pair = {
    id:          uuidv4(),
    mint:        data.mint,
    symbol:      data.symbol,
    name:        data.name,
    color:       data.color || '#00e5ff',
    quote:       'XRS',
    chain:       'xeris',
    dex:         data.dex || 'XerisSwap',
    price:       parseFloat(data.initialPrice) || 0.0001,
    priceUsd:    parseFloat(data.initialPrice) || 0.0001,
    change1h: 0, change6h: 0, change24h: 0,
    volume24h:   0,
    liquidity:   parseFloat(data.initialLiquidity) || 0,
    marketCap:   (parseFloat(data.initialLiquidity) || 0) * 5,
    fdv:         0,
    buys: 0, sells: 0, txns24h: 0,
    age:         0,
    launchedAt:  data.launchedAt || Date.now(),
    verified:    false,
    boosted:     false,
    source:      'launchpad',
    sparkline:   Array.from({ length: 24 }, () => 1),
    creator:     data.creator   || null,
    description: data.description || null,
    website:     data.website   || null,
    twitter:     data.twitter   || null,
    telegram:    data.telegram  || null,
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };

  upsertPair(pair);
  console.log(`[Store] Launchpad → ${pair.symbol}/XRS registered`);
  return pair;
}

function getStats() {
  const pairs  = getAll();
  // Look for XRS/XERIS token in any chain
  const xeris  = pairs.find(p =>
    p.symbol === 'XRS' || p.symbol === 'XERIS' ||
    p.symbol === 'xrs_native'
  );
  return {
    totalPairs:      pairs.length,
    totalVolume24h:  pairs.reduce((s, p) => s + (p.volume24h || 0), 0),
    totalLiquidity:  pairs.reduce((s, p) => s + (p.liquidity  || 0), 0),
    totalTxns24h:    pairs.reduce((s, p) => s + (p.txns24h    || 0), 0),
    newPairs24h:     pairs.filter(p => Date.now() - (p.launchedAt||0) < 86_400_000).length,
    xerisPrice:      xeris?.price     || 0,
    xerisChange24h:  xeris?.change24h || 0,
    dataSource:      USE_XERIS_RPC ? 'xeris-rpc' : USE_SIMULATION ? 'simulation' : 'dexscreener',
    chains: {
      xeris:  pairs.filter(p => p.chain === 'xeris').length,
      solana: pairs.filter(p => p.chain === 'solana' || p.chain === 'solana').length,
    },
  };
}

// ── SPARKLINE ─────────────────────────────────────────────────────────────────
function updateSparkline(pair, newPrice) {
  if (!pair.sparkline) pair.sparkline = [];
  const last = pair.sparkline[pair.sparkline.length - 1] || newPrice;
  pair.sparkline.push(newPrice / (last || newPrice));
  if (pair.sparkline.length > 48) pair.sparkline.shift();
}

// ── EVENT EMITTER ─────────────────────────────────────────────────────────────
const priceListeners = [];
function onPriceChange(fn) { priceListeners.push(fn); }
function emit(updates) { priceListeners.forEach(fn => fn(updates)); }

// ── DEXSCREENER SYNC ──────────────────────────────────────────────────────────
async function syncFromDexScreener() {
  try {
    console.log('[DexScreener] Fetching pairs...');
    // Use fetchTopPairs for broad coverage (XERIS + top Solana tokens)
    const pairs = await dexscreener.fetchTopPairs();

    if (pairs.length === 0) {
      console.warn('[DexScreener] No pairs returned — rate limited? Retrying soon.');
      return;
    }

    const updates = [];
    pairs.forEach((p, i) => {
      const prev = getByMint(p.mint);
      p.rank = i + 1;
      p.age  = Date.now() - (p.launchedAt || Date.now());
      updateSparkline(p, p.price);
      upsertPair(p);
      updates.push({
        id:        p.id || p.mint,
        price:     p.price,
        change1h:  p.change1h,
        change24h: p.change24h,
        volume24h: p.volume24h,
        priceDir:  prev && p.price >= prev.price ? 'up' : 'dn',
      });
    });

    if (updates.length) emit(updates);
    console.log(`[DexScreener] ✓ Synced ${updates.length} pairs`);
  } catch (err) {
    console.error('[DexScreener] Sync error:', err.message);
  }
}

// ── XERIS RPC SYNC ────────────────────────────────────────────────────────────
async function syncFromXerisRpc() {
  // Health check
  const alive = await xerisRpc.healthCheck();
  if (!alive) {
    console.warn('[XerisRPC] Node not reachable — 138.197.116.81:56001');
    return;
  }

  // Fetch network stats
  try {
    const stats = await xerisRpc.getNetworkStats();
    if (stats) {
      console.log(`[XerisRPC] Height: ${stats.height} | TPS: ${stats.tps}`);
    }
  } catch(e) { /* non-fatal */ }

  // Fetch all Xeris pairs (launchpad + swaps + registry)
  try {
    const pairs = await xerisRpc.fetchAllXerisPairs();
    if (!pairs.length) {
      console.warn('[XerisRPC] No pairs returned from testnet');
      return;
    }

    const updates = [];
    pairs.forEach((p, i) => {
      const prev = getByMint(p.mint);
      p.rank = i + 1;
      p.age  = Date.now() - (p.launchedAt || Date.now());
      updateSparkline(p, p.price);
      upsertPair(p);
      updates.push({
        id:        p.id || p.mint,
        price:     p.price,
        change1h:  p.change1h,
        change24h: p.change24h,
        volume24h: p.volume24h,
        priceDir:  prev && p.price >= prev.price ? 'up' : 'dn',
      });
    });

    if (updates.length) emit(updates);
    console.log(`[XerisRPC] Synced ${updates.length} Xeris pairs`);
  } catch (err) {
    console.error('[XerisRPC] fetchAllXerisPairs error:', err.message);
  }
}

// ── SIMULATION MODE ───────────────────────────────────────────────────────────
function seedSimulatedPairs() {
  const TOKENS = [
    {symbol:'XERIS',name:'XerisCoin',color:'#00e5ff'},
    {symbol:'XSWP',name:'XerisSwap',color:'#00ff88'},
    {symbol:'XLND',name:'XerisLend',color:'#ff6b35'},
    {symbol:'XNFT',name:'XerisNFT',color:'#a855f7'},
    {symbol:'XBET',name:'XerisBet',color:'#ffd700'},
    {symbol:'XPAD',name:'XerisPad',color:'#ff3366'},
    {symbol:'XDAO',name:'XerisDAO',color:'#00b4cc'},
    {symbol:'XVLT',name:'XerisVault',color:'#39ff14'},
    {symbol:'XPAY',name:'XerisPay',color:'#ff9500'},
    {symbol:'XGAME',name:'XerisGame',color:'#e040fb'},
  ];
  const DEXES = ['XerisSwap','XerisDEX','OmniSwap','VortexDEX'];
  const r = (a,b) => Math.random()*(b-a)+a;
  const s = () => Math.random()>.5?1:-1;
  TOKENS.forEach((t, i) => {
    const price = r(0.001,10), liq = r(5000,2e6);
    upsertPair({
      id:uuidv4(), mint:`SIM_${t.symbol}`, symbol:t.symbol, name:t.name, color:t.color,
      quote:'XRS', chain:'xeris', dex:DEXES[i%DEXES.length],
      price, priceUsd:price,
      change1h:s()*r(.1,10), change6h:s()*r(.5,25), change24h:s()*r(1,80),
      volume24h:r(liq*.1,liq*2), liquidity:liq, marketCap:liq*r(2,20), fdv:liq*r(5,50),
      buys:Math.floor(r(20,500)), sells:Math.floor(r(10,300)), txns24h:Math.floor(r(30,800)),
      launchedAt:Date.now()-Math.floor(r(1,720))*3.6e6, age:0,
      verified:Math.random()>.5, boosted:Math.random()>.8, source:'simulation',
      sparkline:Array.from({length:24},()=>r(.5,1.5)),
      createdAt:Date.now(), updatedAt:Date.now(),
    });
  });
  console.log(`[Sim] Seeded ${TOKENS.length} pairs`);
}

function startSimulationEngine() {
  seedSimulatedPairs();
  setInterval(() => {
    const updates = [];
    db.pairs.forEach(p => {
      const drift = (Math.random()-.49)*0.003, prev = p.price;
      p.price *= (1+drift); p.priceUsd = p.price;
      p.change1h += (p.price-prev)/prev*100;
      p.volume24h += p.liquidity*Math.random()*.001;
      if(Math.random()>.7){ drift>0?p.buys++:p.sells++; p.txns24h++; }
      updateSparkline(p, p.price); p.updatedAt = Date.now();
      updates.push({id:p.id, price:p.price, change1h:p.change1h, change24h:p.change24h, priceDir:drift>0?'up':'dn'});
    });
    emit(updates);
  }, 2000);
}

// ── START ─────────────────────────────────────────────────────────────────────
async function startPriceEngine() {
  if (USE_SIMULATION) {
    startSimulationEngine();
    return;
  }

  if (USE_XERIS_RPC) {
    await syncFromXerisRpc();
    // Sync every 10s (4s block time, but we don't want to hammer the testnet)
    setInterval(syncFromXerisRpc, 10_000);
    // Micro-ticks between syncs for live UI feel
    setInterval(() => {
      const updates = [];
      db.pairs.forEach(p => {
        if (p.source === 'launchpad' || p.source === 'xeris-launchpad') return;
        const micro = (Math.random()-.5)*0.0002, prev = p.price;
        p.price *= (1+micro); p.priceUsd = p.price;
        updateSparkline(p, p.price); p.updatedAt = Date.now();
        updates.push({id:p.id, price:p.price, change1h:p.change1h, change24h:p.change24h, priceDir:p.price>=prev?'up':'dn'});
      });
      if(updates.length) emit(updates);
    }, 3000);
    return;
  }

  // Default: DexScreener live data (XERIS on Solana)
  await syncFromDexScreener();
  setInterval(syncFromDexScreener, 45_000); // 45s — avoids DexScreener rate limits

  // Micro-ticks between refreshes so UI stays alive
  setInterval(() => {
    const updates = [];
    db.pairs.forEach(p => {
      if (p.source === 'launchpad') return;
      const micro = (Math.random()-.5)*0.0004, prev = p.price;
      p.price *= (1+micro); p.priceUsd = p.price;
      updateSparkline(p, p.price); p.updatedAt = Date.now();
      updates.push({id:p.id, price:p.price, change1h:p.change1h, change24h:p.change24h, priceDir:p.price>=prev?'up':'dn'});
    });
    if(updates.length) emit(updates);
  }, 3000);
}

module.exports = { getAll, getById, getByMint, upsertPair, upsertFromLaunchpad, getStats, onPriceChange, startPriceEngine };
