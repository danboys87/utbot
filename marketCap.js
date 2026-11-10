/**
 * Market Cap Universe — daftar top N koin berdasarkan market cap (CoinGecko, gratis tanpa API key)
 *
 * - Stablecoin dibuang (kategori "stablecoins" CoinGecko + blacklist di user-config.json)
 * - Hasil di-cache 6 jam (memori + logs/marketcap-cache.json) → ±2 panggilan API per 6 jam
 * - Jika CoinGecko gagal: pakai cache lama; kalau tidak ada sama sekali → return null
 *   (screener otomatis fallback ke mode volume)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'logs', 'marketcap-cache.json');
const TTL_MS     = 6 * 60 * 60 * 1000;
const API        = 'https://api.coingecko.com/api/v3/coins/markets';

let _mem = null;   // { at, coins: [{ id, symbol }], stableIds: [] }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) { lastErr = new Error('rate limit (429)'); await sleep(15000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(2000); }
  }
  throw lastErr;
}

function loadFileCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(j?.coins) && j.coins.length) return j;
    }
  } catch {}
  return null;
}

function saveFileCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (e) { log('marketcap_warn', `Gagal simpan cache: ${e.message}`); }
}

async function refresh() {
  // 250 koin teratas menurut market cap
  const top = await getJson(`${API}?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`);
  if (!Array.isArray(top) || !top.length) throw new Error('respons market cap kosong');

  // daftar stablecoin (gagal pun tidak fatal — blacklist tetap berlaku di screener)
  let stableIds = [];
  try {
    await sleep(1500);
    const st = await getJson(`${API}?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=250&page=1&sparkline=false`);
    if (Array.isArray(st)) stableIds = st.map(c => c.id);
  } catch (e) {
    log('marketcap_warn', `Daftar stablecoin gagal diambil (${e.message}) — hanya blacklist yang dipakai`);
  }

  const data = {
    at:        Date.now(),
    coins:     top.map(c => ({ id: c.id, symbol: String(c.symbol || '').toUpperCase() })),
    stableIds,
  };
  _mem = data;
  saveFileCache(data);
  log('marketcap', `✅ Market cap diperbarui: ${data.coins.length} koin, ${stableIds.length} stablecoin dikenali`);
}

async function ensure() {
  if (!_mem) _mem = loadFileCache();
  if (_mem && Date.now() - _mem.at < TTL_MS) return true;
  try {
    await refresh();
    return true;
  } catch (e) {
    if (_mem) {
      log('marketcap_warn', `Gagal update market cap (${e.message}) — pakai cache lama (${Math.round((Date.now() - _mem.at) / 3600000)} jam)`);
      return true;
    }
    log('marketcap_warn', `Gagal ambil market cap (${e.message}) dan tidak ada cache`);
    return false;
  }
}

/**
 * @param {number} n      jumlah koin (setelah stablecoin dibuang)
 * @param {string} quote  quote asset di Bitget (default USDT)
 * @returns {Promise<Map<string, number> | null>}  symbol Bitget (mis. 'SOLUSDT') → peringkat 1..n
 */
export async function getTopMarketCap(n = 100, quote = 'USDT') {
  if (!(await ensure())) return null;

  const stable = new Set(_mem.stableIds);
  const seen   = new Set();
  const out    = new Map();

  for (const c of _mem.coins) {
    if (out.size >= n) break;
    if (stable.has(c.id)) continue;           // buang stablecoin
    if (!c.symbol || seen.has(c.symbol)) continue;   // ticker kembar → ambil yang market cap-nya lebih besar
    seen.add(c.symbol);
    out.set(`${c.symbol}${quote}`, out.size + 1);
  }
  return out;
}
