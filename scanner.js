import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STOCK_WATCHLIST = (process.env.STOCK_WATCHLIST || "AMST,AIIO,ASBP,COIN,MARA,RIOT,NVDA,TSLA,PLTR,AMD")
  .split(",")
  .map(s => s.trim().toUpperCase());

const CRYPTO_WATCHLIST = (process.env.CRYPTO_WATCHLIST || "BTC-USD,ETH-USD,XRP-USD,SOL-USD,DOGE-USD")
  .split(",")
  .map(s => s.trim().toUpperCase());

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const ALERT_SCORE = Number(process.env.ALERT_SCORE || 70);

const alerted = new Set();

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

async function getYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`;

  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const result = data.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};

  const closes = quote.close?.filter(n => typeof n === "number") || [];
  const volumes = quote.volume?.filter(n => typeof n === "number") || [];

  const price = meta.regularMarketPrice || closes.at(-1);
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  const latestVolume = volumes.at(-1) || 0;
  const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const relVol = avgVolume ? latestVolume / avgVolume : 0;

  const recentCloses = closes.slice(-12);
  const highRecent = Math.max(...recentCloses);
  const lowRecent = Math.min(...recentCloses);

  const breakout = price >= highRecent * 0.995;
  const holdingSupport = price > lowRecent * 1.03;
  const momentum = recentCloses.length >= 2 && price > recentCloses[0];

  return {
    symbol,
    price,
    prevClose,
    changePct,
    latestVolume,
    avgVolume,
    relVol,
    breakout,
    holdingSupport,
    momentum,
    highRecent,
    lowRecent
  };
}

function scoreStock(q) {
  let score = 0;
  let reasons = [];

  if (q.changePct >= 3) {
    score += 15;
    reasons.push("green move");
  }

  if (q.changePct >= 8) {
    score += 15;
    reasons.push("strong momentum");
  }

  if (q.relVol >= 1.5) {
    score += 20;
    reasons.push("volume above normal");
  }

  if (q.relVol >= 3) {
    score += 20;
    reasons.push("unusual volume");
  }

  if (q.breakout) {
    score += 20;
    reasons.push("near breakout/highs");
  }

  if (q.holdingSupport) {
    score += 10;
    reasons.push("holding support");
  }

  if (q.momentum) {
    score += 10;
    reasons.push("trend pushing up");
  }

  return { score: Math.min(score, 100), reasons };
}

function scoreCrypto(q) {
  let score = 0;
  let reasons = [];

  if (q.changePct >= 1.5) {
    score += 20;
    reasons.push("crypto momentum");
  }

  if (q.changePct >= 4) {
    score += 20;
    reasons.push("strong crypto push");
  }

  if (q.relVol >= 1.5) {
    score += 20;
    reasons.push("volume expanding");
  }

  if (q.breakout) {
    score += 25;
    reasons.push("breakout setup");
  }

  if (q.holdingSupport) {
    score += 10;
    reasons.push("support holding");
  }

  if (q.momentum) {
    score += 10;
    reasons.push("trend up");
  }

  return { score: Math.min(score, 100), reasons };
}

function label(score) {
  if (score >= 85) return "🔥 STRONG BUY WATCH";
  if (score >= 70) return "✅ GOOD SETUP";
  if (score >= 50) return "👀 WATCH";
  return "AVOID";
}

async function scanStocks() {
  for (const symbol of STOCK_WATCHLIST) {
    try {
      const q = await getYahooQuote(symbol);
      if (!q) continue;

      const s = scoreStock(q);
      const action = label(s.score);

      console.log(`STOCK ${symbol}: ${q.changePct.toFixed(2)}%, RVOL ${q.relVol.toFixed(2)}x, Score ${s.score}, ${action}`);

      const key = `stock-${symbol}-${Math.floor(Date.now() / 1800000)}`;

      if (s.score >= ALERT_SCORE && !alerted.has(key)) {
        alerted.add(key);

        await sendTelegram(
`🔥 CARDINAL STOCK ALERT

${symbol}
Action: ${action}
Score: ${s.score}/100

Price: $${Number(q.price).toFixed(2)}
Move: ${q.changePct.toFixed(2)}%
Relative Volume: ${q.relVol.toFixed(2)}x

Reasons:
${s.reasons.map(r => `- ${r}`).join("\n")}

Game plan:
- Buy only if volume stays strong
- Best entry is pullback + hold OR clean breakout
- Avoid chasing huge candles
- Cut if it loses support/VWAP

Yahoo:
https://finance.yahoo.com/quote/${symbol}

Not financial advice.`
        );
      }
    } catch (err) {
      console.log(`Stock error ${symbol}:`, err.response?.status || err.message);
    }
  }
}

async function scanCrypto() {
  for (const symbol of CRYPTO_WATCHLIST) {
    try {
      const q = await getYahooQuote(symbol);
      if (!q) continue;

      const s = scoreCrypto(q);
      const action = label(s.score);

      console.log(`CRYPTO ${symbol}: ${q.changePct.toFixed(2)}%, RVOL ${q.relVol.toFixed(2)}x, Score ${s.score}, ${action}`);

      const key = `crypto-${symbol}-${Math.floor(Date.now() / 1800000)}`;

      if (s.score >= ALERT_SCORE && !alerted.has(key)) {
        alerted.add(key);

        await sendTelegram(
`🚨 CARDINAL CRYPTO ALERT

${symbol}
Action: ${action}
Score: ${s.score}/100

Price: $${Number(q.price).toFixed(4)}
Move: ${q.changePct.toFixed(2)}%
Relative Volume: ${q.relVol.toFixed(2)}x

Reasons:
${s.reasons.map(r => `- ${r}`).join("\n")}

Game plan:
- Check BTC direction
- Buy only if breakout holds
- Avoid if volume fades
- Cut if support breaks

Yahoo:
https://finance.yahoo.com/quote/${symbol}

Not financial advice.`
        );
      }
    } catch (err) {
      console.log(`Crypto error ${symbol}:`, err.response?.status || err.message);
    }
  }
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS GOOD SETUP SCAN RUNNING...");
  await scanStocks();
  await scanCrypto();
  console.log("SCAN COMPLETE");
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics Good Setup Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "good_setup_stock_crypto_scanner",
    alertScore: ALERT_SCORE,
    stocks: STOCK_WATCHLIST,
    crypto: CRYPTO_WATCHLIST
  });
});

app.get("/scan", async (req, res) => {
  await scanAll();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);
  scanAll();
  setInterval(scanAll, SCAN_INTERVAL_SECONDS * 1000);
});