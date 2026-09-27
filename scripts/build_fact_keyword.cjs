const fs = require("fs");
const path = require("path");
const { callVidiq, parseMarkets, calcOpportunityScore, sleep } = require("./vidiq_research_helper.cjs");

const CACHE_FILE = path.resolve(__dirname, "../writer-room-data/spy-sheet/keyword_cache.json");
const OUTPUT_FILE = path.resolve(__dirname, "../writer-room-data/spy-sheet/inbox/fact_keyword.tsv");

// 15 required unpacked keywords from old sheet's "Low Comp" column
const REQUIRED_LOW_COMP = [
  "wealth mindset",
  "building wealth",
  "what is investment banking",
  "bad money habits and how to break them",
  "bad money habits examples",
  "money habits of millionaires",
  "stock market investing",
  "retire early",
  "levels of financial independence",
  "financial independence motivation",
  "saving money hacks",
  "money saving hacks",
  "how to start saving money",
  "frugal living",
  "index funds for beginners"
];

// Original 7 seeds
const ORIGINAL_SEEDS = [
  "pov finance",
  "money habits",
  "how to build wealth",
  "financial independence",
  "saving money",
  "index fund investing",
  "finance storytelling"
];

// 45+ targeted US POV longtail keywords
const TARGETED_LONGTAILS = [
  "what nobody tells you about money",
  "what nobody tells you about saving money",
  "what nobody tells you about your 30s",
  "what nobody tells you about your first 100k",
  "the true cost of a normal american lifestyle",
  "the true cost of homeownership",
  "the true cost of buying a new car",
  "the true cost of living in america",
  "paid off mortgage early",
  "paid off mortgage at 30",
  "retired early nobody knows",
  "retired early at 40",
  "retired early at 35",
  "silent habits keeping you poor",
  "silent fees draining your bank account",
  "habits keeping you middle class",
  "net worth by age",
  "average net worth by age in america",
  "median net worth by age",
  "stealth wealth habits",
  "signs of stealth wealth",
  "underconsumption core",
  "underconsumption trend",
  "living on dividends",
  "living off dividends in retirement",
  "how much to live off dividends",
  "coast fire",
  "coast fire explained",
  "coast fire retirement",
  "barista fire",
  "quiet quitting money",
  "paying cash for cars",
  "how much car can you actually afford",
  "lifestyle creep and how to avoid it",
  "how 100k changes your life",
  "why the first 100k is the hardest",
  "the illusion of middle class",
  "stop trying to look rich",
  "how to look broke and be rich",
  "why americans are broke",
  "why high earners still feel broke",
  "money dysmorphia",
  "rules of money nobody taught you",
  "stoic money habits",
  "frugal habits that save thousands",
  "financial minimalism",
  "quiet luxury money habits"
];

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    } catch (e) {
      console.warn("Failed to parse cache file, starting fresh:", e.message);
    }
  }
  return {};
}

function saveCache(cache) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

async function main() {
  const cache = loadCache();
  console.log(`Loaded cache with ${Object.keys(cache).length} entries.`);

  const queryList = [
    ...REQUIRED_LOW_COMP,
    ...ORIGINAL_SEEDS,
    ...TARGETED_LONGTAILS
  ];

  // Deduplicate query list while preserving order
  const uniqueQueries = Array.from(new Set(queryList.map(q => q.toLowerCase().trim())));
  console.log(`Total unique queries to ensure: ${uniqueQueries.length}`);

  let callsMade = 0;
  for (const q of uniqueQueries) {
    if (cache[q]) {
      continue;
    }
    console.log(`[vidIQ Query ${++callsMade}] Fetching "${q}"...`);
    const res = await callVidiq(q);
    if (res) {
      cache[q] = res;
      saveCache(cache);
    } else {
      console.warn(`No response for "${q}"`);
    }
    await sleep(600); // polite delay
  }

  console.log(`Done harvesting. Cache contains ${Object.keys(cache).length} query results.`);

  // Now assemble fact_keyword.tsv rows
  // Map of keyword -> row object
  const rowsMap = new Map();

  // Helper to add or update keyword row
  function addRow(data) {
    const k = data.keyword.toLowerCase().trim();
    if (!k) return;

    if (!rowsMap.has(k)) {
      rowsMap.set(k, data);
    } else {
      // If existing row has no geo but new row does, or higher tier, update
      const existing = rowsMap.get(k);
      if (existing.us_share_pct === null && data.us_share_pct !== null) {
        rowsMap.set(k, data);
      } else if (existing.tier === "related" && data.tier !== "related") {
        rowsMap.set(k, data);
      }
    }
  }

  // 1. Process seed queries
  for (const q of uniqueQueries) {
    const data = cache[q];
    if (!data) continue;

    const seed = data.seedKeyword || {};
    const markets = parseMarkets(seed.topMarkets);
    const vol = typeof seed.estimatedMonthlySearch === "number" ? seed.estimatedMonthlySearch : (seed.volume > 0 ? Math.round(seed.volume * 500) : 0);
    const volScore = typeof seed.volume === "number" ? seed.volume : 0;
    const compScore = typeof seed.competition === "number" ? seed.competition : 50;
    const oppScore = calcOpportunityScore(volScore, compScore, markets.usShare);

    // Determine tier
    let tier = "longtail";
    let parent = q;
    if (ORIGINAL_SEEDS.map(s => s.toLowerCase()).includes(q)) {
      tier = "seed";
      parent = q;
    } else if (REQUIRED_LOW_COMP.map(s => s.toLowerCase()).includes(q)) {
      // If it's a short 2-3 word concept, could be related or longtail
      tier = q.split(" ").length <= 2 ? "related" : "longtail";
      // Find suitable parent from original seeds
      if (q.includes("wealth")) parent = "how to build wealth";
      else if (q.includes("saving") || q.includes("frugal")) parent = "saving money";
      else if (q.includes("retire") || q.includes("independence")) parent = "financial independence";
      else if (q.includes("invest") || q.includes("stock") || q.includes("funds")) parent = "index fund investing";
      else if (q.includes("habit")) parent = "money habits";
      else parent = "pov finance";
    } else {
      tier = "longtail";
      if (q.includes("mortgage") || q.includes("car") || q.includes("cost") || q.includes("home")) parent = "the true cost of";
      else if (q.includes("retire") || q.includes("fire") || q.includes("dividends")) parent = "retire early";
      else if (q.includes("habit") || q.includes("lifestyle") || q.includes("broke")) parent = "money habits";
      else if (q.includes("wealth") || q.includes("100k") || q.includes("compounding")) parent = "building wealth";
      else parent = "pov finance";
    }

    const growth = typeof seed.searchDemandGrowthPct === "number" ? parseFloat(seed.searchDemandGrowthPct.toFixed(1)) : null;

    addRow({
      keyword: seed.keyword || q,
      parent_keyword: parent,
      tier,
      search_volume_monthly: vol,
      us_share_pct: markets.usShare,
      tier1_share_pct: markets.tier1Share,
      competition_0_100: parseFloat(compScore.toFixed(1)),
      growth_30d_pct: growth,
      opportunity_score: oppScore,
      top5_geos: markets.top5Str,
      source: "vidiq_keyword_research",
      collected_at: "2026-09-18"
    });

    // 2. Also process relatedKeywords from this query
    const relatedList = data.relatedKeywords || [];
    for (const r of relatedList) {
      const rk = r.keyword;
      if (!rk) continue;

      const rMarkets = parseMarkets(r.topMarkets);
      const rVol = typeof r.estimatedMonthlySearch === "number" ? r.estimatedMonthlySearch : (r.volume > 0 ? Math.round(r.volume * 500) : 0);
      const rVolScore = typeof r.volume === "number" ? r.volume : 0;
      const rCompScore = typeof r.competition === "number" ? r.competition : 50;
      const rOppScore = calcOpportunityScore(rVolScore, rCompScore, rMarkets.usShare);
      const rGrowth = typeof r.searchDemandGrowthPct === "number" ? parseFloat(r.searchDemandGrowthPct.toFixed(1)) : null;

      addRow({
        keyword: rk,
        parent_keyword: q,
        tier: rk.split(" ").length >= 4 ? "longtail" : "related",
        search_volume_monthly: rVol,
        us_share_pct: rMarkets.usShare,
        tier1_share_pct: rMarkets.tier1Share,
        competition_0_100: parseFloat(rCompScore.toFixed(1)),
        growth_30d_pct: rGrowth,
        opportunity_score: rOppScore,
        top5_geos: rMarkets.top5Str,
        source: "vidiq_keyword_research",
        collected_at: "2026-09-18"
      });
    }
  }

  // Format as TSV
  const header = [
    "keyword",
    "parent_keyword",
    "tier",
    "search_volume_monthly",
    "us_share_pct",
    "tier1_share_pct",
    "competition_0_100",
    "growth_30d_pct",
    "opportunity_score",
    "top5_geos",
    "source",
    "collected_at"
  ].join("\t");

  const lines = [header];

  // Helper to format values: missing -> empty string, pure numbers
  for (const [k, row] of rowsMap.entries()) {
    const line = [
      row.keyword,
      row.parent_keyword,
      row.tier,
      row.search_volume_monthly !== null && row.search_volume_monthly !== undefined ? row.search_volume_monthly : "",
      row.us_share_pct !== null && row.us_share_pct !== undefined ? row.us_share_pct : "",
      row.tier1_share_pct !== null && row.tier1_share_pct !== undefined ? row.tier1_share_pct : "",
      row.competition_0_100 !== null && row.competition_0_100 !== undefined ? row.competition_0_100 : "",
      row.growth_30d_pct !== null && row.growth_30d_pct !== undefined ? row.growth_30d_pct : "",
      row.opportunity_score !== null && row.opportunity_score !== undefined ? row.opportunity_score : "",
      row.top5_geos || "",
      row.source,
      row.collected_at
    ].join("\t");
    lines.push(line);
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log(`Successfully wrote ${lines.length - 1} rows to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
