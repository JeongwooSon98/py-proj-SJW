// 백테스트 CLI — 앱의 검증 패널과 '똑같은 엔진'을 터미널에서 돌린다. (npm run backtest)
//
// 왜 필요한가: 가중치·임계값을 바꿀 때(Phase C) 기준선 대비 초과수익을 근거로 삼아야
//  하는데, 브라우저 패널은 눈으로 훑기엔 좋아도 변경 전/후를 나란히 비교하거나 결과를
//  파일로 남기기 어렵다.
//
// 로직을 재구현하지 않는다. StockDashboard.jsx를 esbuild로 번들해 순수 함수
//  (computeIndicators / computeSignal / backtestSeries / aggregateBacktest)를 그대로
//  꺼내 쓴다. 재구현하면 '앱'이 아니라 '복제본'을 검증하게 되므로 의미가 없다.
//  ⚠️ esbuild는 vite의 전이 의존성이다(별도 선언 없음). 개발 전용 도구.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 실행 위치(cwd)와 무관하게 동작하도록 스크립트 위치 기준으로 경로를 잡는다.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src/StockDashboard.jsx");
const TMP = path.join(HERE, ".backtest-cli.gen.mjs"); // 번들 산출물(즉시 삭제)

const patched =
  fs.readFileSync(SRC, "utf8") +
  "\nexport { computeIndicators, computeSignal, backtestSeries, aggregateBacktest, btRegimeMap," +
  " benchmarkFor, btCostOf, isLiveBar, BT_HOLD, BT_WARMUP, BT_RANGE, BT_REGIME_RANGE, BT_REGIME_MIN_BARS, WATCHLIST };\n";

const res = await esbuild.build({
  stdin: { contents: patched, loader: "jsx", resolveDir: path.join(ROOT, "src"), sourcefile: "StockDashboard.jsx" },
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["react", "recharts"], // 컴포넌트는 안 쓰지만 import 구문은 남아 있으므로 외부화
  write: false,
  logLevel: "error",
});
fs.writeFileSync(TMP, res.outputFiles[0].text);

const M = await import(pathToFileURL(TMP).href);
fs.unlinkSync(TMP);

// 표본 기간. 기본은 앱(BT_RANGE)과 일치시킨다 — 다르면 '앱이 보는 것'을 검증하는 게 아니다.
//  `npm run backtest -- --range=3y` 로 덮어쓸 수 있다(표본별 비교·회귀 대조용).
//  ⚠️ range=max는 쓰지 말 것 — Yahoo가 interval=1d를 무시하고 월봉을 준다.
const RANGE = process.argv.find((a) => a.startsWith("--range="))?.slice(8) || M.BT_RANGE;

// Yahoo 일봉 직접 호출 (앱은 브라우저라 프록시를 쓰지만 Node는 직접 된다)
//
// ⚠️ 장중 미완성 봉은 잘라낸다 — 앱의 채점용 fetchSeries와 **같은 규칙**이다(U1).
//  왜: Yahoo는 장중에도 오늘 봉을 시계열에 넣고 그 종가 자리에 '현재가'를 채운다.
//   그대로 두면 아직 안 끝난 종가가 마지막 진입 몇 건의 청산가로 새어 들어가,
//   같은 코드로 두 번 돌려도 결과가 미세하게 달라진다(실측 확인).
//  판정은 재구현하지 않고 앱의 isLiveBar를 그대로 꺼내 쓴다 — CLI가 검증해야 하는 건
//   '앱'이지 '복제본'이 아니다.
//  ↳ 그래서 이 CLI는 **장 마감 후에 돌리면** 잘라낼 봉이 없어 결과가 재현 가능하다.
//    무변경 회귀 검증(출력 동일)은 반드시 장 마감 후에 할 것.
async function fetchSeries(symbol, range = RANGE) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const j = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
  const r = j?.chart?.result?.[0];
  if (!r) return [];
  const q = r.indicators.quote[0];
  const rows = [];
  let lastTs = null; // 살아남은 마지막 봉의 timestamp (미완성 판정용)
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    rows.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
    });
    lastTs = r.timestamp[i];
  }
  if (rows.length && M.isLiveBar(r.meta, lastTs)) rows.pop();
  return rows;
}

// 벤치마크 200일선으로 진입 시점의 레짐(강세장/약세장)을 판정한다 — 앱과 같은 방식.
const regimes = new Map();
for (const bench of ["SPY", "^KS11"]) {
  // 벤치마크는 표본보다 길게(MA200 워밍업분) 받는다 — 앱과 동일(BT_REGIME_RANGE).
  const rows = await fetchSeries(bench, M.BT_REGIME_RANGE);
  if (rows.length >= M.BT_REGIME_MIN_BARS) regimes.set(bench, M.btRegimeMap(rows));
  else console.error(`⚠️ ${bench} 벤치마크가 일봉이 아니다(${rows.length}봉) — 레짐 판정 포기`);
  process.stderr.write(`[bench ${bench} ${rows.length}봉] `);
  await new Promise((r) => setTimeout(r, 250));
}

const all = [];
let total = 0, symbols = 0;
const spans = [];
for (const w of M.WATCHLIST) {
  const rows = await fetchSeries(w.symbol);
  // 제외 기준은 앱(loadBacktest)과 똑같아야 한다 — 다르면 CLI가 '앱이 보는 표본'을 검증하지 않는다.
  if (rows.length < M.BT_WARMUP + Math.min(...M.BT_HOLD)) { console.error(`skip ${w.symbol} (${rows.length}봉)`); continue; }
  const ind = M.computeIndicators(rows);
  const regimeMap = regimes.get(M.benchmarkFor(w.symbol)) || null;
  const { events, delays, entries } = M.backtestSeries(ind, M.btCostOf(w.symbol), regimeMap);
  all.push(...events);
  for (const d of delays)
    all.push({ kind: "delay", label: d.d === 0 ? "당일 진입 (신호 발생 봉)" : `${d.d}봉 지연 진입`, d: d.d, dir: d.dir, ret: d.ret, regime: d.regime });
  total += entries;
  symbols += 1;
  spans.push({ sym: w.symbol, bars: rows.length, from: rows[0].date, to: rows[rows.length - 1].date });
  process.stderr.write(`${w.symbol} `);
  await new Promise((r) => setTimeout(r, 250));
}
console.error(`\n종목 ${symbols} · 신호진입 ${total}건 · 이벤트 ${all.length.toLocaleString()}건\n`);

// 종목별 이력 길이 — MAGS·DRAM처럼 신생 종목은 15년치가 없다(표본이 자동으로 적게 들어감).
console.log(`## 표본 범위 (range=${RANGE})`);
for (const s of spans)
  console.log(`${s.sym.padEnd(12)} ${String(s.bars).padStart(5)}봉  ${s.from} ~ ${s.to}`);

// 레짐 커버리지 — 벤치마크 휴장일 등으로 미분류가 많으면 레짐 표를 믿을 수 없다.
const rc = { bull: 0, bear: 0, none: 0 };
for (const e of all) if (e.kind === "baseline" && e.dir === "buy") rc[e.regime || "none"] += 1;
const rcTot = rc.bull + rc.bear + rc.none;
console.log(
  `\n레짐 분포(기준선 매수 진입 기준): 강세장 ${((rc.bull / rcTot) * 100).toFixed(1)}% · ` +
    `약세장 ${((rc.bear / rcTot) * 100).toFixed(1)}% · 미분류 ${((rc.none / rcTot) * 100).toFixed(1)}%`
);

const { baseline, signals, grades, delays } = M.aggregateBacktest(all);
const f = (v, d = 1) => (v == null ? "  —  " : (v > 0 ? "+" : "") + v.toFixed(d));

function table(title, rows, showEx = true) {
  console.log(`\n## ${title}`);
  console.log("행".padEnd(30) + M.BT_HOLD.map((p) => `${p}일: 평균/승률/n` + (showEx ? " [초과평균/초과승률]" : "")).join("   "));
  for (const r of rows) {
    if (!r) continue;
    let line = (r.label || "").padEnd(30);
    for (const p of M.BT_HOLD) {
      const s = r.stats[p];
      if (!s) { line += "   —   "; continue; }
      line += `${f(s.avg)}% / ${s.win.toFixed(0)}% / ${String(s.n).padStart(5)}`;
      if (showEx && s.exAvg != null) line += ` [${f(s.exAvg)}%p / ${f(s.exWin, 0)}%p]`;
      line += "   ";
    }
    console.log(line);
  }
}

table("기준선", [baseline.buy, baseline.sell], false);
table("① 개별 신호", signals);
table("② 점수 구간", grades);
table("④ 지연 진입 (타이밍 신호)", delays);

console.log("\n## ③ ATR 청산 (손절 2×ATR / 목표 3×ATR)");
console.log("행".padEnd(30) + "기대R    목표%   손절%   시간%   n");
for (const r of [baseline.buy, baseline.sell, ...grades]) {
  if (!r?.atr) continue;
  const a = r.atr;
  console.log(
    r.label.padEnd(30) +
      `${f(a.avgR, 2)}R   ${a.targetRate.toFixed(0)}%    ${a.stopRate.toFixed(0)}%    ${a.timeRate.toFixed(0)}%    ${a.n}`
  );
}

// ⑤ 레짐 분해 — 같은 레짐 안의 기준선과 비교한 초과수익.
//  3년 표본이 만든 착시("강세장이라 오른 것")가 재발하는지 여기서 바로 드러난다.
const RH = 10; // 레짐 표시는 10일 보유 기준
console.log(`\n## ⑤ 레짐 분해 (${RH}일 보유 · 같은 레짐 기준선 대비 초과)`);
console.log("행".padEnd(30) + "강세장(벤치>MA200)".padEnd(26) + "약세장(벤치<MA200)");
for (const r of [baseline.buy, baseline.sell, ...signals, ...grades]) {
  if (!r) continue;
  const cell = (s) => {
    if (!s) return "     —     ".padEnd(26);
    const ex = s.exAvg == null ? "" : ` [${f(s.exAvg)}%p]`;
    return `${f(s.avg)}% / ${s.win.toFixed(0)}% / n${String(s.n).padStart(5)}${ex}`.padEnd(26);
  };
  console.log(r.label.padEnd(30) + cell(r.reg.bull[RH]) + cell(r.reg.bear[RH]));
}

// 중앙값·표준편차·최악값(B2) 샘플 확인
console.log("\n## B2 분포 확인 (10일)");
for (const r of [baseline.buy, ...signals, ...grades]) {
  const s = r?.stats?.[10];
  if (!s) continue;
  console.log(
    r.label.padEnd(30) + `평균 ${f(s.avg)}%  중앙 ${f(s.median)}%  표준편차 ${s.sd.toFixed(1)}%p  최악 ${f(s.min)}%`
  );
}
