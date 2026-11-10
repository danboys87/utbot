/**
 * Debug UT Bot — verifikasi sinyal screener, candle per candle (ikut timeframe config: 4H / 1D)
 *
 * Cara pakai:
 *   node debugUTBot.js SYMBOL [candleLimit] [keyValue] [atrPeriod] [showLastN] [--tf=1d|4h]
 *
 * Contoh:
 *   node debugUTBot.js BTCUSDT                 # timeframe & parameter dari user-config.json
 *   node debugUTBot.js BTCUSDT --tf=1d         # paksa 1D
 *   node debugUTBot.js SOLUSDT 300 2 10 40 --tf=4h
 *
 * Yang dicek:
 *   1. Tabel close / trailing stop / ATR / sinyal per candle (cocokkan dengan UT Bot di TradingView)
 *   2. Hasil fungsi PRODUKSI calcUTBot() (yang dipakai screener) harus sama dengan tabel
 *   3. Filter BUY di config (EMA / ADX / maxRisk) lolos atau tidak
 *   4. Kesimpulan: apakah screener akan meloloskan BUY pada candle terakhir
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import { getCandles }                           from './bitget.js';
import { calcATR, calcUTBot, calcEMA, calcADX } from './indicators.js';
import { config, getUTBotTF }                   from './config.js';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.slice(2).split('='); return [k, v ?? true];
}));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

const symbol = args[0]?.toUpperCase();
if (!symbol) {
  console.log('\n❌ Format: node debugUTBot.js SYMBOL [candleLimit] [keyValue] [atrPeriod] [showLastN] [--tf=1d|4h]');
  console.log('   Contoh : node debugUTBot.js BTCUSDT --tf=1d\n');
  process.exit(1);
}

const U           = config.screening?.utbot ?? {};
const candleLimit = parseInt(args[1] || '300');
const keyValue    = parseFloat(args[2] || U.keyValue  || 2);
const atrPeriod   = parseInt(args[3] || U.atrPeriod   || 10);
const showLastN   = parseInt(args[4] || '30');

// timeframe: flag --tf menang, kalau tidak pakai config
const TF_DEF = { '4h': { api: '4h', label: '4H', periodMs: 4 * 3600000 }, '1d': { api: '1Dutc', label: '1D', periodMs: 86400000 } };
let tf = getUTBotTF();
if (flags.tf) {
  const k = String(flags.tf).toLowerCase() === '4h' ? '4h' : '1d';
  tf = TF_DEF[k];
}

const fmtUTC = ms => new Date(parseInt(ms)).toISOString().replace('T', ' ').slice(0, 16);
const fmtWIB = ms => new Date(parseInt(ms) + 7 * 3600000).toISOString().replace('T', ' ').slice(5, 16);

async function main() {
  console.log(`\n═══ Debug UT Bot — ${symbol} [${tf.label}] ═══`);
  console.log(`candleLimit=${candleLimit} keyValue=${keyValue} atrPeriod=${atrPeriod} | granularity Bitget: ${tf.api}\n`);

  const raw = await getCandles(symbol, tf.api, candleLimit);
  if (!Array.isArray(raw) || raw.length < atrPeriod + 10) { console.log('❌ Data candle tidak cukup / kosong.'); process.exit(1); }

  // candle closed: waktu buka + periode <= sekarang (sama persis dengan screenerUTBot.js)
  const now    = Date.now();
  const closed = raw.filter(c => parseInt(c[0]) + tf.periodMs <= now).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  console.log(`Candle diterima: ${raw.length} | closed dipakai: ${closed.length}`);
  console.log(`Range  : ${fmtUTC(closed[0][0])} → ${fmtUTC(closed[closed.length - 1][0])} (UTC)`);
  console.log(`Candle terakhir yang dinilai screener: buka ${fmtUTC(closed[closed.length - 1][0])} UTC\n`);

  const highs  = closed.map(c => parseFloat(c[2]));
  const lows   = closed.map(c => parseFloat(c[3]));
  const closes = closed.map(c => parseFloat(c[4]));
  const times  = closed.map(c => c[0]);

  // ── 1. Hitung trailing stop per candle ──
  const atrArr = calcATR(highs, lows, closes, atrPeriod);
  if (!atrArr) { console.log('❌ ATR gagal dihitung.'); process.exit(1); }
  const startIdx = atrArr.findIndex(v => v !== null);
  const stops   = new Array(closes.length).fill(null);
  const signals = new Array(closes.length).fill(null);
  stops[startIdx] = closes[startIdx] - atrArr[startIdx] * keyValue;

  for (let i = startIdx + 1; i < closes.length; i++) {
    const atr = atrArr[i];
    if (!atr) { stops[i] = stops[i - 1]; continue; }
    const nLoss = atr * keyValue, close = closes[i], prevClose = closes[i - 1];
    const prevStop = stops[i - 1] ?? (close - nLoss);

    if (close > prevStop && prevClose > prevStop)      stops[i] = Math.max(prevStop, close - nLoss);
    else if (close < prevStop && prevClose < prevStop) stops[i] = Math.min(prevStop, close + nLoss);
    else                                                stops[i] = close > prevStop ? close - nLoss : close + nLoss;

    if (prevClose <= prevStop && close > stops[i]) signals[i] = 'BUY';
    if (prevClose >= prevStop && close < stops[i]) signals[i] = 'SELL';
  }

  console.log('Waktu (UTC)       WIB          Close          TrailingStop   ATR            Posisi   Sinyal');
  console.log('─'.repeat(100));
  const from = Math.max(startIdx, closes.length - showLastN);
  for (let i = from; i < closes.length; i++) {
    const side = closes[i] > stops[i] ? 'di atas ' : 'di bawah';
    const sig  = signals[i] === 'BUY' ? '🟢 BUY' : signals[i] === 'SELL' ? '🔴 SELL' : '';
    console.log(`${fmtUTC(times[i]).padEnd(17)} ${fmtWIB(times[i]).padEnd(12)} ${closes[i].toFixed(6).padEnd(14)} ${stops[i].toFixed(6).padEnd(14)} ${(atrArr[i] ?? 0).toFixed(6).padEnd(14)} ${side} ${sig}`);
  }

  // riwayat sinyal terakhir (untuk dicocokkan dengan panah di TradingView)
  const hist = [];
  for (let i = closes.length - 1; i >= startIdx && hist.length < 5; i--) if (signals[i]) hist.push(`${signals[i]} @ ${fmtUTC(times[i])} UTC (close ${closes[i]})`);
  console.log(`\n5 sinyal terakhir: ${hist.length ? '\n  ' + hist.join('\n  ') : '—'}`);

  // ── 2. Bandingkan dengan fungsi PRODUKSI (yang dipakai screener) ──
  const last = closes.length - 1;
  const prod = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
  const tblSig = signals[last] ?? null, prodSig = prod?.signal ?? null;
  const stopOk = prod && Math.abs(prod.trailingStop - stops[last]) < 1e-9 * Math.max(1, Math.abs(stops[last]));
  console.log('\n── Cek konsistensi dengan screener ──');
  console.log(`  Tabel ini      : sinyal=${tblSig ?? '—'} stop=${stops[last].toFixed(6)}`);
  console.log(`  calcUTBot()    : sinyal=${prodSig ?? '—'} stop=${prod ? prod.trailingStop.toFixed(6) : '—'}`);
  console.log(`  ${tblSig === prodSig && stopOk ? '✅ Konsisten' : '❌ BEDA — ada bug di indicators.js / screener, kabari saya'}`);

  // ── 3. Filter BUY dari config ──
  const f = U.filters ?? {};
  const close = closes[last];
  const checks = [];
  if (f.maxRisk?.enabled && prod) {
    const sl = prod.trailingStop * (1 - (config.management?.slBuffer ?? 0.005));
    const risk = (close - sl) / close * 100, max = f.maxRisk.maxPct ?? 8;
    checks.push({ name: `Risiko SL ≤ ${max}%`, ok: risk <= max, info: `risiko ${risk.toFixed(1)}%` });
  }
  if (f.adx?.enabled) {
    const a = calcADX(highs, lows, closes, f.adx.period ?? 14);
    checks.push({ name: `ADX ≥ ${f.adx.min ?? 20}`, ok: !!a && a.adx >= (f.adx.min ?? 20), info: a ? `ADX ${a.adx.toFixed(1)}` : 'data kurang' });
  }
  if (f.ema?.enabled) {
    const p = f.ema.period ?? 50, e = calcEMA(closes, p);
    checks.push({ name: `Close > EMA${p}`, ok: e !== null && close > e, info: e !== null ? `close ${close} vs EMA${p} ${e.toFixed(6)}` : 'data kurang' });
  }
  console.log('\n── Filter BUY (user-config.json) ──');
  if (!checks.length) console.log('  (tidak ada filter aktif)');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '⛔'} ${c.name} — ${c.info}`);

  // ── 4. Kesimpulan ──
  const filtersOk = checks.every(c => c.ok);
  console.log('\n── Kesimpulan ──');
  if (prodSig === 'BUY')       console.log(filtersOk ? '  🟢 Screener akan MELOLOSKAN sinyal BUY ini.' : '  🟡 Ada sinyal BUY tetapi DITOLAK filter (lihat ⛔ di atas).');
  else if (prodSig === 'SELL') console.log('  🔴 Sinyal SELL pada candle terakhir (dipakai untuk exit posisi terbuka).');
  else                         console.log('  ⚪ Tidak ada sinyal pada candle terakhir. Screener hanya melihat candle TERAKHIR yang closed.');
  console.log(`  Trailing stop saat ini: ${stops[last].toFixed(6)} | Close: ${close} | Jarak: ${((close - stops[last]) / close * 100).toFixed(1)}%`);
  console.log('');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
