// src/adapters/xeris-rpc.js
// ─────────────────────────────────────────────────────────────────────────────
// XerisCoin Testnet Adapter — SDK v1.3
// Node:     138.197.116.81
// RPC:      port 56001  (tx submission + chain state queries)
// Explorer: port 50008  (block explorer + Solana-compat JSON-RPC)
// P2P:      port 4000   (node sync, not used here)
//
// Activate: set USE_XERIS_RPC=true in Railway/Render environment variables
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
const NODE_HOST    = process.env.XERIS_NODE_HOST || '138.197.116.81';
const RPC_PORT     = parseInt(process.env.XERIS_RPC_PORT)      || 56001;
const EXPLORER_PORT= parseInt(process.env.XERIS_EXPLORER_PORT) || 50008;

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
function fetchJSON(host, port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr  = body ? JSON.stringify(body) : null;
    const options  = {
      hostname: host,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'XeriscoIndex/1.0',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message} — raw: ${data.slice(0,120)}`)); }
      });
    });

    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// RPC port helper (port 56001)
const rpcGET  = (path)       => fetchJSON(NODE_HOST, RPC_PORT, path, 'GET');
const rpcPOST = (path, body) => fetchJSON(NODE_HOST, RPC_PORT, path, 'POST', body);

// Explorer port helpers (port 50008)
const expGET  = (path)       => fetchJSON(NODE_HOST, EXPLORER_PORT, path, 'GET');
const expRPC  = (method, params = []) => fetchJSON(NODE_HOST, EXPLORER_PORT, '/', 'POST', {
  jsonrpc: '2.0', id: Date.now(), method, params,
});

// ── COLOR POOL ────────────────────────────────────────────────────────────────
const COLOR_POOL = [
  '#00e5ff','#00ff88','#ff6b35','#a855f7','#ffd700',
  '#ff3366','#00b4cc','#39ff14','#ff9500','#e040fb',
  '#40c4ff','#69ff47','#ff4081','#00e676','#ffab40',
  '#7c4dff','#18ffff','#b388ff','#ccff90','#ff80ab',
];

function tokenColor(sym) {
  if (!sym) return COLOR_POOL[0];
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = sym.charCodeAt(i) + ((h << 5) - h);
  return COLOR_POOL[Math.abs(h) % COLOR_POOL.length];
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const r = await rpcGET('/health');
    return r?.status === 'ok' || r === 'ok';
  } catch {
    return false;
  }
}

// ── NETWORK STATS ─────────────────────────────────────────────────────────────
async function getNetworkStats() {
  try {
    const stats = await expGET('/v2/stats');
    return {
      height:       stats.height       || stats.slot || 0,
      tps:          stats.tps          || 0,
      totalSupply:  stats.total_supply  || 0,
      difficulty:   stats.difficulty    || 0,
      blockTime:    4,  // 4s per block per SDK spec
    };
  } catch (err) {
    console.error('[XerisRPC] getNetworkStats:', err.message);
    return null;
  }
}

// ── NETWORK ECONOMICS ─────────────────────────────────────────────────────────
async function getNetworkEconomics() {
  try {
    return await rpcGET('/network/economics');
  } catch (err) {
    console.error('[XerisRPC] getNetworkEconomics:', err.message);
    return null;
  }
}

// ── ALL REGISTERED TOKENS ─────────────────────────────────────────────────────
// GET /v2/tokens  →  array of { token_id, name, symbol, decimals, max_supply, ... }
async function getRegisteredTokens() {
  try {
    const data = await expGET('/v2/tokens');
    const tokens = Array.isArray(data) ? data : (data.tokens || data.data || []);
    return tokens;
  } catch (err) {
    console.error('[XerisRPC] getRegisteredTokens:', err.message);
    return [];
  }
}

// ── LAUNCHPAD (BONDING CURVES) ────────────────────────────────────────────────
// GET /launchpads → array of active bonding curve contracts with live prices
async function getLaunchpads() {
  try {
    const data = await rpcGET('/launchpads');
    const pads = Array.isArray(data) ? data : (data.launchpads || data.data || []);
    return pads;
  } catch (err) {
    console.error('[XerisRPC] getLaunchpads:', err.message);
    return [];
  }
}

// GET /launchpad/:id/quote?xrs_amount=N
async function getLaunchpadQuote(contractId, xrsLamports = 1_000_000_000) {
  try {
    return await rpcGET(`/launchpad/${contractId}/quote?xrs_amount=${xrsLamports}`);
  } catch (err) {
    console.error('[XerisRPC] getLaunchpadQuote:', err.message);
    return null;
  }
}

// ── SWAP CONTRACTS (AMM POOLS) ────────────────────────────────────────────────
async function getSwapContracts() {
  try {
    const data = await rpcGET('/contracts');
    const all  = Array.isArray(data) ? data : (data.contracts || data.data || []);
    return all.filter(c => c.contract_type === 'swap' || c.type === 'swap');
  } catch (err) {
    console.error('[XerisRPC] getSwapContracts:', err.message);
    return [];
  }
}

// ── RECENT BLOCKS ─────────────────────────────────────────────────────────────
async function getRecentBlocks(page = 1, pageSize = 20) {
  try {
    const data = await expGET(`/v2/blocks?page=${page}&page_size=${pageSize}`);
    return Array.isArray(data) ? data : (data.blocks || data.data || []);
  } catch (err) {
    console.error('[XerisRPC] getRecentBlocks:', err.message);
    return [];
  }
}

// ── RECENT TRANSACTIONS ───────────────────────────────────────────────────────
async function getRecentTransactions(page = 1, pageSize = 50) {
  try {
    const data = await expGET(`/v2/transactions?page=${page}&page_size=${pageSize}`);
    return Array.isArray(data) ? data : (data.transactions || data.data || []);
  } catch (err) {
    console.error('[XerisRPC] getRecentTransactions:', err.message);
    return [];
  }
}

// ── LATEST BLOCKHASH (for tx building) ───────────────────────────────────────
async function getLatestBlockhash() {
  try {
    const r = await expRPC('getLatestBlockhash');
    return r?.result?.value || r?.result || null;
  } catch (err) {
    console.error('[XerisRPC] getLatestBlockhash:', err.message);
    return null;
  }
}

// ── ACCOUNT BALANCE ───────────────────────────────────────────────────────────
async function getBalance(address) {
  try {
    const r = await expRPC('getBalance', [address]);
    return r?.result?.value || 0;
  } catch { return 0; }
}

// ── NORMALIZE LAUNCHPAD → SCREENER PAIR FORMAT ────────────────────────────────
function normalizeLaunchpad(pad, index) {
  const sym      = pad.symbol || pad.token_symbol || '???';
  const name     = pad.name   || pad.token_name   || sym;
  const priceXRS = parseFloat(pad.current_price)  || 0;
  const mcap     = parseFloat(pad.market_cap)      || 0;
  const progress = parseFloat(pad.progress_pct)    || 0;
  const vol24    = parseFloat(pad.volume_24h)       || parseFloat(pad.volume) || 0;
  const liq      = parseFloat(pad.liquidity)        || mcap * 0.1;

  return {
    id:          pad.contract_id || pad.id,
    rank:        index + 1,
    mint:        pad.token_id    || pad.contract_id || pad.id,
    tokenAddress: pad.token_id   || '',
    symbol:      sym,
    name,
    color:       tokenColor(sym),
    quote:       'XRS',
    dex:         'XerisLaunch',
    chain:       'xeris',
    url:         `http://explorer.xerisweb.com`,
    price:       priceXRS,
    priceUsd:    priceXRS,
    change1h:    parseFloat(pad.change_1h)  || 0,
    change6h:    parseFloat(pad.change_6h)  || 0,
    change24h:   parseFloat(pad.change_24h) || 0,
    volume24h:   vol24,
    liquidity:   liq,
    marketCap:   mcap,
    fdv:         parseFloat(pad.fdv) || mcap,
    buys:        parseInt(pad.buys)  || 0,
    sells:       parseInt(pad.sells) || 0,
    txns24h:     (parseInt(pad.buys) || 0) + (parseInt(pad.sells) || 0),
    age:         0,
    launchedAt:  pad.created_at  || Date.now(),
    verified:    false,
    boosted:     false,
    source:      'xeris-launchpad',
    launchProgress: progress,
    sparkline:   [],
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    _raw:        pad,
  };
}

// ── NORMALIZE SWAP CONTRACT → SCREENER PAIR FORMAT ───────────────────────────
function normalizeSwap(contract, index) {
  const state = contract.state || contract;
  const symA  = state.token_a  || 'TOKEN';
  const symB  = state.token_b  || 'XRS';
  const sym   = symA === 'xrs_native' ? symB : symA;

  const reserveA  = parseFloat(state.reserve_a  || state.amount_a) || 0;
  const reserveB  = parseFloat(state.reserve_b  || state.amount_b) || 0;
  const LAMPORTS  = 1_000_000_000;

  // Price = reserveB (XRS) / reserveA (token), both in base units
  const price = reserveA > 0 ? (reserveB / reserveA) : 0;
  const liq   = (reserveB / LAMPORTS) * 2;  // both sides in XRS
  const vol24 = parseFloat(state.volume_24h) || 0;

  return {
    id:          contract.contract_id || contract.id,
    rank:        index + 1,
    mint:        contract.contract_id || contract.id,
    tokenAddress: state.token_a || '',
    symbol:      sym,
    name:        state.name || `${sym}/XRS Pool`,
    color:       tokenColor(sym),
    quote:       'XRS',
    dex:         'XerisSwap',
    chain:       'xeris',
    url:         `http://explorer.xerisweb.com`,
    price,
    priceUsd:    price,
    change1h:    parseFloat(state.change_1h)  || 0,
    change6h:    parseFloat(state.change_6h)  || 0,
    change24h:   parseFloat(state.change_24h) || 0,
    volume24h:   vol24,
    liquidity:   liq,
    marketCap:   0,
    fdv:         0,
    buys:        parseInt(state.buys)  || 0,
    sells:       parseInt(state.sells) || 0,
    txns24h:     (parseInt(state.buys) || 0) + (parseInt(state.sells) || 0),
    age:         0,
    launchedAt:  contract.created_at || Date.now(),
    verified:    true,
    boosted:     false,
    source:      'xeris-swap',
    sparkline:   [],
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    _raw:        contract,
  };
}

// ── NORMALIZE TOKEN REGISTRY ENTRY ───────────────────────────────────────────
// For tokens that exist on chain but don't have a swap pool yet
function normalizeToken(token, index) {
  const sym = token.symbol || '???';
  return {
    id:          token.token_id || token.id || sym,
    rank:        index + 1,
    mint:        token.token_id || token.id || sym,
    tokenAddress: token.token_id || '',
    symbol:      sym,
    name:        token.name || sym,
    color:       tokenColor(sym),
    quote:       'XRS',
    dex:         'XerisChain',
    chain:       'xeris',
    url:         `http://explorer.xerisweb.com`,
    price:       0,
    priceUsd:    0,
    change1h: 0, change6h: 0, change24h: 0,
    volume24h:   0,
    liquidity:   0,
    marketCap:   parseFloat(token.market_cap) || 0,
    fdv:         parseFloat(token.fdv) || 0,
    buys: 0, sells: 0, txns24h: 0,
    age:         0,
    launchedAt:  token.created_at || Date.now(),
    verified:    token.verified || false,
    boosted:     false,
    source:      'xeris-registry',
    supply:      parseFloat(token.max_supply) || 0,
    decimals:    token.decimals || 9,
    sparkline:   [],
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    _raw:        token,
  };
}

// ── MAIN FETCH: ALL XERIS PAIRS ───────────────────────────────────────────────
// Combines: launchpad tokens + swap pools + registered tokens
async function fetchAllXerisPairs() {
  const results  = [];
  const seenIds  = new Set();

  const add = (pair) => {
    if (!pair?.id || seenIds.has(pair.id)) return;
    seenIds.add(pair.id);
    results.push(pair);
  };

  // 1. Launchpad bonding curves (highest priority — have live prices)
  try {
    const pads = await getLaunchpads();
    pads.forEach((p, i) => add(normalizeLaunchpad(p, i)));
    if (pads.length) console.log(`[XerisRPC] Launchpad: ${pads.length} curves`);
  } catch (e) {
    console.error('[XerisRPC] Launchpad fetch failed:', e.message);
  }

  // 2. Swap pool contracts (XerisSwap AMM)
  try {
    const swaps = await getSwapContracts();
    swaps.forEach((s, i) => add(normalizeSwap(s, results.length + i)));
    if (swaps.length) console.log(`[XerisRPC] Swap pools: ${swaps.length}`);
  } catch (e) {
    console.error('[XerisRPC] Swap fetch failed:', e.message);
  }

  // 3. All registered tokens (fill in tokens not yet in a pool)
  try {
    const tokens = await getRegisteredTokens();
    tokens.forEach((t, i) => add(normalizeToken(t, results.length + i)));
    if (tokens.length) console.log(`[XerisRPC] Token registry: ${tokens.length} tokens`);
  } catch (e) {
    console.error('[XerisRPC] Token registry failed:', e.message);
  }

  console.log(`[XerisRPC] Total Xeris pairs: ${results.length}`);
  return results;
}

// ── SUBMIT TRANSACTION ────────────────────────────────────────────────────────
// POST /submit with { tx_base64: "..." }
async function submitTransaction(txBase64) {
  try {
    return await rpcPOST('/submit', { tx_base64: txBase64 });
  } catch (err) {
    console.error('[XerisRPC] submitTransaction:', err.message);
    throw err;
  }
}

// ── AIRDROP (TESTNET FAUCET) ──────────────────────────────────────────────────
// GET /airdrop/{address}/{amount_lamports}
async function requestAirdrop(address, xrsAmount = 10) {
  const lamports = Math.floor(xrsAmount * 1_000_000_000);
  try {
    return await rpcGET(`/airdrop/${address}/${lamports}`);
  } catch (err) {
    console.error('[XerisRPC] airdrop:', err.message);
    throw err;
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  // Core
  healthCheck,
  fetchAllXerisPairs,
  getNetworkStats,
  getNetworkEconomics,
  // Tokens
  getRegisteredTokens,
  getBalance,
  getLatestBlockhash,
  // DEX
  getLaunchpads,
  getLaunchpadQuote,
  getSwapContracts,
  // Chain data
  getRecentBlocks,
  getRecentTransactions,
  // Tx
  submitTransaction,
  requestAirdrop,
  // Normalize helpers (used by store)
  normalizeLaunchpad,
  normalizeSwap,
  normalizeToken,
  // Config
  NODE_HOST,
  RPC_PORT,
  EXPLORER_PORT,
};
