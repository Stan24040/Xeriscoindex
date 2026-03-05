// src/adapters/dexscreener.js
// ─────────────────────────────────────────────────────────────────────────────
// Pulls REAL data from DexScreener public API (free, no key needed)
// Used now because XERIS currently trades on Solana / PumpSwap.
//
// When Xeris native chain launches, swap this file for src/adapters/xeris-rpc.js
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

// Known XERIS-related pairs on Solana (from DexScreener)
// Main pair: XERIS/SOL on PumpSwap
const XERIS_PAIRS = [
  '2Ff7ABu3yFcJBRZcoBMydyKnEDGmqEz76CmkWq2BdTFq',  // XERIS/SOL - PumpSwap (main)
];

// Token contract address for XERIS on Solana
const XERIS_TOKEN_ADDRESS = '9ezFthWrDUpSSeMdpLW6SDD9TJigHdc4AuQ5QN5bpump';

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'XeriscoIndex/1.0' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Normalize a DexScreener pair → XeriscoIndex pair format ──────────────────
function normalizePair(raw, index) {
  const base  = raw.baseToken  || {};
  const quote = raw.quoteToken || {};
  const price = parseFloat(raw.priceUsd) || 0;
  const liq   = parseFloat(raw.liquidity?.usd) || 0;
  const vol24 = parseFloat(raw.volume?.h24) || 0;
  const mcap  = parseFloat(raw.marketCap) || liq * 5;

  const h1   = parseFloat(raw.priceChange?.h1)  || 0;
  const h6   = parseFloat(raw.priceChange?.h6)  || 0;
  const h24  = parseFloat(raw.priceChange?.h24) || 0;

  const txns = raw.txns?.h24 || {};
  const buys  = txns.buys  || 0;
  const sells = txns.sells || 0;

  return {
    id:          raw.pairAddress,
    rank:        index + 1,
    mint:        raw.pairAddress,
    tokenAddress: base.address || '',
    symbol:      base.symbol  || '???',
    name:        base.name    || base.symbol || '???',
    color:       tokenColor(base.symbol),
    quote:       quote.symbol || 'SOL',
    dex:         formatDex(raw.dexId),
    chain:       raw.chainId  || 'solana',
    url:         raw.url      || `https://dexscreener.com/solana/${raw.pairAddress}`,
    price,
    priceUsd:    price,
    change1h:    h1,
    change6h:    h6,
    change24h:   h24,
    volume24h:   vol24,
    liquidity:   liq,
    marketCap:   mcap,
    fdv:         parseFloat(raw.fdv) || 0,
    buys,
    sells,
    txns24h:     buys + sells,
    age:         raw.pairCreatedAt ? Date.now() - raw.pairCreatedAt : 0,
    launchedAt:  raw.pairCreatedAt || Date.now(),
    verified:    false,
    boosted:     false,
    source:      'dexscreener',
    sparkline:   [],            // DexScreener doesn't provide sparkline — we build it
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    // Raw DexScreener fields preserved for detail page
    _raw:        raw,
  };
}

function formatDex(dexId) {
  const map = {
    'pumpswap':   'PumpSwap',
    'raydium':    'Raydium',
    'orca':       'Orca',
    'meteora':    'Meteora',
    'jupiter':    'Jupiter',
    'serum':      'Serum',
  };
  return map[dexId] || (dexId ? dexId.charAt(0).toUpperCase() + dexId.slice(1) : 'DEX');
}

const COLOR_POOL = [
  '#00e5ff','#00ff88','#ff6b35','#a855f7','#ffd700',
  '#ff3366','#00b4cc','#39ff14','#ff9500','#e040fb',
  '#40c4ff','#69ff47','#ff4081','#00e676','#ffab40',
];

function tokenColor(sym) {
  if (!sym) return COLOR_POOL[0];
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = sym.charCodeAt(i) + ((h << 5) - h);
  return COLOR_POOL[Math.abs(h) % COLOR_POOL.length];
}

// ── API CALLS ─────────────────────────────────────────────────────────────────

// Fetch XERIS specific pair by address
async function fetchXerisPairs() {
  try {
    const pairStr = XERIS_PAIRS.join(',');
    const data = await fetchJSON(`${DEXSCREENER_BASE}/latest/dex/pairs/solana/${pairStr}`);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    return pairs.map(normalizePair);
  } catch (err) {
    console.error('[DexScreener] fetchXerisPairs error:', err.message);
    return [];
  }
}

// Fetch all pairs for the XERIS token (discovers all markets)
async function fetchXerisTokenPairs() {
  try {
    const data = await fetchJSON(`${DEXSCREENER_BASE}/latest/dex/tokens/${XERIS_TOKEN_ADDRESS}`);
    const pairs = data.pairs || [];
    return pairs
      .filter(p => parseFloat(p.liquidity?.usd) > 100) // filter dust pools
      .map(normalizePair);
  } catch (err) {
    console.error('[DexScreener] fetchXerisTokenPairs error:', err.message);
    return [];
  }
}

// Search DexScreener for a token by name/symbol
async function searchPairs(query) {
  try {
    const data = await fetchJSON(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
    return (data.pairs || []).map(normalizePair);
  } catch (err) {
    console.error('[DexScreener] searchPairs error:', err.message);
    return [];
  }
}

// Fetch a single pair by address
async function fetchPair(chain, pairAddress) {
  try {
    const data = await fetchJSON(`${DEXSCREENER_BASE}/latest/dex/pairs/${chain}/${pairAddress}`);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    return pairs.length ? normalizePair(pairs[0], 0) : null;
  } catch (err) {
    console.error('[DexScreener] fetchPair error:', err.message);
    return null;
  }
}

// ── Fetch many popular Solana pairs (broad screener data) ────────────────────
// Uses DexScreener's token endpoint for known popular tokens
// This ensures the screener has data even if XERIS has low volume

const TOP_SOLANA_TOKENS = [
  '9ezFthWrDUpSSeMdpLW6SDD9TJigHdc4AuQ5QN5bpump', // XERIS
  'So11111111111111111111111111111111111111112',     // SOL (wrapped)
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',  // MEW
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  // BOME
  'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump',  // FWOG
  'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump',  // CHILLGUY
];

const SEARCH_QUERIES = ['XERIS', 'BONK WIF SOL', 'JUP POPCAT MEW', 'TRUMP FARTCOIN', 'PEPE MEME'];

async function fetchTopPairs() {
  const all = [];
  const seen = new Set();

  const add = (pairs) => {
    pairs.forEach(p => {
      if (!p.id || seen.has(p.id)) return;
      if ((p.liquidity || 0) < 50) return;
      seen.add(p.id);
      all.push(p);
    });
  };

  // 1. XERIS token first
  try {
    const xeris = await fetchXerisTokenPairs();
    add(xeris);
  } catch(e) { console.error('[DexScreener] XERIS fetch:', e.message); }

  // 2. Search queries for broad coverage
  for (const q of SEARCH_QUERIES) {
    try {
      const r = await searchPairs(q);
      const solana = r.filter(p => p.chain === 'solana');
      add(solana);
      await new Promise(res => setTimeout(res, 300)); // avoid rate limit
    } catch(e) { /* skip */ }
    if (all.length >= 80) break;
  }

  // Sort by volume
  all.sort((a,b) => (b.volume24h||0) - (a.volume24h||0));
  all.forEach((p,i) => { p.rank = i+1; });

  return all;
}

module.exports = {
  fetchXerisPairs,
  fetchXerisTokenPairs,
  fetchTopPairs,
  searchPairs,
  fetchPair,
  normalizePair,
  XERIS_TOKEN_ADDRESS,
  XERIS_PAIRS,
};
