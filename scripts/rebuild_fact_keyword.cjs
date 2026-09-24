const fs = require("fs");
const path = require("path");
const { parseMarkets } = require("./vidiq_research_helper.cjs");

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

const BRANDS_EXACT = new Set([
  "dave ramsey",
  "the dave ramsey show",
  "dave ramsey show",
  "gabe bult",
  "frugal fit mom",
  "smart money bro",
  "money guy show",
  "the money guy show",
  "the luxury lane",
  "luxury lane",
  "graham stephan",
  "andrei jikh",
  "caleb hammer",
  "ali abdaal",
  "humphrey yang",
  "jaspreet singh",
  "mark tilbury",
  "ramit sethi",
  "mr finance",
  "mister finance",
  "statrys",
  "bille finance",
  "crayon capital",
  "martik finance",
  "alicia invests",
  "nick invests",
  "jack explains money",
  "lucas grant",
  "rookie finance",
  "money tom",
  "biz life pov",
  "tram tri thuc",
  "mind over pages",
  "cnbc make it",
  "cnbc",
  "bloomberg",
  "forbes",
  "morning brew",
  "wall street journal",
  "wsj",
  "charlie munger",
  "warren buffett",
  "dan lok",
  "robert kiyosaki"
]);

const AMBIGUOUS_EXACT = new Set([
  "wealth",
  "finance",
  "money",
  "rich",
  "video essay",
  "tiktok",
  "react",
  "storytelling",
  "aesthetic",
  "video",
  "videos",
  "youtube",
  "documentary",
  "documentary film"
]);

function classifyKeyword(kw) {
  const k = kw.toLowerCase().trim();
  if (BRANDS_EXACT.has(k)) {
    return "brand_or_person";
  }
  if (AMBIGUOUS_EXACT.has(k)) {
    return "ambiguous";
  }

  // Check if it contains a brand/person name but also has a substantive topic
  for (const b of BRANDS_EXACT) {
    if (k === b) return "brand_or_person";
    if (k.startsWith(b + " ") || k.endsWith(" " + b) || k.includes(" " + b + " ")) {
      const substantive = [
        "first 100k", "100k", "how to", "habits", "advice", "rule", "rules",
        "formula", "strategy", "portfolio", "tips", "mistakes", "steps",
        "guide", "investing", "budget", "retirement", "building wealth",
        "index funds", "pay off debt", "minimalism"
      ].some(term => k.includes(term));

      if (substantive) {
        return "topic";
      } else {
        return "brand_or_person";
      }
    }
  }

  return "topic";
}

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  console.log(`Loaded cache with ${Object.keys(cache).length} query entries.`);

  const rowsMap = new Map();

  function addRow(data) {
    const k = data.keyword.toLowerCase().trim();
    if (!k) return;

    // Filter out "wealth mindset 99" (channel name / noise)
    if (k === "wealth mindset 99") {
      console.log(`Removing noise / channel name: "${k}"`);
      return;
    }

    if (!rowsMap.has(k)) {
      rowsMap.set(k, data);
    } else {
      const existing = rowsMap.get(k);
      // Upgrade if existing has no geo but new has geo, or higher priority tier
      if (existing.us_share_pct === null && data.us_share_pct !== null) {
        rowsMap.set(k, data);
      } else if (existing.tier === "related" && data.tier !== "related") {
        rowsMap.set(k, data);
      }
    }
  }

  for (const q of Object.keys(cache)) {
    const data = cache[q];
    if (!data) continue;

    const seed = data.seedKeyword || {};
    const markets = parseMarkets(seed.topMarkets);
    const vol = typeof seed.estimatedMonthlySearch === "number" ? seed.estimatedMonthlySearch : (seed.volume > 0 ? Math.round(seed.volume * 500) : 0);
    const volScore = typeof seed.volume === "number" ? parseFloat(seed.volume.toFixed(1)) : 0.0;
    const compScore = typeof seed.competition === "number" ? parseFloat(seed.competition.toFixed(1)) : 50.0;
    const growth = typeof seed.searchDemandGrowthPct === "number" ? parseFloat(seed.searchDemandGrowthPct.toFixed(1)) : null;

    let tier = "longtail";
    let parent = q;
    if (ORIGINAL_SEEDS.map(s => s.toLowerCase()).includes(q)) {
      tier = "seed";
      parent = q;
    } else if (REQUIRED_LOW_COMP.map(s => s.toLowerCase()).includes(q)) {
      tier = q.split(" ").length <= 2 ? "related" : "longtail";
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

    const geoKnown = markets.usShare !== null;
    let marketTier = "unknown";
    if (geoKnown) {
      if (markets.usShare >= 40) {
        marketTier = "us_core";
      } else if (markets.usShare >= 20) {
        marketTier = "us_mixed";
      } else {
        marketTier = "tier3";
      }
    }

    let oppScore = null;
    let oppScoreProv = null;
    let rankScore = null;

    if (geoKnown) {
      oppScore = parseFloat((0.35 * volScore + 0.35 * (100 - compScore) + 0.30 * markets.usShare).toFixed(1));
    } else {
      oppScoreProv = parseFloat((0.50 * volScore + 0.50 * (100 - compScore)).toFixed(1));
    }

    if (marketTier === "us_core" || marketTier === "us_mixed") {
      rankScore = parseFloat((0.35 * volScore + 0.35 * (100 - compScore) + 0.30 * markets.usShare).toFixed(1));
    }

    addRow({
      keyword: seed.keyword || q,
      parent_keyword: parent,
      tier,
      keyword_kind: classifyKeyword(seed.keyword || q),
      market_tier: marketTier,
      search_volume_monthly: vol,
      volume_score: volScore,
      competition_0_100: compScore,
      growth_30d_pct: growth,
      geo_known: geoKnown ? "TRUE" : "FALSE",
      us_share_pct: markets.usShare,
      tier1_share_pct: markets.tier1Share,
      rank_score: rankScore,
      opportunity_score: oppScore,
      opportunity_score_provisional: oppScoreProv,
      top5_geos: markets.top5Str,
      source: "vidiq_keyword_research",
      collected_at: "2026-09-18"
    });

    const relatedList = data.relatedKeywords || [];
    for (const r of relatedList) {
      const rk = r.keyword;
      if (!rk) continue;

      const rMarkets = parseMarkets(r.topMarkets);
      const rVol = typeof r.estimatedMonthlySearch === "number" ? r.estimatedMonthlySearch : (r.volume > 0 ? Math.round(r.volume * 500) : 0);
      const rVolScore = typeof r.volume === "number" ? parseFloat(r.volume.toFixed(1)) : 0.0;
      const rCompScore = typeof r.competition === "number" ? parseFloat(r.competition.toFixed(1)) : 50.0;
      const rGrowth = typeof r.searchDemandGrowthPct === "number" ? parseFloat(r.searchDemandGrowthPct.toFixed(1)) : null;

      const rGeoKnown = rMarkets.usShare !== null;
      let rMarketTier = "unknown";
      if (rGeoKnown) {
        if (rMarkets.usShare >= 40) {
          rMarketTier = "us_core";
        } else if (rMarkets.usShare >= 20) {
          rMarketTier = "us_mixed";
        } else {
          rMarketTier = "tier3";
        }
      }

      let rOppScore = null;
      let rOppScoreProv = null;
      let rRankScore = null;

      if (rGeoKnown) {
        rOppScore = parseFloat((0.35 * rVolScore + 0.35 * (100 - rCompScore) + 0.30 * rMarkets.usShare).toFixed(1));
      } else {
        rOppScoreProv = parseFloat((0.50 * rVolScore + 0.50 * (100 - rCompScore)).toFixed(1));
      }

      if (rMarketTier === "us_core" || rMarketTier === "us_mixed") {
        rRankScore = parseFloat((0.35 * rVolScore + 0.35 * (100 - rCompScore) + 0.30 * rMarkets.usShare).toFixed(1));
      }

      addRow({
        keyword: rk,
        parent_keyword: q,
        tier: rk.split(" ").length >= 4 ? "longtail" : "related",
        keyword_kind: classifyKeyword(rk),
        market_tier: rMarketTier,
        search_volume_monthly: rVol,
        volume_score: rVolScore,
        competition_0_100: rCompScore,
        growth_30d_pct: rGrowth,
        geo_known: rGeoKnown ? "TRUE" : "FALSE",
        us_share_pct: rMarkets.usShare,
        tier1_share_pct: rMarkets.tier1Share,
        rank_score: rRankScore,
        opportunity_score: rOppScore,
        opportunity_score_provisional: rOppScoreProv,
        top5_geos: rMarkets.top5Str,
        source: "vidiq_keyword_research",
        collected_at: "2026-09-18"
      });
    }
  }

  const header = [
    "keyword",
    "parent_keyword",
    "tier",
    "keyword_kind",
    "market_tier",
    "search_volume_monthly",
    "volume_score",
    "competition_0_100",
    "growth_30d_pct",
    "geo_known",
    "us_share_pct",
    "tier1_share_pct",
    "rank_score",
    "opportunity_score",
    "opportunity_score_provisional",
    "top5_geos",
    "source",
    "collected_at"
  ].join("\t");

  const lines = [header];

  for (const [k, row] of rowsMap.entries()) {
    const line = [
      row.keyword,
      row.parent_keyword,
      row.tier,
      row.keyword_kind,
      row.market_tier,
      row.search_volume_monthly !== null && row.search_volume_monthly !== undefined ? row.search_volume_monthly : "",
      row.volume_score !== null && row.volume_score !== undefined ? row.volume_score : "",
      row.competition_0_100 !== null && row.competition_0_100 !== undefined ? row.competition_0_100 : "",
      row.growth_30d_pct !== null && row.growth_30d_pct !== undefined ? row.growth_30d_pct : "",
      row.geo_known,
      row.us_share_pct !== null && row.us_share_pct !== undefined ? row.us_share_pct : "",
      row.tier1_share_pct !== null && row.tier1_share_pct !== undefined ? row.tier1_share_pct : "",
      row.rank_score !== null && row.rank_score !== undefined ? row.rank_score : "",
      row.opportunity_score !== null && row.opportunity_score !== undefined ? row.opportunity_score : "",
      row.opportunity_score_provisional !== null && row.opportunity_score_provisional !== undefined ? row.opportunity_score_provisional : "",
      row.top5_geos || "",
      row.source,
      row.collected_at
    ].join("\t");
    lines.push(line);
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
  console.log(`Successfully wrote ${lines.length - 1} rows to ${OUTPUT_FILE}`);
}

main();
