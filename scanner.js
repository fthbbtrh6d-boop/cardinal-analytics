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
const ENABLE_DEXSCREENER = String(process.env.ENABLE_DEXSCREENER || "false").toLowerCase() === "true";
const ENABLE_IGNITION_SCANNER = String(process.env.ENABLE_IGNITION_SCANNER || "true").toLowerCase() === "true";

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 120);

const WATCHLIST_SCORE = Number(process.env.WATCHLIST_SCORE || 60);
const DISCOVERY_SCORE = Number(process.env.DISCOVERY_SCORE || 70);
const MOMENTUM_SCORE = Number(process.env.MOMENTUM_SCORE || 90);
const PARABOLIC_SCORE = Number(process.env.PARABOLIC_SCORE || 97);
const IGNITION_SCORE = Number(process.env.IGNITION_SCORE || 75);
const IGNITION_ALERT_SCORE = Number(process.env.IGNITION_ALERT_SCORE || 85);
const ALLOW_LOW_RVOL_BREAKOUTS = String(process.env.ALLOW_LOW_RVOL_BREAKOUTS || "true").toLowerCase() === "true";

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 4);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 1000000);
const MIN_LIVE_CANDLE_VOLUME = Number(process.env.MIN_LIVE_CANDLE_VOLUME || 50000);

const MIN_COINBASE_VOLUME_24H = Number(process.env.MIN_COINBASE_VOLUME_24H || 2500000);

const MIN_DEX_LIQUIDITY = Number(process.env.MIN_DEX_LIQUIDITY || 150000);
const MAX_DEX_LIQUIDITY = Number(process.env.MAX_DEX_LIQUIDITY || 5000000);
const MIN_DEX_VOLUME_5M = Number(process.env.MIN_DEX_VOLUME_5M || 25000);
const MIN_DEX_TXNS_5M = Number(process.env.MIN_DEX_TXNS_5M || 75);

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
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

function fmtVol(n) {
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.round(n)}`;
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

function tier(finalScore, ignitionScore) {
  if (finalScore >= PARABOLIC_SCORE) return "🔴 PARABOLIC RISK";
  if (finalScore >= MOMENTUM_SCORE) return "🟢 HIGH CONVICTION";
  if (finalScore >= IGNITION_ALERT_SCORE && ignitionScore >= IGNITION_SCORE) return "🚨 IGNITION";
  if (finalScore >= DISCOVERY_SCORE) return "🟠 DISCOVERY";
  if (finalScore >= WATCHLIST_SCORE) return "🟡 WATCHLIST";
  return "⚪️ HOLD";
}

function polygonUrl(path) {
  return `https://api.polygon.io${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(POLYGON_API_KEY)}`;
}

async function getPolygonSnapshot(category) {
  if (!POLYGON_API_KEY) return null;
  try {
    const url = polygonUrl(`/v3/snapshot/locale/us/markets/stocks/${encodeURIComponent(category)}`);
    const { data } = await axios.get(url, { timeout: 20000 });
    return data?.tickers || [];
  } catch (err) {
    console.log(`STOCK: Polygon snapshot ${category} error:`, err.response?.data || err.message);
    return null;
  }
}

async function getPolygonStockDiscovery() {
  const categories = ["pre-market", "after-hours", "gainers", "mostactive"];
  const discovered = new Map();
  let results = [];

  if (POLYGON_API_KEY) {
    for (const category of categories) {
      const tickers = await getPolygonSnapshot(category);
      if (!tickers) continue;
      for (const item of tickers.slice(0, 60)) {
        const price = item.last?.price || item.day?.c || item.lastTrade?.p || 0;
        const volume = item.day?.v || item.last?.volume || 0;
        if (!price || price < 0.5) continue;
        if (price > 500) continue;
        if (volume < MIN_STOCK_VOLUME / 10) continue;
        if (discovered.has(item.ticker)) continue;

        discovered.set(item.ticker, true);
        results.push({
          market: "STOCK",
          type: "stock",
          symbol: item.ticker,
          display: item.ticker,
          price,
          changePct: item.day?.c ? pct(item.day?.c, item.day?.o) : 0,
          volume,
          premarket: category === "pre-market",
          afterHours: category === "after-hours",
          marketCap: item.day?.marketCap || null,
          floatShares: item.day?.float || null,
          url: `https://finance.yahoo.com/quote/${item.ticker}`
        });
      }
    }
  }

  if (results.length < 20) {
    const yahoo = await getYahooStockDiscovery();
    results = results.concat(yahoo.filter(x => !discovered.has(x.symbol))).slice(0, 60);
  }

  return results.slice(0, 80);
}

function trendCheck(candles) {
  if (!candles || candles.length < 20) return { aligned: false, short: false, medium: false, long: false };
  const closes = candles.map(c => c.close);
  const short = closes.at(-1) > closes.at(-4);
  const medium = closes.at(-1) > closes.at(-12);
  const long = closes.at(-1) > closes.at(-20);
  return { aligned: short && medium && long, short, medium, long };
}

function scoreCap(score, setup, risk, volumeQuality) {
  if (volumeQuality === "BAD") return Math.min(score, 60);
  if (risk === "High") return Math.min(score, 72);
  if (setup.includes("Discovery")) return Math.min(score, 78);
  if (setup.includes("Consolidation")) return Math.min(score, 86);
  if (setup.includes("Pre-Breakout")) return Math.min(score, 90);
  if (setup.includes("Breakout")) return Math.min(score, 94);
  return Math.min(score, 94);
}

function volumeQualityCheck(asset, vols, priorVols, latestVolume) {
  const recentAvg = avg(vols.slice(0, -1));
  const priorAvg = avg(priorVols);
  const maxVol = Math.max(...vols, 0);
  const nonZero = vols.filter(v => v > 0).length;
  const relVol = Math.min(priorAvg > 0 ? recentAvg / priorAvg : 1, 15);

  const hardStockFail =
    asset.market === "STOCK" &&
    (asset.volume < MIN_STOCK_VOLUME || latestVolume < MIN_LIVE_CANDLE_VOLUME);

  const deadVolume = nonZero < Math.floor(vols.length * 0.5) || recentAvg <= 0;
  const oneCandleSpike = recentAvg > 0 && maxVol > recentAvg * 8 && latestVolume < maxVol * 0.35;
  const fadingVolume = recentAvg > 0 && latestVolume < recentAvg * 0.45 && relVol < 1;
  const weakVolume = relVol < 0.85;

  const reasons = [];
  if (hardStockFail) reasons.push("stock volume/live candle volume too low");
  if (deadVolume) reasons.push("volume is too dead/inconsistent");
  if (oneCandleSpike) reasons.push("volume inflated by one spike");
  if (fadingVolume) reasons.push("latest volume is fading hard");
  if (weakVolume) reasons.push("relative volume is weak");
  if (relVol < 1) reasons.push("RVOL under 1.0");

  const bad = hardStockFail || deadVolume || oneCandleSpike || fadingVolume;
  if (bad) {
    return {
      quality: "BAD",
      relVol,
      reasons,
      lowRvolOnly: false
    };
  }

  if (weakVolume) {
    return {
      quality: ALLOW_LOW_RVOL_BREAKOUTS ? "LOW" : "BAD",
      relVol,
      reasons,
      lowRvolOnly: true
    };
  }

  if (relVol >= 1.3 && latestVolume >= recentAvg * 1.1) {
    return { quality: "GOOD", relVol, reasons: ["volume quality is clean"], lowRvolOnly: false };
  }

  return { quality: "OK", relVol, reasons: ["volume is acceptable"], lowRvolOnly: false };
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
    avoidAbove = breakout * 1.025;
    stop = support * 0.985;
  }

  const extensionPct = breakout && price ? ((price - breakout) / breakout) * 100 : 0;
  const isExtended = extensionPct > 2.5;
  const nearEntry = idealLow && idealHigh && price >= idealLow && price <= idealHigh;
  const belowTrigger = breakout && price < breakout;
  const retestZone = breakout && price >= breakout * 0.995 && price <= breakout * 1.015;

  let executionScore = 45;
  const notes = [];

  if (analysis.volumeQuality === "BAD") {
    executionScore -= 40;
    notes.push("Bad volume quality. Do not trade this.");
  }

  if (analysis.setup.includes("Pre-Breakout")) {
    executionScore += 20;
    notes.push("Setup is forming before breakout.");
  }

  if (nearEntry) {
    executionScore += 20;
    notes.push("Price is inside ideal entry zone.");
  }

  if (belowTrigger) {
    executionScore += 12;
    notes.push("Price is below trigger, less chase risk.");
  }

  if (retestZone) {
    executionScore += 12;
    notes.push("Price is near breakout/retest zone.");
  }

  if (analysis.relVol >= 1.2 && analysis.relVol <= 4) {
    executionScore += 12;
    notes.push("Volume is active but not overheated.");
  }

  if (analysis.relVol > 5) {
    executionScore -= 10;
    notes.push("RVOL is very hot; slippage/chase risk higher.");
  }

  if (isExtended) {
    executionScore -= 30;
    notes.push("Price is extended above breakout. Wait for pullback/retest.");
  }

  if (analysis.risk === "High") {
    executionScore -= 30;
    notes.push("High risk conditions. Avoid.");
  }

  if (asset.market === "DEX") {
    idealLow = null;
    idealHigh = null;
    trigger = null;
    avoidAbove = null;
    stop = null;

    if (asset.liquidity >= 200000) {
      executionScore += 12;
      notes.push("DEX liquidity is stronger, fills may be cleaner.");
    } else {
      executionScore -= 20;
      notes.push("DEX liquidity not ideal for clean execution.");
    }

    notes.push("DEX exact entry zones require manual chart confirmation.");
  }

  executionScore = Math.max(0, Math.min(100, executionScore));

  let tradeState = "WATCH";
  if (analysis.setup.includes("Pre-Breakout")) tradeState = "PRE-BREAKOUT";
  if (analysis.setup.includes("Breakout")) tradeState = "BREAKOUT";
  if (isExtended) tradeState = "EXTENDED / WAIT";
  if (analysis.volumeQuality === "BAD") tradeState = "BAD VOLUME / AVOID";
  if (analysis.risk === "High") tradeState = "HIGH RISK / AVOID";

  let executionQuality = "MODERATE";
  if (executionScore >= 75) executionQuality = "GOOD";
  if (executionScore < 60) executionQuality = "POOR";

  return {
    executionScore,
    executionQuality,
    tradeState,
    formatted: {
      idealEntry: idealLow && idealHigh ? `${fmtMoney(idealLow, decimals)} - ${fmtMoney(idealHigh, decimals)}` : "N/A",
      trigger: trigger ? fmtMoney(trigger, decimals) : "N/A",
      avoidAbove: avoidAbove ? fmtMoney(avoidAbove, decimals) : "N/A",
      stop: stop ? fmtMoney(stop, decimals) : "N/A"
    },
    notes
  };
}

function updateStateEntry(key, asset, analysis, execution) {
  const prev = state.get(key) || {};
  state.set(key, {
    asset,
    analysis,
    execution,
    updated: new Date().toISOString(),
    previousPrice: prev.asset?.price,
    previousScore: prev.analysis?.finalScore,
    previousVolume: prev.asset?.volume,
    previousHigh: prev.recentHigh,
    previousLow: prev.recentLow,
    previousTightening: prev.tightRange,
    previousHigherLows: prev.higherLow,
    previousVolumeReturning: prev.volumeReturning,
    previousPressureBuilding: prev.pressureBuilding,
    recentHigh: analysis.recentHigh,
    recentLow: analysis.recentLow,
    tightRange: analysis.tightRange,
    higherLow: analysis.higherLow,
    volumeReturning: analysis.volumeReturning,
    pressureBuilding: analysis.pressureBuilding,
    reclaimHigh: analysis.reclaimHigh
  });
}

function shouldSendAlert(asset, analysis, execution, key) {
  if (!analysis) return { send: false, block: "Alert BLOCKED: no analysis" };
  if (analysis.blockReason) return { send: false, block: analysis.blockReason };
  if (analysis.risk === "High" && analysis.finalScore < PARABOLIC_SCORE) return { send: false, block: "Alert BLOCKED: high risk" };
  if (!cooldownPassed(key, analysis.finalScore)) return { send: false, block: "Alert BLOCKED: cooldown active" };

  const score = analysis.finalScore;
  const ignitionScore = analysis.ignitionScore || 0;

  if (score >= PARABOLIC_SCORE && execution.executionScore >= 65) return { send: true };
  if (score >= MOMENTUM_SCORE && execution.executionScore >= 68) return { send: true };
  if (score >= IGNITION_ALERT_SCORE && ignitionScore >= IGNITION_SCORE && execution.executionScore >= 62) return { send: true };

  return { send: false, block: "Alert BLOCKED: non-ignition/discovery watch only" };
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
      .slice(0, 30);
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

function analyzeMomentumIgnition(asset, candles5m, candles1m = null, candles15m = null, previous = null) {
  if (!candles5m || candles5m.length < 40) {
    return {
      score: 0,
      finalScore: 0,
      setup: "No Data",
      blockReason: "Alert BLOCKED: no candle data",
      discoveryScore: 0,
      structureScore: 0,
      volumeScore: 0,
      ignitionScore: 0,
      riskScore: 0,
      relVol: 0,
      volume: asset.volume,
      price: asset.price || 0,
      support: null,
      breakout: null,
      risk: "High",
      reasons: ["insufficient candle history"],
      recentHigh: null,
      recentLow: null,
      tightRange: false,
      higherLow: false,
      volumeReturning: false,
      pressureBuilding: false,
      reclaimHigh: false
    };
  }

  const recent = candles5m.slice(-24);
  const prior = candles5m.slice(-48, -24);
  const last = recent.at(-1);
  const prev = recent.at(-2);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const vols = recent.map(c => c.volume || 0);
  const priorVols = prior.map(c => c.volume || 0);

  const vq = volumeQualityCheck(asset, vols, priorVols, last.volume || 0);
  const price = last.close;
  asset.price = price;

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = Math.max(...prior.map(c => c.high));
  const support = recentLow;
  const breakout = Math.max(priorHigh, recentHigh);

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;
  const distanceToBreakoutPct = breakout ? ((breakout - price) / breakout) * 100 : 999;

  const higherLow = lows.at(-1) > lows.at(-8);
  const tightRange = rangePct < 6.5;
  const pullbackHeld = price > support * 1.025;
  const nearBreakout = distanceToBreakoutPct >= 0 && distanceToBreakoutPct <= 2.5;
  const breakoutCandle = price > breakout * 1.002;
  const avgVolume = avg(vols.slice(0, -1));
  const volumeReturning = avgVolume > 0 && last.volume >= avgVolume * 1.4;
  const volumeExpansion = avgVolume > 0 && last.volume >= avgVolume * 2;
  const pressureBuilding = last.close >= recentHigh * 0.995 || vq.relVol >= 1.1 || last.volume > avgVolume * 1.2;
  const noRejection = last.close > last.open && last.close > (last.high + last.low) / 2;
  const retestHeld = prev && prev.close >= breakout * 0.985 && last.close >= breakout * 0.995;

  const trend5m = trendCheck(candles5m);
  const trend1m = trendCheck(candles1m);
  const trend15m = trendCheck(candles15m);
  const positiveTrend = trend5m.aligned || trend1m.short || trend15m.medium || trend15m.long;
  const multiTimeframe = trend5m.aligned && (!candles1m || trend1m.short) && (!candles15m || trend15m.medium || trend15m.long);

  const lowFloat = asset.market === "STOCK" && asset.floatShares && asset.floatShares < 20_000_000;
  const smallCapRunner = asset.market === "STOCK" && price >= 0.5 && price <= 25 && (lowFloat || (asset.marketCap && asset.marketCap < 250_000_000));
  const earlyRunner = asset.market === "STOCK" && (asset.premarket || asset.afterHours);
  const extended = asset.changePct > 28 || price > breakout * 1.04;
  const wickRisk = (last.high - last.close) > (last.high - last.low) * 0.42;
  const exhaustionRisk = extended || wickRisk || rangePct > 12;

  const supportHold = pullbackHeld || retestHeld;
  const consolidationAfterSpike = recent.slice(0, 6).some(c => c.volume > avg(vols) * 2.2 && c.close > c.open) && tightRange;
  const isConsolidation = higherLow && tightRange && supportHold;
  const reclaimHigh = price >= priorHigh || (previous && previous.recentHigh && price >= previous.recentHigh);
  const isIgnition = pressureBuilding && (nearBreakout || breakoutCandle || reclaimHigh);
  const isBreakout = breakoutCandle && noRejection && volumeReturning;

  let discoveryScore = 0;
  let structureScore = 0;
  let volumeScore = 0;
  let ignitionScore = 0;
  let riskScore = 0;
  const reasons = [...vq.reasons];

  if (price >= 0.5 && price <= 25) { discoveryScore += 6; reasons.push("ideal runner price range"); }
  if (asset.changePct >= 3) { discoveryScore += 8; reasons.push("power move detected"); }
  if (asset.changePct >= 6) { discoveryScore += 8; reasons.push("momentum is accelerating"); }
  if (positiveTrend) { discoveryScore += 8; reasons.push("trend bias is bullish"); }
  if (lowFloat) { discoveryScore += 10; reasons.push("low float runner profile"); }
  if (smallCapRunner) { discoveryScore += 8; reasons.push("small cap momentum candidate"); }
  if (earlyRunner) { discoveryScore += 8; reasons.push("pre/after-hours strength"); }

  if (supportHold) { structureScore += 16; reasons.push("support is holding"); }
  if (higherLow) { structureScore += 16; reasons.push("higher lows are forming"); }
  if (tightRange) { structureScore += 14; reasons.push("tight compression under resistance"); }
  if (nearBreakout) { structureScore += 12; reasons.push("price is near resistance"); }
  if (reclaimHigh) { structureScore += 10; reasons.push("reclaiming prior highs"); }
  if (breakout > 0 && price < breakout) { structureScore += 6; }
  if (consolidationAfterSpike) { structureScore += 10; reasons.push("consolidation after first spike"); }
  if (multiTimeframe) { structureScore += 10; reasons.push("multi-timeframe trend alignment"); }

  if (vq.quality === "GOOD") { volumeScore += 16; reasons.push("volume is strong and clean"); }
  if (vq.quality === "OK") { volumeScore += 10; reasons.push("volume is acceptable"); }
  if (vq.quality === "LOW") { volumeScore += 6; reasons.push("low RVOL breakout allowed"); }
  if (volumeReturning) { volumeScore += 14; reasons.push("volume is beginning to return"); }
  if (volumeExpansion) { volumeScore += 12; reasons.push("sudden volume expansion"); }
  if (pressureBuilding) { volumeScore += 8; reasons.push("breakout pressure is increasing"); }

  if (pressureBuilding) { ignitionScore += 18; reasons.push("pressure building into move"); }
  if (breakoutCandle) { ignitionScore += 20; reasons.push("early breakout candle seen"); }
  if (volumeReturning) { ignitionScore += 16; reasons.push("volume is returning on rise"); }
  if (retestHeld) { ignitionScore += 10; reasons.push("retest holding support"); }
  if (reclaimHigh) { ignitionScore += 12; reasons.push("reclaiming highs for continuation"); }
  if (consolidationAfterSpike) { ignitionScore += 10; reasons.push("consolidation after first spike"); }
  if (isIgnition) { ignitionScore += 14; }
  if (isBreakout) { ignitionScore += 18; reasons.push("breakout continuation"); }

  if (previous && previous.analysis?.finalScore) {
    const deltaScore = (discoveryScore + structureScore + volumeScore + ignitionScore - riskScore) - previous.analysis.finalScore;
    if (deltaScore >= 6) { ignitionScore += 10; reasons.push("score improving across scans"); }
    if (reclaimHigh && previous.recentHigh && price > previous.recentHigh) { ignitionScore += 12; reasons.push("reclaiming prior scan highs"); }
    if (tightRange && previous.isTightening) { ignitionScore += 8; reasons.push("tightening continues across scans"); }
    if (volumeReturning && previous.volumeReturning) { ignitionScore += 8; reasons.push("volume return is persistent"); }
    if (pressureBuilding && previous.pressureBuilding) { ignitionScore += 8; reasons.push("pressure is building across scans"); }
  }

  if (exhaustionRisk) { riskScore += 24; reasons.push("extended/rejection risk present"); }
  if (!supportHold) { riskScore += 16; reasons.push("support not holding"); }
  if (vq.quality === "BAD") { riskScore += 30; reasons.push("volume quality is poor"); }
  if (asset.market === "DEX" && asset.liquidity < MIN_DEX_LIQUIDITY * 1.2) { riskScore += 12; reasons.push("DEX liquidity is thin"); }

  if (!asset.price || asset.price < 0.5) { riskScore += 12; reasons.push("price is too low for reliable pattern detection"); }

  const rawScore = discoveryScore + structureScore + volumeScore + ignitionScore - riskScore;
  let finalScore = scoreCap(rawScore, isBreakout ? "Breakout Execution" : isIgnition ? "Ignition Execution" : isConsolidation ? "Pre-Breakout Execution" : "Discovery", riskScore > 20 ? "High" : "Medium", vq.quality);
  finalScore = Math.max(0, Math.min(100, finalScore));

  let risk = "Medium";
  if (riskScore >= 30 || exhaustionRisk || vq.quality === "BAD") risk = "High";
  else if (riskScore >= 16 || lowFloat) risk = "Medium-High";

  let setup = "Discovery Watch";
  if (isBreakout) setup = "Breakout Execution";
  else if (isIgnition) setup = "Ignition Setup";
  else if (isConsolidation) setup = "Pre-Breakout Setup";

  return {
    score: finalScore,
    finalScore,
    discoveryScore,
    structureScore,
    volumeScore,
    ignitionScore,
    riskScore,
    setup,
    move: asset.changePct,
    relVol: vq.relVol,
    volume: asset.volume,
    price,
    support,
    breakout,
    risk,
    volumeQuality: vq.quality,
    lowRvolOnly: vq.lowRvolOnly,
    reasons,
    blockReason: null,
    recentHigh,
    recentLow,
    tightRange,
    higherLow,
    volumeReturning,
    pressureBuilding,
    reclaimHigh,
    breakoutCandle,
    priorHigh
  };
}

function analyzeCandleMarket(asset, candles5m, candles1m = null, candles15m = null, previous = null) {
  return analyzeMomentumIgnition(asset, candles5m, candles1m, candles15m, previous);
}

async function scanStocks() {
  if (!ENABLE_STOCKS) {
    console.log("STOCK: disabled");
    return [];
  }

  const assets = await getPolygonStockDiscovery();
  const results = [];

  for (const asset of assets) {
    try {
      const c5 = await getYahooCandles(asset.symbol, "5m");
      const c1 = await getYahooCandles(asset.symbol, "1m");
      const c15 = await getYahooCandles(asset.symbol, "15m");
      const key = `STOCK:${asset.symbol}`;
      const previous = state.get(key);

      const analysis = analyzeCandleMarket(asset, c5, c1, c15, previous);
      const execution = buildExecution(asset, analysis);

      updateStateEntry(key, asset, analysis, execution);

      console.log(`STOCK: ${asset.symbol} | ${analysis.setup} | Final ${analysis.finalScore} | Exec ${execution.executionScore} | Vol ${analysis.volumeQuality} | ${execution.tradeState}`);

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
      const key = `COINBASE:${symbol}`;
      const previous = state.get(key);

      const analysis = analyzeCandleMarket(asset, candles, null, null, previous);
      const execution = buildExecution(asset, analysis);

      updateStateEntry(key, asset, analysis, execution);

      console.log(`COINBASE: ${symbol} | ${analysis.setup} | Final ${analysis.finalScore} | Exec ${execution.executionScore} | Vol ${analysis.volumeQuality} | ${execution.tradeState}`);

      await maybeAlert(asset, analysis, execution, key);
      results.push({ asset, analysis, execution });
    } catch (err) {
      console.log(`COINBASE: process error ${symbol}:`, err.message);
    }
  }

  return results;
}

async function getDexScreenerPairs() {
  const queries = ["solana", "base", "ethereum"];
  const found = new Map();

  for (const query of queries) {
    try {
      const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
        timeout: 20000
      });
      const pairs = Array.isArray(data.pairs) ? data.pairs : [];
      for (const pair of pairs) {
        const key = `${pair.chainId}:${pair.pairAddress || pair.url || pair.name}`;
        if (!found.has(key)) {
          found.set(key, pair);
        }
      }
    } catch (err) {
      console.log(`DEX: DexScreener ${query} error:`, err.message);
    }
  }

  return [...found.values()];
}

function analyzeDexPair(pair, asset, previous = null) {
  const liquidity = pair.liquidity?.usd || 0;
  const vol5m = pair.volume?.m5 || 0;
  const txns5m = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);
  const buys5m = pair.txns?.m5?.buys || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const change5m = pair.priceChange?.m5 || 0;
  const change1h = pair.priceChange?.h1 || 0;

  if (liquidity < MIN_DEX_LIQUIDITY) {
    return { score: 0, finalScore: 0, setup: "Liquidity Too Low", blockReason: "Alert BLOCKED: liquidity too low", relVol: 0, volume: vol5m, price: asset.price, support: null, breakout: null, risk: "High", volumeQuality: "BAD", reasons: ["liquidity too low"], recentHigh: null, recentLow: null, tightRange: false, higherLow: false, volumeReturning: false, pressureBuilding: false, reclaimHigh: false };
  }

  let volumeQuality = "OK";
  const reasons = [];

  if (vol5m < MIN_DEX_VOLUME_5M || txns5m < MIN_DEX_TXNS_5M) {
    volumeQuality = "BAD";
    reasons.push("DEX volume/transactions too low");
  }

  const buyRatio = txns5m ? buys5m / txns5m : 0;
  const pressure = liquidity ? vol5m / liquidity : 0;
  const relVol = Math.min(pressure * 20, 15);

  let score = 0;

  if (liquidity >= 150000) { score += 14; reasons.push("stronger DEX liquidity"); }
  if (vol5m >= MIN_DEX_VOLUME_5M) { score += 14; reasons.push("5m volume active"); }
  if (txns5m >= MIN_DEX_TXNS_5M) { score += 14; reasons.push("5m transactions active"); }
  if (change5m >= 2) { score += 10; reasons.push("positive 5m price change"); }
  if (change5m >= 6 || change1h >= 12) { score += 12; reasons.push("short-term DEX momentum"); }
  if (buyRatio >= 0.58) { score += 12; reasons.push("buyers leading sellers"); }
  if (pressure >= 0.1) { score += 10; reasons.push("volume/liquidity pressure building"); }
  if (relVol >= 1.2) { score += 8; reasons.push("DEX RVOL pressure building"); }

  let risk = "Medium";
  if (liquidity < 150000) risk = "Medium-High";
  if (sells5m > buys5m * 1.25 && txns5m >= 20) {
    score -= 25;
    risk = "High";
    reasons.push("warning: sellers outpacing buyers");
  }
  if (change5m > 25) {
    score -= 18;
    risk = "High";
    reasons.push("warning: parabolic 5m move");
  }
  if (volumeQuality === "BAD") {
    score -= 35;
    risk = "High";
    reasons.push("bad DEX volume quality");
  }

  if (previous && previous.analysis?.finalScore) {
    if (score > previous.analysis.finalScore) {
      score += 8;
      reasons.push("DEX score improving across scans");
    }
    if (pressure >= 0.1 && previous.pressureBuilding) {
      score += 6;
      reasons.push("DEX pressure building across scans");
    }
    if (vol5m > previous.previousVolume * 1.2) {
      score += 8;
      reasons.push("DEX volume returning");
    }
  }

  const setup =
    score >= MOMENTUM_SCORE
      ? "DEX Momentum Execution"
      : score >= EXECUTION_ALERT_SCORE
        ? "DEX Execution Watch"
        : "DEX Discovery Watch";

  const finalScore = scoreCap(Math.max(0, score), setup, risk, volumeQuality);

  return {
    score: finalScore,
    finalScore,
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
    reasons,
    recentHigh: null,
    recentLow: null,
    tightRange: false,
    higherLow: false,
    volumeReturning: false,
    pressureBuilding: pressure >= 0.1,
    reclaimHigh: false
  };
}

async function scanDexScreener() {
  if (!ENABLE_DEXSCREENER) {
    console.log("DEX: disabled");
    return [];
  }

  const pairs = await getDexScreenerPairs();
  const results = [];

  for (const pair of pairs.slice(0, 120)) {
    try {
      if (!["solana", "base", "ethereum"].includes(pair.chainId)) continue;

      const liquidity = pair.liquidity?.usd || 0;
      const vol5m = pair.volume?.m5 || 0;
      const txns5m = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);

      if (liquidity < MIN_DEX_LIQUIDITY) continue;
      if (liquidity > MAX_DEX_LIQUIDITY) continue;
      if (vol5m < MIN_DEX_VOLUME_5M) continue;
      if (txns5m < MIN_DEX_TXNS_5M) continue;

      const base = pair.baseToken?.symbol || "UNKNOWN";
      const quote = pair.quoteToken?.symbol || pair.quoteToken?.name || "PAIR";
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
      const key = `DEX:${pair.chainId}:${pair.pairAddress}`;
      const previous = state.get(key);

      const analysis = analyzeDexPair(pair, asset, previous);
      const execution = buildExecution(asset, analysis);

      updateStateEntry(key, asset, analysis, execution);

      console.log(`DEX: ${display} | ${analysis.setup} | Final ${analysis.finalScore} | Exec ${execution.executionScore} | Vol ${analysis.volumeQuality} | Liquidity ${fmtVol(liquidity)} | ${execution.tradeState}`);

      await maybeAlert(asset, analysis, execution, key);
      results.push({ asset, analysis, execution });
    } catch (err) {
      console.log("DEX: process error:", err.message);
    }
  }

  return results;
}

async function scanMomentumIgnition() {
  if (!ENABLE_IGNITION_SCANNER) {
    console.log("IGNITION: disabled");
    return [];
  }

  console.log("IGNITION: scanning stored candidates for ignition setups...");
  const results = [];

  for (const [key, entry] of state.entries()) {
    const { asset, analysis, execution } = entry;
    if (!analysis || !execution) continue;

    const ignitionCandidate = analysis.finalScore >= IGNITION_ALERT_SCORE && analysis.ignitionScore >= IGNITION_SCORE;
    if (!ignitionCandidate) continue;
    if (!cooldownPassed(key, analysis.finalScore)) {
      console.log(`${asset.market}: ${asset.display} | ALERT BLOCKED: cooldown active`);
      continue;
    }

    await maybeAlert(asset, analysis, execution, key);
    results.push({ asset, analysis, execution });
  }

  return results;
}

async function maybeAlert(asset, analysis, execution, key) {
  const decision = shouldSendAlert(asset, analysis, execution, key);

  if (!decision.send) {
    console.log(`${asset.market}: ${asset.display} | ${decision.block}`);
    return;
  }

  markAlerted(key, analysis.finalScore);

  const decimals = decimalsFor(asset);

  await sendTelegram(
`🚨 CARDINAL EXECUTION ENGINE

Ticker/Pair: ${asset.display}
Market: ${asset.market}
Tier: ${tier(analysis.finalScore, analysis.ignitionScore)}
Final Score: ${analysis.finalScore}/100
Ignition Score: ${analysis.ignitionScore}/100
Setup Type: ${analysis.setup}
Price: ${fmtMoney(asset.price, decimals)}
Move: ${Number(analysis.move || 0).toFixed(2)}%
Volume: ${fmtVol(analysis.volume)}
RVOL: ${analysis.relVol?.toFixed?.(2) || "N/A"}
Support: ${analysis.support ? fmtMoney(analysis.support, decimals) : "N/A"}
Breakout Level: ${analysis.breakout ? fmtMoney(analysis.breakout, decimals) : "N/A"}
Stop/Fails Level: ${execution.formatted.stop}
Risk: ${analysis.risk}
Why It Triggered:
- Tier threshold met
- ${analysis.reasons.slice(0, 5).join("\n- ")}
Chart URL: ${asset.url}

Alerts only. Not financial advice.`
  );
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS STRICT EXECUTION SCAN STARTING...");

  const results = [];
  if (ENABLE_STOCKS) results.push(...(await scanStocks()));
  if (ENABLE_COINBASE) results.push(...(await scanCoinbaseCrypto()));
  if (ENABLE_DEXSCREENER) results.push(...(await scanDexScreener()));
  if (ENABLE_IGNITION_SCANNER) results.push(...(await scanMomentumIgnition()));

  console.log(`SCAN COMPLETE | Total tracked this run: ${results.length}`);
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics Strict Execution Engine Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "cardinal_analytics_strict_execution_engine",
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