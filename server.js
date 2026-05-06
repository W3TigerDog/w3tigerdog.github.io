import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------- CONFIG ----------
const COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" },
  { id: "binancecoin", symbol: "BNB", name: "BNB" },
  { id: "ripple", symbol: "XRP", name: "XRP" },
  { id: "cardano", symbol: "ADA", name: "Cardano" },
  { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" }
];

const FIAT = "usd";

// 你原来是 10s，CoinGecko 很容易 429
// 建议：本地开发 20-30s；部署看情况
const BASE_FETCH_MS = 20_000;

// 429/错误时最大退避到 5 分钟
const MAX_BACKOFF_MS = 300_000;

// ---------- DB (SQLite) ----------
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, "prices.db");

const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database
});

await db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS ticks (
    coin TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (coin, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_ticks_coin_ts ON ticks (coin, ts);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------- In-memory cache ----------
let latest = {
  ok: false,
  ts: Date.now(),
  prices: {},
  error: null
};

function nowMs() { return Date.now(); }
function coinIds() { return COINS.map(c => c.id); }

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---------- CoinGecko fetch with backoff ----------
let fetchTimer = null;
let backoffMs = BASE_FETCH_MS;

function scheduleNextFetch(delayMs) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(async () => {
    await fetchCoinGecko();
    scheduleNextFetch(backoffMs);
  }, delayMs);
}

async function fetchCoinGecko() {
  const ids = coinIds().join(",");
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", ids);
  url.searchParams.set("vs_currencies", FIAT);
  url.searchParams.set("include_24hr_change", "true");

  try {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });

    // 429: 退避
    if (res.status === 429) {
      backoffMs = Math.min(MAX_BACKOFF_MS, Math.floor(backoffMs * 1.8));
      latest = { ...latest, ok: false, error: "HTTP 429 (rate limited)", ts: nowMs() };
      broadcast({ type: "tick", payload: latest });
      console.log("CoinGecko rate limited. Backoff to", backoffMs, "ms");
      return;
    }

    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    const ts = nowMs();

    const prices = {};
    const insert = await db.prepare("INSERT OR IGNORE INTO ticks (coin, ts, price) VALUES (?, ?, ?)");
    try {
      for (const c of COINS) {
        const row = data?.[c.id];
        const price = row?.[FIAT];
        const chg24 = row?.[`${FIAT}_24h_change`];

        if (typeof price === "number") {
          prices[c.id] = { price, chg24: (typeof chg24 === "number" ? chg24 : null) };
          await insert.run(c.id, ts, price);
        }
      }
    } finally {
      await insert.finalize();
    }

    latest = { ok: true, ts, prices, error: null };
    broadcast({ type: "tick", payload: latest });

    const gainers = await getTopGainers(8);
    broadcast({ type: "gainers", payload: { ts, gainers } });

    // 成功后回到基础间隔
    backoffMs = BASE_FETCH_MS;

    console.log("Fetched prices @", new Date(ts).toISOString());
  } catch (e) {
    // 网络/解析错误也退避一点点
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.floor(backoffMs * 1.3));
    latest = { ...latest, ok: false, error: String(e?.message || e), ts: nowMs() };
    broadcast({ type: "tick", payload: latest });
    console.log("Fetch error:", latest.error, "| backoff:", backoffMs);
  }
}

// ---------- Aggregations ----------
async function getTopGainers(limit = 10) {
  const end = nowMs();
  const start = end - 24 * 60 * 60 * 1000;

  const gainers = [];
  for (const c of COINS) {
    const first = await db.get(
      "SELECT price FROM ticks WHERE coin=? AND ts>=? ORDER BY ts ASC LIMIT 1",
      [c.id, start]
    );
    const last = await db.get(
      "SELECT price FROM ticks WHERE coin=? AND ts<=? ORDER BY ts DESC LIMIT 1",
      [c.id, end]
    );

    if (!first?.price || !last?.price) continue;
    const pct = ((last.price - first.price) / first.price) * 100;

    gainers.push({ coin: c.id, symbol: c.symbol, name: c.name, pct, last: last.price });
  }

  gainers.sort((a, b) => b.pct - a.pct);
  return gainers.slice(0, limit);
}

app.get("/api/gainers", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  const gainers = await getTopGainers(limit);
  res.json({ gainers });
});

// ---------- WebSocket ----------
wss.on("connection", async (ws) => {
  ws.send(JSON.stringify({
    type: "snapshot",
    payload: { latest, coins: COINS, fiat: FIAT }
  }));

  const gainers = await getTopGainers(8);
  ws.send(JSON.stringify({ type: "gainers", payload: { ts: nowMs(), gainers } }));
});







// ---------- Start ----------
server.listen(PORT, () => {
  console.log("Server running on", PORT);

  // 立即抓一次，然后用“自适应退避调度”
  fetchCoinGecko().then(() => {
    backoffMs = BASE_FETCH_MS;
    scheduleNextFetch(backoffMs);
  }).catch(() => {
    scheduleNextFetch(backoffMs);
  });
});
