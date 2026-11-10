import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'user-config.json');

function load() {
  const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (process.env.BUDGET)   base.trading.budgetPerTrade       = parseFloat(process.env.BUDGET);
  if (process.env.TP)       base.management.takeProfitPct     = parseFloat(process.env.TP);
  if (process.env.SL)       base.management.stopLossPct       = -Math.abs(parseFloat(process.env.SL));
  if (process.env.MAX_POS)  base.trading.maxOpenPositions     = parseInt(process.env.MAX_POS);
  if (process.env.GAS)      base.trading.gasReserve           = parseFloat(process.env.GAS);
  if (process.env.TRAIL_PCT)     base.management.trailingStop.trailPct           = parseFloat(process.env.TRAIL_PCT);
  if (process.env.TRAIL_ACTIVATE) base.management.trailingStop.activateAtProfitPct = parseFloat(process.env.TRAIL_ACTIVATE);

  return base;
}

export let config = load();

// ── Timeframe UT Bot ──────────────────────────────────────────────────────────
// '4h'   → candle 4 jam
// '1day' → candle harian UTC (Bitget '1Dutc' = sama dengan TradingView, close 00:00 UTC / 07:00 WIB)
const TF_MAP = {
  '4h':   { api: '4h',    label: '4H', periodMs: 4 * 3600000, minutes: 240  },
  '1day': { api: '1Dutc', label: '1D', periodMs: 86400000,    minutes: 1440 },
};

export function getUTBotTF() {
  const raw = String(config.screening?.utbot?.timeframe ?? '4h').toLowerCase();
  const key = ['1d', '1day', 'd', 'daily'].includes(raw) ? '1day' : '4h';
  return { key, ...TF_MAP[key] };
}

export function saveConfig(updates) {
  const merged = deepMerge(load(), updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  config = merged;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
