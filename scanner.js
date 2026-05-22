import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ENABLE_STOCKS = String(process.env.ENABLE_STOCKS || "true").toLowerCase() === "true";
const ENABLE_COINBASE = String(process.env.ENABLE_COINBASE || "true").toLowerCase() === "true";
const ENABLE_DEXSCREENER = String(process.env.ENABLE_DEXSCREENER || "true").toLowerCase() === "true";

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 90);

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 4);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 300000);
const MIN_COINBASE_VOLUME_24H = Number(process.env.MIN_COINBASE_VOLUME_24H || 1000000);

const MIN_DEX_LIQUIDITY = Number(process.env.MIN_DEX_LIQUIDITY || 75000);
const MAX_DEX_LIQUIDITY = Number(process.env.MAX_DEX_LIQUIDITY || 5000000);
const MIN_DEX_VOLUME_5M = Number(process.env.MIN_DEX_VOLUME_5M || 10000);
const MIN_DEX_TXNS_5M = Number(process.env.MIN_DEX_TXNS_5M || 50);

const EXECUTION_ALERT_SCORE = Number(process.env.EXECUTION_ALERT_SCORE || 80);
const MOMENTUM_SCORE = Number(process.env.MOMENTUM_SCORE || 90);
const PARABOLIC_SCORE = Number(process.env.PARABOLIC_SCORE || 97);

const DEFAULT_COINBASE_WATCHLIST =
  "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD,ADA-USD,LINK-USD,AVAX-USD,SUI-USD,PEPE-USD,WIF-USD,BONK-USD,FET-USD,RENDER-USD,ONDO-USD,ARB-USD,OP-USD,NEAR-USD,INJ-USD,AERO-USD";

const COINBASE_WATCHLIST = (process.env.COINBASE_WATCHLIST || DEFAULT_COINBASE_WATCHLIST)
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const state = new Map();
const alertMemory = new Map();

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false
    });
  } catch (err) {
    console.log("Telegram error:", err.response?.data || err.message);
  }
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function pct(current, previous) {
  return previous ? ((current - previous) / previous) * 100 : 0;
}

function clampScore(score, setup, risk, volumeQuality) {
  if (volumeQuality === "BAD") return Math.min(score, 72);
  if (risk === "High") return Math.min(score, 78);
  if (setup.includes("Discovery")) return Math.min(score, 84);
  if (setup.includes("Consolidation")) return Math.min(score, 90);
  if (setup.includes("Pre-Breakout")) return Math.min(score, 93);
  if (setup.includes("Breakout") || setup.includes("Momentum")) return Math.min(score, 96);
  return Math.min(score, 94);
}

function decimalsFor(asset) {
  if (asset.market === "STOCK") return 2;
  const p = Number(asset.price || 0);
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 8;
}

function fmtMoney(n, decimals = 2) {
  if (!Number.isFinite(n)) return "N/A";
  return `$${n.toFixed(decimals)}`;
}

function fmtVol(n) {
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.round(n)}`;
}

function tier(score, executionScore) {
  if (score >= PARABOLIC_SCORE && executionScore >= 65) return "PARABOLIC WATCH";
  if (score >= MOMENTUM_SCORE && executionScore >= 70) return "MOMENTUM EXECUTION";
  if (score >= EXECUTION_ALERT_SCORE && executionScore >= 65) return "EXECUTION SETUP";
  if (score >= EXECUTION_ALERT_SCORE) return "WATCH ONLY";
  return "NO ALERT";
}

function cooldownPassed(key, score) {
  const prev = alertMemory.get(key);
  if (!prev) return true;

  const expired = Date.now() - prev.time > ALERT_COOLDOWN_MINUTES * 60 * 1000;
  const improved = score >= prev.score + 8;

  return expired || improved;
}

function markAlerted(key, score) {
  alertMemory.set(key, { time: Date.now(), score });
}

function trendCheck(candles) {
  if (!candles || candles.length < 20) {
    return { aligned: false, short: false, medium: false, long: false };
  }

  const closes = candles.map(c => c.close);
  const short = closes.at(-1) > closes.at(-4);
  const medium = closes.at(-1) > closes.at(-12);
  const long = closes.at(-1) > closes.at(-20);

  return { aligned: short && medium && long, short, medium, long };
}

function volumeQualityCheck(vols, priorVols, latestVolume) {
  const recentAvg = avg(vols.slice(0, -1));
  const priorAvg = avg(priorVols);
  const maxVol = Math.max(...vols, 0);
  const nonZero = vols.filter(v => v > 0).length;
  const relVol = Math.min(priorAvg > 0 ? recentAvg / priorAvg : 1, 15);

  const deadVolume = nonZero < Math.floor(vols.length * 0.4) || recentAvg <= 0;
  const oneCandleSpike = maxVol > recentAvg * 8 && latestVolume < maxVol * 0.35;
  const fadingVolume = latestVolume < recentAvg * 0.45 && relVol < 1;
  const weakVolume = relVol < 0.7;

  if (deadVolume || oneCandleSpike || fadingVolume || weakVolume) {
    return {
      quality: "BAD",
      relVol,
      reasons: [
        deadVolume ? "volume is too dead/inconsistent" : null,
        oneCandleSpike ? "volume looks jacked by one spike" : null,
        fadingVolume ? "latest volume is fading hard" : null,
        weakVolume ? "relative volume is weak" : null
      ].filter(Boolean)
    };
  }

  if (relVol >= 1.2 && latestVolume >= recentAvg * 0.9) {
    return { quality: "GOOD", relVol, reasons: ["volume quality looks clean"] };
  }

  return { quality: "OK", relVol, reasons: ["volume acceptable but not elite"] };
}

function buildExecution(asset, analysis) {
  const price = asset.price || analysis.price;
  const support = analysis.support;
  const breakout = analysis.breakout;
  const decimals = decimalsFor(asset);

  let idealLow = null;
  let idealHigh = null;
  let trigger = breakout || null;
  let avoidAbove = null;
  let stop = null;

  if (support && breakout && asset.market !== "DEX") {
    idealLow = support * 1.005;
    idealHigh = breakout * 0.995;
    avoidAbove = breakout * 1.035;
    stop = support * 0.985;
  }

  const extensionPct = breakout && price ? ((price - breakout) / breakout) * 100 : 0;
  const isExtended = extensionPct > 3.5;
  const nearEntry = idealLow && idealHigh && price >= idealLow && price <= idealHigh;
  const belowTrigger = breakout && price < breakout;
  const retestZone = breakout && price >= breakout * 0.995 && price <= breakout * 1.02;

  let executionScore = 50;
  const notes = [];

  if (analysis.volumeQuality === "BAD") {
    executionScore -= 30;
    notes.push("Volume quality is bad; avoid or wait for cleaner confirmation.");
  }

  if (analysis.setup.includes("Pre-Breakout")) {
    executionScore += 20;
    notes.push("Setup is forming before the breakout candle.");
  }

  if (nearEntry) {
    executionScore += 18;
    notes.push("Current price is inside ideal entry zone.");
  }

  if (belowTrigger) {
    executionScore += 10;
    notes.push("Price is still below breakout trigger, less chase risk.");
  }

  if (retestZone) {
    executionScore += 12;
    notes.push("Price is near breakout/retest zone.");
  }

  if (analysis.relVol >= 1 && analysis.relVol <= 3.5) {
    executionScore += 10;
    notes.push("Volume is active but not extremely overheated.");
  }

  if (analysis.relVol > 5) {
    executionScore -= 8;
    notes.push("RVOL is very hot; spreads/slippage may widen.");
  }

  if (isExtended) {
    executionScore -= 25;
    notes.push("Price is extended above breakout; avoid chasing.");
  }

  if (analysis.risk === "High") {
    executionScore -= 20;
    notes.push("High risk conditions detected.");
  }

  if (asset.market === "DEX") {
    idealLow = null;
    idealHigh = null;
    trigger = null;
    avoidAbove = null;
    stop = null;

    if (asset.liquidity >= 150000) {
      executionScore += 12;
      notes.push("DEX liquidity is stronger, fills may be cleaner.");
    } else if (asset.liquidity < 100000) {
      executionScore -= 15;
      notes.push("DEX liquidity is thin; slippage risk is high.");
    }

    notes.push("DEX entry zones require chart confirmation; do not rely on exact support/breakout here.");
  }

  executionScore = Math.max(0, Math.min(100, executionScore));

  let tradeState = "WATCH";
  if (analysis.setup.includes("Pre-Breakout")) tradeState = "PRE-BREAKOUT";
  if (analysis.setup.includes("Breakout") || analysis.setup.includes("Momentum")) tradeState = "BREAKOUT";
  if (isExtended) tradeState = "EXTENDED / WAIT";
  if (analysis.volumeQuality === "BAD") tradeState = "BAD VOLUME / WAIT";
  if (analysis.risk === "High") tradeState = "HIGH RISK / WAIT";

  let executionQuality = "MODERATE";
  if (executionScore >= 75) executionQuality = "GOOD";
  if (executionScore < 55) executionQuality = "POOR";

  return {
    executionScore,
    executionQuality,
    tradeState,
    idealLow,
    idealHigh,
    trigger,
    avoidAbove,
    stop,
    isExtended,
    extensionPct,
    notes,
    formatted: {
      idealEntry: idealLow && idealHigh ? `${fmtMoney(idealLow, decimals)} - ${fmtMoney(idealHigh, decimals)}` : "N/A",
      trigger: trigger ? fmtMoney(trigger, decimals) : "N/A",
      avoidAbove: avoidAbove ? fmtMoney(avoidAbove, decimals) : "N/A",
      stop: stop ? fmtMoney(stop, decimals) : "N/A"
    }
  };
}

function shouldSendAlert(asset, analysis, execution, key) {
  if (!analysis) return { send: false, block: "Alert BLOCKED: no analysis" };
  if (analysis.blockReason) return { send: false, block: analysis.blockReason };
  if (analysis.volumeQuality === "BAD") return { send: false, block: "Alert BLOCKED: bad/low/jacked volume" };
  if (!cooldownPassed(key, analysis.score)) return { send: false, block: "Alert BLOCKED: cooldown active" };

  if (analysis.score >= MOMENTUM_SCORE && execution.executionScore >= 60) return { send: true };
  if (analysis.score >= EXECUTION_ALERT_SCORE && execution.executionScore >= 65) return { send: true };

  return { send: false, block: "Alert BLOCKED: execution quality or score too low" };
}

async function getYahooStockDiscovery() {
  try {
    const url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=75";

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const quotes = data.finance?.result?.[0]?.quotes || [];

    return quotes
      .map(q => {
        const pre = q.preMarketChangePercent || 0;
        const reg = q.regularMarketChangePercent || 0;
        const move = Math.abs(pre) > Math.abs(reg) ? pre : reg;
        const volume = q.preMarketVolume || q.regularMarketVolume || 0;

        return {
          market: "STOCK",
          type: "stock",
          symbol: q.symbol,
          display: q.symbol,
          price: q.regularMarketPrice || q.preMarketPrice || 0,
          changePct: move,
          volume,
          premarket: Math.abs(pre) > 0,
          marketCap: q.marketCap || null,
          floatShares: q.sharesOutstanding || null,
          url: `https://finance.yahoo.com/quote/${q.symbol}`
        };
      })
      .filter(x => x.price > 1 && x.changePct >= MIN_STOCK_GAIN && x.volume >= MIN_STOCK_VOLUME)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 40);
  } catch (err) {
    console.log("STOCK: Yahoo discovery error:", err.message);
    return [];
  }
}

async function getYahooCandles(symbol, interval = "5m") {
  try {
    const range = interval === "1m" ? "1d" : "5d";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const result = data.chart?.result?.[0];
    if (!result) return null;

    const q = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];

    return ts
      .map((time, i) => ({
        time,
        open: q.open?.[i],
        high: q.high?.[i],
        low: q.low?.[i],
        close: q.close?.[i],
        volume: q.volume?.[i] || 0
      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      );
  } catch (err) {
    console.log(`STOCK: Yahoo candle error ${symbol} ${interval}:`, err.message);
    return null;
  }
}

function analyzeCandleMarket(asset, candles5m, candles1m = null, candles15m = null) {
  if (!candles5m || candles5m.length < 50) {
    return { score: 0, setup: "No Data", blockReason: "Alert BLOCKED: score below threshold" };
  }

  const recent = candles5m.slice(-24);
  const prior = candles5m.slice(-48, -24);
  const last = recent.at(-1);
  const prev = recent.at(-2);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const vols = recent.map(c => c.volume || 0);
  const priorVols = prior.map(c => c.volume || 0);

  const vq = volumeQualityCheck(vols, priorVols, last.volume || 0);

  const price = last.close;
  asset.price = price;

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = Math.max(...prior.map(c => c.high));
  const support = recentLow;
  const breakout = Math.max(priorHigh, recentHigh);

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;
  const distanceToBreakoutPct = breakout ? ((breakout - price) / breakout) * 100 : 999;

  const pullbackHeld = price > support * 1.025;
  const higherLow = lows.at(-1) > lows.at(-8);
  const tightening = rangePct < 7.5;
  const nearBreakout = distanceToBreakoutPct >= 0 && distanceToBreakoutPct <= 3;
  const pressureBuilding = vq.relVol >= 1.0 || last.volume > avg(vols.slice(0, -1)) * 1.15;

  const breakoutCandle = price > breakout * 1.002;
  const volumeReturning = last.volume > avg(vols.slice(0, -1)) * 1.35;
  const noRejection = last.close > last.open && last.close > (last.high + last.low) / 2;

  const retestHeld = prev && prev.close >= breakout * 0.985 && last.close >= breakout * 0.995;

  const trend5m = trendCheck(candles5m);
  const trend1m = trendCheck(candles1m);
  const trend15m = trendCheck(candles15m);

  const multiTimeframe =
    trend5m.aligned &&
    (!candles1m || trend1m.short) &&
    (!candles15m || trend15m.medium || trend15m.long);

  const lowFloat = asset.market === "STOCK" && asset.floatShares && asset.floatShares < 20_000_000;
  const extended = asset.changePct > 35;
  const wickRisk = (last.high - last.close) > (last.high - last.low) * 0.45;
  const exhaustionRisk = extended || wickRisk || rangePct > 14;

  let score = 0;
  const reasons = [...vq.reasons];

  if (asset.premarket) { score += 8; reasons.push("premarket mover"); }
  if (asset.changePct >= 3) { score += 10; reasons.push("strong move"); }
  if (asset.changePct >= 8) { score += 10; reasons.push("major momentum move"); }
  if (vq.relVol >= 1.0) { score += 8; reasons.push("volume activity starting"); }
  if (vq.relVol >= 1.5) { score += 10; reasons.push("relative volume expanding"); }
  if (vq.relVol >= 2.5) { score += 10; reasons.push("strong relative volume"); }
  if (pullbackHeld) { score += 10; reasons.push("pullback held support"); }
  if (higherLow) { score += 10; reasons.push("higher low forming"); }
  if (tightening) { score += 10; reasons.push("tightening under resistance"); }
  if (nearBreakout) { score += 14; reasons.push("price near breakout trigger"); }
  if (pressureBuilding) { score += 10; reasons.push("pressure building before breakout"); }
  if (breakoutCandle) { score += 12; reasons.push("breakout candle"); }
  if (volumeReturning) { score += 12; reasons.push("volume returning"); }
  if (retestHeld) { score += 10; reasons.push("breakout/retest holding"); }
  if (noRejection) { score += 8; reasons.push("no instant rejection"); }
  if (multiTimeframe) { score += 12; reasons.push("multi-timeframe trend alignment"); }
  if (lowFloat) { score += 8; reasons.push("low float squeeze potential"); }
  if (exhaustionRisk) { score -= 18; reasons.push("warning: exhaustion/rejection risk"); }
  if (vq.quality === "BAD") { score -= 25; reasons.push("bad volume quality blocks clean execution"); }

  const consolidation = pullbackHeld && higherLow && tightening;
  const preBreakout = consolidation && nearBreakout && pressureBuilding && !breakoutCandle && !exhaustionRisk;
  const confirmedBreakout = consolidation && breakoutCandle && noRejection && (volumeReturning || vq.relVol >= 1);

  const setup = confirmedBreakout
    ? "Breakout Execution"
    : preBreakout
      ? "Pre-Breakout Execution"
      : consolidation
        ? "Consolidation Execution Watch"
        : `${asset.market} Discovery Watch`;

  const risk = exhaustionRisk ? "High" : vq.quality === "BAD" ? "High" : lowFloat || asset.changePct > 20 ? "Medium-High" : "Medium";
  const capped = clampScore(Math.max(0, score), setup, risk, vq.quality);

  return {
    score: capped,
    setup,
    move: asset.changePct,
    relVol: vq.relVol,
    volume: asset.volume,
    price,
    support,
    breakout,
    risk,
    volumeQuality: vq.quality,
    reasons
  };
}

async function scanStocks() {
  if (!ENABLE_STOCKS) {
    console.log("STOCK: disabled");
    return [];
  }

  const assets = await getYahooStockDiscovery();
  const results = [];

  for (const asset of assets) {
    try {
      const c5 = await getYahooCandles(asset.symbol, "5m");
      const c1 = await getYahooCandles(asset.symbol, "1m");
      const c15 = await getYahooCandles(asset.symbol, "15m");
      const analysis = analyzeCandleMarket(asset, c5, c1, c15);
      const execution = buildExecution(asset, analysis);
      const key = `STOCK:${asset.symbol}`;

      state.set(key, { asset, analysis, execution, updated: new Date().toISOString() });

      console.log(`STOCK: ${asset.symbol} | ${analysis.setup} | Setup ${analysis.score} | Exec ${execution.executionScore} | Volume ${analysis.volumeQuality} | State ${execution.tradeState}`);

      await maybeAlert(asset, analysis, execution, key);
      results.push({ asset, analysis, execution });
    } catch (err) {
      console.log(`STOCK: process error ${asset.symbol}:`, err.message);
    }
  }

  return results;
}

async function getCoinbaseCandles(symbol, granularity = 300) {
  try {
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    return data
      .map(c => ({
        time: c[0],
        low: c[1],
        high: c[2],
        open: c[3],
        close: c[4],
        volume: c[5]
      }))
      .sort((a, b) => a.time - b.time);
  } catch (err) {
    console.log(`COINBASE: candle error ${symbol}:`, err.response?.status || err.message);
    return null;
  }
}

async function scanCoinbaseCrypto() {
  if (!ENABLE_COINBASE) {
    console.log("COINBASE: disabled");
    return [];
  }

  const results = [];

  for (const symbol of COINBASE_WATCHLIST) {
    try {
      const candles = await getCoinbaseCandles(symbol, 300);
      if (!candles || candles.length < 60) continue;

      const recent24 = candles.slice(-288);
      const first = recent24[0]?.close;
      const last = candles.at(-1).close;
      const move = pct(last, first);
      const volume24h = recent24.reduce((sum, c) => sum + c.volume * c.close, 0);

      if (volume24h < MIN_COINBASE_VOLUME_24H) continue;

      const asset = {
        market: "COINBASE",
        type: "coinbase",
        symbol,
        display: symbol,
        price: last,
        changePct: move,
        volume: volume24h,
        url: `https://www.coinbase.com/advanced-trade/spot/${symbol}`
      };

      const analysis = analyzeCandleMarket(asset, candles, null, null);
      const execution = buildExecution(asset, analysis);
      const key = `COINBASE:${symbol}`;

      state.set(key, { asset, analysis, execution, updated: new Date().toISOString() });

      console.log(`COINBASE: ${symbol} | ${analysis.setup} | Setup ${analysis.score} | Exec ${execution.executionScore} | Volume ${analysis.volumeQuality} | State ${execution.tradeState}`);

      await maybeAlert(asset, analysis, execution, key);
      results.push({ asset, analysis, execution });
    } catch (err) {
      console.log(`COINBASE: process error ${symbol}:`, err.message);
    }
  }

  return results;
}

async function getDexScreenerPairs() {
  try {
    const { data } = await axios.get("https://api.dexscreener.com/latest/dex/search?q=solana", {
      timeout: 15000
    });
    return Array.isArray(data.pairs) ? data.pairs : [];
  } catch (err) {
    console.log("DEX: DexScreener error:", err.message);
    return [];
  }
}

function analyzeDexPair(pair, asset) {
  const liquidity = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const txns5m = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);
  const buys5m = pair.txns?.m5?.buys || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const change5m = pair.priceChange?.m5 || 0;
  const change1h = pair.priceChange?.h1 || 0;
  const marketCap = pair.marketCap || pair.fdv || 0;

  if (liquidity < MIN_DEX_LIQUIDITY) {
    return { score: 0, setup: "Liquidity Too Low", blockReason: "Alert BLOCKED: liquidity too low" };
  }

  const buyRatio = txns5m ? buys5m / txns5m : 0;
  const pressure = liquidity ? vol5m / liquidity : 0;
  const relVol = Math.min(pressure * 20, 15);

  let score = 0;
  const reasons = [];

  let volumeQuality = "OK";

  if (vol5m < MIN_DEX_VOLUME_5M || txns5m < MIN_DEX_TXNS_5M) {
    volumeQuality = "BAD";
    reasons.push("DEX volume/transactions too low");
  }

  if (vol5m > 0 && txns5m <= 3) {
    volumeQuality = "BAD";
    reasons.push("DEX volume looks unreliable with too few transactions");
  }

  if (liquidity >= 75000) { score += 12; reasons.push("liquidity acceptable for cleaner fills"); }
  if (liquidity >= 150000) { score += 12; reasons.push("stronger DEX liquidity"); }
  if (vol5m >= MIN_DEX_VOLUME_5M) { score += 14; reasons.push("5m volume active"); }
  if (txns5m >= MIN_DEX_TXNS_5M) { score += 14; reasons.push("5m transactions active"); }
  if (change5m >= 2) { score += 10; reasons.push("positive 5m price change"); }
  if (change5m >= 6 || change1h >= 12) { score += 12; reasons.push("strong short-term DEX momentum"); }
  if (buyRatio >= 0.55) { score += 10; reasons.push("buyers leading sellers"); }
  if (marketCap > 0 && marketCap < 20_000_000) { score += 8; reasons.push("early market cap range"); }
  if (pressure >= 0.1) { score += 10; reasons.push("volume/liquidity pressure building"); }

  let risk = "Medium";
  if (liquidity < 100000) risk = "Medium-High";
  if (sells5m > buys5m * 1.4 && txns5m >= 20) {
    score -= 18;
    risk = "High";
    reasons.push("warning: sellers outpacing buyers");
  }
  if (change5m > 30) {
    score -= 12;
    risk = "High";
    reasons.push("warning: parabolic 5m move");
  }
  if (volumeQuality === "BAD") {
    score -= 30;
    risk = "High";
    reasons.push("bad DEX volume quality; avoid execution");
  }

  const setup =
    score >= MOMENTUM_SCORE
      ? "DEX Momentum Execution"
      : score >= EXECUTION_ALERT_SCORE
        ? "DEX Execution Watch"
        : "DEX Discovery Watch";

  return {
    score: clampScore(Math.max(0, score), setup, risk, volumeQuality),
    setup,
    move: Math.max(change5m, change1h),
    relVol,
    volume: vol5m,
    price: asset.price,
    support: null,
    breakout: null,
    risk,
    volumeQuality,
    liquidity,
    vol5m,
    txns5m,
    reasons
  };
}

async function scanDexScreener() {
  if (!ENABLE_DEXSCREENER) {
    console.log("DEX: disabled");
    return [];
  }

  const pairs = await getDexScreenerPairs();
  const results = [];

  for (const pair of pairs.slice(0, 80)) {
    try {
      if (pair.chainId !== "solana") continue;

      const liquidity = pair.liquidity?.usd || 0;
      const vol5m = pair.volume?.m5 || 0;
      const txns5m = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);

      if (liquidity < MIN_DEX_LIQUIDITY) continue;
      if (liquidity > MAX_DEX_LIQUIDITY) continue;
      if (vol5m < MIN_DEX_VOLUME_5M) continue;
      if (txns5m < MIN_DEX_TXNS_5M) continue;

      const base = pair.baseToken?.symbol || "UNKNOWN";
      const quote = pair.quoteToken?.symbol || "SOL";
      const display = `${base}/${quote}`;

      const asset = {
        market: "DEX",
        type: "dex",
        symbol: display,
        display,
        price: Number(pair.priceUsd || 0),
        changePct: Math.max(pair.priceChange?.m5 || 0, pair.priceChange?.h1 || 0),
        volume: vol5m,
        liquidity,
        url: pair.url,
        chainId: pair.chainId,
        dexId: pair.dexId,
        pairAddress: pair.pairAddress,
        marketCap: pair.marketCap || pair.fdv || null
      };

      const analysis = analyzeDexPair(pair, asset);
      const execution = buildExecution(asset, analysis);
      const key = `DEX:${pair.chainId}:${pair.pairAddress}`;

      state.set(key, { asset, analysis, execution, updated: new Date().toISOString() });

      console.log(`DEX: ${display} | ${analysis.setup} | Setup ${analysis.score} | Exec ${execution.executionScore} | Volume ${analysis.volumeQuality} | Liquidity ${fmtVol(liquidity)} | Risk ${analysis.risk}`);

      await maybeAlert(asset, analysis, execution, key);
      results.push({ asset, analysis, execution });
    } catch (err) {
      console.log("DEX: process error:", err.message);
    }
  }

  return results;
}

async function maybeAlert(asset, analysis, execution, key) {
  const decision = shouldSendAlert(asset, analysis, execution, key);

  if (!decision.send) {
    console.log(`${asset.market}: ${asset.display} | ${decision.block}`);
    return;
  }

  markAlerted(key, analysis.score);

  const decimals = decimalsFor(asset);

  await sendTelegram(
`🚨 CARDINAL EXECUTION ENGINE

Ticker/Pair: ${asset.display}
Market: ${asset.market}
Tier: ${tier(analysis.score, execution.executionScore)}
Trade State: ${execution.tradeState}

Setup Score: ${analysis.score}/100
Execution Score: ${execution.executionScore}/100
Execution Quality: ${execution.executionQuality}
Volume Quality: ${analysis.volumeQuality}
Setup: ${analysis.setup}
Risk: ${analysis.risk}

Price: ${fmtMoney(asset.price, decimals)}
Move: ${Number(analysis.move || 0).toFixed(2)}%
RVOL / Pressure: ${analysis.relVol?.toFixed?.(2) || "N/A"}x
Volume: ${fmtVol(analysis.volume)}

Ideal Entry Zone: ${execution.formatted.idealEntry}
Breakout Trigger: ${execution.formatted.trigger}
Avoid Chasing Above: ${execution.formatted.avoidAbove}
Suggested Stop: ${execution.formatted.stop}

Execution Notes:
${execution.notes.map(n => `- ${n}`).join("\n")}

Setup Reasons:
${analysis.reasons.map(r => `- ${r}`).join("\n")}

URL: ${asset.url}

Alerts only. Not financial advice.`
  );
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS EXECUTION ENGINE SCAN STARTING...");

  const results = [];
  if (ENABLE_STOCKS) results.push(...(await scanStocks()));
  if (ENABLE_COINBASE) results.push(...(await scanCoinbaseCrypto()));
  if (ENABLE_DEXSCREENER) results.push(...(await scanDexScreener()));

  console.log(`SCAN COMPLETE | Total tracked this run: ${results.length}`);
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics Execution Engine Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "cardinal_analytics_execution_engine_volume_quality",
    enableStocks: ENABLE_STOCKS,
    enableCoinbase: ENABLE_COINBASE,
    enableDexScreener: ENABLE_DEXSCREENER,
    scanInterval: SCAN_INTERVAL_SECONDS,
    tracked: state.size,
    lastChecked: new Date().toISOString()
  });
});

app.get("/watchlist", (req, res) => {
  const data = [...state.entries()].map(([key, value]) => ({
    key,
    market: value.asset.market,
    symbol: value.asset.display,
    price: value.asset.price,
    setupScore: value.analysis.score,
    executionScore: value.execution.executionScore,
    executionQuality: value.execution.executionQuality,
    volumeQuality: value.analysis.volumeQuality,
    tradeState: value.execution.tradeState,
    setup: value.analysis.setup,
    idealEntry: value.execution.formatted.idealEntry,
    trigger: value.execution.formatted.trigger,
    avoidAbove: value.execution.formatted.avoidAbove,
    stop: value.execution.formatted.stop,
    risk: value.analysis.risk,
    reasons: value.analysis.reasons,
    executionNotes: value.execution.notes,
    url: value.asset.url,
    updated: value.updated
  }));

  res.json(data.sort((a, b) => b.executionScore + b.setupScore - (a.executionScore + a.setupScore)));
});

app.get("/scan", async (req, res) => {
  await scanAll();
  res.json({ ok: true, tracked: state.size });
});

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);
  scanAll();
  setInterval(scanAll, SCAN_INTERVAL_SECONDS * 1000);
});