import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_SCORE = Number(process.env.ALERT_SCORE || 70);

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 5);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 500000);
const MIN_CRYPTO_GAIN = Number(process.env.MIN_CRYPTO_GAIN || 4);
const MIN_CRYPTO_VOLUME = Number(process.env.MIN_CRYPTO_VOLUME || 1000000);

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
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const quotes = data.finance?.result?.[0]?.quotes || [];

    return quotes
      .map(q => ({
        type: "stock",
        symbol: q.symbol,
        price: q.regularMarketPrice || 0,
        changePct: q.regularMarketChangePercent || 0,
        volume: q.regularMarketVolume || 0
      }))
      .filter(x => x.price > 1 && x.changePct >= MIN_STOCK_GAIN && x.volume >= MIN_STOCK_VOLUME)
      .slice(0, 35);
  } catch (err) {
    console.log("Yahoo stock discovery error:", err.message);
    return [];
  }
}

async function getYahooCandles(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=5d&interval=5m`;

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });

    const result = data.chart?.result?.[0];
    if (!result) return null;

    const q = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];

    const candles = ts
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

    return candles;
  } catch (err) {
    console.log(`Yahoo candle error ${symbol}:`, err.message);
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

async function getCoinbaseCandles(symbol) {
  try {
    const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=300`;

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
    const candles = await getCoinbaseCandles(symbol);
    if (!candles || candles.length < 25) continue;

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
        candles
      });
    }
  }

  return movers.sort((a, b) => b.changePct - a.changePct);
}

function analyze(item, candles) {
  if (!candles || candles.length < 30) return null;

  const recent = candles.slice(-24);
  const prior = candles.slice(-48, -24);

  const last = recent.at(-1);
  const closes = recent.map(c => c.close);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const vols = recent.map(c => c.volume || 0);
  const priorVols = prior.map(c => c.volume || 0);

  const price = last.close;
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = prior.length ? Math.max(...prior.map(c => c.high)) : recentHigh;

  const avgVol = avg(vols.slice(0, -1));
  const priorAvgVol = avg(priorVols);
  const relVol = priorAvgVol ? avgVol / priorAvgVol : 1;

  const rangePct = price ? ((recentHigh - recentLow) / price) * 100 : 999;

  const pullbackHeld = price > recentLow * 1.025;
  const higherLow = lows.at(-1) > lows.at(-6);
  const tightening = rangePct < 8;
  const volumeCooling = priorAvgVol ? avgVol < priorAvgVol * 1.25 : true;
  const breakout = price >= Math.max(priorHigh, recentHigh) * 0.995;
  const volumeReturning = last.volume > avgVol * 1.3;
  const noRejection = last.close > last.open;
  const trendUp = closes.at(-1) > closes.at(-12);

  let score = 0;
  const reasons = [];

  if (item.changePct >= 4) {
    score += 10;
    reasons.push("strong market move");
  }
  if (relVol >= 1.5) {
    score += 15;
    reasons.push("relative volume elevated");
  }
  if (pullbackHeld) {
    score += 15;
    reasons.push("pullback held support");
  }
  if (higherLow) {
    score += 15;
    reasons.push("higher low forming");
  }
  if (tightening) {
    score += 10;
    reasons.push("candles tightening");
  }
  if (volumeCooling) {
    score += 10;
    reasons.push("selling pressure cooling");
  }
  if (breakout) {
    score += 15;
    reasons.push("breakout area reached");
  }
  if (volumeReturning) {
    score += 15;
    reasons.push("volume returning");
  }
  if (noRejection) {
    score += 10;
    reasons.push("no instant rejection");
  }
  if (trendUp) {
    score += 10;
    reasons.push("trend pushing higher");
  }

  const stageB = pullbackHeld && higherLow && tightening;
  const stageC = stageB && breakout && volumeReturning && noRejection;

  return {
    score: Math.min(score, 100),
    setup: stageC ? "Pullback Hold Breakout" : stageB ? "Consolidation Watch" : "Discovery Watch",
    stageB,
    stageC,
    price,
    support: recentLow,
    breakoutLevel: Math.max(priorHigh, recentHigh),
    relVol,
    reasons
  };
}

async function processItem(item) {
  let candles = item.candles;

  if (item.type === "stock") {
    candles = await getYahooCandles(item.symbol);
  }

  if (!candles) return;

  const result = analyze(item, candles);
  if (!result) return;

  const key = `${item.type}:${item.symbol}`;

  state.set(key, {
    ...item,
    analysis: result,
    updated: new Date().toISOString()
  });

  console.log(
    `${item.type.toUpperCase()} ${item.symbol} | ${result.setup} | Score ${result.score} | Move ${item.changePct.toFixed(2)}%`
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
`🚨 CARDINAL ${item.type.toUpperCase()} STRONG SETUP

${item.symbol}
Setup: ${result.setup}
Score: ${result.score}/100

Price: ${fmtMoney(result.price, decimals)}
Move: ${item.changePct.toFixed(2)}%
Volume: ${fmtVol(item.volume)}
Relative Volume: ${result.relVol.toFixed(2)}x

Support: ${fmtMoney(result.support, decimals)}
Breakout: ${fmtMoney(result.breakoutLevel, decimals)}

Why it alerted:
${result.reasons.map(r => `- ${r}`).join("\n")}

Game plan:
- Do NOT chase the first candle
- Look for breakout hold or pullback hold
- Cut if it loses support/VWAP area
- Best setups hold higher lows with volume returning

${link}

Not financial advice.`
    );
  }
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS 3-STAGE SCANNER RUNNING...");

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
  res.send("Cardinal Analytics Stock + Crypto Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "stock_crypto_3_stage_no_polygon",
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
    support: value.analysis.support,
    breakout: value.analysis.breakoutLevel,
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