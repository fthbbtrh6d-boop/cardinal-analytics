import axios from "axios";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(message) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
            }
        );
    } catch (err) {
        console.log("Telegram Error:", err.message);
    }
}

async function scanDexScreener() {
    try {
        const response = await axios.get(
            "https://api.dexscreener.com/latest/dex/search?q=SOL"
        );

        const pairs = response.data.pairs;

        const filtered = pairs.filter((coin) => {
            const liquidity = coin.liquidity?.usd || 0;
            const volume = coin.volume?.h24 || 0;
            const marketCap = coin.marketCap || 0;

            return (
                liquidity > 15000 &&
                liquidity < 150000 &&
                volume > 50000 &&
                marketCap < 5000000
            );
        });

        for (const coin of filtered.slice(0, 3)) {
            const message = `
🚨 CARDINAL ANALYTICS ALERT 🚨

Coin: ${coin.baseToken.name}
Symbol: ${coin.baseToken.symbol}

Price: $${coin.priceUsd}

Liquidity: $${Math.floor(coin.liquidity.usd)}
24H Volume: $${Math.floor(coin.volume.h24)}
Market Cap: $${Math.floor(coin.marketCap)}

Dex: ${coin.dexId}

Chart:
${coin.url}
            `;

            console.log(message);

            await sendTelegramMessage(message);
        }
    } catch (err) {
        console.log("Scanner Error:", err.message);
    }
}

setInterval(scanDexScreener, 30000);

app.get("/", (req, res) => {
    res.send("Cardinal Analytics Scanner Running");
});

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        scanner: "active",
    });
});

app.listen(PORT, () => {
    console.log(`Scanner running on port ${PORT}`);
});