const fs = require("fs");
const https = require("https");
const path = require("path");

const API_KEY = process.env.VIDIQ_API_KEY || "vidiq_X56YDx57h612EW_0v0tJjUoLw6fwWREMgJbFozpX";
const TIER1_COUNTRIES = new Set(["US", "CA", "GB", "AU", "NZ"]);

function callVidiq(keyword) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "vidiq_keyword_research",
        arguments: { keyword, mode: "research" }
      }
    });

    const req = https.request("https://mcp.vidiq.com/mcp", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const line = data.split(/\r?\n/).find(l => l.startsWith("data:"));
          if (!line) {
            return resolve(null);
          }
          const json = JSON.parse(line.slice(5).trim());
          const text = json.result?.content?.[0]?.text || "";
          const idx = text.indexOf("{");
          if (idx !== -1) {
            const parsed = JSON.parse(text.slice(idx));
            resolve(parsed);
          } else {
            resolve(null);
          }
        } catch (e) {
          console.error(`Error parsing response for "${keyword}":`, e.message);
          resolve(null);
        }
      });
    });

    req.on("error", (e) => {
      console.error(`Request error for "${keyword}":`, e.message);
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

function parseMarkets(markets) {
  if (!markets || !Array.isArray(markets) || markets.length === 0) {
    return { usShare: null, tier1Share: null, top5Str: "" };
  }

  let usShare = null;
  let tier1Share = 0;
  const top5Parts = [];

  markets.slice(0, 5).forEach(m => {
    const code = m.country || "";
    const pct = typeof m.pct === "number" ? m.pct * 100 : 0;
    if (code === "US") {
      usShare = pct;
    }
    if (TIER1_COUNTRIES.has(code)) {
      tier1Share += pct;
    }
    top5Parts.push(`${code}: ${pct.toFixed(1)}%`);
  });

  return {
    usShare: usShare !== null ? parseFloat(usShare.toFixed(1)) : 0,
    tier1Share: parseFloat(tier1Share.toFixed(1)),
    top5Str: top5Parts.join(", ")
  };
}

function calcOpportunityScore(volScore, compScore, usShare) {
  const v = typeof volScore === "number" ? volScore : 0;
  const c = typeof compScore === "number" ? compScore : 50;
  const lowComp = Math.max(0, 100 - c);

  if (typeof usShare === "number") {
    // 35% Volume + 35% Low Competition + 30% US Audience Share
    return parseFloat((0.35 * v + 0.35 * lowComp + 0.30 * usShare).toFixed(1));
  } else {
    // Missing geo: 50% Volume + 50% Low Competition
    return parseFloat((0.50 * v + 0.50 * lowComp).toFixed(1));
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  callVidiq,
  parseMarkets,
  calcOpportunityScore,
  sleep
};
