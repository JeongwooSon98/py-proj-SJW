#!/usr/bin/env node
/**
 * src/data/fundamentals.json 재생성 스크립트 (빌드타임/수동 실행).
 *
 * 왜 정적 JSON인가:
 *   FMP MCP 도구는 "에이전트"가 부르는 것이고 브라우저 Vite 앱은 직접 못 부른다.
 *   런타임에 FMP REST를 부르면 (1) API 키가 클라이언트 번들에 노출되고 (2) CORS,
 *   (3) 무료 티어 호출 한도(일 250건) 문제가 생긴다. 그래서 펀더멘털은 "빌드타임에
 *   한 번 구워" 정적 JSON으로 앱에 넣는다. 키는 이 스크립트(서버/로컬)에만 머문다.
 *
 * 사용법:
 *   FMP_API_KEY=내키 node scripts/fetch-fundamentals.mjs
 *
 * 주의(현재 FMP 하위 플랜에서 실측된 커버리지):
 *   - 어닝 캘린더(earnings-calendar) = 전 종목 플랜 차단 → MVP 제외.
 *   - 한국(.KS)·일부 종목(AVGO 등) = 밸류에이션/애널리스트 지역·종목 차단 → 자동 생략.
 *   - ETF(QQQ 등) = PER/EPS 없음 → 대상 아님.
 *   종목별 호출이 실패(차단/누락)하면 조용히 건너뛰고 성공한 종목만 기록한다.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../src/data/fundamentals.json");

const API_KEY = process.env.FMP_API_KEY;
if (!API_KEY) {
  console.error("FMP_API_KEY 환경변수가 필요합니다. 예) FMP_API_KEY=xxx node scripts/fetch-fundamentals.mjs");
  process.exit(1);
}

// 펀더멘털 대상 = 미국 개별주만. (WATCHLIST의 ETF·한국주는 제외)
const SYMBOLS = ["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "AVGO"];

const STABLE = "https://financialmodelingprep.com/stable";

async function getJson(url) {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}apikey=${API_KEY}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 플랜 차단 등은 보통 객체로 에러 메시지가 온다.
  if (!Array.isArray(json)) throw new Error(json?.["Error Message"] || "non-array");
  return json;
}

function round(v, d = 2) {
  if (v == null || !isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

async function fetchOne(symbol) {
  // 밸류에이션(필수) + 애널리스트 목표가(보조). 밸류에이션이 막히면 그 종목은 생략.
  const ratios = (await getJson(`${STABLE}/ratios-ttm?symbol=${symbol}`))[0];
  if (!ratios) throw new Error("no ratios");

  let target = null;
  try {
    target = (await getJson(`${STABLE}/price-target-consensus?symbol=${symbol}`))[0] || null;
  } catch {
    target = null; // 목표가만 막혀도 밸류에이션은 보여준다.
  }

  return {
    per: round(ratios.priceToEarningsRatioTTM),
    pbr: round(ratios.priceToBookRatioTTM),
    peg: round(ratios.priceToEarningsGrowthRatioTTM),
    divYield: round(ratios.dividendYieldTTM, 5),
    targetConsensus: target ? round(target.targetConsensus) : null,
    targetHigh: target ? target.targetHigh : null,
    targetLow: target ? target.targetLow : null,
    currency: "USD",
  };
}

const data = {};
for (const sym of SYMBOLS) {
  try {
    data[sym] = await fetchOne(sym);
    console.log(`✓ ${sym}`);
  } catch (e) {
    console.warn(`· ${sym} 생략 (${e.message})`); // 종목별 실패는 조용히 생략(기존 패턴)
  }
}

const out = {
  meta: {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: "Financial Modeling Prep (financialmodelingprep.com)",
    scope: "미국 개별주만. ETF·한국(.KS)·미커버 종목(AVGO 등)은 제외.",
    note: "참고용 펀더멘털 스냅샷. 추천 점수에 반영되지 않음. 갱신: FMP_API_KEY=... node scripts/fetch-fundamentals.mjs",
  },
  data,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\n${Object.keys(data).length}개 종목 → ${OUT}`);
