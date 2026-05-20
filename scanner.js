import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STOCK_WATCHLIST = (process.env.STOCK_WATCHLIST || "AMST,AIIO,ASBP,COIN,MARA,RIOT,NVDA,TSLA")
  .split(",")
  .map(s => s.trim().toUpperCase());

const CRYPTO_WATCHLIST = (process.env.CRYPTO_WATCHLIST || "BTC-USD,ETH-USD,XRP-USD,SOL-USD,DOGE-USD")
  .split(",")
  .map(s => s.trim().toUpperCase());

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);
const alerted = new Set();

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Missing Telegram env vars");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    });
  } catch (err) {
    console.log("Telegram Error:", err.response?.data || err.message);
  }
}

async function getYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
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
  const latestVol = volumes.at(-1) || 0;
  const avgVol = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const relVol = avgVol ? latestVol / avgVol : 0;

  return { symbol, price, prevClose, changePct, latestVol, avgVol, relVol };
}

function gradeStock(q) {
  let score = 0;
  if (Math.abs(q.changePct) >= 3) score += 25;
  if (q.changePct >= 5) score += 25;
  if (q.relVol >= 2) score += 25;
  if (q.relVol >= 4) score += 25;

  return score;
}

async function scanStocks() {
  for (const symbol of STOCK_WATCHLIST) {
    try {
      const q = await getYahooQuote(symbol);
      if (!q) continue;

      const score = gradeStock(q);
      const key = `stock-${symbol}-${Math.floor(Date.now() / 1800000)}`;

      if (score >= 50 && !alerted.has(key)) {
        alerted.add(key);

        await sendTelegram(
`🔥 STOCK MOMENTUM ALERT

Ticker: ${symbol}
Price: $${Number(q.price).toFixed(2)}
Change: ${q.changePct.toFixed(2)}%
Relative Volume: ${q.relVol.toFixed(2)}x
Score: ${score}/100

What to check:
- Is it above VWAP?
- Is volume still increasing?
- Is it breaking resistance?
- Is there news/earnings/catalyst?

Not financial advice.`
        );
      }

      console.log(`STOCK ${symbol}: ${q.changePct.toFixed(2)}%, RVOL ${q.relVol.toFixed(2)}x, Score ${score}`);
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

      const score = gradeStock(q);
      const key = `crypto-${symbol}-${Math.floor(Date.now() / 1800000)}`;

      if (score >= 50 && !alerted.has(key)) {
        alerted.add(key);

        await sendTelegram(
`🚨 CRYPTO MOMENTUM ALERT

Asset: ${symbol}
Price: $${Number(q.price).toFixed(4)}
Change: ${q.changePct.toFixed(2)}%
Relative Volume: ${q.relVol.toFixed(2)}x
Score: ${score}/100

What to check:
- Is it breaking resistance?
- Is BTC confirming?
- Is volume expanding?
- Is it holding support?

Not financial advice.`
        );
      }

      console.log(`CRYPTO ${symbol}: ${q.changePct.toFixed(2)}%, RVOL ${q.relVol.toFixed(2)}x, Score ${score}`);
    } catch (err) {
      console.log(`Crypto error ${symbol}:`, err.response?.status || err.message);
    }
  }
}

async function scanAll() {
  console.log("CARDINAL ANALYTICS SCAN RUNNING...");
  await scanStocks();
  await scanCrypto();
  console.log("SCAN COMPLETE");
}

app.get("/", (req, res) => {
  res.send("Cardinal Analytics Stocks + Crypto Scanner Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "stocks_crypto_active",
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