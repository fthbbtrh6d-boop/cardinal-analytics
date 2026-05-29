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

const FOCUS_MARKET = String(process.env.FOCUS_MARKET || "all").toLowerCase();
const PREMARKET_MODE = String(process.env.PREMARKET_MODE || "false").toLowerCase() === "true";

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 120);

const WATCHLIST_SCORE = Number(process.env.WATCHLIST_SCORE || 60);
const DISCOVERY_SCORE = Number(process.env.DISCOVERY_SCORE || 70);
const PRE_IGNITION_SCORE = Number(process.env.PRE_IGNITION_SCORE || 70);
const MOMENTUM_SCORE = Number(process.env.MOMENTUM_SCORE || 90);
const PARABOLIC_SCORE = Number(process.env.PARABOLIC_SCORE || 97);
const IGNITION_SCORE = Number(process.env.IGNITION_SCORE || 78);
const ALLOW_LOW_RVOL_BREAKOUTS = String(process.env.ALLOW_LOW_RVOL_BREAKOUTS || "true").toLowerCase() === "true";

const IGNITION_ALERT_SCORE = Number(process.env.IGNITION_ALERT_SCORE || 40);
const HIGH_CONVICTION_SCORE = Number(process.env.HIGH_CONVICTION_SCORE || 62);
const EXECUTION_ALERT_SCORE = Number(process.env.EXECUTION_ALERT_SCORE || 15);

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN != null ? process.env.MIN_STOCK_GAIN : PREMARKET_MODE ? 2 : 4);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME != null ? process.env.MIN_STOCK_VOLUME : PREMARKET_MODE ? 50000 : 1000000);
const MIN_LIVE_CANDLE_VOLUME = Number(process.env.MIN_LIVE_CANDLE_VOLUME != null ? process.env.MIN_LIVE_CANDLE_VOLUME : PREMARKET_MODE ? 10000 : 50000);
const MIN_RELATIVE_VOLUME = Number(process.env.MIN_RELATIVE_VOLUME || 1.15);
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
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const STRICT_LARGE_CAP_COINS = new Set(["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"]);

const state = new Map();
const alertMemory = new Map();
const stockNewsCache = new Map();

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false,
    });
  } catch (err) {
    console.log("Telegram error:", err.response?.data || err.message);
  }
}

function avg(arr) {
  return arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : 0;
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

function recordAlertReplay(key, asset, analysis) {
  const entry = state.get(key) || {};
  const price = asset.price || analysis.price || 0;
  const replay = entry.replay || {};

  replay.alertedAt = new Date().toISOString();
  replay.alertPrice = price;
  replay.maxPriceAfterAlert = price;
  replay.minPriceAfterAlert = price;
  replay.outcome = null;
  replay.followThrough = null;
  replay.logged = false;

  entry.replay = replay;
  state.set(key, entry);
}

function tier(finalScore, ignitionScore) {
  if (finalScore >= PARABOLIC_SCORE) return "🔴 PARABOLIC RISK";
  if (finalScore >= MOMENTUM_SCORE) return "🟢 HIGH CONVICTION";
  if (finalScore >= IGNITION_ALERT_SCORE && ignitionScore >= IGNITION_SCORE) return "🚨 IGNITION WATCH";
  if (finalScore >= PRE_IGNITION_SCORE) return "🟠 EARLY WATCH";
  if (finalScore >= DISCOVERY_SCORE) return "🟡 DISCOVERY";
  if (finalScore >= WATCHLIST_SCORE) return "🟡 WATCHLIST";
  return "⚪️ HOLD";
}

function polygonUrl(path) {
  return `https://api.polygon.io${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(POLYGON_API_KEY)}`;
}

async function getPolygonNews(symbol) {
  if (!POLYGON_API_KEY || !symbol) return null;
  const cacheKey = symbol.toUpperCase();
  if (stockNewsCache.has(cacheKey)) return stockNewsCache.get(cacheKey);

  try {
    const url = polygonUrl(`/v2/reference/news?ticker=${encodeURIComponent(symbol)}&limit=8`);
    const { data } = await axios.get(url, { timeout: 20000 });
    const items = Array.isArray(data.results) ? data.results : [];
    const news = items.map((item) => ({
      title: item.title,
      description: item.description,
      published_utc: item.published_utc,
      url: item.article_url,
    }));
    stockNewsCache.set(cacheKey, news);
    return news;
  } catch (err) {
    console.log(`STOCK: Polygon news ${symbol} error:`, err.response?.data || err.message);
    stockNewsCache.set(cacheKey, null);
    return null;
  }
}

function classifyCatalystHeadlines(news = []) {
  const positive = [
    /FDA/i,
    /earnings/i,
    /contract/i,
    /partnership/i,
    /upgrade/i,
    /buyout/i,
    /approval/i,
    /launch/i,
    /regulatory/i,
    /ETF/i,
    /deal/i,
    /grant/i,
    /pilot/i,
    /win/i,
    /order/i,
  ];
  const negative = [
    /dilution/i,
    /offering/i,
    /secondary offering/i,
    /delist/i,
    /bankruptcy/i,
    /investigation/i,
    /lawsuit/i,
    /suspension/i,
    /recall/i,
    /bid/i,
  ];

  let catalystScore = 0;
  const found = [];

  for (const item of news) {
    const text = `${item.title || ""} ${item.description || ""}`;
    for (const regex of negative) {
      if (regex.test(text)) {
        catalystScore -= 16;
        found.push(`negative catalyst: ${item.title}`);
        break;
      }
    }
    if (found.some((line) => line.startsWith("negative catalyst"))) continue;
    for (const regex of positive) {
      if (regex.test(text)) {
        catalystScore += 12;
        found.push(`positive catalyst: ${item.title}`);
        break;
      }
    }
  }

  let catalystStatus = "no catalyst found";
  if (found.length) {
    catalystStatus = catalystScore > 0 ? "positive catalyst" : "negative catalyst";
  }

  return {
    catalystScore,
    catalystStatus,
    catalystReasons: found,
  };
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
          url: `https://finance.yahoo.com/quote/${item.ticker}`,
        });
      }
    }
  }

  if (results.length < 20) {
    const yahoo = await getYahooStockDiscovery();
    results = results.concat(yahoo.filter((x) => !discovered.has(x.symbol))).slice(0, 60);
  }

  return results.slice(0, 80);
}

function trendCheck(candles) {
  if (!candles || candles.length < 20) return { aligned: false, short: false, medium: false, long: false };
  const closes = candles.map((c) => c.close);
  const short = closes.at(-1) > closes.at(-4);
  const medium = closes.at(-1) > closes.at(-12);
  const long = closes.at(-1) > closes.at(-20);
  return { aligned: short && medium && long, short, medium, long };
}

function scoreCap(score, setup, risk, volumeQuality) {
  if (volumeQuality === "BAD") return Math.min(score, 60);
  if (risk === "High") return Math.min(score, 72);
  if (setup.includes("Discovery")) return Math.min(score, 78);
  if (setup.includes("Pre-Breakout")) return Math.min(score, 88);
  if (setup.includes("Ignition")) return Math.min(score, 92);
  if (setup.includes("Breakout")) return Math.min(score, 96);
  return Math.min(score, 94);
}

function calculateFinalScore({
  ignitionScore = 0,
  structureScore = 0,
  continuationScore = 0,
  accelerationScore = 0,
  breakoutPressureScore = 0,
  catalystFound = false,
  rvol = 0,
  move = 0,
  mtfConfirmed = false,
  failedBreakoutRisk = "Low",
  momentumQuality = "Neutral",
}) {
  ignitionScore = Math.max(0, Math.min(100, ignitionScore));
  structureScore = Math.max(0, Math.min(100, structureScore));
  continuationScore = Math.max(0, Math.min(100, continuationScore));
  accelerationScore = Math.max(0, Math.min(100, accelerationScore));
  breakoutPressureScore = Math.max(0, Math.min(100, breakoutPressureScore));

  let finalScore =
    ignitionScore * 0.45 +
    structureScore * 0.20 +
    continuationScore * 0.15 +
    accelerationScore * 0.12 +
    breakoutPressureScore * 0.08;

  if (rvol < 2) finalScore -= 12;
  if (rvol < 1.2) finalScore -= 16;
  if (!mtfConfirmed) finalScore -= 8;
  if (!catalystFound) finalScore -= 6;
  if (move < 0) finalScore -= 10;
  if (failedBreakoutRisk === "High") finalScore -= 14;

  if (rvol >= 4) finalScore += 8;
  if (rvol >= 6) finalScore += 10;
  if (accelerationScore >= 20) finalScore += 8;
  if (breakoutPressureScore >= 18) finalScore += 8;
  if (catalystFound) finalScore += 6;

  if (momentumQuality === "Strong") finalScore += 10;
  else if (momentumQuality === "Good") finalScore += 4;
  else if (momentumQuality === "Weak") finalScore -= 12;

  finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

  let tierLabel = "⚪️ WATCH";
  if (finalScore >= PARABOLIC_SCORE) tierLabel = "🔴 PARABOLIC RISK";
  else if (finalScore >= HIGH_CONVICTION_SCORE) tierLabel = "🟢 HIGH CONVICTION";
  else if (finalScore >= IGNITION_ALERT_SCORE && (ignitionScore >= IGNITION_SCORE || structureScore >= 35 || momentumQuality === "Strong")) tierLabel = "🚨 IGNITION WATCH";
  else if (finalScore >= PRE_IGNITION_SCORE) tierLabel = "🟠 EARLY WATCH";
  else if (finalScore >= DISCOVERY_SCORE) tierLabel = "🟡 DISCOVERY";

  return { finalScore, tierLabel };
}

function volumeQualityCheck(asset, vols, priorVols, latestVolume) {
  const recentAvg = avg(vols.slice(0, -1));
  const priorAvg = avg(priorVols);
  const maxVol = Math.max(...vols, 0);
  const relVol = priorAvg > 0 ? recentAvg / priorAvg : 1;
  const normalizedRvol = Number.isFinite(relVol) ? Math.min(relVol, 15) : 0;

  const hardStockFail =
    asset.market === "STOCK" &&
    (asset.volume < MIN_STOCK_VOLUME || latestVolume < MIN_LIVE_CANDLE_VOLUME);

  const deadVolume = recentAvg <= 0 || vols.filter((v) => v > 0).length < Math.floor(vols.length * 0.5);
  const oneCandleSpike = recentAvg > 0 && maxVol > recentAvg * 8 && latestVolume < maxVol * 0.35;
  const fadingVolume = recentAvg > 0 && latestVolume < recentAvg * 0.45 && normalizedRvol < MIN_RELATIVE_VOLUME;
  const weakVolume = normalizedRvol < MIN_RELATIVE_VOLUME;

  const reasons = [];
  if (hardStockFail) reasons.push("stock volume or live candle volume too low");
  if (deadVolume) reasons.push("volume has been dead or inconsistent");
  if (oneCandleSpike) reasons.push("volume inflated by a single spike");
  if (fadingVolume) reasons.push("volume is fading into the signal");
  if (weakVolume) reasons.push("RVOL is weak");
  if (normalizedRvol < 1) reasons.push("RVOL below 1.0");

  const bad = hardStockFail || deadVolume || oneCandleSpike || fadingVolume;
  if (bad) {
    return {
      quality: "BAD",
      relVol: normalizedRvol,
      reasons,
      lowRvolOnly: false,
    };
  }

  if (weakVolume) {
    return {
      quality: ALLOW_LOW_RVOL_BREAKOUTS ? "LOW" : "BAD",
      relVol: normalizedRvol,
      reasons,
      lowRvolOnly: true,
    };
  }

  if (normalizedRvol >= 1.3 && latestVolume >= recentAvg * 1.1) {
    return { quality: "GOOD", relVol: normalizedRvol, reasons: ["volume is strong and clean"], lowRvolOnly: false };
  }

  return { quality: "OK", relVol: normalizedRvol, reasons: ["volume is acceptable"], lowRvolOnly: false };
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
    idealLow = support * 1.006;
    idealHigh = Math.min(breakout * 0.994, support * 1.025);
    trigger = breakout;
    avoidAbove = breakout * 1.03;
    stop = support * 0.986;
    if (analysis.retestHeld) {
      idealLow = support * 1.01;
      idealHigh = breakout * 0.998;
      stop = support * 0.99;
    }
  }

  if (!idealLow && breakout && asset.market !== "DEX") {
    idealLow = breakout * 0.995;
    idealHigh = breakout * 1.015;
    stop = breakout * 0.98;
    avoidAbove = breakout * 1.04;
  }

  const extensionPct = breakout && price ? ((price - breakout) / breakout) * 100 : 0;
  const isExtended = extensionPct > 2.5;
  const nearEntry = idealLow && idealHigh && price >= idealLow && price <= idealHigh;
  const belowTrigger = breakout && price < breakout;
  const retestZone = breakout && price >= breakout * 0.995 && price <= breakout * 1.02;

  let executionScore = 55;
  const notes = [];

  if (analysis.volumeQuality === "BAD") {
    executionScore -= 40;
    notes.push("Bad volume quality. Avoid.");
  }

  if (analysis.setup.includes("Pre-Breakout")) {
    executionScore += 20;
    notes.push("Pre-breakout structure visible.");
  }

  if (nearEntry) {
    executionScore += 18;
    notes.push("Inside clean entry zone.");
  }

  if (belowTrigger) {
    executionScore += 10;
    notes.push("Below breakout trigger, lower risk.");
  }

  if (retestZone) {
    executionScore += 12;
    notes.push("Holding breakout/retest zone.");
  }

  if (analysis.relVol >= 1.2 && analysis.relVol <= 4) {
    executionScore += 12;
    notes.push("RVOL is in a healthy range.");
  }

  if (analysis.relVol > 5) {
    executionScore -= 10;
    notes.push("RVOL is too hot; chase risk.");
  }

  if (isExtended) {
    executionScore -= 28;
    notes.push("Extended beyond breakout; wait for pullback.");
  }

  if (analysis.risk === "High") {
    executionScore -= 26;
    notes.push("High risk conditions.");
  }

  if (analysis.momentumQuality === "Strong") {
    executionScore += 12;
    notes.push("Momentum quality is strong.");
  }

  if (analysis.momentumQuality === "Weak") {
    executionScore -= 16;
    notes.push("Momentum quality is weak.");
  }

  if (analysis.breakoutCandle && analysis.volumeReturning) {
    executionScore += 10;
    notes.push("Breakout candle with return volume.");
  }

  if (analysis.retestHeld) {
    executionScore += 10;
    notes.push("Pullback/retest is holding.");
  }

  if (analysis.failedBreakoutRisk === "High") {
    executionScore -= 22;
    notes.push("Failed breakout risk detected.");
  }

  if (asset.market === "DEX") {
    if (asset.liquidity >= 200000) {
      executionScore += 10;
      notes.push("DEX liquidity is solid.");
    } else {
      executionScore -= 18;
      notes.push("DEX liquidity is thinner than ideal.");
    }
    notes.push("DEX entry zones require chart confirmation.");
  }

  executionScore = Math.max(0, Math.min(100, executionScore));

  let tradeState = "WATCH";
  if (analysis.setup.includes("Pre-Breakout")) tradeState = "PRE-BREAKOUT";
  if (analysis.setup.includes("Ignition")) tradeState = "IGNITION";
  if (analysis.setup.includes("Breakout")) tradeState = "BREAKOUT";
  if (isExtended) tradeState = "EXTENDED / WAIT";
  if (analysis.volumeQuality === "BAD") tradeState = "BAD VOLUME";
  if (analysis.risk === "High") tradeState = "HIGH RISK";

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
      stop: stop ? fmtMoney(stop, decimals) : "N/A",
    },
    notes,
  };
}

function updateStateEntry(key, asset, analysis, execution) {
  const prev = state.get(key) || {};
  const replay = prev.replay ? { ...prev.replay } : null;

  if (replay?.alertedAt) {
    const price = asset.price || analysis.price || 0;
    replay.maxPriceAfterAlert = Math.max(replay.maxPriceAfterAlert || price, price);
    replay.minPriceAfterAlert = Math.min(replay.minPriceAfterAlert || price, price);

    if (!replay.outcome) {
      const alertPrice = replay.alertPrice || price;
      if (replay.maxPriceAfterAlert >= alertPrice * 1.06) {
        replay.outcome = "follow-through";
        replay.followThrough = true;
      } else if (replay.minPriceAfterAlert <= alertPrice * 0.96 && price < alertPrice * 0.99) {
        replay.outcome = "failed";
        replay.followThrough = false;
      }
    }

    if (replay.outcome && !replay.logged) {
      const alertPrice = replay.alertPrice || asset.price || 0;
      const maxP = replay.maxPriceAfterAlert || alertPrice;
      const minP = replay.minPriceAfterAlert || alertPrice;
      const performance = replay.outcome === "follow-through"
        ? `+${((maxP / alertPrice - 1) * 100).toFixed(1)}%`
        : `-${((alertPrice / minP - 1) * 100).toFixed(1)}%`;
      console.log(`REPLAY: ${asset.display} ${replay.outcome} ${performance}`);
      replay.logged = true;
    }
  }

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
    reclaimHigh: analysis.reclaimHigh,
    replay,
  });
}

function shouldSendAlert(asset, analysis, execution, key) {
  if (!analysis) return { send: false, block: "score too low" };
  if (analysis.blockReason) return { send: false, block: analysis.blockReason };
  if (analysis.failedBreakoutRisk === "High") return { send: false, block: "failed breakout risk" };
if (
  analysis.risk === "High" &&
  analysis.finalScore < 55 &&
  execution.executionScore < 35
) {
  return { send: false, block: "high risk" };
}  if (!cooldownPassed(key, analysis.finalScore)) return { send: false, block: "cooldown active" };
  if (analysis.volumeQuality === "LOW" && !analysis.structureStrong) return { send: false, block: "low RVOL without clean structure" };
  if (FOCUS_MARKET === "stocks" && asset.market !== "STOCK") return { send: false, block: "focus market is stocks" };

  const score = analysis.finalScore;
  const executionScore = execution.executionScore || 0;
  const ignitionScore = analysis.ignitionScore || 0;
  const isIgnitionSetup = analysis.setup?.includes("Ignition");

  if (asset.market === "COINBASE" && STRICT_LARGE_CAP_COINS.has(asset.symbol)) {
    if (score < MOMENTUM_SCORE || ignitionScore < 80 || analysis.breakoutCandle !== true) {
      return { send: false, block: "large cap crypto requires strong breakout momentum" };
    }
  }

  if (score >= HIGH_CONVICTION_SCORE) return { send: true };
  if (score >= IGNITION_ALERT_SCORE) return { send: true };
  if (executionScore >= EXECUTION_ALERT_SCORE && isIgnitionSetup) return { send: true };

  return { send: false, block: "alert thresholds not met" };
}

async function getYahooStockDiscovery() {
  try {
    const url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=75";
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000,
    });

    const quotes = data.finance?.result?.[0]?.quotes || [];

    return quotes
      .map((q) => {
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
          url: `https://finance.yahoo.com/quote/${q.symbol}`,
        };
      })
      .filter((x) => x.price > 1 && x.changePct >= MIN_STOCK_GAIN && x.volume >= MIN_STOCK_VOLUME)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 30);
  } catch (err) {
    console.log("STOCK: Yahoo discovery error:", err.message);
    return [];
  }
}

async function getYahooCandles(symbol, interval = "5m") {
  try {
    const range = interval === "1m" ? "1d" : interval === "15m" ? "7d" : "5d";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000,
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
        volume: q.volume?.[i] || 0,
      }))
      .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
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
      tierLabel: "⚪️ HOLD",
      setup: "No Data",
      blockReason: "no candle data",
      discoveryScore: 0,
      structureScore: 0,
      volumeScore: 0,
      ignitionScore: 0,
      accelerationScore: 0,
      breakoutPressureScore: 0,
      continuationProbability: 0,
      momentumQuality: "Weak",
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
      reclaimHigh: false,
      breakoutCandle: false,
      failedBreakoutRisk: "High",
    };
  }

  const recent = candles5m.slice(-24);
  const prior = candles5m.slice(-48, -24);
  const last = recent.at(-1);
  const prev = recent.at(-2);

  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const vols = recent.map((c) => c.volume || 0);
  const priorVols = prior.map((c) => c.volume || 0);

  const vq = volumeQualityCheck(asset, vols, priorVols, last.volume || 0);
  const price = last.close;
  asset.price = price;

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const support = Math.min(...recent.slice(-8).map((c) => c.low));
  const breakout = priorHigh > recentHigh ? priorHigh : recentHigh;

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;
  const distanceToBreakoutPct = breakout ? ((breakout - price) / breakout) * 100 : 999;

  const higherLow = lows.at(-1) > lows.at(-8);
  const tighteningRange = rangePct < 7.5;
  const pullbackHeld = price > support * 1.028;
  const nearBreakout = distanceToBreakoutPct >= 0 && distanceToBreakoutPct <= 3;
  const breakoutCandle = price > breakout * 1.01;
  const avgVolume = avg(vols.slice(0, -1));
  const volumeReturning = avgVolume > 0 && last.volume >= avgVolume * 1.35;
  const volumeExpansion = avgVolume > 0 && last.volume >= avgVolume * 2;
  const pressureBuilding = last.close >= recentHigh * 0.992 || vq.relVol >= 1.15 || last.volume > avgVolume * 1.2;
  const noRejection = last.close > last.open && last.close > (last.high + last.low) / 2;
  const retestHeld = prev && prev.close >= breakout * 0.985 && last.close >= breakout * 0.995;

  const floatShares = asset.floatShares || asset.sharesOutstanding || null;
  let floatScore = 0;
  let floatRisk = "Unknown";
  let floatStatus = "float unknown";
  if (Number.isFinite(floatShares) && floatShares > 0) {
    floatStatus = `${fmtVol(floatShares)} float`;
    if (floatShares < 5_000_000) {
      floatScore = 14;
      floatRisk = "Low";
    } else if (floatShares < 20_000_000) {
      floatScore = 10;
      floatRisk = "Low";
    } else if (floatShares < 50_000_000) {
      floatScore = 6;
      floatRisk = "Medium";
    } else {
      floatScore = 2;
      floatRisk = "Higher";
    }
  }

  const catalystData = asset.market === "STOCK" ? classifyCatalystHeadlines(asset.news || []) : { catalystScore: 0, catalystStatus: "no catalyst found", catalystReasons: [] };
  const catalystScore = catalystData.catalystScore || 0;
  const catalystStatus = catalystData.catalystStatus;
  const catalystReasons = catalystData.catalystReasons;

  const previousVolume = previous?.asset?.volume || 0;
  const volumeChangePct = previousVolume > 0 ? pct(asset.volume, previousVolume) : 0;
  let accelerationScore = 0;
  const accelerationNotes = [];
  if (volumeChangePct >= 100) {
    accelerationScore += 18;
    accelerationNotes.push("scan-to-scan volume doubled");
  } else if (volumeChangePct >= 50) {
    accelerationScore += 12;
    accelerationNotes.push("volume accelerating across scans");
  } else if (volumeChangePct >= 25) {
    accelerationScore += 8;
    accelerationNotes.push("steady volume acceleration");
  }
  if (asset.premarket || asset.afterHours) {
    accelerationScore += 8;
    accelerationNotes.push("overnight or premarket momentum");
  }
  if (volumeChangePct > 12 && price >= (previous?.asset?.price || price) * 0.995) {
    accelerationScore += 6;
    accelerationNotes.push("price holding while volume rises");
  }

  const trend5m = trendCheck(candles5m);
  const trend1m = trendCheck(candles1m);
  const trend15m = trendCheck(candles15m);
  const multiTimeframe = trend5m.aligned && (!candles1m || trend1m.short) && (!candles15m || trend15m.medium || trend15m.long);
  let mtfScore = 0;
  if (trend1m.short) mtfScore += 12;
  if (trend5m.aligned) mtfScore += 10;
  if (trend15m.medium || trend15m.long) mtfScore += 8;
  let mtfStatus = "MTF unavailable";
  if (trend1m.short || trend5m.aligned || trend15m.medium || trend15m.long) {
    mtfStatus = trend5m.aligned && trend1m.short && (trend15m.medium || trend15m.long) ? "Confirmed" : "Partial";
  }
  if (!candles15m) mtfStatus = `${mtfStatus} (15m unavailable)`;

  const lowFloat = asset.market === "STOCK" && asset.floatShares && asset.floatShares < 20_000_000;
  const smallCapRunner = asset.market === "STOCK" && price >= 0.5 && price <= 25 && (lowFloat || (asset.marketCap && asset.marketCap < 250_000_000));
  const earlyRunner = asset.market === "STOCK" && (asset.premarket || asset.afterHours);
  const extended = asset.changePct > 28 || price > breakout * 1.04;
  const wickRisk = (last.high - last.close) > (last.high - last.low) * 0.42;
  const exhaustionRisk = extended || wickRisk || rangePct > 12;
  const rejectionCount = recent.slice(-6).filter((c) => breakout && c.high >= breakout * 0.995 && c.close < breakout * 0.98).length;
  const upperWickPct = last.high > last.low ? (last.high - Math.max(last.close, last.open)) / (last.high - last.low) : 0;
  let failedBreakoutRiskScore = 0;
  if (breakout > 0 && last.close < breakout * 0.99) failedBreakoutRiskScore += 14;
  if (upperWickPct > 0.42) failedBreakoutRiskScore += 10;
  if (rejectionCount >= 2) failedBreakoutRiskScore += 8;
  if (last.volume > avgVolume * 1.8 && !breakoutCandle && last.close < breakout * 0.995) failedBreakoutRiskScore += 10;
  const failedBreakoutRisk = failedBreakoutRiskScore >= 18 ? "High" : failedBreakoutRiskScore >= 10 ? "Medium" : "Low";

  const supportHold = pullbackHeld || retestHeld;
  const consolidationAfterSpike = recent.slice(0, 6).some((c) => c.volume > avg(vols) * 2.2 && c.close > c.open) && tighteningRange;
  const isConsolidation = higherLow && tighteningRange && supportHold && !failedBreakoutRisk;
  const reclaimHigh = price >= priorHigh || (previous && previous.recentHigh && price >= previous.recentHigh);
  const isIgnition = pressureBuilding && (nearBreakout || breakoutCandle || reclaimHigh);
  const isBreakout = breakoutCandle && noRejection && volumeReturning;
  const structureStrong = tighteningRange && higherLow && supportHold && pressureBuilding && volumeReturning && !failedBreakoutRisk;

  const breakoutPressureScore =
    (nearBreakout ? 8 : 0) +
    (pressureBuilding ? 10 : 0) +
    (volumeReturning ? 10 : 0) +
    (retestHeld ? 8 : 0);
  const continuationProbability =
    Math.min(100,
      (mtfStatus === "Confirmed" ? 20 : mtfStatus.startsWith("Partial") ? 12 : 4) +
      (higherLow ? 18 : 0) +
      (supportHold ? 16 : 0) +
      (volumeReturning ? 16 : 0) +
      (reclaimHigh ? 12 : 0)
    );
  let momentumQuality = "Neutral";
  if (accelerationScore > 0 && vq.relVol >= 2 && breakoutPressureScore >= 50) momentumQuality = "Strong";
  else if (vq.relVol >= 1.2 && (trend5m.aligned || trend1m.short || trend15m.medium || trend15m.long)) momentumQuality = "Good";
  else if (accelerationScore === 0 && breakoutPressureScore < 40) momentumQuality = "Weak";

  let discoveryScore = 0;
  let structureScore = 0;
  let volumeScore = 0;
  let ignitionScore = 0;
  let riskScore = 0;
  const reasons = [...vq.reasons, ...accelerationNotes];

  const structureClean = supportHold && higherLow && tighteningRange;

  if (price >= 0.5 && price <= 25) { discoveryScore += 6; reasons.push("ideal runner price range"); }
  if (asset.changePct >= 3) { discoveryScore += 8; reasons.push("momentum move in progress"); }
  if (asset.changePct >= 6) { discoveryScore += 8; reasons.push("power move accelerating"); }
  if (trend5m.aligned || trend15m.medium || trend15m.long) { discoveryScore += 10; reasons.push("trend bias is bullish"); }
  if (lowFloat) { discoveryScore += 10; reasons.push("low float candidate"); }
  if (smallCapRunner) { discoveryScore += 8; reasons.push("small cap momentum runner"); }
  if (earlyRunner) { discoveryScore += 8; reasons.push("overnight strength present"); }
  if (floatScore && asset.market === "STOCK") { discoveryScore += floatScore; }
  if (catalystScore > 0) { discoveryScore += Math.min(catalystScore, 12); reasons.push("positive catalyst"); }
  if (catalystScore < 0) { riskScore += Math.min(Math.abs(catalystScore), 20); }
  if (failedBreakoutRisk !== "Low") { riskScore += failedBreakoutRisk === "High" ? 18 : 10; reasons.push("breakout risk detected"); }

  if (supportHold) { structureScore += 20; reasons.push("support is holding"); }
  if (higherLow) { structureScore += 20; reasons.push("higher lows are present"); }
  if (tighteningRange) { structureScore += 18; reasons.push("tight consolidation"); }
  if (nearBreakout) { structureScore += 12; reasons.push("price is near breakout"); }
  if (reclaimHigh) { structureScore += 14; reasons.push("reclaiming prior highs"); }
  if (breakout > 0 && price < breakout) { structureScore += 6; }
  if (consolidationAfterSpike) { structureScore += 10; reasons.push("consolidation after initial spike"); }
  if (multiTimeframe) { structureScore += 10; reasons.push("multi-timeframe alignment"); }
  if (mtfScore) { structureScore += Math.min(mtfScore, 12); }
  if (pressureBuilding && !breakoutCandle) { structureScore += 6; }

  if (vq.quality === "GOOD") { volumeScore += 16; reasons.push("strong volume profile"); }
  if (vq.quality === "OK") { volumeScore += 10; reasons.push("acceptable volume profile"); }
  if (vq.quality === "LOW") {
    volumeScore += 6;
    if (structureClean) { volumeScore += 8; reasons.push("clean structure supports low RVOL"); }
    else { riskScore += 6; reasons.push("low RVOL without clean structure"); }
  }
  if (volumeReturning) { volumeScore += 16; reasons.push("volume is returning"); }
  if (volumeExpansion) { volumeScore += 12; reasons.push("volume expansion is present"); }
  if (pressureBuilding) { volumeScore += 12; reasons.push("pressure building into breakout"); }
  if (accelerationScore) { volumeScore += Math.min(accelerationScore, 12); }

  if (pressureBuilding) { ignitionScore += 20; reasons.push("pressure building into the move"); }
  if (breakoutCandle) { ignitionScore += 24; reasons.push("early breakout candle seen"); }
  if (volumeReturning) { ignitionScore += 18; reasons.push("volume returning on breakout attempt"); }
  if (retestHeld) { ignitionScore += 12; reasons.push("retest is holding"); }
  if (reclaimHigh) { ignitionScore += 14; reasons.push("reclaiming highs"); }
  if (consolidationAfterSpike) { ignitionScore += 12; reasons.push("clean consolidation after first spike"); }
  if (structureClean) { ignitionScore += 8; reasons.push("clean structural support"); }
  if (isIgnition) { ignitionScore += 18; }
  if (isBreakout) { ignitionScore += 20; reasons.push("breakout continuation candidate"); }

  if (previous && previous.analysis?.finalScore) {
    const deltaScore = (discoveryScore + structureScore + volumeScore + ignitionScore - riskScore) - previous.analysis.finalScore;
    if (deltaScore >= 6) { ignitionScore += 10; reasons.push("scan-to-scan score improvement"); }
    if (reclaimHigh && previous.recentHigh && price > previous.recentHigh) { ignitionScore += 12; reasons.push("reclaiming scan high"); }
    if (tighteningRange && previous.tightRange) { ignitionScore += 8; reasons.push("range tightening across scans"); }
    if (volumeReturning && previous.volumeReturning) { ignitionScore += 8; reasons.push("continuing volume return"); }
    if (pressureBuilding && previous.pressureBuilding) { ignitionScore += 8; reasons.push("pressure building across scans"); }
  }

  if (exhaustionRisk) { riskScore += 28; reasons.push("extended or reversal risk"); }
  if (!supportHold) { riskScore += 20; reasons.push("support not holding"); }
  if (vq.quality === "BAD") { riskScore += 32; reasons.push("poor volume quality"); }
  if (asset.market === "DEX" && asset.liquidity < MIN_DEX_LIQUIDITY * 1.2) { riskScore += 14; reasons.push("thin DEX liquidity"); }
  if (!asset.price || asset.price < 0.5) { riskScore += 12; reasons.push("price too low for reliable structure"); }

  const mtfConfirmed = mtfStatus === "Confirmed";
  const catalystFound = catalystScore > 0 || catalystStatus !== "no catalyst found";
  const { finalScore: newFinalScore, tierLabel: newTierLabel } = calculateFinalScore({
    ignitionScore,
    structureScore,
    continuationScore: volumeScore,
    accelerationScore,
    breakoutPressureScore,
    catalystFound,
    rvol: vq.relVol || 0,
    move: asset.changePct || 0,
    mtfConfirmed,
    failedBreakoutRisk,
    momentumQuality,
  });

  const finalScore = scoreCap(newFinalScore, isBreakout ? "Breakout" : isIgnition ? "Ignition" : isConsolidation ? "Pre-Breakout" : "Discovery", riskScore >= 30 ? "High" : "Medium", vq.quality);

  let risk = "Medium";
  if (riskScore >= 30 || exhaustionRisk || vq.quality === "BAD") risk = "High";
  else if (riskScore >= 16) risk = "Medium-High";

  let setup = "Discovery Watch";
  if (isBreakout) setup = "Breakout Execution";
  else if (isIgnition) setup = "Ignition Setup";
  else if (isConsolidation) setup = "Pre-Breakout Setup";

  let replayStatus = "none";
  if (previous?.replay?.alertedAt) {
    const replay = previous.replay;
    const alertPrice = replay.alertPrice || price;
    const maxP = replay.maxPriceAfterAlert || alertPrice;
    const minP = replay.minPriceAfterAlert || alertPrice;
    if (replay.outcome === "follow-through") {
      replayStatus = `follow-through +${((maxP / alertPrice - 1) * 100).toFixed(1)}%`;
    } else if (replay.outcome === "failed") {
      replayStatus = `failed -${((alertPrice / minP - 1) * 100).toFixed(1)}%`;
    } else {
      replayStatus = `tracking +${((maxP / alertPrice - 1) * 100).toFixed(1)}% / -${((alertPrice / minP - 1) * 100).toFixed(1)}%`;
    }
  }

  return {
    score: finalScore,
    finalScore,
    tierLabel: newTierLabel,
    discoveryScore,
    structureScore: Math.max(0, Math.min(100, structureScore)),
    structureStrong,
    volumeScore: Math.max(0, Math.min(100, volumeScore)),
    ignitionScore: Math.max(0, Math.min(100, ignitionScore)),
    accelerationScore: Math.max(0, Math.min(100, accelerationScore)),
    breakoutPressureScore: Math.max(0, Math.min(100, breakoutPressureScore)),
    continuationProbability: Math.max(0, Math.min(100, continuationProbability)),
    momentumQuality,
    riskScore,
    floatScore,
    floatRisk,
    floatStatus,
    catalystScore,
    catalystStatus,
    catalystReasons,
    premarketAccelerationScore: accelerationScore,
    mtfScore,
    mtfStatus,
    failedBreakoutRiskScore,
    failedBreakoutRisk,
    replayStatus,
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
    tightRange: tighteningRange,
    higherLow,
    volumeReturning,
    pressureBuilding,
    reclaimHigh,
    breakoutCandle,
    priorHigh,
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
      asset.news = await getPolygonNews(asset.symbol);

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
    const range = granularity === 60 ? "1d" : granularity === 300 ? "3d" : "7d";
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data
      .map((c) => ({
        time: c[0],
        low: c[1],
        high: c[2],
        open: c[3],
        close: c[4],
        volume: c[5],
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
      const c1 = await getCoinbaseCandles(symbol, 60);
      const c15 = await getCoinbaseCandles(symbol, 900);

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
        url: `https://www.coinbase.com/advanced-trade/spot/${symbol}`,
      };
      const key = `COINBASE:${symbol}`;
      const previous = state.get(key);

      const analysis = analyzeCandleMarket(asset, candles, c1, c15, previous);
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
        timeout: 20000,
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
    return {
      score: 0,
      finalScore: 0,
      setup: "Liquidity Too Low",
      blockReason: "liquidity too low",
      relVol: 0,
      volume: vol5m,
      price: asset.price,
      support: null,
      breakout: null,
      risk: "High",
      volumeQuality: "BAD",
      reasons: ["liquidity too low"],
      recentHigh: null,
      recentLow: null,
      tightRange: false,
      higherLow: false,
      volumeReturning: false,
      pressureBuilding: false,
      reclaimHigh: false,
      breakoutCandle: false,
      failedBreakoutRisk: "High",
    };
  }

  let volumeQuality = "OK";
  const reasons = [];

  if (vol5m < MIN_DEX_VOLUME_5M || txns5m < MIN_DEX_TXNS_5M) {
    volumeQuality = "BAD";
    reasons.push("DEX volume or transactions too low");
  }

  const buyRatio = txns5m ? buys5m / txns5m : 0;
  const pressure = liquidity ? vol5m / liquidity : 0;
  const relVol = Math.min(pressure * 20, 15);

  let score = 0;
  if (liquidity >= 150000) { score += 14; reasons.push("strong DEX liquidity"); }
  if (vol5m >= MIN_DEX_VOLUME_5M) { score += 14; reasons.push("active 5m volume"); }
  if (txns5m >= MIN_DEX_TXNS_5M) { score += 14; reasons.push("active 5m transactions"); }
  if (change5m >= 2) { score += 10; reasons.push("positive 5m move"); }
  if (change5m >= 6 || change1h >= 12) { score += 12; reasons.push("short-term momentum"); }
  if (buyRatio >= 0.58) { score += 12; reasons.push("buyers leading sellers"); }
  if (pressure >= 0.1) { score += 10; reasons.push("volume/liquidity pressure"); }
  if (relVol >= 1.2) { score += 8; reasons.push("DEX RVOL rising"); }

  let risk = "Medium";
  if (liquidity < 150000) risk = "Medium-High";
  if (sells5m > buys5m * 1.25 && txns5m >= 20) {
    score -= 25;
    risk = "High";
    reasons.push("sellers are dominating");
  }
  if (change5m > 25) {
    score -= 18;
    risk = "High";
    reasons.push("parabolic 5m move");
  }
  if (volumeQuality === "BAD") {
    score -= 35;
    risk = "High";
    reasons.push("bad DEX volume quality");
  }

  if (previous && previous.analysis?.finalScore) {
    if (score > previous.analysis.finalScore) {
      score += 8;
      reasons.push("DEX score improving");
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

  const breakoutPressureScore = pressure >= 0.1 ? 12 : 6;
  const continuationProbability = buyRatio >= 0.58 ? 60 : 40;
  const momentumQuality = change5m >= 6 || change1h >= 12 ? "Good" : "Neutral";

  const setup = score >= MOMENTUM_SCORE ? "DEX Momentum Execution" : score >= IGNITION_ALERT_SCORE ? "DEX Ignition Watch" : "DEX Discovery Watch";
  const finalScore = scoreCap(Math.max(0, score), setup, risk, volumeQuality);

  return {
    score: finalScore,
    finalScore,
    tierLabel: tier(finalScore, finalScore),
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
    volumeReturning: pressure >= 0.1,
    pressureBuilding: pressure >= 0.1,
    reclaimHigh: false,
    breakoutCandle: false,
    failedBreakoutRisk: volumeQuality === "BAD" ? "High" : "Low",
    accelerationScore: 0,
    breakoutPressureScore,
    continuationProbability,
    momentumQuality,
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
        marketCap: pair.marketCap || pair.fdv || null,
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

  console.log("IGNITION: checking tracked candidates for ignition follow-up...");
  const results = [];

  for (const [key, entry] of state.entries()) {
    const { asset, analysis, execution } = entry;
    if (!analysis || !execution) continue;
    const ignitionCandidate = (analysis.finalScore >= IGNITION_ALERT_SCORE && analysis.ignitionScore >= IGNITION_SCORE) || (analysis.finalScore >= PRE_IGNITION_SCORE && analysis.structureStrong);
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
  const decimals = decimalsFor(asset);
  const profitZones = analysis.breakout ? `${fmtMoney(analysis.breakout * 1.02, decimals)} / ${fmtMoney(analysis.breakout * 1.04, decimals)} / ${fmtMoney(analysis.breakout * 1.08, decimals)}` : "N/A";
  const bestEntry = execution.formatted.idealEntry || "N/A";
  const failLevel = execution.formatted.stop || "N/A";
  const summary = `${asset.market}: ${asset.display} | ${analysis.setup} | Final ${analysis.finalScore} | Exec ${execution.executionScore} | Best Entry ${bestEntry} | Fail Level ${failLevel} | Profit Zones ${profitZones}`;

  const tierLabel = analysis.tierLabel || tier(analysis.finalScore, analysis.ignitionScore);
  if (!decision.send) {
    console.log(`${tierLabel}: ALERT BLOCKED: ${summary} | ${decision.block}`);
    return;
  }

  if (FOCUS_MARKET === "stocks" && asset.market !== "STOCK") {
    console.log(`${tierLabel}: ALERT MATCHED BUT TELEGRAM SKIPPED DUE TO STOCK FOCUS: ${summary}`);
    return;
  }

  const alertType = analysis.finalScore >= HIGH_CONVICTION_SCORE
    ? "High Conviction"
    : analysis.setup?.includes("Ignition")
      ? "Possible Entry"
      : "Watch Only";

  console.log(`${tierLabel}: ALERT SENT: ${summary}`);
  markAlerted(key, analysis.finalScore);
  recordAlertReplay(key, asset, analysis);

  await sendTelegram(
`🚨 CARDINAL EXECUTION ENGINE

Ticker/Pair: ${asset.display}
Market: ${asset.market}
Tier: ${analysis.tierLabel || tier(analysis.finalScore, analysis.ignitionScore)}
Alert Type: ${alertType}
Final Score: ${analysis.finalScore}/100
Ignition Score: ${analysis.ignitionScore}/100
Momentum Quality: ${analysis.momentumQuality}
Continuation Probability: ${analysis.continuationProbability}%
Setup Type: ${analysis.setup}
Price: ${fmtMoney(asset.price, decimals)}
Move: ${Number(analysis.move || 0).toFixed(2)}%
Volume: ${fmtVol(analysis.volume)}
RVOL: ${analysis.relVol?.toFixed?.(2) || "N/A"}
Float: ${analysis.floatStatus}
Catalyst: ${analysis.catalystStatus}
Breakout Pressure: ${analysis.breakoutPressureScore}
Acceleration: ${analysis.accelerationScore}
MTF Confirmation: ${analysis.mtfStatus}
Failed Breakout Risk: ${analysis.failedBreakoutRisk}
Replay Status: ${analysis.replayStatus}
Support: ${analysis.support ? fmtMoney(analysis.support, decimals) : "N/A"}
Breakout Level: ${analysis.breakout ? fmtMoney(analysis.breakout, decimals) : "N/A"}
Best Entry: ${bestEntry}
Stop/Fails Level: ${failLevel}
Profit Zones: ${profitZones}
Risk: ${analysis.risk}
Why It Triggered:
- ${analysis.reasons.slice(0, 5).join("\n- ")}
Chart URL: ${asset.url}

This is a short watch alert. Not financial advice.`
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
    lastChecked: new Date().toISOString(),
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
    updated: value.updated,
  }));

  res.json(data.sort((a, b) => (b.executionScore + b.setupScore) - (a.executionScore + a.setupScore)));
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
