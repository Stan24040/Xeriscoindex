// src/adapters/xeris-rpc.js
// ─────────────────────────────────────────────────────────────────────────────
// XERIS NATIVE CHAIN ADAPTER — ACTIVATE WHEN MAINNET LAUNCHES
//
// The Xeris blockchain uses a Triple Consensus model (PoW + PoS + PoH).
// Architecture is similar to Solana (PoH-based), so we use @solana/web3.js
// compatible patterns.  Swap the RPC_URL when Zachary publishes public nodes.
//
// To activate:
//   1. Set XERIS_RPC_URL in Railway environment variables
//   2. Set USE_XERIS_RPC=true in Railway environment variables
//   3. Deploy — XeriscoIndex will auto-switch from DexScreener to native data
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── CONFIG ────────────────────────────────────────────────────────────────────
// Update these when Xeris publishes their public endpoints
const XERIS_ENDPOINTS = {
  // Primary RPC — replace with real URL from Xeris team
  rpc:       process.env.XERIS_RPC_URL      || 'https://rpc.xeris.network',
  // WebSocket for live block/trade events
  ws:        process.env.XERIS_WS_URL       || 'wss://rpc.xeris.network',
  // REST API (if Xeris exposes one like Solana's API port)
  api:       process.env.XERIS_API_URL      || 'https://api.xeris.network',
  // XerisSwap DEX program ID (update when deployed)
  dexProgram: process.env.XERIS_DEX_PROGRAM || 'XerisSwap1111111111111111111111111111111111',
};

// ── HTTP HELPER ───────────────────────────────────────────────────────────────
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });

    const url = new URL(XERIS_ENDPOINTS.rpc);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      port:     url.port || 443,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'XeriscoIndex/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

// ── CHAIN DATA ────────────────────────────────────────────────────────────────

// Get latest block info (Solana-compatible JSON-RPC)
async function getLatestBlock() {
  try {
    const slot = await rpcCall('getSlot');
    const block = await rpcCall('getBlock', [slot, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
    }]);
    return block;
  } catch (err) {
    console.error('[XerisRPC] getLatestBlock:', err.message);
    return null;
  }
}

// Get XRS token price from on-chain AMM pools
async function getXRSPrice() {
  try {
    // Query native XRS/USDC pool reserves
    // This uses the getAccountInfo call on the pool state account
    const poolState = await rpcCall('getAccountInfo', [
      process.env.XERIS_XRS_POOL || 'XRS_POOL_ADDRESS_HERE',
      { encoding: 'jsonParsed' }
    ]);
    // Parse AMM reserves to calculate price
    // (exact parsing depends on XerisSwap's on-chain account structure)
    return parsePoolPrice(poolState);
  } catch (err) {
    console.error('[XerisRPC] getXRSPrice:', err.message);
    return null;
  }
}

// Parse AMM pool state → price
// Update this function once XerisSwap publishes their program layout
function parsePoolPrice(poolAccount) {
  if (!poolAccount?.value?.data?.parsed) return null;
  const { tokenAmountA, tokenAmountB } = poolAccount.value.data.parsed.info || {};
  if (!tokenAmountA || !tokenAmountB) return null;
  return parseFloat(tokenAmountB.uiAmount) / parseFloat(tokenAmountA.uiAmount);
}

// Get all token accounts created by the launchpad program
// This is how we discover new tokens without waiting for webhooks
async function getLaunchpadTokens(launchpadProgramId) {
  try {
    const accounts = await rpcCall('getProgramAccounts', [
      launchpadProgramId || process.env.XERIS_LAUNCHPAD_PROGRAM || 'LAUNCHPAD_PROGRAM_ID',
      {
        encoding: 'jsonParsed',
        filters: [
          { dataSize: 165 },  // Token account size — update with actual launchpad account size
        ],
      }
    ]);
    return accounts || [];
  } catch (err) {
    console.error('[XerisRPC] getLaunchpadTokens:', err.message);
    return [];
  }
}

// Get transaction history for a pair (for building sparkline / volume)
async function getPairTransactions(pairAddress, limit = 100) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [
      pairAddress,
      { limit }
    ]);
    return sigs || [];
  } catch (err) {
    console.error('[XerisRPC] getPairTransactions:', err.message);
    return [];
  }
}

// Ping RPC to check if it's live
async function healthCheck() {
  try {
    const health = await rpcCall('getHealth');
    return health === 'ok';
  } catch {
    return false;
  }
}

// ── NETWORK STATS ─────────────────────────────────────────────────────────────
async function getNetworkStats() {
  try {
    const [slot, supply, perfSamples] = await Promise.all([
      rpcCall('getSlot'),
      rpcCall('getSupply'),
      rpcCall('getRecentPerformanceSamples', [5]),
    ]);

    const avgTps = perfSamples?.reduce((s, p) => {
      return s + (p.numTransactions / p.samplePeriodSecs);
    }, 0) / (perfSamples?.length || 1);

    return {
      currentSlot:     slot,
      circulatingSupply: supply?.value?.circulating || 0,
      totalSupply:     supply?.value?.total || 0,
      tps:             Math.round(avgTps || 0),
    };
  } catch (err) {
    console.error('[XerisRPC] getNetworkStats:', err.message);
    return null;
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  healthCheck,
  getLatestBlock,
  getXRSPrice,
  getLaunchpadTokens,
  getPairTransactions,
  getNetworkStats,
  rpcCall,
  XERIS_ENDPOINTS,
};
