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
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 45);
const ALLOW_LOW_RVOL_BREAKOUTS =
  String(process.env.ALLOW_LOW_RVOL_BREAKOUTS || "true").toLowerCase() === "true";

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 4);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 300000);

const MIN_COINBASE_VOLUME_24H = Number(process.env.MIN_COINBASE_VOLUME_24H || 1000000);

const MIN_DEX_LIQUIDITY = Number(process.env.MIN_DEX_LIQUIDITY || 25000);
const MAX_DEX_LIQUIDITY = Number(process.env.MAX_DEX_LIQUIDITY || 5000000);
const MIN_DEX_VOLUME_5M = Number(process.env.MIN_DEX_VOLUME_5M || 3000);
const MIN_DEX_TXNS_5M = Number(process.env.MIN_DEX_TXNS_5M || 20);

const WATCHLIST_SCORE = Number(process.env.WATCHLIST_SCORE || 60);
const DISCOVERY_SCORE = Number(process.env.DISCOVERY_SCORE || 70);
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

function fmtMoney(n, decimals = 2) {
  return Number.isFinite(n) ? `$${n.toFixed(decimals)}` : "N/A";
}

function fmtVol(n) {
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.round(n)}`;
}

function tierFromScore(score) {
  if (score >= PARABOLIC_SCORE) return "PARABOLIC";
  if (score >= MOMENTUM_SCORE) return "MOMENTUM";
  if (score >= DISCOVERY_SCORE) return "DISCOVERY";
  if (score >= WATCHLIST_SCORE) return "WATCHLIST";
  return "NO ALERT";
}

function cooldownPassed(key) {
  const previous = alertMemory.get(key);
  if (!previous) return true;
  return Date.now() - previous.time > ALERT_COOLDOWN_MINUTES * 60 * 1000;
}

function markAlerted(key, score) {
  alertMemory.set(key, {
    time: Date.now(),
    score
  });
}

function shouldSendAlert(asset, analysis, key) {
  if (!analysis) return { send: false, block: "Alert BLOCKED: no analysis" };

  if (analysis.blockReason) {
    return { send: false, block: analysis.blockReason };
  }

  if (!cooldownPassed(key)) {
    return { send: false, block: "Alert BLOCKED: cooldown active" };
  }

  if (analysis.score >= MOMENTUM_SCORE) {
    return { send: true, block: null };
  }

  const cleanEarlySetup =
    ALLOW_LOW_RVOL_BREAKOUTS &&
    analysis.score >= DISCOVERY_SCORE &&
    ["Breakout Watch", "Consolidation Watch", "DEX Discovery Watch", "Crypto Momentum Watch"].includes(
      analysis.setup
    );

  if (cleanEarlySetup) {
    return { send: true, block: null };
  }

  return { send: false, block: "Alert BLOCKED: score below threshold" };
}

async function getYahooStockDiscovery() {
  try {
    const url =
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=75";

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const quotes = data.finance?.result?.[0]?.quotes || [];

    return quotes
      .map(q => {
        const premarketMove = q.preMarketChangePercent || 0;
        const regularMove = q.regularMarketChangePercent || 0;

        const finalMove =
          Math.abs(premarketMove) > Math.abs(regularMove)
            ? premarketMove
            : regularMove;

        const finalVolume = q.preMarketVolume || q.regularMarketVolume || 0;

        return {
          market: "STOCK",
          type: "stock",
          symbol: q.symbol,
          display: q.symbol,
          price: q.regularMarketPrice || q.preMarketPrice || 0,
          changePct: finalMove,
          volume: finalVolume,
          premarket: Math.abs(premarketMove) > 0,
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
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=${range}&interval=${interval}`;

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
      .filter(
        c =>
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

function trendCheck(candles) {
  if (!candles || candles.length < 20) {
    return { shortTrend: false, mediumTrend: false, longTrend: false, aligned: false };
  }

  const closes = candles.map(c => c.close);
  const shortTrend = closes.at(-1) > closes.at(-4);
  const mediumTrend = closes.at(-1) > closes.at(-12);
  const longTrend = closes.at(-1) > closes.at(-20);

  return { shortTrend, mediumTrend, longTrend, aligned: shortTrend && mediumTrend && longTrend };
}

function analyzeStock(asset, candles5m, candles1m, candles15m) {
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

  const price = last.close;
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = Math.max(...prior.map(c => c.high));

  const avgVol = avg(vols.slice(0, -1));
  const priorAvgVol = avg(priorVols);
  const relVol = Math.min(priorAvgVol > 0 ? avgVol / priorAvgVol : 1, 15);

  const support = recentLow;
  const breakout = Math.max(priorHigh, recentHigh);

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;

  const pullbackHeld = price > support * 1.025;
  const higherLow = lows.at(-1) > lows.at(-8);
  const tightening = rangePct < 7.5;
  const volumeCooling = priorAvgVol ? avgVol < priorAvgVol * 1.25 : true;
  const breakoutCandle = price > breakout * 1.002;
  const volumeReturning = last.volume > avgVol * 1.35;
  const noRejection = last.close > last.open && last.close > (last.high + last.low) / 2;

  const retestHeld =
    prev && prev.close >= breakout * 0.985 && last.close >= breakout * 0.995;

  const trend5m = trendCheck(candles5m);
  const trend1m = trendCheck(candles1m);
  const trend15m = trendCheck(candles15m);

  const multiTimeframe =
    trend5m.aligned &&
    (!candles1m || trend1m.shortTrend) &&
    (!candles15m || trend15m.mediumTrend || trend15m.longTrend);

  const lowFloat = asset.floatShares && asset.floatShares < 20_000_000;
  const extended = asset.changePct > 35;
  const wickRisk = (last.high - last.close) > (last.high - last.low) * 0.45;
  const exhaustionRisk = extended || wickRisk || rangePct > 14;

  let score = 0;
  const reasons = [];

  if (asset.premarket) {
    score += 8;
    reasons.push("premarket mover");
  }
  if (asset.changePct >= 4) {
    score += 10;
    reasons.push("strong stock move");
  }
  if (asset.changePct >= 10) {
    score += 8;
    reasons.push("major momentum move");
  }
  if (relVol >= 1.2) {
    score += 8;
    reasons.push("RVOL noticeable");
  }
  if (relVol >= 2) {
    score += 10;
    reasons.push("RVOL strong");
  }
  if (pullbackHeld) {
    score += 10;
    reasons.push("pullback held support");
  }
  if (higherLow) {
    score += 10;
    reasons.push("higher low forming");
  }
  if (tightening) {
    score += 8;
    reasons.push("candles tightening");
  }
  if (volumeCooling) {
    score += 6;
    reasons.push("selling pressure cooling");
  }
  if (breakoutCandle) {
    score += 14;
    reasons.push("breakout candle");
  }
  if (volumeReturning) {
    score += 12;
    reasons.push("volume returning");
  }
  if (retestHeld) {
    score += 10;
    reasons.push("breakout/retest holding");
  }
  if (noRejection) {
    score += 8;
    reasons.push("no instant rejection");
  }
  if (multiTimeframe) {
    score += 12;
    reasons.push("multi-timeframe trend alignment");
  }
  if (lowFloat) {
    score += 8;
    reasons.push("low float squeeze potential");
  }
  if (exhaustionRisk) {
    score -= 18;
    reasons.push("warning: exhaustion/rejection risk");
  }

  const consolidation = pullbackHeld && higherLow && tightening;
  const confirmedBreakout =
    consolidation && breakoutCandle && noRejection && (volumeReturning || ALLOW_LOW_RVOL_BREAKOUTS);

  const setup = confirmedBreakout
    ? "Breakout Watch"
    : consolidation
      ? "Consolidation Watch"
      : "Stock Discovery Watch";

  const risk = exhaustionRisk ? "High" : lowFloat || asset.changePct > 20 ? "Medium-High" : "Medium";

  return {
    score: Math.max(0, Math.min(score, 100)),
    tier: tierFromScore(score),
    setup,
    move: asset.changePct,
    relVol,
    volume: asset.volume,
    support,
    breakout,
    risk,
    reasons
  };
}

async function scanStocks() {
  if (!ENABLE_STOCKS) {
    console.log("STOCK: disabled");
    return [];
  }

  const discovered = await getYahooStockDiscovery();
  const results = [];

  for (const asset of discovered) {
    try {
      const candles5m = await getYahooCandles(asset.symbol, "5m");
      const candles1m = await getYahooCandles(asset.symbol, "1m");
      const candles15m = await getYahooCandles(asset.symbol, "15m");

      const analysis = analyzeStock(asset, candles5m, candles1m, candles15m);
      const key = `STOCK:${asset.symbol}`;

      state.set(key, { asset, analysis, updated: new Date().toISOString() });

      console.log(
        `STOCK: ${asset.symbol} | ${analysis.setup} | Score ${analysis.score} | Move ${analysis.move.toFixed(
          2
        )}% | RVOL ${analysis.relVol?.toFixed?.(2) || "N/A"} | Risk ${analysis.risk}`
      );

      await maybeAlert(asset, analysis, key);
      results.push({ asset, analysis });
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

function analyzeCoinbase(asset, candles5m) {
  if (!candles5m || candles5m.length < 60) {
    return { score: 0, setup: "No Data", blockReason: "Alert BLOCKED: score below threshold" };
  }

  const recent24 = candles5m.slice(-288);
  const recent12 = candles5m.slice(-144);
  const recent1h = candles5m.slice(-12);
  const prior1h = candles5m.slice(-24, -12);

  const first = recent24[0]?.close || recent12[0]?.close;
  const last = candles5m.at(-1).close;

  const move24h = pct(last, first);
  const move1h = pct(last, recent1h[0].close);

  const dollarVolume24h = recent24.reduce((sum, c) => sum + c.volume * c.close, 0);
  const volume1h = recent1h.reduce((sum, c) => sum + c.volume * c.close, 0);
  const priorVolume1h = prior1h.reduce((sum, c) => sum + c.volume * c.close, 0);

  const relVol = Math.min(priorVolume1h ? volume1h / priorVolume1h : 1, 15);

  const highs = recent1h.map(c => c.high);
  const lows = recent1h.map(c => c.low);
  const support = Math.min(...lows);
  const breakout = Math.max(...highs);

  const trend = trendCheck(candles5m);
  const momentum = last > recent1h[0].close;
  const breakoutLike = last >= breakout * 0.995;
  const consolidation = last > support * 1.015 && momentum;

  let score = 0;
  const reasons = [];

  if (move24h >= 3) {
    score += 12;
    reasons.push("positive 24h crypto move");
  }
  if (move24h >= 8) {
    score += 12;
    reasons.push("strong 24h crypto momentum");
  }
  if (move1h >= 1.5) {
    score += 10;
    reasons.push("1h momentum building");
  }
  if (dollarVolume24h >= MIN_COINBASE_VOLUME_24H) {
    score += 10;
    reasons.push("24h volume liquid enough");
  }
  if (relVol >= 1.2) {
    score += 10;
    reasons.push("crypto volume expanding");
  }
  if (relVol >= 2) {
    score += 10;
    reasons.push("strong crypto relative volume");
  }
  if (trend.aligned) {
    score += 14;
    reasons.push("crypto trend aligned");
  }
  if (momentum) {
    score += 10;
    reasons.push("momentum positive");
  }
  if (breakoutLike) {
    score += 12;
    reasons.push("near crypto breakout area");
  }
  if (consolidation) {
    score += 10;
    reasons.push("crypto consolidation holding");
  }

  const setup = breakoutLike
    ? "Crypto Momentum Watch"
    : consolidation
      ? "Consolidation Watch"
      : "Crypto Discovery Watch";

  const risk = move24h > 18 ? "High" : "Medium";

  return {
    score: Math.max(0, Math.min(score, 100)),
    tier: tierFromScore(score),
    setup,
    move: move24h,
    relVol,
    volume: dollarVolume24h,
    support,
    breakout,
    risk,
    reasons
  };
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

      const last = candles.at(-1).close;

      const asset = {
        market: "COINBASE",
        type: "coinbase",
        symbol,
        display: symbol,
        price: last,
        changePct: 0,
        volume: 0,
        url: `https://www.coinbase.com/advanced-trade/spot/${symbol}`
      };

      const analysis = analyzeCoinbase(asset, candles);
      asset.changePct = analysis.move;
      asset.volume = analysis.volume;

      const key = `COINBASE:${symbol}`;
      state.set(key, { asset, analysis, updated: new Date().toISOString() });

      console.log(
        `COINBASE: ${symbol} | ${analysis.setup} | Score ${analysis.score} | Move ${analysis.move.toFixed(
          2
        )}% | RVOL ${analysis.relVol.toFixed(2)} | Risk ${analysis.risk}`
      );

      await maybeAlert(asset, analysis, key);
      results.push({ asset, analysis });
    } catch (err) {
      console.log(`COINBASE: process error ${symbol}:`, err.message);
    }
  }

  return results;
}

async function getDexScreenerPairs() {
  try {
    const url = "https://api.dexscreener.com/latest/dex/search?q=solana";
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data.pairs) ? data.pairs : [];
  } catch (err) {
    console.log("DEX: DexScreener error:", err.message);
    return [];
  }
}

function analyzeDexPair(pair) {
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

  if (liquidity > MAX_DEX_LIQUIDITY) {
    return { score: 0, setup: "Liquidity Too High", blockReason: "Alert BLOCKED: score below threshold" };
  }

  const buyRatio = txns5m ? buys5m / txns5m : 0;
  const pressure = liquidity ? vol5m / liquidity : 0;
  const relVol = Math.min(pressure * 20, 15);

  let score = 0;
  const reasons = [];

  if (liquidity >= MIN_DEX_LIQUIDITY) {
    score += 10;
    reasons.push("liquidity passes filter");
  }
  if (liquidity >= 50000) {
    score += 8;
    reasons.push("liquidity stronger");
  }
  if (vol5m >= MIN_DEX_VOLUME_5M) {
    score += 14;
    reasons.push("5m volume active");
  }
  if (vol5m >= MIN_DEX_VOLUME_5M * 3) {
    score += 12;
    reasons.push("5m volume accelerating");
  }
  if (txns5m >= MIN_DEX_TXNS_5M) {
    score += 12;
    reasons.push("5m transactions active");
  }
  if (txns5m >= MIN_DEX_TXNS_5M * 2) {
    score += 10;
    reasons.push("transaction velocity rising");
  }
  if (change5m >= 2) {
    score += 10;
    reasons.push("positive 5m price change");
  }
  if (change5m >= 6 || change1h >= 12) {
    score += 12;
    reasons.push("strong short-term DEX momentum");
  }
  if (buyRatio >= 0.55 && txns5m >= MIN_DEX_TXNS_5M) {
    score += 10;
    reasons.push("buyers leading sellers");
  }
  if (marketCap > 0 && marketCap < 20_000_000) {
    score += 8;
    reasons.push("early market cap range");
  }
  if (pressure >= 0.1) {
    score += 8;
    reasons.push("volume/liquidity pressure building");
  }

  let risk = "Medium";

  if (liquidity < 50000) risk = "High";
  if (sells5m > buys5m * 1.4 && txns5m >= 20) {
    score -= 15;
    risk = "High";
    reasons.push("warning: sell pressure heavy");
  }
  if (change5m > 30) {
    score -= 12;
    risk = "High";
    reasons.push("warning: parabolic 5m move");
  }

  const setup =
    score >= MOMENTUM_SCORE
      ? "DEX Momentum Breakout"
      : score >= DISCOVERY_SCORE
        ? "DEX Discovery Watch"
        : "DEX Watchlist";

  return {
    score: Math.max(0, Math.min(score, 100)),
    tier: tierFromScore(score),
    setup,
    move: Math.max(change5m, change1h),
    relVol,
    volume: vol5m,
    support: null,
    breakout: null,
    risk,
    reasons,
    liquidity,
    vol5m,
    txns5m
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

      const analysis = analyzeDexPair(pair);
      const key = `DEX:${pair.chainId}:${pair.pairAddress}`;

      state.set(key, { asset, analysis, updated: new Date().toISOString() });

      console.log(
        `DEX: ${display} | ${analysis.setup} | Score ${analysis.score} | Liquidity ${fmtVol(
          liquidity
        )} | Vol5m ${fmtVol(vol5m)} | Txns5m ${txns5m} | Risk ${analysis.risk}`
      );

      await maybeAlert(asset, analysis, key);
      results.push({ asset, analysis });
    } catch (err) {
      console.log("DEX: process error:", err.message);
    }
  }

  return results;
}

async function maybeAlert(asset, analysis, key) {
  const decision = shouldSendAlert(asset, analysis, key);

  if (!decision.send) {
    console.log(`${asset.market}: ${asset.display} | ${decision.block}`);
    return;
  }

  markAlerted(key, analysis.score);

  const tier = tierFromScore(analysis.score);

  await sendTelegram(
`🚨 CARDINAL ANALYTICS ALERT

Ticker/Pair: ${asset.display}
Market: ${asset.market}
Tier: ${tier}
Score: ${analysis.score}/100
Setup: ${analysis.setup}
Move: ${Number(analysis.move || 0).toFixed(2)}%
RVOL or Volume: ${asset.market === "DEX" ? fmtVol(analysis.vol5m || analysis.volume) : `${analysis.relVol?.toFixed?.(2) || "N/A"}x`}
Support: ${analysis.support ? fmtMoney(analysis.support, asset.market === "STOCK" ? 2 : 6) : "N/A"}
Breakout: ${analysis.breakout ? fmtMoney(analysis.breakout, asset.market === "STOCK" ? 2 : 6) : "N/A"}
Risk: ${analysis.risk}
Reason:
${analysis.reasons.map(r => `- ${r}`).join("\n")}
URL: ${asset.url}

Alerts only. Not financial advice.`
  );
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS V3 SCAN STARTING...");

  const results = [];

  if (ENABLE_STOCKS) results.push(...(await scanStocks()));
  if (ENABLE_COINBASE) results.push(...(await scanCoinbaseCrypto()));
  if (ENABLE_DEXSCREENER) results.push(...(await scanDexScreener()));

  console.log(`SCAN COMPLETE | Total tracked this run: ${results.length}`);
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics V3 Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "cardinal_analytics_v3",
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
    score: value.analysis.score,
    tier: tierFromScore(value.analysis.score),
    setup: value.analysis.setup,
    move: value.analysis.move,
    volume: value.analysis.volume,
    liquidity: value.asset.liquidity || null,
    support: value.analysis.support,
    breakout: value.analysis.breakout,
    risk: value.analysis.risk,
    reasons: value.analysis.reasons,
    url: value.asset.url,
    updated: value.updated
  }));

  res.json(data.sort((a, b) => b.score - a.score));
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