import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_SCORE = Number(process.env.ALERT_SCORE || 85);

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 4);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 300000);
const MIN_CRYPTO_GAIN = Number(process.env.MIN_CRYPTO_GAIN || 3);
const MIN_CRYPTO_VOLUME = Number(process.env.MIN_CRYPTO_VOLUME || 750000);

const state = new Map();
const alerted = new Set();

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

function alertBucket() {
  return Math.floor(Date.now() / (30 * 60 * 1000));
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

        const finalVolume =
          q.preMarketVolume ||
          q.regularMarketVolume ||
          0;

        return {
          type: "stock",
          symbol: q.symbol,
          price: q.regularMarketPrice || q.preMarketPrice || 0,
          changePct: finalMove,
          volume: finalVolume,
          premarket: Math.abs(premarketMove) > 0,
          marketCap: q.marketCap || null,
          floatShares: q.sharesOutstanding || null
        };
      })
      .filter(x =>
        x.price > 1 &&
        x.changePct >= MIN_STOCK_GAIN &&
        x.volume >= MIN_STOCK_VOLUME
      )
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 40);
  } catch (err) {
    console.log("Yahoo stock discovery error:", err.message);
    return [];
  }
}

async function getYahooCandles(symbol, interval = "5m") {
  try {
    const range = interval === "1m" ? "1d" : interval === "15m" ? "5d" : "5d";
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
    console.log(`Yahoo candle error ${symbol} ${interval}:`, err.message);
    return null;
  }
}

const CRYPTO_PRODUCTS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "DOGE-USD",
  "AVAX-USD",
  "LINK-USD",
  "ADA-USD",
  "SUI-USD",
  "LTC-USD",
  "BCH-USD",
  "PEPE-USD"
];

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
    console.log(`Coinbase candle error ${symbol}:`, err.response?.status || err.message);
    return null;
  }
}

async function getCryptoDiscovery() {
  const movers = [];

  for (const symbol of CRYPTO_PRODUCTS) {
    const candles = await getCoinbaseCandles(symbol, 300);
    if (!candles || candles.length < 30) continue;

    const recent = candles.slice(-24);
    const first = recent[0].close;
    const last = recent.at(-1).close;
    const changePct = pct(last, first);
    const dollarVolume = recent.reduce((sum, c) => sum + c.volume * c.close, 0);

    if (changePct >= MIN_CRYPTO_GAIN && dollarVolume >= MIN_CRYPTO_VOLUME) {
      movers.push({
        type: "crypto",
        symbol,
        price: last,
        changePct,
        volume: dollarVolume,
        premarket: false,
        marketCap: null,
        floatShares: null,
        candles
      });
    }
  }

  return movers.sort((a, b) => b.changePct - a.changePct);
}

function trendCheck(candles) {
  if (!candles || candles.length < 20) {
    return {
      shortTrend: false,
      mediumTrend: false,
      longTrend: false,
      aligned: false
    };
  }

  const closes = candles.map(c => c.close);

  const shortTrend = closes.at(-1) > closes.at(-4);
  const mediumTrend = closes.at(-1) > closes.at(-12);
  const longTrend = closes.at(-1) > closes.at(-20);

  return {
    shortTrend,
    mediumTrend,
    longTrend,
    aligned: shortTrend && mediumTrend && longTrend
  };
}

function analyze(item, candles, candles1m = null, candles15m = null) {
  if (!candles || candles.length < 50) return null;

  const recent = candles.slice(-24);
  const prior = candles.slice(-48, -24);

  const last = recent.at(-1);
  const prev = recent.at(-2);

  const closes = recent.map(c => c.close);
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
  const rawRelVol = priorAvgVol > 0 ? avgVol / priorAvgVol : 1;
  const relVol = Math.min(rawRelVol, 15);

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;

  const support = recentLow;
  const breakoutLevel = Math.max(priorHigh, recentHigh);

  const pullbackHeld = price > support * 1.025;
  const higherLow = lows.at(-1) > lows.at(-8);
  const tightening = rangePct < 7.5;
  const volumeCooling = priorAvgVol ? avgVol < priorAvgVol * 1.25 : true;

  const breakoutCandle = price > breakoutLevel * 1.002;
  const volumeReturning = last.volume > avgVol * 1.5;
  const greenCandle = last.close > last.open;
  const closesStrong = last.close > ((last.high + last.low) / 2);
  const noInstantRejection = greenCandle && closesStrong;

  const retestHeld =
    prev &&
    prev.close >= breakoutLevel * 0.985 &&
    last.close >= breakoutLevel * 0.995;

  const fiveMinTrend = trendCheck(candles);
  const oneMinTrend = trendCheck(candles1m);
  const fifteenMinTrend = trendCheck(candles15m);

  const multiTimeframeAligned =
    fiveMinTrend.aligned &&
    (!candles1m || oneMinTrend.shortTrend) &&
    (!candles15m || fifteenMinTrend.mediumTrend || fifteenMinTrend.longTrend);

  const lowFloat =
    item.type === "stock" &&
    item.floatShares &&
    item.floatShares < 20_000_000;

  const mediumFloat =
    item.type === "stock" &&
    item.floatShares &&
    item.floatShares >= 20_000_000 &&
    item.floatShares < 100_000_000;

  const overextended = item.changePct > 35;

  const exhaustionRisk =
    rangePct > 14 ||
    (last.high - last.close) > (last.high - last.low) * 0.45 ||
    overextended;

  const catalystPlaceholder =
    item.changePct >= 12 || item.premarket;

  let score = 0;
  const reasons = [];

  if (item.premarket) {
    score += 8;
    reasons.push("premarket mover");
  }

  if (item.changePct >= 4) {
    score += 10;
    reasons.push("strong market move");
  }

  if (item.changePct >= 10) {
    score += 8;
    reasons.push("major momentum move");
  }

  if (relVol >= 1.5) {
    score += 12;
    reasons.push("relative volume elevated");
  }

  if (relVol >= 3) {
    score += 10;
    reasons.push("unusual relative volume");
  }

  if (pullbackHeld) {
    score += 12;
    reasons.push("pullback held support");
  }

  if (higherLow) {
    score += 12;
    reasons.push("higher low forming");
  }

  if (tightening) {
    score += 10;
    reasons.push("candles tightening");
  }

  if (volumeCooling) {
    score += 8;
    reasons.push("selling pressure cooling");
  }

  if (breakoutCandle) {
    score += 15;
    reasons.push("true breakout candle");
  }

  if (volumeReturning) {
    score += 15;
    reasons.push("volume returning strongly");
  }

  if (retestHeld) {
    score += 12;
    reasons.push("breakout/retest holding");
  }

  if (noInstantRejection) {
    score += 10;
    reasons.push("no instant rejection");
  }

  if (fiveMinTrend.aligned) {
    score += 10;
    reasons.push("5m trend aligned");
  }

  if (multiTimeframeAligned) {
    score += 15;
    reasons.push("multi-timeframe trend alignment");
  }

  if (lowFloat) {
    score += 10;
    reasons.push("low float squeeze potential");
  } else if (mediumFloat) {
    score += 5;
    reasons.push("medium float momentum profile");
  }

  if (catalystPlaceholder) {
    score += 5;
    reasons.push("possible catalyst/news runner");
  }

  if (exhaustionRisk) {
    score -= 20;
    reasons.push("warning: possible exhaustion or rejection risk");
  }

  const stageB =
    pullbackHeld &&
    higherLow &&
    tightening &&
    volumeCooling;

  const stageC =
    stageB &&
    breakoutCandle &&
    volumeReturning &&
    noInstantRejection &&
    retestHeld &&
    !exhaustionRisk &&
    relVol >= 1.2;

  let risk = "Normal";
  if (item.changePct > 25 || rangePct > 10 || lowFloat) risk = "High volatility";
  if (exhaustionRisk) risk = "High rejection risk";

  return {
    score: Math.max(0, Math.min(score, 100)),
    setup: stageC ? "Confirmed Breakout Continuation" : stageB ? "Consolidation Watch" : "Discovery Watch",
    stageB,
    stageC,
    price,
    support,
    breakoutLevel,
    relVol,
    rawRelVol,
    rangePct,
    lowFloat,
    mediumFloat,
    multiTimeframeAligned,
    risk,
    reasons
  };
}

async function processItem(item) {
  let candles5m = item.candles;
  let candles1m = null;
  let candles15m = null;

  if (item.type === "stock") {
    candles5m = await getYahooCandles(item.symbol, "5m");
    candles1m = await getYahooCandles(item.symbol, "1m");
    candles15m = await getYahooCandles(item.symbol, "15m");
  }

  if (item.type === "crypto") {
    candles1m = await getCoinbaseCandles(item.symbol, 60);
    candles15m = await getCoinbaseCandles(item.symbol, 900);
  }

  if (!candles5m) return;

  const result = analyze(item, candles5m, candles1m, candles15m);
  if (!result) return;

  if (result.score < 60) return;

  const key = `${item.type}:${item.symbol}`;

  state.set(key, {
    ...item,
    analysis: result,
    updated: new Date().toISOString()
  });

  console.log(
    `${item.type.toUpperCase()} ${item.symbol} | ${result.setup} | Score ${result.score} | Move ${item.changePct.toFixed(2)}% | RVOL ${result.relVol.toFixed(2)}x`
  );

  const alertKey = `${key}:${alertBucket()}`;

  if (result.stageC && result.score >= ALERT_SCORE && !alerted.has(alertKey)) {
    alerted.add(alertKey);

    const decimals = item.type === "crypto" ? 4 : 2;
    const link =
      item.type === "stock"
        ? `https://finance.yahoo.com/quote/${item.symbol}`
        : `https://www.coinbase.com/advanced-trade/spot/${item.symbol}`;

    await sendTelegram(
`🚨 CARDINAL ANALYTICS ALERT

${item.symbol}
Asset: ${item.type.toUpperCase()}
Stage: BREAKOUT CONFIRMED
Setup: ${result.setup}
Score: ${result.score}/100
Risk: ${result.risk}

Price: ${fmtMoney(result.price, decimals)}
Move: ${item.changePct.toFixed(2)}%
Premarket: ${item.premarket ? "YES" : "NO"}
Volume: ${fmtVol(item.volume)}
Relative Volume: ${result.relVol.toFixed(2)}x

Support: ${fmtMoney(result.support, decimals)}
Breakout: ${fmtMoney(result.breakoutLevel, decimals)}

Structure:
${result.reasons.map(r => `- ${r}`).join("\n")}

Game plan:
- Do NOT chase if it is already extended
- Best entry is breakout hold or pullback hold
- Cut if it loses support/VWAP area
- Size smaller on high-volatility names
- Avoid if volume fades after alert

${link}

Not financial advice.`
    );
  }
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS V1 SCANNER RUNNING...");

  const stocks = await getYahooStockDiscovery();
  const crypto = await getCryptoDiscovery();
  const discovery = [...stocks, ...crypto];

  console.log(`Stage A Discovery Found: ${discovery.length} movers`);

  for (const item of discovery) {
    try {
      await processItem(item);
    } catch (err) {
      console.log(`Process error ${item.symbol}:`, err.message);
    }
  }

  console.log("SCAN COMPLETE");
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics V1 Stock + Crypto Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "cardinal_analytics_v1_stock_crypto",
    interval: SCAN_INTERVAL_SECONDS,
    alertScore: ALERT_SCORE,
    tracked: state.size,
    lastChecked: new Date().toISOString()
  });
});

app.get("/watchlist", (req, res) => {
  const data = [...state.entries()].map(([key, value]) => ({
    key,
    symbol: value.symbol,
    type: value.type,
    price: value.analysis.price,
    score: value.analysis.score,
    setup: value.analysis.setup,
    risk: value.analysis.risk,
    premarket: value.premarket,
    relativeVolume: value.analysis.relVol,
    support: value.analysis.support,
    breakout: value.analysis.breakoutLevel,
    lowFloat: value.analysis.lowFloat,
    multiTimeframeAligned: value.analysis.multiTimeframeAligned,
    reasons: value.analysis.reasons,
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