import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_SCORE = Number(process.env.ALERT_SCORE || 70);

const MIN_STOCK_GAIN = Number(process.env.MIN_STOCK_GAIN || 5);
const MIN_STOCK_VOLUME = Number(process.env.MIN_STOCK_VOLUME || 500000);
const MIN_RELATIVE_VOLUME = Number(process.env.MIN_RELATIVE_VOLUME || 2);

const MIN_CRYPTO_GAIN = Number(process.env.MIN_CRYPTO_GAIN || 4);
const MIN_CRYPTO_VOLUME = Number(process.env.MIN_CRYPTO_VOLUME || 1000000);

const state = new Map();
const alerted = new Map();

function nowBucket(minutes = 30) {
  return Math.floor(Date.now() / (minutes * 60 * 1000));
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Missing Telegram env vars");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false
    });
  } catch (err) {
    console.log("Telegram Error:", err.response?.data || err.message);
  }
}

function sma(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pctChange(current, previous) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}

function getCandlesFromYahooResult(result) {
  const quote = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];

  const candles = timestamps.map((t, i) => ({
    time: t,
    open: quote.open?.[i],
    high: quote.high?.[i],
    low: quote.low?.[i],
    close: quote.close?.[i],
    volume: quote.volume?.[i]
  })).filter(c =>
    typeof c.open === "number" &&
    typeof c.high === "number" &&
    typeof c.low === "number" &&
    typeof c.close === "number"
  );

  return candles;
}

async function getYahooCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`;

  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000
  });

  const result = data.chart?.result?.[0];
  if (!result) return null;

  const candles = getCandlesFromYahooResult(result);
  const meta = result.meta || {};

  return {
    symbol,
    price: meta.regularMarketPrice || candles.at(-1)?.close,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    candles
  };
}

async function getPolygonStockDiscovery() {
  if (!POLYGON_API_KEY) {
    console.log("Missing POLYGON_API_KEY");
    return [];
  }

  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLYGON_API_KEY}`;

  const { data } = await axios.get(url, { timeout: 15000 });

  const tickers = data.tickers || [];

  return tickers
    .map(t => {
      const day = t.day || {};
      const prevDay = t.prevDay || {};
      const lastTrade = t.lastTrade || {};
      const price = lastTrade.p || day.c || 0;
      const prevClose = prevDay.c || 0;
      const changePct = pctChange(price, prevClose);
      const volume = day.v || 0;

      return {
        type: "stock",
        symbol: t.ticker,
        price,
        changePct,
        volume
      };
    })
    .filter(x =>
      x.price > 0 &&
      x.changePct >= MIN_STOCK_GAIN &&
      x.volume >= MIN_STOCK_VOLUME
    )
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 35);
}

async function getCoinbaseProducts() {
  const { data } = await axios.get("https://api.exchange.coinbase.com/products", {
    timeout: 10000
  });

  return data
    .filter(p =>
      p.quote_currency === "USD" &&
      !p.trading_disabled &&
      ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "AVAX-USD", "LINK-USD", "ADA-USD", "SUI-USD", "LTC-USD", "BCH-USD", "PEPE-USD"].includes(p.id)
    )
    .map(p => p.id);
}

async function getCoinbaseCandles(symbol) {
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=300`;

  const { data } = await axios.get(url, { timeout: 10000 });

  const candles = data
    .map(c => ({
      time: c[0],
      low: c[1],
      high: c[2],
      open: c[3],
      close: c[4],
      volume: c[5]
    }))
    .sort((a, b) => a.time - b.time);

  const price = candles.at(-1)?.close;

  return {
    symbol,
    price,
    candles
  };
}

async function getCryptoDiscovery() {
  const products = await getCoinbaseProducts();
  const results = [];

  for (const symbol of products) {
    try {
      const data = await getCoinbaseCandles(symbol);
      const candles = data.candles;
      if (candles.length < 20) continue;

      const first = candles.at(-20).close;
      const last = candles.at(-1).close;
      const changePct = pctChange(last, first);
      const volume = candles.slice(-12).reduce((sum, c) => sum + (c.volume * c.close), 0);

      if (changePct >= MIN_CRYPTO_GAIN && volume >= MIN_CRYPTO_VOLUME) {
        results.push({
          type: "crypto",
          symbol,
          price: last,
          changePct,
          volume
        });
      }
    } catch (err) {
      console.log(`Crypto discovery error ${symbol}:`, err.response?.status || err.message);
    }
  }

  return results.sort((a, b) => b.changePct - a.changePct).slice(0, 25);
}

function analyzeSetup(item, candles) {
  if (!candles || candles.length < 25) return null;

  const recent = candles.slice(-24);
  const prior = candles.slice(-48, -24);
  const last = recent.at(-1);

  const closes = recent.map(c => c.close);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const volumes = recent.map(c => c.volume || 0);
  const priorVolumes = prior.map(c => c.volume || 0);

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const priorHigh = prior.length ? Math.max(...prior.map(c => c.high)) : recentHigh;
  const avgVol = sma(volumes.slice(0, -1));
  const priorAvgVol = sma(priorVolumes);
  const relVol = priorAvgVol ? avgVol / priorAvgVol : 1;

  const price = last.close;
  const range = recentHigh - recentLow;
  const rangePct = price ? (range / price) * 100 : 999;

  const higherLow = lows.at(-1) > lows.at(-6);
  const pullbackHeld = price > recentLow * 1.025;
  const tightening = rangePct < 8;
  const volumeCooling = avgVol < priorAvgVol * 1.2;
  const volumeReturning = last.volume > avgVol * 1.35;
  const breakout = price > priorHigh * 1.002 || price >= recentHigh * 0.995;
  const noInstantRejection = price > (last.open || price);
  const trendUp = closes.at(-1) > closes.at(-12);

  let score = 0;
  const reasons = [];

  if (item.changePct >= 5) {
    score += 10;
    reasons.push("strong market move");
  }

  if (relVol >= MIN_RELATIVE_VOLUME) {
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

  if (noInstantRejection) {
    score += 10;
    reasons.push("no instant rejection");
  }

  if (trendUp) {
    score += 10;
    reasons.push("trend still pushing higher");
  }

  const stageB =
    pullbackHeld &&
    higherLow &&
    tightening &&
    volumeCooling;

  const stageC =
    stageB &&
    breakout &&
    volumeReturning &&
    noInstantRejection;

  return {
    score: Math.min(score, 100),
    reasons,
    price,
    support: recentLow,
    breakoutLevel: Math.max(priorHigh, recentHigh),
    relVol,
    stageB,
    stageC,
    setupName: stageC ? "Pullback Hold Breakout" : stageB ? "Consolidation Watch" : "Discovery Watch"
  };
}

async function hydrateItem(item) {
  if (item.type === "stock") {
    const data = await getYahooCandles(item.symbol);
    return data?.candles ? { ...item, candles: data.candles, price: data.price || item.price } : null;
  }

  if (item.type === "crypto") {
    const data = await getCoinbaseCandles(item.symbol);
    return data?.candles ? { ...item, candles: data.candles, price: data.price || item.price } : null;
  }

  return null;
}

function formatMoney(n, decimals = 2) {
  if (!Number.isFinite(n)) return "N/A";
  return `$${n.toFixed(decimals)}`;
}

function formatVolume(n) {
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.round(n)}`;
}

async function processMarketItem(item) {
  const hydrated = await hydrateItem(item);
  if (!hydrated) return null;

  const analysis = analyzeSetup(hydrated, hydrated.candles);
  if (!analysis) return null;

  const key = `${item.type}:${item.symbol}`;
  state.set(key, {
    ...hydrated,
    analysis,
    lastUpdated: new Date().toISOString()
  });

  console.log(
    `${item.type.toUpperCase()} ${item.symbol} | ${analysis.setupName} | Score ${analysis.score} | Move ${item.changePct.toFixed(2)}%`
  );

  const alertKey = `${key}:${nowBucket(30)}`;

  if (analysis.stageC && analysis.score >= ALERT_SCORE && !alerted.has(alertKey)) {
    alerted.set(alertKey, Date.now());

    const link =
      item.type === "stock"
        ? `https://finance.yahoo.com/quote/${item.symbol}`
        : `https://www.coinbase.com/advanced-trade/spot/${item.symbol}`;

    await sendTelegram(
`🚨 CARDINAL ${item.type.toUpperCase()} STRONG SETUP

${item.symbol}
Setup: ${analysis.setupName}
Score: ${analysis.score}/100

Price: ${formatMoney(analysis.price, item.type === "crypto" ? 4 : 2)}
Move: ${item.changePct.toFixed(2)}%
Volume: ${formatVolume(item.volume)}
Relative Volume: ${analysis.relVol.toFixed(2)}x

Support: ${formatMoney(analysis.support, item.type === "crypto" ? 4 : 2)}
Breakout: ${formatMoney(analysis.breakoutLevel, item.type === "crypto" ? 4 : 2)}

Why it alerted:
${analysis.reasons.map(r => `- ${r}`).join("\n")}

Game plan:
- Do NOT chase the first candle
- Look for breakout hold or pullback hold
- Cut if it loses support/VWAP area
- Best setups hold higher lows with volume returning

${link}

Not financial advice.`
    );
  }

  return { item, analysis };
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS 3-STAGE SCANNER RUNNING...");

  try {
    const stocks = await getPolygonStockDiscovery();
    const crypto = await getCryptoDiscovery();

    const discovery = [...stocks, ...crypto];

    console.log(`Stage A Discovery Found: ${discovery.length} movers`);

    for (const item of discovery) {
      try {
        await processMarketItem(item);
      } catch (err) {
        console.log(`Process error ${item.symbol}:`, err.response?.status || err.message);
      }
    }

    console.log("SCAN COMPLETE");
  } catch (err) {
    console.log("Scan error:", err.response?.data || err.message);
  }
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics 3-Stage Stock + Crypto Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "3_stage_stock_crypto_scanner",
    scanInterval: SCAN_INTERVAL_SECONDS,
    alertScore: ALERT_SCORE,
    trackedSetups: state.size,
    lastScan: new Date().toISOString()
  });
});

app.get("/watchlist", (req, res) => {
  const data = [...state.entries()].map(([key, value]) => ({
    key,
    symbol: value.symbol,
    type: value.type,
    price: value.analysis.price,
    score: value.analysis.score,
    setup: value.analysis.setupName,
    support: value.analysis.support,
    breakout: value.analysis.breakoutLevel,
    reasons: value.analysis.reasons,
    updated: value.lastUpdated
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