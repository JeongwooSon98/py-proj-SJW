import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Bar,
  Cell,
  Scatter,
  CartesianGrid,
} from "recharts";
import fundamentalsData from "./data/fundamentals.json";

/* ------------------------------------------------------------------ */
/*  설정값                                                             */
/* ------------------------------------------------------------------ */

const PROXY = "https://corsproxy.io/?";
const BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

// 색상: 상승=빨강, 하락=파랑
const UP = "#ff4d4d";
const DOWN = "#4d8bff";
const FLAT = "#cccccc";

const INDICES = [
  { name: "KOSPI", symbol: "^KS11" },
  { name: "KOSDAQ", symbol: "^KQ11" },
  { name: "NASDAQ", symbol: "^IXIC" },
  { name: "S&P 500", symbol: "^GSPC" },
  { name: "Dow Jones", symbol: "^DJI" },
];

const EXCHANGE_RATE = { name: "USD/KRW", symbol: "USDKRW=X" };

const WATCHLIST = [
  { name: "NVDA", symbol: "NVDA" },
  { name: "TSLA", symbol: "TSLA" },
  { name: "AAPL", symbol: "AAPL" },
  { name: "MSFT", symbol: "MSFT" },
  { name: "GOOGL", symbol: "GOOGL" },
  { name: "AMZN", symbol: "AMZN" },
  { name: "AVGO", symbol: "AVGO" },
  { name: "QQQ", symbol: "QQQ" },
  { name: "SPY", symbol: "SPY" },
  { name: "SOXX", symbol: "SOXX" },
  { name: "MAGS", symbol: "MAGS" },
  { name: "DRAM", symbol: "DRAM" },
  { name: "삼성전자", symbol: "005930.KS" },
  { name: "하이닉스", symbol: "000660.KS" },
  { name: "현대차", symbol: "005380.KS" },
];

const MA_COLORS = {
  ma5: "#ffd24d",
  ma20: "#4dffb0",
  ma60: "#b04dff",
  ma120: "#ff8c4d",
};

// 차트 기간 선택지 (label = 표시명, range = Yahoo range 파라미터)
const RANGE_OPTIONS = [
  { label: "1달", range: "1mo" },
  { label: "3개월", range: "3mo" },
  { label: "6개월", range: "6mo" },
  { label: "1년", range: "1y" },
  { label: "2년", range: "2y" },
  { label: "3년", range: "3y" },
];

// 봉 종류 선택지 (interval = Yahoo interval 파라미터)
const INTERVAL_OPTIONS = [
  { label: "일봉", interval: "1d" },
  { label: "주봉", interval: "1wk" },
];

/* ------------------------------------------------------------------ */
/*  데이터 fetch 유틸                                                  */
/* ------------------------------------------------------------------ */

// Yahoo Finance chart API 호출 (corsproxy 경유)
//  ⚠️ D4: corsproxy.io는 단일 장애점(SPOF)이다. 죽으면 앱 전체가 멈춘다.
//   폴백 프록시를 찾으려 했으나(2026-07-16 브라우저 실측) allorigins·thingproxy·codetabs가
//   모두 Yahoo에 대해 동작하지 않았고, 성공한 것은 corsproxy.io 변형뿐이라(같은 제공자)
//   독립적 폴백이 되지 못했다. 그래서 (1) 일시적 실패 1회 재시도, (2) 실패 시 명확한
//   사용자 안내(RecommendPanel/차트 에러 문구)로 대응한다. SPOF 위험 자체는 남아 있다.
async function fetchChart(symbol, range = "1d", interval = "1d", attempt = 0) {
  const target = `${BASE}${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
  const url = `${PROXY}${encodeURIComponent(target)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error("No data");
    return result;
  } catch (e) {
    // 일시적 네트워크/프록시 오류는 짧은 지연 후 1회 재시도. 그래도 실패하면 던진다.
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 600));
      return fetchChart(symbol, range, interval, attempt + 1);
    }
    throw e;
  }
}

// 지수/종목의 현재가·전일대비 요약
async function fetchQuote(symbol) {
  // 최근 5일 일봉으로 현재가와 전일 종가 산출
  const result = await fetchChart(symbol, "5d", "1d");
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).filter((v) => v != null);

  const price =
    meta.regularMarketPrice != null
      ? meta.regularMarketPrice
      : closes[closes.length - 1];

  const prevClose =
    meta.chartPreviousClose != null
      ? meta.chartPreviousClose
      : meta.previousClose != null
      ? meta.previousClose
      : closes[closes.length - 2];

  if (price == null || prevClose == null) throw new Error("No price");

  const change = price - prevClose;
  const changePct = (change / prevClose) * 100;
  // 데이터 기준 시각 (시장별로 다름). 없으면 마지막 봉의 타임스탬프로 대체
  const ts = result.timestamp || [];
  const marketTime =
    meta.regularMarketTime != null
      ? meta.regularMarketTime
      : ts.length
      ? ts[ts.length - 1]
      : null;
  return { price, change, changePct, marketTime };
}

// 타임스탬프(초) → "YYYY-MM-DD" (로컬 기준, 시계열 date와 동일 포맷)
function fmtYmd(epochSec) {
  const d = new Date(epochSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "YYYY-MM-DD" → 그 주의 월요일 날짜(주 식별 키). 주봉 완성 여부 판정용(⑥ repaint 방지).
//  두 날짜가 같은 주면 같은 키가 나온다. 타임존 하드코딩 없이 주 경계만 본다.
function weekKey(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// 지금이 그 종목의 **정규장 시간**인지 판정한다(시계 vs 거래소 정규장 구간. 봉과 무관).
//  ⚠️ 거래시간은 시장마다 다르다(미국 ↔ KRX). KST 시각을 하드코딩하지 말 것 —
//   meta가 주는 거래소 기준 구간(currentTradingPeriod.regular)만 쓴다.
//  판정에 실패하면(필드 없음) 보수적으로 '장중'으로 본다(→ stale 보정을 걸어 잠그고
//   배지를 띄운다. 흔들리는 점수보다 하루 늦은 점수가 낫다).
function isInSession(meta) {
  const reg = meta?.currentTradingPeriod?.regular;
  if (!reg || reg.start == null || reg.end == null) return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= reg.start && now < reg.end;
}

// 마지막 일봉이 아직 '진행 중'(장중 미완성)인지 판정한다.
//  왜 필요한가: Yahoo는 장중에 그날의 봉을 시계열에 넣고, 그 종가 자리에 '현재가'를
//  채워 준다. 이 봉으로 채점하면 신호가 켜졌다 꺼졌다 한다(repaint).
//  ⚠️ isInSession과 다르다. '장중'이어도 마지막 봉이 어제일 수 있다(예: .KS는 장중에
//   오늘 봉 close가 null로 와서 걸러진다). 그 경우 여기서는 false(잘라낼 봉이 없음)지만
//   여전히 장중이므로 stale 보정은 별도로 isInSession으로 막는다(loadSeries 참고).
function isLiveBar(meta, lastTs) {
  const reg = meta?.currentTradingPeriod?.regular;
  if (!reg || reg.start == null || reg.end == null || lastTs == null) return true;
  // 지금이 정규장 구간 안이고, 마지막 봉이 '그 세션의 봉'이면 아직 안 끝난 봉이다.
  //  (일봉의 timestamp는 그날 정규장 시작 시각이라 reg.start와 같은 값이 된다)
  return isInSession(meta) && lastTs >= reg.start;
}

// 지정 기간/간격의 시계열 + 마지막 봉이 미완성인지 여부.
//  호출부는 이 함수를 직접 쓰지 말고 아래 둘 중 하나를 쓴다:
//   ▸ fetchSeries     — 채점·백테스트용 (완성 봉만)
//   ▸ fetchSeriesLive — 차트·현재가 표시용 (미완성 봉 포함)
async function loadSeries(symbol, range = "3y", interval = "1d") {
  const result = await fetchChart(symbol, range, interval);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const rows = [];
  let lastTs = null;
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    const v = q.volume?.[i];
    rows.push({
      date: fmtYmd(ts[i]),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v != null ? v : 0,
    });
    lastTs = ts[i];
  }

  if (interval !== "1d" || !rows.length)
    return { rows, live: false, inSession: false, livePrice: null };

  const inSession = isInSession(result.meta);
  const live = isLiveBar(result.meta, lastTs);
  // 장중 현재가 — 표시 전용(배지·차트). 장중이 아니면 없음.
  const livePrice = inSession ? result.meta?.regularMarketPrice ?? null : null;

  // 시계열 지연(stale) 보정 — '장중 미완성 봉'과는 **다른 문제**다. 분기를 섞지 말 것.
  //  증상: 정규장이 끝났는데도 일부 종목(특히 .KS)은 그날 봉의 close가 null로 와서
  //   위 루프에서 통째로 걸러진다. 그러면 마지막 봉이 하루 뒤처지고, 지표가 묵은
  //   종가로 계산된다. 이때만 마지막(완성) 봉의 종가를 meta 현재가로 갱신해 최신화한다.
  //  ⚠️ 봉을 새로 추가하지는 않는다 — 미국 거래일↔KST 타임존 경계에서 중복 봉이 생긴다.
  //  ⚠️ **장중(inSession)에는 절대 하지 않는다.** .KS는 장중에 오늘 봉 close가 null로
  //   빠져 마지막 봉이 '어제'가 되는데(→ live=false), 그때 덮어쓰면 어제 봉에 실시간가가
  //   들어가 점수가 흔들린다(KRX 장중 repaint). 그래서 조건이 !live가 아니라 !inSession이다.
  if (!inSession) {
    const price = result.meta?.regularMarketPrice;
    const last = rows[rows.length - 1];
    if (price != null && price !== last.close) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
    }
  }

  return { rows, live, inSession, livePrice };
}

// 채점·백테스트용 시계열 — **완성된 봉만**. 장중이면 진행 중인 마지막 봉을 잘라낸다.
//  이래야 백테스트가 검증한 것과 화면이 보여주는 것이 같은 물건이 된다.
async function fetchSeries(symbol, range = "3y", interval = "1d") {
  const { rows, live } = await loadSeries(symbol, range, interval);
  if (live) rows.pop();
  return rows;
}

// 차트·현재가 표시용 시계열 — 장중 미완성 봉을 그대로 포함한다(현재가 확인용).
//  { rows, live } 를 그대로 돌려주므로, 호출부는 live일 때 미완성 봉을 구분해 표시한다.
async function fetchSeriesLive(symbol, range = "3y", interval = "1d") {
  return loadSeries(symbol, range, interval);
}

/* ------------------------------------------------------------------ */
/*  관심종목 전체 신호 로딩 (신호 종합 패널용, 순차 호출 + 5분 캐시)           */
/* ------------------------------------------------------------------ */

const SIGNAL_CACHE_MS = 5 * 60_000;
// 모듈 레벨 캐시: 탭을 다시 열거나 컴포넌트가 재마운트돼도 재호출 방지
let signalCache = { time: 0, data: null, loading: null };

// 최근 period봉 수익률(%) — 상대강도(RS) 계산용
function periodReturn(rows, period) {
  if (!rows || rows.length < period + 1) return null;
  const last = rows[rows.length - 1].close;
  const prev = rows[rows.length - 1 - period].close;
  if (prev == null || prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

// 주봉 추세 판정: 주봉 MA20 vs MA60 — 멀티 타임프레임 필터용
function computeWeeklyTrend(rows) {
  if (!rows || rows.length < 61) return null;
  const ind = computeIndicators(rows);
  const last = ind[ind.length - 1];
  if (last.ma20 == null || last.ma60 == null) return null;
  if (last.ma20 > last.ma60) return "up";
  if (last.ma20 < last.ma60) return "down";
  return "flat";
}

// 미국=SPY, 한국(.KS)=^KS11 기준으로 벤치마크 선택
function benchmarkFor(symbol) {
  return symbol.endsWith(".KS") ? "^KS11" : "SPY";
}

// RS 비교 기간(거래일) — 단기(20)·중기(60) 동시 조건으로 경로 의존성 보정.
//  60일 두 끝점만 보면, 앞 두 달 급등 후 최근 급락한 종목도 누적 초과수익이
//  (+)면 '강세'로 오판된다. 단기 RS를 함께 봐 최근 모멘텀 반전을 걸러낸다.
const RS_SHORT = 20;
const RS_LONG = 60;
const RS_DEADZONE = 3; // %p — 미미한 차이는 노이즈로 거르는 데드존

// 지수(벤치마크) 레짐 판정 — 평균회귀 신호 가중 축소용. 위험(risk)·강세(bull) 대칭.
//  "확실한 국면"만 좁게 발동(공격적 성향: 흔한 등락은 두고 추세/패닉만 잡음).
//   ▸ 위험(risk): 하락추세(종가 < MA60 AND MA20 < MA60) 또는 급락(10일 ≤ −7%)
//       → '매수' 평균회귀 신호(RSI 과매도·볼린저 하단)를 축소(떨어지는 칼 매수 억제)
//   ▸ 강세(bull): 상승추세(종가 > MA60 AND MA20 > MA60) 또는 급등(10일 ≥ +7%)
//       → '매도' 평균회귀 신호(RSI 과매수·볼린저 상단)를 축소. 강세장에선 과매수
//         되돌림 매도가 추세에 역행해 자주 틀린다(백테스트 실측: 승률 30%대) →
//         단일 과매수만으로 뜨던 '매도 신호' 오노출을 임계 아래로 떨어뜨린다.
//   위험·강세는 추세가 상호배타라 사실상 동시에 켜지지 않는다(드문 교차 국면 무해).
const REGIME_DROP_PERIOD = 10;
const REGIME_DROP_PCT = -7;
const REGIME_RISE_PCT = 7; // 급등 임계(급락의 대칭)

function computeBenchRegime(rows) {
  if (!rows || rows.length < 61) return { risk: false, bull: false };
  const ind = computeIndicators(rows);
  const last = ind[ind.length - 1];
  const move = periodReturn(rows, REGIME_DROP_PERIOD); // 최근 10거래일 변동률(±)
  const downtrend =
    last.ma20 != null &&
    last.ma60 != null &&
    last.close < last.ma60 &&
    last.ma20 < last.ma60;
  const uptrend =
    last.ma20 != null &&
    last.ma60 != null &&
    last.close > last.ma60 &&
    last.ma20 > last.ma60;
  const crash = move != null && move <= REGIME_DROP_PCT;
  const surge = move != null && move >= REGIME_RISE_PCT;
  return {
    risk: downtrend || crash,
    bull: uptrend || surge,
    downtrend,
    uptrend,
    crash,
    surge,
    drop: move,
  };
}

// WATCHLIST 전체를 순차 호출(rate limit 회피)하여 종합 신호 계산
async function loadAllSignals() {
  // 벤치마크 단기/중기 수익률 + 레짐을 먼저 한 번만 받아 재사용
  const benchReturns = {};
  const benchRegime = {};
  for (const sym of ["SPY", "^KS11"]) {
    try {
      const rows = await fetchSeries(sym, "6mo", "1d");
      benchReturns[sym] = {
        short: periodReturn(rows, RS_SHORT),
        long: periodReturn(rows, RS_LONG),
      };
      benchRegime[sym] = computeBenchRegime(rows);
    } catch {
      benchReturns[sym] = { short: null, long: null };
      benchRegime[sym] = { risk: false };
    }
  }

  const results = [];
  for (const w of WATCHLIST) {
    try {
      // 채점은 **완성 봉만** 쓴다(장중 repaint 방지). 장중 현재가(livePrice)는 채점에
      //  넣지 않고 카드의 '장중 배지'에만 표시한다 — 사실/채점 분리.
      //  ⚠️ 배지 판정은 live(마지막 봉이 미완성 봉인가)가 아니라 inSession(지금이 정규장인가)이다.
      //   .KS는 장중에도 오늘 봉이 null로 빠져 live=false가 될 수 있는데, 그래도 '장중'이다.
      const { rows: liveRows, live, inSession, livePrice } = await loadSeries(w.symbol, "1y", "1d");
      const rows = live ? liveRows.slice(0, -1) : liveRows;
      if (!rows.length) continue;
      const ind = computeIndicators(rows);

      // 주봉 추세 (멀티 타임프레임). 실패해도 일봉 신호는 진행
      let weeklyTrend = null;
      try {
        const wk = await fetchSeries(w.symbol, "2y", "1wk");
        // ⑥ repaint 방지: 진행 중인 '이번 주' 봉은 채점에서 제외한다(완성 주만 사용).
        //  판정: 마지막 완성 일봉이 마지막 주봉과 같은 주면, 그 주봉은 아직 일봉으로
        //  채워지는 중이다. 주봉은 loadSeries가 안 잘라내므로(일봉 전용) 여기서 처리.
        //  (fetchSeries "1wk"는 미완성 주 봉을 포함해서 준다.)
        const lastDaily = rows[rows.length - 1]?.date;
        if (wk.length && lastDaily && weekKey(lastDaily) === weekKey(wk[wk.length - 1].date))
          wk.pop();
        weeklyTrend = computeWeeklyTrend(wk);
      } catch {
        // 주봉 실패는 무시
      }

      // 상대강도(RS): 종목 − 벤치마크 초과수익(%p)을 단기/중기 각각 산출.
      //  computeSignal에서 둘 다 강세/약세여야 신호를 부여(엇갈리면 중립).
      //  ⚠️ D3: 벤치마크와 동일 심볼(예: SPY)은 RS = 자기 − 자기 = 0이라 신호가
      //   구조적으로 불가능하다. null을 넘겨 '계산했는데 0'이 아니라 '해당 없음'으로
      //   명시하고, 카드에 표기한다(selfBench). 어차피 0은 데드존이라 점수는 불변.
      //   레짐(⑦)은 건드리지 않는다: 자기벤치의 레짐 = 시장 레짐이고, SPY의 역추세
      //   신호를 시장 국면으로 누르는 건 SPY에도 타당하므로 순환이지만 무해하다.
      const isSelfBench = benchmarkFor(w.symbol) === w.symbol;
      const bench = benchReturns[benchmarkFor(w.symbol)] || {};
      const retShort = periodReturn(rows, RS_SHORT);
      const retLong = periodReturn(rows, RS_LONG);
      const rsShort =
        isSelfBench || bench.short == null || retShort == null ? null : retShort - bench.short;
      const rsLong =
        isSelfBench || bench.long == null || retLong == null ? null : retLong - bench.long;

      // 지수 레짐 → 평균회귀 신호 가중 축소(대칭): 위험(하락/급락)이면 매수 축소,
      //  강세(상승/급등)이면 매도 축소.
      const reg = benchRegime[benchmarkFor(w.symbol)] || {};
      const regimeRisk = !!reg.risk;
      const regimeBull = !!reg.bull;

      const sig = computeSignal(ind, {
        weeklyTrend,
        rsShort,
        rsLong,
        regimeRisk,
        regimeBull,
      });
      // barDate = 채점 기준이 된 완성 봉의 날짜. 카드의 모든 수치(점수·RSI·손절·목표)가
      //  이 봉 기준이다. intraday면 화면의 현재가(livePrice)와 기준 봉이 다르다는 뜻.
      if (sig)
        results.push({
          ...w,
          ...sig,
          intraday: inSession,
          livePrice,
          barDate: rows[rows.length - 1].date,
          selfBench: isSelfBench,
        });
    } catch {
      // 개별 종목 실패는 건너뜀
    }
  }
  // D4: 한 종목도 못 받았으면(=프록시/네트워크 총실패) 조용히 빈 목록을 반환하지 않는다.
  //  그러면 화면이 "±3 넘는 종목 없음"처럼 정상인 척 비어 보인다. 던져서 error 상태로
  //  보내 명확한 안내(새로고침)를 띄운다. 유효 종목이 하나라도 있으면 정상 진행.
  if (!results.length) throw new Error("신호 데이터를 한 종목도 불러오지 못했습니다");
  return results;
}

/* ------------------------------------------------------------------ */
/*  변화 감지 (U3) — 직전 완성 봉 대비 무엇이 바뀌었나 (예측 아님, 사실)        */
/* ------------------------------------------------------------------ */
// localStorage에 '직전 완성 봉'의 점수·신호 라벨을 종목별로 저장해, 오늘과의 차이를
//  사실로만 보여준다. 키는 완성 봉 날짜(barDate)다 — U1이 선행돼야 하는 이유. 장중
//  미완성 봉을 저장하면 델타가 하루 종일 요동친다.
//  기준(prev)은 '하루 동안 고정'된다: 같은 barDate로 여러 번 열어도 델타가 안 바뀐다.
//  새 봉이 닫히면(barDate 전진) 직전 cur를 prev로 굴린다.
//  ⚠️ 문구 규칙(REFRAME R1~R4): "새 기회" 같은 말 금지. "어제 없던 신호"처럼 사실만.
const SNAP_KEY = "stockdash.signalSnap.v1";
const SNAP_EXPOSED = 3; // 노출 임계(±3)와 동일 — 목록 진입/이탈 판정용

function readSnap() {
  try {
    return JSON.parse(localStorage.getItem(SNAP_KEY)) || {};
  } catch {
    return {};
  }
}
function writeSnap(snap) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {
    /* 용량 초과 등은 무시(변화 감지는 보조 기능) */
  }
}

// 카드에 실제로 보이는(우세 방향) 신호 라벨 목록. 델타의 '신호' 비교 단위.
function activeLabels(item) {
  const rs = item.score >= 0 ? item.buy : item.sell;
  return (rs || []).map((r) => r.label);
}

// data(loadAllSignals 결과)에 종목별 델타를 붙이고, 저장할 다음 스냅샷과 패널 요약을 만든다.
//  순수 계산 + localStorage '읽기'만 한다(쓰기는 호출부 useEffect에서). 같은 data로 여러
//  번 불려도 idempotent다(barDate가 같으면 스냅샷을 굴리지 않으므로).
function computeDeltas(data) {
  if (!data) return { items: null, summary: null, nextSnap: null };
  const prevSnap = readSnap();
  const nextSnap = { ...prevSnap };

  const items = data.map((item) => {
    const cur = { barDate: item.barDate, score: item.score, labels: activeLabels(item) };
    const e = prevSnap[item.symbol];
    let baseline = null; // 비교 기준(직전 완성 봉의 상태)
    if (!e) {
      // 첫 조회 — 기준 없음. 저장만 해 둔다(델타는 표시하지 않는다).
      nextSnap[item.symbol] = { curBarDate: cur.barDate, cur, prevBarDate: null, prev: null };
    } else if (e.curBarDate === cur.barDate) {
      // 같은 완성 봉 — 하루 동안 기준 고정. prev가 있으면 그것과 비교.
      baseline = e.prev || null;
    } else {
      // 새 완성 봉 — 직전 cur를 prev로 굴린다.
      baseline = e.cur;
      nextSnap[item.symbol] = {
        curBarDate: cur.barDate,
        cur,
        prevBarDate: e.curBarDate,
        prev: e.cur,
      };
    }
    let delta = null;
    if (baseline) {
      const newLabels = cur.labels.filter((l) => !baseline.labels.includes(l));
      delta = { baseDate: baseline.barDate, scoreDelta: cur.score - baseline.score, newLabels };
    }
    return { ...item, delta };
  });

  // 패널 요약: 어제 노출(±3) → 오늘 빠짐 / 어제 안 뜸 → 오늘 노출.
  //  baseline.score = 현재 점수 − scoreDelta 로 복원(스냅샷 내부 구조에 의존하지 않음).
  const newlyExposed = [];
  const dropped = [];
  let baseDate = null;
  for (const it of items) {
    if (!it.delta) continue;
    baseDate = it.delta.baseDate;
    const prevScore = it.score - it.delta.scoreDelta;
    const prevExposed = Math.abs(prevScore) >= SNAP_EXPOSED;
    const curExposed = Math.abs(it.score) >= SNAP_EXPOSED;
    if (curExposed && !prevExposed)
      newlyExposed.push({ symbol: it.symbol, name: it.name, score: it.score });
    if (!curExposed && prevExposed)
      dropped.push({ symbol: it.symbol, name: it.name, prevScore });
  }
  const summary = baseDate ? { baseDate, newlyExposed, dropped } : null;
  return { items, summary, nextSnap };
}

function useSignals() {
  const [state, setState] = useState({
    loading: true,
    data: null,
    error: false,
    time: 0,
  });

  const run = useCallback((force = false) => {
    const now = Date.now();
    // 캐시 유효하면 즉시 사용
    if (!force && signalCache.data && now - signalCache.time < SIGNAL_CACHE_MS) {
      setState({
        loading: false,
        data: signalCache.data,
        error: false,
        time: signalCache.time,
      });
      return;
    }
    // 이미 진행 중인 로딩이 있으면 공유
    if (signalCache.loading) {
      setState((s) => ({ ...s, loading: true }));
      signalCache.loading
        .then((d) =>
          setState({ loading: false, data: d, error: false, time: signalCache.time })
        )
        .catch(() => setState({ loading: false, data: null, error: true, time: 0 }));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: false }));
    const p = loadAllSignals()
      .then((d) => {
        signalCache = { time: Date.now(), data: d, loading: null };
        return d;
      })
      .catch((e) => {
        signalCache.loading = null;
        throw e;
      });
    signalCache.loading = p;
    p.then((d) =>
      setState({ loading: false, data: d, error: false, time: signalCache.time })
    ).catch(() => setState({ loading: false, data: null, error: true, time: 0 }));
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  return { ...state, refresh: () => run(true) };
}

/* ------------------------------------------------------------------ */
/*  백테스트 로딩 (lazy, 종목 합산 + 캐시)                              */
/* ------------------------------------------------------------------ */

// 무거운 연산(15종목 × 15년 일봉 × 봉별 점수 재계산)이라 종목 합산 결과를 캐시한다.
//  신호 종합 패널(signalCache)과 별도이며, 사용자가 검증 패널을 펼칠 때 1회만 계산한다.
const BT_CACHE_MS = 30 * 60_000; // 과거 통계라 자주 바뀌지 않음 → 30분
let backtestCache = { time: 0, data: null, loading: null };

// 백테스트 표본 기간. 15년 = 2015·2018·2020·2022 하락장을 포함한다.
//  ⚠️ 직전 표본(3y)은 2023-07~ 이라 하락장이 한 번도 없었다. 하락장이 없으면 "신호가
//   맞았다"와 "그냥 시장이 올랐다"를 구분할 수 없고, 표본이 짧아 검정력도 부족하다.
//   표본을 다시 줄이지 말 것 — 짧은 표본은 우위를 만들어내지도, 반증하지도 못한다.
const BT_RANGE = "15y";

async function loadBacktest() {
  const all = [];
  let symbols = 0;
  let total = 0; // 신호·구간 진입 건수(기준선 제외)

  // 벤치마크(미국=SPY / 한국=KOSPI) 200일선으로 진입 시점의 레짐을 판정한다(STEP 1-3).
  const regimes = new Map(); // 벤치마크 심볼 → Map<date, "bull"|"bear">
  for (const bench of ["SPY", "^KS11"]) {
    try {
      const rows = await fetchSeries(bench, BT_REGIME_RANGE, "1d");
      if (rows.length >= BT_REGIME_MIN_BARS) regimes.set(bench, btRegimeMap(rows));
    } catch {
      // 벤치마크 실패 시 해당 시장은 레짐 미분류(전체 집계는 그대로 나온다)
    }
  }

  for (const w of WATCHLIST) {
    try {
      const rows = await fetchSeries(w.symbol, BT_RANGE, "1d");
      if (rows.length < BT_WARMUP + Math.min(...BT_HOLD)) continue;
      const ind = computeIndicators(rows);
      // 거래비용은 종목 국적별로 다르다(한국은 증권거래세 포함).
      const regimeMap = regimes.get(benchmarkFor(w.symbol)) || null;
      const { events, delays, entries } = backtestSeries(ind, btCostOf(w.symbol), regimeMap);
      if (!events.length) continue;
      all.push(...events);
      // 지연 진입은 별도 kind로 같은 집계에 흘려보낸다(초과수익 계산을 그대로 재사용).
      for (const d of delays)
        all.push({
          kind: "delay",
          label: d.d === 0 ? "당일 진입 (신호 발생 봉)" : `${d.d}봉 지연 진입`,
          d: d.d,
          dir: d.dir,
          ret: d.ret,
          regime: d.regime,
        });
      total += entries;
      symbols += 1;
    } catch {
      // 개별 종목 실패는 건너뜀
    }
  }
  // D4: 한 종목도 못 받았으면 빈 표를 정상인 척 그리지 않고 던져 error 안내를 띄운다.
  if (!symbols) throw new Error("백테스트 데이터를 한 종목도 불러오지 못했습니다");
  const { baseline, signals, grades, delays } = aggregateBacktest(all);
  return { baseline, signals, grades, delays, symbols, total };
}

// 신호 종합 패널과 달리 마운트 시 자동 실행하지 않고, run()을 호출해야 시작한다(lazy).
function useBacktest() {
  const [state, setState] = useState({
    loading: false,
    started: false,
    data: null,
    error: false,
    time: 0,
  });

  const run = useCallback((force = false) => {
    const now = Date.now();
    if (!force && backtestCache.data && now - backtestCache.time < BT_CACHE_MS) {
      setState({ loading: false, started: true, data: backtestCache.data, error: false, time: backtestCache.time });
      return;
    }
    if (backtestCache.loading) {
      setState((s) => ({ ...s, started: true, loading: true }));
      backtestCache.loading
        .then((d) => setState({ loading: false, started: true, data: d, error: false, time: backtestCache.time }))
        .catch(() => setState({ loading: false, started: true, data: null, error: true, time: 0 }));
      return;
    }
    setState((s) => ({ ...s, started: true, loading: true, error: false }));
    const p = loadBacktest()
      .then((d) => {
        backtestCache = { time: Date.now(), data: d, loading: null };
        return d;
      })
      .catch((e) => {
        backtestCache.loading = null;
        throw e;
      });
    backtestCache.loading = p;
    p.then((d) => setState({ loading: false, started: true, data: d, error: false, time: backtestCache.time }))
      .catch(() => setState({ loading: false, started: true, data: null, error: true, time: 0 }));
  }, []);

  return { ...state, run, refresh: () => run(true) };
}

/* ------------------------------------------------------------------ */
/*  시세 폴링 훅 (60초 주기 자동 갱신)                                  */
/* ------------------------------------------------------------------ */

const REFRESH_MS = 60_000;

function useQuote(symbol) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;

    const load = () => {
      fetchQuote(symbol)
        .then((r) => {
          if (!alive) return;
          setQ(r);
          setErr(false);
        })
        .catch(() => alive && setErr(true));
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol]);

  return { q, err };
}

/* ------------------------------------------------------------------ */
/*  시장 레짐 훅 (VIX + S&P500 ADX) — 상단 요약 위젯용                  */
/* ------------------------------------------------------------------ */

// VIX(변동성)로 위험선호/회피, S&P500 ADX로 추세장/횡보장을 한 번 받아 요약.
//  점수에는 영향 없는 표시용 컨텍스트. (개별 종목 레짐 보정은 ⑦ computeBenchRegime)
function useMarketRegime() {
  const [state, setState] = useState({ vix: null, adx: null, loading: true, err: false });

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchQuote("^VIX").catch(() => null),
      fetchSeries("^GSPC", "6mo", "1d").catch(() => null),
    ]).then(([vixQ, spx]) => {
      if (!alive) return;
      let adx = null;
      if (spx && spx.length > 40) {
        const ind = computeIndicators(spx);
        for (let i = ind.length - 1; i >= 0; i--) {
          if (ind[i].adx != null) {
            adx = ind[i].adx;
            break;
          }
        }
      }
      setState({
        vix: vixQ ? vixQ.price : null,
        adx,
        loading: false,
        err: !vixQ && adx == null,
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/* ------------------------------------------------------------------ */
/*  지표 계산                                                          */
/* ------------------------------------------------------------------ */

function sma(values, period, i) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += values[k];
  return sum / period;
}

// 표준편차 (볼린저 밴드용, 최근 period개의 모집단 표준편차)
function stddev(values, period, i) {
  if (i < period - 1) return null;
  const mean = sma(values, period, i);
  let sq = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const diff = values[k] - mean;
    sq += diff * diff;
  }
  return Math.sqrt(sq / period);
}

// 전체 시계열에 대한 EMA 배열 (첫 period개의 SMA를 seed로 사용)
function emaArray(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      // 첫 period개가 모이면 SMA로 seed
      if (i >= period - 1) {
        prev = sma(values, period, i);
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// 다이버전스 스윙 피벗 확정에 필요한 좌우 봉 수. 피벗 봉 b는 b+DIV_PIVOT_L봉이
//  모여야 확정되므로, 마커는 시계열 끝에서 최소 DIV_PIVOT_L봉 앞에만 찍힌다.
//  computeSignal도 같은 값으로 '확정된 마커만 채점' 가드를 건다(백테스트 look-ahead 차단).
const DIV_PIVOT_L = 3;
// 다이버전스로 비교하는 두 피벗의 간격 제약 (D2). 간격 제약이 없으면 5봉 떨어진
//  피벗과 80봉 떨어진 피벗을 똑같이 비교해 노이즈가 섞인다. 너무 가까우면(<5봉)
//  같은 스윙을 쪼갠 것이고, 너무 멀면(>60봉) 서로 다른 국면을 억지로 잇는 것이다.
//  ⚠️ 이 제약은 markDiv(전체 시계열)에서만 걸린다 — computeSignal의 스캔창
//   (DIV_LOOKBACK=12)은 그대로이므로 BT_SIG_WINDOW(60)와 무관하다.
//  근거는 노이즈 제거(설계)이지 성과가 아니다.
const DIV_MIN_GAP = 5;
const DIV_MAX_GAP = 60;

function computeIndicators(rows) {
  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);
  const n = rows.length;

  // 이동평균선 + 볼린저 밴드 (20일, ±2σ)
  const out = rows.map((r, i) => {
    const mid = sma(closes, 20, i);
    const sd = stddev(closes, 20, i);
    const upper = mid != null && sd != null ? mid + 2 * sd : null;
    const lower = mid != null && sd != null ? mid - 2 * sd : null;
    return {
      ...r,
      ma5: sma(closes, 5, i),
      ma20: sma(closes, 20, i),
      ma60: sma(closes, 60, i),
      ma120: sma(closes, 120, i),
      // 볼린저 밴드
      bbMid: mid,
      bbUpper: upper,
      bbLower: lower,
      // 볼린저 %B — 밴드 내 상대 위치(0=하단, 0.5=중심선, 1=상단).
      //  밴드 폭(=변동성)으로 나눠 정규화하므로 종목 변동성과 무관하게 '극단'의
      //  의미가 같아진다. 절대 % 완충(예: 하단×1.02)은 저변동 종목에서 완충폭이
      //  밴드폭의 대부분을 잠식해(SPY 실측 81%) 사실상 'MA20 아래'와 같은 뜻이 된다.
      pctB:
        upper != null && lower != null && upper > lower
          ? (r.close - lower) / (upper - lower)
          : null,
      // 캔들스틱용 범위 (low~high) + 색상 판단
      range: [r.low, r.high],
      rising: r.close >= r.open,
    };
  });

  // MACD (12, 26, 9)
  const ema12 = emaArray(closes, 12);
  const ema26 = emaArray(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null
  );
  const signalLine = emaArray(macdLine, 9);
  for (let i = 0; i < n; i++) {
    out[i].macd = macdLine[i];
    out[i].macdSignal = signalLine[i];
    out[i].macdHist =
      macdLine[i] != null && signalLine[i] != null
        ? macdLine[i] - signalLine[i]
        : null;
  }

  // 거래량 20일 평균 (급증 판단용)
  const vols = rows.map((r) => r.volume || 0);
  for (let i = 0; i < n; i++) {
    out[i].volMa20 = sma(vols, 20, i);
  }

  // ATR (14, Wilder smoothing) — 변동성 기반 손절·목표가 산출용.
  //  True Range = max(고-저, |고-전일종가|, |저-전일종가|)
  //  ATR seed = 첫 14개 TR의 단순평균, 이후 (이전ATR×13 + 당일TR)/14
  const atrPeriod = 14;
  const trArr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      trArr[i] = highs[i] - lows[i];
      continue;
    }
    const prevClose = closes[i - 1];
    trArr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
  }
  let atrPrev = null;
  for (let i = 0; i < n; i++) {
    if (i < atrPeriod - 1) continue;
    if (atrPrev == null) {
      let s = 0;
      for (let k = 0; k < atrPeriod; k++) s += trArr[i - k];
      atrPrev = s / atrPeriod;
    } else {
      atrPrev = (atrPrev * (atrPeriod - 1) + trArr[i]) / atrPeriod;
    }
    out[i].atr = atrPrev;
  }

  // ADX (14, Wilder) — 추세 '강도'(방향 무관). 추세장(ADX≥25)/횡보장(<20) 판별용.
  //  +DM/-DM(방향성 이동) → +DI/-DI → DX → ADX(DX의 Wilder 평활). TR은 trArr 재사용.
  const adxPeriod = 14;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  // +DM/-DM/TR의 Wilder 합 평활 → +DI/-DI → DX
  const dxArr = new Array(n).fill(null);
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i < n; i++) {
    if (i <= adxPeriod) {
      trS += trArr[i];
      pS += plusDM[i];
      mS += minusDM[i];
      if (i < adxPeriod) continue; // i===adxPeriod에서 첫 평활합 완성
    } else {
      trS = trS - trS / adxPeriod + trArr[i];
      pS = pS - pS / adxPeriod + plusDM[i];
      mS = mS - mS / adxPeriod + minusDM[i];
    }
    const pDI = trS > 0 ? (100 * pS) / trS : 0;
    const mDI = trS > 0 ? (100 * mS) / trS : 0;
    const diSum = pDI + mDI;
    dxArr[i] = diSum > 0 ? (100 * Math.abs(pDI - mDI)) / diSum : 0;
  }
  // ADX = DX의 Wilder 평활 (seed = 첫 adxPeriod개 DX 평균)
  let adxPrev = null;
  let dxSum = 0;
  let dxCount = 0;
  for (let i = 1; i < n; i++) {
    if (dxArr[i] == null) continue;
    if (adxPrev == null) {
      dxSum += dxArr[i];
      dxCount++;
      if (dxCount === adxPeriod) {
        adxPrev = dxSum / adxPeriod;
        out[i].adx = adxPrev;
      }
    } else {
      adxPrev = (adxPrev * (adxPeriod - 1) + dxArr[i]) / adxPeriod;
      out[i].adx = adxPrev;
    }
  }

  // RSI (14, Wilder smoothing)
  const period = 14;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i].rsi = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i].rsi = 100 - 100 / (1 + rs);
    }
  }

  // Slow Stochastic (14, 3, 3) — 업계 표준(George Lane 권장값).
  //  원시 %K(14)는 매우 예민해 가짜 크로스가 많다. 한 번 더 3일 평활한
  //  Slow %K를 쓰고, 그 3일 평균을 Slow %D로 삼아 노이즈를 제거한다.
  //   rawK : (종가-최저)/(최고-최저)×100  (Fast %K)
  //   k(Slow %K) = SMA3(rawK)             (= Fast %D)
  //   d(Slow %D) = SMA3(Slow %K)
  const kPeriod = 14;
  const smooth = 3; // %K 평활 = %D 평활
  const rawK = [];
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1) {
      rawK.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = i - kPeriod + 1; k <= i; k++) {
      if (highs[k] > hh) hh = highs[k];
      if (lows[k] < ll) ll = lows[k];
    }
    rawK.push(hh === ll ? 0 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  // Slow %K = rawK의 3일 단순평균
  const slowK = [];
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1 + (smooth - 1) || rawK.slice(i - smooth + 1, i + 1).some((v) => v == null)) {
      slowK.push(null);
      continue;
    }
    let s = 0;
    for (let k = i - smooth + 1; k <= i; k++) s += rawK[k];
    slowK.push(s / smooth);
    out[i].k = slowK[i];
  }
  // Slow %D = Slow %K의 3일 단순평균
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1 + (smooth - 1) * 2) continue;
    if (slowK[i] == null || slowK[i - 1] == null || slowK[i - 2] == null) continue;
    out[i].d = (slowK[i] + slowK[i - 1] + slowK[i - 2]) / 3;
  }

  // Stochastic %K x %D 교차 마커
  // golden = %K가 %D 상향 돌파, dead = 하향 돌파.
  // 과매도(20 이하) 골든 / 과매수(80 이상) 데드는 신뢰도 높은 신호로 별도 표시.
  for (let i = 1; i < n; i++) {
    const k0 = out[i].k;
    const d0 = out[i].d;
    const k1 = out[i - 1].k;
    const d1 = out[i - 1].d;
    if (k0 == null || d0 == null || k1 == null || d1 == null) continue;
    const crossUp = k1 <= d1 && k0 > d0;
    const crossDown = k1 >= d1 && k0 < d0;
    if (crossUp) {
      const strong = d0 <= 20; // 과매도 구간 골든크로스
      out[i].stochCross = "golden";
      out[i].stochStrong = strong;
      // 강신호(과매도 골든)만 차트에 마커 표시. 일반 크로스는 노이즈라 생략
      if (strong) out[i].stochMarkerY = (k0 + d0) / 2;
    } else if (crossDown) {
      const strong = d0 >= 80; // 과매수 구간 데드크로스
      out[i].stochCross = "dead";
      out[i].stochStrong = strong;
      if (strong) out[i].stochMarkerY = (k0 + d0) / 2;
    }
  }

  // 다이버전스 (가격 vs RSI/MACD) — 추세 반전 조짐.
  //  강세(bull): 가격 저점↓ + 오실레이터 저점↑ / 약세(bear): 가격 고점↑ + 오실레이터 고점↓.
  //  스윙 피벗(좌우 DIV_L봉의 최저/최고)을 찾아 직전 2개를 비교한다. 피벗은
  //  i+DIV_L봉에서야 확정되므로(우측 봉이 모여야 함), 마커는 피벗 봉(b)에 찍고
  //  computeSignal은 최근 봉에서 이 마커를 스캔해 점수화한다(스토캐스틱 크로스와 동일 패턴).
  const DIV_L = DIV_PIVOT_L;
  const pivotLows = [];
  const pivotHighs = [];
  for (let i = DIV_L; i < n - DIV_L; i++) {
    let lowPiv = true;
    let highPiv = true;
    for (let k = 1; k <= DIV_L; k++) {
      if (lows[i] > lows[i - k] || lows[i] > lows[i + k]) lowPiv = false;
      if (highs[i] < highs[i - k] || highs[i] < highs[i + k]) highPiv = false;
    }
    if (lowPiv) pivotLows.push(i);
    if (highPiv) pivotHighs.push(i);
  }
  // 오실레이터별로 직전 2개 피벗을 비교해 더 최근 피벗 봉(b)에 다이버전스 마커를 찍는다.
  //  divKey="rsiDiv"/"macdDiv"(방향), yKey=마커 Y좌표(해당 오실레이터 값).
  const markDiv = (pivots, oscKey, divKey, yKey, dir) => {
    for (let p = 1; p < pivots.length; p++) {
      const a = pivots[p - 1];
      const b = pivots[p];
      const gap = b - a; // 두 피벗 간 거리(봉). 노이즈 제거용 하한/상한(D2).
      if (gap < DIV_MIN_GAP || gap > DIV_MAX_GAP) continue;
      const oa = out[a][oscKey];
      const ob = out[b][oscKey];
      if (oa == null || ob == null) continue;
      if (dir === "bull") {
        if (lows[b] < lows[a] && ob > oa) {
          out[b][divKey] = "bull";
          out[b][yKey] = ob;
        }
      } else if (highs[b] > highs[a] && ob < oa) {
        out[b][divKey] = "bear";
        out[b][yKey] = ob;
      }
    }
  };
  markDiv(pivotLows, "rsi", "rsiDiv", "rsiDivY", "bull");
  markDiv(pivotHighs, "rsi", "rsiDiv", "rsiDivY", "bear");
  markDiv(pivotLows, "macd", "macdDiv", "macdDivY", "bull");
  markDiv(pivotHighs, "macd", "macdDiv", "macdDivY", "bear");

  return out;
}

/* ------------------------------------------------------------------ */
/*  종합 신호 점수 (여러 지표의 방향 합의도 — 예측력 미검증)            */
/* ------------------------------------------------------------------ */

// computeIndicators 결과를 받아 마지막 봉 기준으로 매수/매도 신호를 점수화.
// 양수=매수 우위, 음수=매도 우위. buy/sell 배열에 충족 근거를 라벨로 담는다.
// 가중치 설계 원칙:
//  - 추세 전환 '타이밍' 신호(MACD·과매도 스토캐스틱 크로스)가 가장 신뢰도 높음 → 3점
//  - '위치' 신호(RSI 과매도, 볼린저 밴드 이탈)는 진입 영역 판단 → 2점
//  - 추세 필터(MA 배열)·거래량 확인은 보조 근거 → 1점
//  매도는 동일 구조의 음수. 여러 신호가 겹칠수록(confluence) 총점이 커진다.

// 신호 신선도(freshness ⑫) — 타이밍 신호가 '언제 켜졌고 그 후 가격이 얼마나 갔는지'를
//  표시 전용 '사실'로 계산한다. ⚠️ 점수에는 반영하지 않는다(사실/점수 분리 원칙).
//  MACD·스토캐스틱·다이버전스는 최근 몇 봉을 되돌아보며 탐지하므로(확정에 미래 봉이
//  필요), 발생 봉이 며칠 전일 수 있다. 그 사이 가격이 이미 신호 방향으로 급등/급락하면
//  진입 우위가 소진됐을 수 있다("옛날 자리를 지금 사라"는 오해의 원인). 발생 봉 종가 대비
//  현재가가 신호 방향으로 EXT_FRESH_ATR×ATR 넘게 움직였거나(가격 소진), 발생이
//  EXT_FRESH_BARS봉보다 오래됐으면(시간 경과) 배지를 주황으로 강조해 사용자가 스스로
//  '지나간 자리'인지 판단하게 한다. 아래 두 상수는 배지 색칠 기준일 뿐, 점수·등급·정렬·
//  만점 어디에도 영향이 없다(검증되지 않은 감쇠를 점수에 넣지 않는다).
//   ▸ ATR로 정규화 → 종목별 변동성에 맞춤(TSLA처럼 변동성 큰 종목은 같은 %라도 덜 소진).
const EXT_FRESH_ATR = 1.0; // 발생 봉 종가 기준 1×ATR 이내 이동 = 아직 유효한 자리
const EXT_FRESH_BARS = 5; // 발생 후 5봉 이내 = 아직 최신 (넘으면 시간상 소진)

// 진입 위치(⑬) — "지금 이 가격이 어디에 있나"를 현재가 기준으로 평가하는 표시 전용 레벨.
//  신호(과거 발생)가 아무리 좋아도 현재가가 20일선에서 신호 방향으로 크게 벌어져 있으면
//  (추격/낙폭과대) 손절까지 거리가 멀고 되돌림 위험이 커 '지금 진입' 매력이 떨어진다.
//  MA20 대비 벌어짐을 ATR로 정규화(종목 변동성 반영)해 레벨을 판정한다.
//  ⚠️ 점수·등급·정렬·만점에 일절 반영하지 않는다(사실/점수 분리). "MA20에서 확장됐으니
//   감점"은 곧 평균회귀 베팅인데, 추세장에선 확장이 정상(모멘텀)이라 레짐 없이 일괄
//   감점하면 강한 추세를 놓친다. 점수에 넣으려면 먼저 백테스트 근거가 있어야 한다.
//  아래 두 상수는 배지 레벨 판정 임계일 뿐이다.
const EXT_STRETCH_ATR = 1.0; // MA20에서 신호 방향 1×ATR 이상 = 🟡 다소 확장
const EXT_HOT_ATR = 2.0; // 2×ATR 이상 = 🔴 과열·추격
// 낙폭과대(falling-knife) 경고 — 신호 '반대' 방향으로 깊이 벌어진 진입.
//  매수인데 MA20보다 1.5×ATR 넘게 아래(급락) / 매도인데 그만큼 위(급등)면서
//  추세까지 이탈(MA60 이탈·역/정배열)했으면, 겉보기 '좋은 자리(🟢)'가 실은
//  하락 지속(매수)·숏스퀴즈(매도) 위험이 큰 자리다. 🟢 대신 ⚠️ 경고로 구분한다.
const EXT_KNIFE_ATR = -1.5; // 신호 방향 −1.5×ATR 이하(반대로 벌어짐) = 낙폭과대 후보

// 볼린저 극단 판정(아래 4번) — %B(밴드 내 상대 위치) 임계.
//  %B ≤ 0.05 = 하단 극단(밴드 하단 5% 이내) / %B ≥ 0.95 = 상단 극단.
//  ▸ 왜 %B인가: 예전 판정(종가 ≤ 하단×1.02)은 '절대 2%' 완충이라 밴드 폭이 좁은
//    저변동 종목일수록 헐거워진다. SPY는 2%가 밴드폭의 81%를 잠식해 전체 거래일의
//    34%(하단)·53%(상단)에 발화했다(SOXX 하단 6.9%) — 같은 ±2점이 종목에 따라
//    5배 넘게 남발돼 '통계적 극단'이라는 의미를 잃었다. %B로 정규화하면 발화율이
//    종목 간 균일해진다(실측 하단 2~13%).
const BB_EXTREME = 0.05;

function computeSignal(rows, ctx = {}) {
  const n = rows.length;
  if (n < 30) return null;
  const last = rows[n - 1];
  let score = 0;
  const buy = [];
  const sell = [];
  // 근거를 점수와 함께 기록 (UI에서 "라벨 (+점수)"로 표시)
  // chart = 근거가 보이는 차트 키("price"/"rsi"/"stoch"/"macd"),
  // date = 해당 신호가 발생한 봉의 날짜. 신호 카드에서 배지를 누르면
  // 이 정보로 차트의 정확한 위치를 하이라이트한다.
  // chart/date가 있으면 차트 이동(하이라이트)용, 없으면 explain(설명 팝오버)용.
  // interval = 이동 시 전환할 봉 종류("1wk"면 주봉 차트로 전환). 기본 일봉.
  const addBuy = (label, pts, chart, date, explain, interval, fresh) => {
    score += pts;
    buy.push({ label, points: pts, chart, date, explain, interval, fresh });
  };
  const addSell = (label, pts, chart, date, explain, interval, fresh) => {
    score += pts;
    sell.push({ label, points: pts, chart, date, explain, interval, fresh });
  };
  // 타이밍 신호 신선도 계산 + 점수 축소.
  //  sigIdx=신호 발생 봉 인덱스, basePts=원점수, dir=+1 매수 / −1 매도.
  //  ⚠️ 점수(pts)는 원점수 그대로 반환한다(신선도로 감점하지 않음 — 검증되지 않은
  //   가중 조정을 점수에 넣지 않는다는 '사실/점수 분리' 원칙). fresh는 표시 전용 사실:
  //   신호 발생 후 몇 봉이 지났고 가격이 그 방향으로 얼마나 움직였는지를 배지에 보여줘,
  //   "지나간 자리"인지 사용자가 스스로 판단하게 한다. stale = 정보성 강조(가격 소진/오래됨).
  const freshTiming = (sigIdx, basePts, dir) => {
    const sig = rows[sigIdx];
    const barsAgo = n - 1 - sigIdx;
    const moveSince = sig.close ? ((last.close - sig.close) / sig.close) * 100 : 0;
    const favor = dir > 0 ? last.close - sig.close : sig.close - last.close; // 신호 방향 진행폭(가격)
    const extAtr = last.atr != null && last.atr > 0 ? favor / last.atr : null;
    const stale =
      (extAtr != null && extAtr > EXT_FRESH_ATR) || barsAgo > EXT_FRESH_BARS;
    return { pts: basePts, fresh: { barsAgo, moveSince, stale } };
  };
  // 레짐 정합 보너스(아래 10번) 판정용 — 어떤 '타입'의 신호가 떴는지 추적.
  //  추세추종 = MACD 강크로스(0선 정합)·MA 배열, 평균회귀 = RSI·볼린저.
  let hasTrendBuy = false;
  let hasMeanRevBuy = false;
  let hasTrendSell = false;
  let hasMeanRevSell = false;

  // 1) MACD 교차 (추세 전환, 최근 5봉) — 0선(Zero Line) 위치로 신뢰도 차등.
  //  MACD는 추세 추종 지표라 횡보장에서 가짜 크로스가 잦다. 0선 위치로
  //  걸러주면 추세 지속(강)과 추세 속 일시 반등/눌림(약)을 구분할 수 있다.
  //   0선 위 골든 / 0선 아래 데드 = 추세 지속 → ±3 (강)
  //   0선 아래 골든 / 0선 위 데드 = 반등·눌림 가능성 → ±2 (약)
  for (let i = n - 1; i >= Math.max(1, n - 5); i--) {
    const cur = rows[i];
    const prev = rows[i - 1];
    if (
      cur.macd == null ||
      cur.macdSignal == null ||
      prev.macd == null ||
      prev.macdSignal == null
    )
      continue;
    if (prev.macd <= prev.macdSignal && cur.macd > cur.macdSignal) {
      const strong = cur.macd > 0; // 0선 위 골든크로스 = 추세 지속(신뢰↑)
      const { pts, fresh } = freshTiming(i, strong ? 3 : 2, +1);
      addBuy(
        strong ? "MACD 골든크로스(0선 위)" : "MACD 골든크로스(0선 아래·약)",
        pts,
        "macd",
        cur.date,
        null,
        undefined,
        fresh
      );
      // 0선 위 강골든만 추세추종 정합으로 인정
      if (strong) hasTrendBuy = true;
      break;
    }
    if (prev.macd >= prev.macdSignal && cur.macd < cur.macdSignal) {
      const strong = cur.macd < 0; // 0선 아래 데드크로스 = 하락 지속(신뢰↑)
      const { pts, fresh } = freshTiming(i, strong ? -3 : -2, -1);
      addSell(
        strong ? "MACD 데드크로스(0선 아래)" : "MACD 데드크로스(0선 위·약)",
        pts,
        "macd",
        cur.date,
        null,
        undefined,
        fresh
      );
      // 0선 아래 강데드만 추세추종 정합으로 인정
      if (strong) hasTrendSell = true;
      break;
    }
  }

  // 2) Stochastic 강한 크로스만 (최근 3봉) — ±3. 일반 크로스는 노이즈라 제외
  for (let i = n - 1; i >= Math.max(0, n - 3); i--) {
    if (rows[i].stochCross === "golden" && rows[i].stochStrong) {
      const { pts, fresh } = freshTiming(i, 3, +1);
      addBuy("스토캐스틱 과매도 골든크로스", pts, "stoch", rows[i].date, null, undefined, fresh);
      break;
    }
    if (rows[i].stochCross === "dead" && rows[i].stochStrong) {
      const { pts, fresh } = freshTiming(i, -3, -1);
      addSell("스토캐스틱 과매수 데드크로스", pts, "stoch", rows[i].date, null, undefined, fresh);
      break;
    }
  }

  // 지수 레짐에 따라 평균회귀 신호를 절반으로 축소(가중↓). 만점·등급컷은 불변.
  //  ▸ 위험(하락추세/급락): 평균회귀 '매수'(RSI 과매도·볼린저 하단) +2→+1.
  //     '떨어지는 칼' 매수를 억제 → 평균회귀만으로 뜬 칼받이는 노출 임계 아래로,
  //     추세가 받쳐주는 반등은 그대로 노출.
  //  ▸ 강세(상승추세/급등): 평균회귀 '매도'(RSI 과매수·볼린저 상단) −2→−1.
  //     강세장에선 과매수 되돌림 매도가 추세에 역행해 자주 틀린다(백테스트 실측).
  //     단일 과매수만으로 뜨던 '매도 신호' 오노출을 억제 → 추세 매도(역배열·MACD
  //     데드·약세 다이버전스)가 함께 받쳐주는 진짜 고점은 confluence로 그대로 노출.
  const regimeRisk = !!ctx.regimeRisk;
  const regimeBull = !!ctx.regimeBull;

  // 3) RSI 과매도/과매수 (위치, 평균회귀) — ±2 (레짐 시 ±1)
  if (last.rsi != null) {
    if (last.rsi < 30) {
      regimeRisk
        ? addBuy("RSI 과매도(지수 약세·가중↓)", 1, "rsi", last.date)
        : addBuy("RSI 과매도(<30)", 2, "rsi", last.date);
      hasMeanRevBuy = true;
    } else if (last.rsi > 70) {
      regimeBull
        ? addSell("RSI 과매수(지수 강세·가중↓)", -1, "rsi", last.date)
        : addSell("RSI 과매수(>70)", -2, "rsi", last.date);
      hasMeanRevSell = true;
    }
  }

  // 4) 볼린저 밴드 이탈/근접 (평균회귀) — ±2 (레짐 시 ±1).
  //  %B ≤ 0.05(하단 5% 이내) / ≥ 0.95(상단 5% 이내). 밴드 폭으로 정규화한 판정이라
  //  종목 변동성과 무관하게 '극단'의 의미가 같다(BB_EXTREME 주석 참고).
  if (last.pctB != null && last.pctB <= BB_EXTREME) {
    regimeRisk
      ? addBuy("볼린저 하단(지수 약세·가중↓)", 1, "price", last.date)
      : addBuy("볼린저 하단 이탈/근접", 2, "price", last.date);
    hasMeanRevBuy = true;
  } else if (last.pctB != null && last.pctB >= 1 - BB_EXTREME) {
    regimeBull
      ? addSell("볼린저 상단(지수 강세·가중↓)", -1, "price", last.date)
      : addSell("볼린저 상단 이탈/근접", -2, "price", last.date);
    hasMeanRevSell = true;
  }

  // 5) 이동평균 배열 (추세 필터) — ±1
  if (last.ma5 != null && last.ma20 != null && last.ma60 != null) {
    if (last.ma5 > last.ma20 && last.ma20 > last.ma60) {
      addBuy("정배열(MA5>20>60)", 1, "price", last.date);
      hasTrendBuy = true;
    } else if (last.ma5 < last.ma20 && last.ma20 < last.ma60) {
      addSell("역배열(MA5<20<60)", -1, "price", last.date);
      hasTrendSell = true;
    }
  }

  // 6) 거래량 급증(20일 평균 대비 1.5배) + 가격 상승 확인 — +1
  if (last.volMa20 && last.volume > last.volMa20 * 1.5 && last.close >= last.open) {
    addBuy("거래량 급증+상승", 1, "price", last.date);
  }

  // 7) 주봉 추세 (멀티 타임프레임 필터, 추세 보조) — ±1.
  //  큰 흐름(주봉 MA20>MA60=상승)에 일봉 신호를 정렬시킨다. 일봉 매수신호인데
  //  주봉이 하락이면 이 −1이 점수를 상쇄해 역추세 진입을 자연스럽게 억제한다.
  //  배지 클릭 시 차트를 '주봉'으로 전환(chart="price", interval="1wk")해
  //  MA20·MA60 배열을 직접 보여준다. 추세 '상태'라 특정 날짜 세로선은 없고
  //  주봉 가격 차트로 스크롤·강조하는 방식이다.
  if (ctx.weeklyTrend === "up") {
    addBuy("주봉 상승추세", 1, "price", last.date, null, "1wk");
  } else if (ctx.weeklyTrend === "down") {
    addSell("주봉 하락추세", -1, "price", last.date, null, "1wk");
  }

  // 8) 시장 대비 상대강도(RS, 확인 보조) — ±1. 단기(20일)+중기(60일) 동시 조건.
  //  ±3%p 데드존으로 노이즈 제거. 미국=SPY, 한국=KOSPI 대비 초과수익.
  //  둘 다 강세여야 +1 / 둘 다 약세여야 −1 / 엇갈리면 중립(신호 미부여).
  //  → 앞 두 달 급등 뒤 최근 급락한 종목은 단기 RS가 음전해 강세에서 자동 탈락,
  //    누적 초과수익만 보고 '칼받이'를 강세로 오판하던 문제를 막는다.
  if (ctx.rsShort != null && ctx.rsLong != null) {
    const sTxt = `${ctx.rsShort > 0 ? "+" : ""}${ctx.rsShort.toFixed(1)}%p`;
    const lTxt = `${ctx.rsLong > 0 ? "+" : ""}${ctx.rsLong.toFixed(1)}%p`;
    if (ctx.rsShort >= RS_DEADZONE && ctx.rsLong >= RS_DEADZONE)
      addBuy(
        "시장 대비 강세",
        1,
        null,
        last.date,
        `시장(미국 종목=S&P500 SPY, 한국 종목=KOSPI)보다 단기(20일) ${sTxt}, 중기(60일) ${lTxt} 강합니다. 단기·중기 둘 다 +${RS_DEADZONE}%p를 넘을 때만 켜지므로, 최근에도 추세가 꺾이지 않은 강한 종목이라는 뜻입니다.\n\n⚠️ 이 배지 하나가 매수 근거가 되지는 않습니다. 종합 점수에 +1을 더하는 '확인' 보조 신호일 뿐입니다. 방향 합의도는 카드 위쪽의 종합 점수·등급으로 확인하세요. RS는 MACD·스토캐스틱 같은 타이밍 신호가 함께 떴을 때 '그 종목이 시장보다 강한지'를 가산해 주는 역할입니다.`
      );
    else if (ctx.rsShort <= -RS_DEADZONE && ctx.rsLong <= -RS_DEADZONE)
      addSell(
        "시장 대비 약세",
        -1,
        null,
        last.date,
        `시장(미국 종목=S&P500 SPY, 한국 종목=KOSPI)보다 단기(20일) ${sTxt}, 중기(60일) ${lTxt} 약합니다. 단기·중기 둘 다 −${RS_DEADZONE}%p 아래라 시장 전체보다 부진한 종목이라는 뜻입니다.\n\n⚠️ 이 배지 하나가 매도 신호는 아닙니다. 종합 점수에서 −1 하는 '확인' 보조 신호일 뿐입니다. 최종 판단은 카드 위쪽의 종합 점수·등급으로 하세요.`
      );
  }

  // 9) 다이버전스 (위치, ±2) — 가격과 RSI/MACD의 저점/고점이 엇갈리는 추세 반전 조짐.
  //  computeIndicators가 피벗 봉에 찍어둔 마커를 최근 DIV_LOOKBACK봉에서 스캔한다.
  //  피벗은 우측 DIV_L봉이 모여야 확정되므로 가장 최근 가능한 피벗도 몇 봉 전이다.
  //  최신→과거 순으로 훑어 가장 최근 다이버전스 하나만 채점(강세·약세 동시 노이즈 방지).
  //  RSI에서 났으면 chart="rsi", 아니면 "macd"로 배지에 부여해 ↗ 차트 이동.
  //  ⚠️ 인과성 가드: 마지막 DIV_PIVOT_L봉은 스캔하지 않는다. 피벗 확정에 우측 3봉이
  //   필요하므로 '지금' 시점에 그 구간의 마커는 원래 존재할 수 없다(실전 동작 불변).
  //   백테스트는 지표를 전체 시계열에 한 번 계산해 재사용하는데, 그 마커를 그대로
  //   읽으면 봉 i 시점에 i+1~i+3의 미래 정보가 섞인다(낙관 편향). 이 가드로 차단한다.
  const DIV_LOOKBACK = 12;
  for (let i = n - 1 - DIV_PIVOT_L; i >= Math.max(0, n - DIV_LOOKBACK); i--) {
    const r = rows[i];
    const div = r.rsiDiv || r.macdDiv;
    if (!div) continue;
    const chart = r.rsiDiv ? "rsi" : "macd";
    if (div === "bull") {
      const { pts, fresh } = freshTiming(i, 2, +1);
      addBuy("강세 다이버전스", pts, chart, r.date, null, undefined, fresh);
    } else {
      const { pts, fresh } = freshTiming(i, -2, -1);
      addSell("약세 다이버전스", pts, chart, r.date, null, undefined, fresh);
    }
    break;
  }

  // 10) 레짐 정합 보너스 (확인 보조, ±1) — 종목 자체 ADX로 추세장/횡보장을 판정해,
  //  신호 '타입'이 레짐과 맞으면 ±1을 한 번만 가산한다. 개별 신호 점수는 그대로 두고
  //  천장만 1점 상향(추세장 추세추종 +1 / 횡보장 평균회귀 +1, 매도는 대칭 −1).
  //   추세장 ADX≥25 = 추세추종(MACD 강크로스·MA배열) / 횡보장 ADX<20 = 평균회귀(RSI·볼린저)
  //   전환 구간(20~25)은 보너스 없음. ⑦(벤치 추세 기반)과 달리 '종목' ADX라 독립적.
  //  방향은 현재 종합 점수 부호로 결정해 우세 방향만 강화(상반 신호 혼재 시 보너스 보류).
  //  ⚠️ 게이트가 |score|≥3(노출 임계)이다: '이미 노출된 종목의 천장만' 올린다. 부호(>0)만
  //   보면 +2 종목을 +3으로 밀어 하단 컷을 낮춰 노출 구성을 바꾼다(문서 서술과 불일치).
  //   근거는 문서-코드 일치(설계)이지 성과가 아니다. 만점·등급컷 숫자는 불변.
  if (last.adx != null) {
    const trendRegime = last.adx >= 25;
    const rangeRegime = last.adx < 20;
    if (score >= 3) {
      if (trendRegime && hasTrendBuy)
        addBuy(
          "추세장 추세신호 정합",
          1,
          null,
          last.date,
          "이 종목은 ADX≥25로 추세가 강한 국면(추세장)이고, MACD 0선 위 골든크로스나 정배열 같은 추세추종 매수신호가 함께 떴습니다. 추세장에선 추세추종 신호가 잘 통해 신뢰도를 +1 가산합니다.\n\n⚠️ 단독 신호가 아니라 기존 추세 신호에 확인 +1을 더하는 보조 신호입니다. 매수 판단은 카드 위쪽의 종합 점수·등급으로 하세요."
        );
      else if (rangeRegime && hasMeanRevBuy)
        addBuy(
          "횡보장 평균회귀 정합",
          1,
          null,
          last.date,
          "이 종목은 ADX<20으로 추세가 약한 국면(횡보장)이고, RSI 과매도나 볼린저 하단 같은 평균회귀 매수신호가 함께 떴습니다. 횡보장에선 과매도 반등(평균회귀)이 잘 통해 신뢰도를 +1 가산합니다.\n\n⚠️ 단독 신호가 아니라 기존 평균회귀 신호에 확인 +1을 더하는 보조 신호입니다. 매수 판단은 카드 위쪽의 종합 점수·등급으로 하세요."
        );
    } else if (score <= -3) {
      if (trendRegime && hasTrendSell)
        addSell(
          "추세장 추세신호 정합",
          -1,
          null,
          last.date,
          "이 종목은 ADX≥25 추세장이고, MACD 0선 아래 데드크로스나 역배열 같은 추세추종 매도신호가 함께 떴습니다. 추세장에선 추세추종 신호가 잘 통해 −1 가산합니다.\n\n⚠️ 기존 추세 신호에 확인 −1을 더하는 보조 신호입니다. 최종 판단은 종합 점수·등급으로 하세요."
        );
      else if (rangeRegime && hasMeanRevSell)
        addSell(
          "횡보장 평균회귀 정합",
          -1,
          null,
          last.date,
          "이 종목은 ADX<20 횡보장이고, RSI 과매수나 볼린저 상단 같은 평균회귀 매도신호가 함께 떴습니다. 횡보장에선 과매수 조정(평균회귀)이 잘 통해 −1 가산합니다.\n\n⚠️ 기존 평균회귀 신호에 확인 −1을 더하는 보조 신호입니다. 최종 판단은 종합 점수·등급으로 하세요."
        );
    }
  }

  // ⑬ 진입 위치 (지금-진입 참고) — 현재가와 MA20의 벌어짐(ATR 단위)을 '사실'로만 계산한다.
  //  ⚠️ 점수에는 반영하지 않는다(사실/점수 분리 원칙). "신호 방향으로 얼마나 확장됐나
  //   / 반대로 깊이 벌어졌나(낙폭과대)"를 카드의 진입 배지로 보여줘, 지금 자리의 질을
  //   사용자가 스스로 판단하게 한다. level: good/stretched/hot/knife (표시 전용).
  let entry = null;
  if (last.ma20 != null && last.atr != null && last.atr > 0) {
    const extATR = (last.close - last.ma20) / last.atr; // +: MA20 위 / −: 아래
    const dir = score > 0 ? 1 : score < 0 ? -1 : 0; // 신호 방향
    const stretch = dir > 0 ? extATR : dir < 0 ? -extATR : 0; // 신호 방향으로 벌어진 정도
    let level = "good";
    if (dir !== 0) {
      if (stretch >= EXT_HOT_ATR) level = "hot"; // 추격/낙폭 과대(신호 방향 급등·급락)
      else if (stretch >= EXT_STRETCH_ATR) level = "stretched"; // 다소 확장
      else if (stretch <= EXT_KNIFE_ATR) {
        // 신호 반대 방향으로 깊이 벌어짐(매수인데 급락 / 매도인데 급등) + 추세 이탈이면
        //  겉보기 눌림(🟢)이 실은 낙폭과대·스퀴즈 위험 → ⚠️ 경고 레벨로 구분.
        const revArr =
          last.ma5 != null &&
          last.ma60 != null &&
          (dir > 0
            ? last.ma5 < last.ma20 && last.ma20 < last.ma60 // 역배열
            : last.ma5 > last.ma20 && last.ma20 > last.ma60); // 정배열
        const brokeTrend =
          last.ma60 != null &&
          (dir > 0 ? last.close < last.ma60 : last.close > last.ma60);
        if (revArr || brokeTrend) level = "knife";
      }
    }
    entry = { extATR, dir, stretch, level };
  }

  // 리스크 관리: ATR 기반 손절·목표가·손익비 (점수에는 영향 없음, 정보 표시용).
  //  손절 2×ATR / 1차 목표 3×ATR → 손익비 1.5:1. 매수 우위면 아래로 손절·위로 목표,
  //  매도 우위면 반대 방향으로 산출한다.
  let risk = null;
  if (last.atr != null && last.close) {
    const atr = last.atr;
    const atrPct = (atr / last.close) * 100;
    const long = score >= 0; // 매수 우위 방향
    const stop = long ? last.close - 2 * atr : last.close + 2 * atr;
    const target = long ? last.close + 3 * atr : last.close - 3 * atr;
    const riskDist = Math.abs(last.close - stop);
    const rr = riskDist > 0 ? Math.abs(target - last.close) / riskDist : null;
    risk = { atr, atrPct, stop, target, rr, long };
  }

  return { score, buy, sell, rsi: last.rsi, price: last.close, risk, entry };
}

/* ------------------------------------------------------------------ */
/*  간이 백테스트 (신호 신뢰성 검증)                                    */
/* ------------------------------------------------------------------ */

// 신호 검증의 목적: 현재 점수 체계가 "실제로 맞는지" 과거 데이터로 확인한다.
//  ⚠️ 점수 체계 자체는 바꾸지 않는 검증 도구다(만점·등급·임계값 불변).
//  방식: computeIndicators로 지표를 한 번 계산한 뒤, 과거 각 봉 i 시점에서
//  computeSignal(ind.slice(0, i+1))을 호출해 "그 시점까지의 데이터로 본 신호"를
//  그대로 재현한다(점수·임계값 로직을 백테스트에 중복하지 않고 재사용). 직전 봉엔
//  없다가 i봉에서 새로 켜진 신호를 '진입'으로 잡아, N봉 후 종가 수익률을 집계한다.

// 보유기간(거래일). 진입 봉 종가 → N봉 후 종가 수익률.
const BT_HOLD = [5, 10, 20];
// 지표 안정화 전 구간은 건너뛴다(computeSignal은 30봉 미만 null, MA60 등 워밍업).
const BT_WARMUP = 60;

// 거래비용(왕복, %p) — 수수료+슬리피지(한국은 증권거래세 포함) 근사 가정치.
//  기준선·신호에 똑같이 차감하므로 '초과수익'에는 영향이 없고, 절대 수익률만 현실화된다.
const BT_COST_US = 0.05;
const BT_COST_KR = 0.2;
const btCostOf = (symbol) => (symbol.endsWith(".KS") ? BT_COST_KR : BT_COST_US);

// ATR 청산 검증(B3) — 카드가 '표시하는' 청산 규칙(손절 2×ATR / 목표 3×ATR)을 그대로 검증한다.
//  지금까지 백테스트는 고정 N봉 종가 청산만 재서, 화면에 띄우는 규칙은 검증된 적이 없었다.
const BT_ATR_STOP = 2; // 손절 = 2×ATR (= 1R)
const BT_ATR_TARGET = 3; // 1차 목표 = 3×ATR (R:R 1.5)
const BT_ATR_MAXBARS = 20; // 최대 보유. 미도달 시 종가 청산

// 지연 진입 검증(B4) — 신호가 켜진 봉이 아니라 N봉 뒤에 진입했을 때의 성과.
//  MACD는 5봉·스토캐스틱은 3봉을 되돌아보며 채점하므로, 사용자는 신호 발생 며칠 뒤에
//  카드를 보고 산다. '검증한 진입 시점'과 '실제 진입 시점'의 괴리를 수치로 드러낸다.
const BT_DELAYS = [0, 1, 2, 3, 5];

// 백테스트가 봉 i 시점을 재현할 때 computeSignal에 넘기는 창(窓) 길이.
//  왜 필요한가: 봉마다 ind.slice(0, i+1)을 넘기면 매번 배열 전체를 복사해 O(n²)가 된다.
//  15년 표본(n≈3,700)에서는 3년(n≈750) 대비 약 25배 느려져 브라우저가 멈춘다.
//  고정 창으로 잘라도 되는 근거: computeSignal은 computeIndicators가 미리 계산해 둔
//  행 필드(pctB·volMa20·adx·atr·stochCross·macd…)만 읽고, 행을 직접 되돌아보는 최대
//  구간은 다이버전스 스캔의 DIV_LOOKBACK(12봉)이다(MACD 6봉·스토캐스틱 3봉·나머지는
//  마지막 봉만). 따라서 12봉 이상을 넘기면 결과가 전체 슬라이스와 완전히 동일하다.
//  ⚠️ 신호가 60봉 넘게 되돌아보게 되면(DIV_LOOKBACK 확대 등) 이 값을 반드시 올려야 한다.
//   조용히 틀린 결과를 내는 종류의 버그라, 되돌아보기 구간을 늘릴 때 여기를 같이 볼 것.
//   computeSignal의 `n < 30` 가드보다 커야 하고, BT_WARMUP(60)부터 시작하므로 창은 항상 꽉 찬다.
const BT_SIG_WINDOW = 60; // 최대 되돌아보기(12봉)의 5배 여유

// 종합 점수 → 검증용 구간(버킷). 매수(+)·매도(−) 의미 구간만 잡고 중립은 제외.
//  dir: 수익률 방향(buy=상승 적중, sell=하락 적중). 등급컷(±7/±3)과 동일 경계.
//  라벨은 signalGrade와 같은 이름을 쓴다(경계·집계 key는 불변, 표시 문자열만 동기화).
function btScoreBucket(score) {
  if (score >= 7) return { key: "g_strong_buy", label: "매수신호 강함 (+7↑)", dir: "buy" };
  if (score >= 3) return { key: "g_buy", label: "매수신호 있음 (+3~6)", dir: "buy" };
  if (score <= -7) return { key: "g_strong_sell", label: "매도신호 강함 (−7↓)", dir: "sell" };
  if (score <= -3) return { key: "g_sell", label: "매도신호 있음 (−3~−6)", dir: "sell" };
  return null; // 중립(−2~+2)은 미집계
}

// 진입 봉 i 종가 대비 N봉 후 종가 수익률(%). 매도 방향은 하락이 적중이므로 부호 반전.
//  거래비용(왕복 %p)을 차감한다. 미래 봉이 부족한 기간은 표본에서 제외(부분 집계).
function btReturns(closes, i, dir, holdPeriods, cost = 0) {
  const base = closes[i];
  if (base == null || base === 0) return null;
  const out = {};
  let any = false;
  for (const p of holdPeriods) {
    const j = i + p;
    if (j < closes.length && closes[j] != null) {
      let r = ((closes[j] - base) / base) * 100;
      if (dir === "sell") r = -r; // 매도신호: 하락 시 적중(+)
      out[p] = r - cost;
      any = true;
    }
  }
  return any ? out : null;
}

// ATR 청산 백테스트(B3) — 진입 봉 i 종가에서 들어가, 이후 봉의 고가/저가로
//  손절(2×ATR)·목표(3×ATR) 중 먼저 닿는 쪽으로 청산한다.
//   ▸ 같은 봉에서 둘 다 닿으면 보수적으로 손절 우선(봉 내부 순서는 알 수 없으므로,
//     유리한 쪽을 고르면 look-ahead 낙관 편향이 된다).
//   ▸ BT_ATR_MAXBARS 내 미도달이면 그 봉 종가로 청산(time).
//   ▸ R = 손익 ÷ 1R(=2×ATR). 목표 도달 = +1.5R, 손절 = −1R, 시간청산 = 그 사이 값.
//  미래 봉이 부족한 진입은 창 잘림 편향을 막기 위해 표본에서 제외한다.
function btAtrExit(rows, i, dir, cost = 0) {
  const entry = rows[i].close;
  const atr = rows[i].atr;
  const end = i + BT_ATR_MAXBARS;
  if (entry == null || entry === 0 || atr == null || atr <= 0) return null;
  if (end > rows.length - 1) return null;

  const long = dir === "buy";
  const risk = BT_ATR_STOP * atr; // 1R (가격 단위)
  const stop = long ? entry - risk : entry + risk;
  const target = long ? entry + BT_ATR_TARGET * atr : entry - BT_ATR_TARGET * atr;

  const close = (outcome, px) => {
    const gross = long ? px - entry : entry - px; // 방향 보정 손익(가격)
    const fee = (cost / 100) * entry; // 왕복 거래비용(가격 단위)
    return { outcome, r: (gross - fee) / risk, ret: ((gross - fee) / entry) * 100 };
  };

  for (let j = i + 1; j <= end; j++) {
    const hi = rows[j].high;
    const lo = rows[j].low;
    if (hi == null || lo == null) continue;
    if (long ? lo <= stop : hi >= stop) return close("stop", stop);
    if (long ? hi >= target : lo <= target) return close("target", target);
  }
  return close("time", rows[end].close);
}

// 기준선(baseline) 행 라벨 — 신호와 무관하게 '워밍업 이후 아무 봉에나 진입'한 성과.
//  신호 성과가 이 값을 넘지 못하면 그 신호는 알파가 아니라 그냥 시장 드리프트(베타)다.
//  ⚠️ 표본은 15년 일봉(2015·2018·2020·2022 하락장 포함)이지만, 관심종목이 반도체·빅테크
//   생존자 15개라 절대 수익률·승률은 신호가 없어도 구조적으로 (+)가 된다.
//  → 어떤 신호든 '기준선 대비 초과'로만 유효성을 주장할 수 있다.
const BT_BASE_BUY = "기준선 (전체 봉 · 매수)";
const BT_BASE_SELL = "기준선 (전체 봉 · 매도)";

// 레짐 분해(STEP 1-3) — 진입 시점의 시장 국면을 벤치마크 200일선 위/아래로 나눈다.
//  왜 필요한가: 직전 표본(3년)에는 하락장이 아예 없어서, 신호의 우위가 '지표의 힘'인지
//  '강세장이라 아무거나 사도 오른 것'인지 구분할 수 없었다. 레짐을 쪼개 같은 국면 안의
//  기준선과 비교해야 그 착시가 재발하지 않는다.
//  ⚠️ 판정은 진입 시점까지의 정보만 쓴다(인과적) — MA200은 그 날짜까지의 종가로만 계산.
const BT_REGIME_MA = 200; // 벤치마크 추세 판정선(일)
// 벤치마크는 표본보다 길게 받는다. MA200은 앞 200봉이 워밍업이라, 벤치마크를 표본과 같은
//  15년만 받으면 표본 앞부분(≈3.7%)이 레짐 미분류로 빠진다. 과거를 더 주는 것이므로
//  인과성은 그대로다(미래 정보가 아니다).
//  ⚠️ "max"를 쓰면 안 된다 — Yahoo는 range=max에서 interval=1d를 무시하고 월봉을 준다
//   (granularity=1mo, SPY 403봉). 날짜가 안 맞아 레짐이 97% 미분류가 되는데, 표는 멀쩡해
//   보여서 조용히 틀린다. 20y는 일봉이 온다(SPY 5,030봉 · 2006~).
const BT_REGIME_RANGE = "20y";
// 벤치마크가 일봉이 맞는지 확인하는 하한선. 20년 일봉이면 ~5,000봉이라 월봉(~400봉)과
//  확실히 갈린다. 미달이면 레짐 판정을 아예 포기한다(틀린 레짐 표보다 없는 게 낫다).
const BT_REGIME_MIN_BARS = 2500;
// 레짐 표에 보여줄 보유기간. 표를 2열(강세/약세)로 유지하려고 대표 기간 하나만 쓴다.
const BT_REGIME_HOLD = 10;

// 벤치마크 일봉 → Map<date, "bull"|"bear">. close > MA200 = 강세장.
function btRegimeMap(rows) {
  const map = new Map();
  const closes = rows.map((r) => r.close);
  for (let i = 0; i < rows.length; i++) {
    const ma = sma(closes, BT_REGIME_MA, i); // i시점까지의 종가만 사용 → look-ahead 없음
    if (ma == null || closes[i] == null) continue;
    map.set(rows[i].date, closes[i] > ma ? "bull" : "bear");
  }
  return map;
}

// 한 종목(지표 계산된 ind)의 진입 이벤트를 수집.
//  events: [{ kind:"baseline"|"signal"|"grade", label, dir, ret:{5,10,20}, atr, regime }]
//  delays: [{ d, dir, ret, regime }] — 타이밍 신호의 지연 진입 성과(B4)
//  regimeMap: 진입 봉 날짜 → "bull"|"bear" (없으면 레짐 미분류 = 레짐 표에서만 제외)
function backtestSeries(ind, cost = 0, regimeMap = null) {
  const n = ind.length;
  const events = [];
  const delays = [];
  if (n < BT_WARMUP + Math.min(...BT_HOLD)) return { events, delays, entries: 0 };
  const closes = ind.map((r) => r.close);
  let entries = 0; // 신호·구간 진입 건수(기준선 제외)

  let prevLabels = new Set(); // 직전 봉에서 켜져 있던 신호 라벨(엣지 감지용)
  let prevBucketKey = null; // 직전 봉의 점수 구간 키
  for (let i = BT_WARMUP; i < n; i++) {
    // 진입 시점의 레짐(강세/약세). 진입 봉 날짜로 조회하므로 미래 정보가 섞이지 않는다.
    const regime = regimeMap ? regimeMap.get(ind[i].date) || null : null;

    // 기준선: 신호와 무관하게 모든 봉에서 진입했다고 가정한 성과(매수·매도 양방향).
    for (const dir of ["buy", "sell"]) {
      const ret = btReturns(closes, i, dir, BT_HOLD, cost);
      if (ret)
        events.push({
          kind: "baseline",
          label: dir === "buy" ? BT_BASE_BUY : BT_BASE_SELL,
          dir,
          ret,
          atr: btAtrExit(ind, i, dir, cost),
          regime,
        });
    }

    // ctx 미주입: 주봉추세(#7)·RS(#8)는 과거 시점 재현이 어려워 백테스트 제외,
    //  RSI·볼린저는 지수 레짐 축소 없는 '신호 자체'(원점수)로 검증한다.
    // 전체 슬라이스(0..i) 대신 고정 창을 넘긴다 — 결과는 동일하고 O(n²)를 없앤다(BT_SIG_WINDOW 주석).
    const sig = computeSignal(ind.slice(i - BT_SIG_WINDOW + 1, i + 1));
    if (!sig) {
      prevLabels = new Set();
      prevBucketKey = null;
      continue;
    }

    // 개별 신호: label을 안정 키로 사용(라벨 텍스트는 고정, 가변값은 explain에만).
    //  timing = freshTiming을 거친 신호(MACD·스토캐스틱·다이버전스)만 fresh가 붙는다.
    //  라벨 문자열 매칭 대신 이 표식을 쓰므로 신호가 늘어도 자동으로 따라온다.
    const curLabels = new Map(); // label -> { dir, timing }
    for (const r of sig.buy) curLabels.set(r.label, { dir: "buy", timing: !!r.fresh });
    for (const r of sig.sell) curLabels.set(r.label, { dir: "sell", timing: !!r.fresh });
    for (const [label, { dir, timing }] of curLabels) {
      if (prevLabels.has(label)) continue; // 이미 켜져 있던 신호는 중복 진입 아님
      const ret = btReturns(closes, i, dir, BT_HOLD, cost);
      if (ret) {
        events.push({ kind: "signal", label, dir, ret, atr: btAtrExit(ind, i, dir, cost), regime });
        entries += 1;
      }
      // 지연 진입: 타이밍 신호만(되돌아보며 탐지하는 신호라 '늦게 보게 되는' 문제가 있음)
      if (timing)
        for (const d of BT_DELAYS) {
          const dRet = btReturns(closes, i + d, dir, BT_HOLD, cost);
          if (dRet) delays.push({ d, dir, ret: dRet, regime });
        }
    }
    prevLabels = new Set(curLabels.keys());

    // 종합 점수 구간: 직전과 다른 (의미있는) 구간으로 바뀐 봉을 진입으로 기록.
    const bucket = btScoreBucket(sig.score);
    if (bucket && bucket.key !== prevBucketKey) {
      const ret = btReturns(closes, i, bucket.dir, BT_HOLD, cost);
      if (ret) {
        events.push({
          kind: "grade",
          label: bucket.label,
          dir: bucket.dir,
          ret,
          atr: btAtrExit(ind, i, bucket.dir, cost),
          regime,
        });
        entries += 1;
      }
    }
    prevBucketKey = bucket ? bucket.key : null;
  }
  return { events, delays, entries };
}

// 이벤트 목록을 (kind+label)별로 집계.
//  기간별 stats: 평균·승률·표본수 + 중앙값·표준편차·최악값(B2) + 기준선 대비 초과(B1).
//   ▸ 왜 중앙값·최악값인가: "승률 70% / 평균 +0.5%"가 실은 가끔 −15% 터지는 신호일 수
//     있다. 평균만으로는 꼬리 위험이 안 보인다.
//  atr: ATR 청산(2×/3×) 성과 — 기대 R·손절/목표/시간 도달률(B3).
function aggregateBacktest(events) {
  // 하나의 표본(수익률 r, 방향 dir)을 누적 버킷에 담는다.
  //  nBuy/nSell: 방향이 섞인 행(지연 진입 표)에서 기준선을 표본 비율대로 가중하기 위함.
  const push = (bucket, p, r, dir) => {
    const a = bucket[p] || (bucket[p] = { vals: [], win: 0, nBuy: 0, nSell: 0 });
    a.vals.push(r);
    if (r > 0) a.win += 1;
    if (dir === "buy") a.nBuy += 1;
    else a.nSell += 1;
  };

  const map = new Map();
  for (const ev of events) {
    const key = `${ev.kind}:${ev.label}`;
    let g = map.get(key);
    if (!g) {
      g = {
        kind: ev.kind,
        label: ev.label,
        dir: ev.dir,
        d: ev.d,
        perP: {}, // 전체 표본
        regP: { bull: {}, bear: {} }, // 레짐별 표본(STEP 1-3)
        atr: { rs: [], stop: 0, target: 0, time: 0 },
      };
      map.set(key, g);
    }
    for (const p of BT_HOLD) {
      const r = ev.ret[p];
      if (r == null) continue;
      push(g.perP, p, r, ev.dir);
      // 레짐 미분류(벤치마크 휴장일 등)는 레짐 표에서만 빠지고 전체 집계에는 남는다.
      if (ev.regime) push(g.regP[ev.regime], p, r, ev.dir);
    }
    if (ev.atr) {
      g.atr.rs.push(ev.atr.r);
      g.atr[ev.atr.outcome] += 1;
    }
  }

  // 누적 버킷 → 기간별 통계(평균·승률·표본수 + 중앙값·표준편차·최악값).
  const statsOf = (bucket) => {
    const stats = {};
    for (const p of BT_HOLD) {
      const a = bucket[p];
      if (!a || !a.vals.length) {
        stats[p] = null;
        continue;
      }
      const n = a.vals.length;
      const avg = a.vals.reduce((s, v) => s + v, 0) / n;
      const sorted = [...a.vals].sort((x, y) => x - y);
      const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      const sd = Math.sqrt(a.vals.reduce((s, v) => s + (v - avg) ** 2, 0) / n);
      stats[p] = { avg, win: (a.win / n) * 100, n, median, sd, min: sorted[0], nBuy: a.nBuy, nSell: a.nSell };
    }
    return stats;
  };

  const toStats = (g) => {
    const an = g.atr.rs.length;
    const atr =
      an > 0
        ? {
            n: an,
            avgR: g.atr.rs.reduce((s, v) => s + v, 0) / an,
            stopRate: (g.atr.stop / an) * 100,
            targetRate: (g.atr.target / an) * 100,
            timeRate: (g.atr.time / an) * 100,
          }
        : null;
    return {
      kind: g.kind,
      label: g.label,
      dir: g.dir,
      d: g.d,
      stats: statsOf(g.perP),
      reg: { bull: statsOf(g.regP.bull), bear: statsOf(g.regP.bear) },
      atr,
    };
  };

  const rows = Array.from(map.values()).map(toStats);
  const findBase = (dir) => rows.find((r) => r.kind === "baseline" && r.dir === dir) || null;
  const baseline = { buy: findBase("buy"), sell: findBase("sell") };

  // 기준선 대비 초과(%p). 행의 방향 구성(nBuy/nSell)대로 매수·매도 기준선을 가중평균해
  //  비교 대상을 만든다. 매수 신호는 매수 기준선, 매도 신호는 매도 기준선과 비교된다.
  //  exAvg ≤ 0 이면 "그냥 아무 날에나 산 것만도 못하다" = 알파 없음.
  //  ⚠️ 레짐별 초과는 반드시 '같은 레짐의 기준선'과 비교한다. 강세장 신호를 전체 기준선과
  //   비교하면 강세장 드리프트가 신호의 알파로 둔갑한다(3년 표본이 만든 착시가 바로 이것).
  const excess = (row, get) => {
    for (const p of BT_HOLD) {
      const s = get(row)[p];
      const bb = baseline.buy && get(baseline.buy)[p];
      const bs = baseline.sell && get(baseline.sell)[p];
      if (!s || !bb || !bs) continue;
      const tot = s.nBuy + s.nSell;
      if (!tot) continue;
      s.exAvg = s.avg - (bb.avg * s.nBuy + bs.avg * s.nSell) / tot;
      s.exWin = s.win - (bb.win * s.nBuy + bs.win * s.nSell) / tot;
    }
  };
  for (const row of rows) {
    if (row.kind === "baseline") continue;
    excess(row, (r) => r.stats);
    excess(row, (r) => r.reg.bull);
    excess(row, (r) => r.reg.bear);
  }

  // 표본이 가장 많은 기간(10일 우선) 기준 표본수 내림차순 정렬.
  //  지연 진입 행만은 지연 봉수 순으로 둬야 '우위 소진' 추이가 읽힌다.
  const nOf = (r) => (r.stats[10]?.n ?? r.stats[5]?.n ?? r.stats[20]?.n ?? 0);
  const pick = (kind) => rows.filter((r) => r.kind === kind).sort((a, b) => nOf(b) - nOf(a));
  return {
    baseline,
    signals: pick("signal"),
    grades: pick("grade"),
    delays: rows.filter((r) => r.kind === "delay").sort((a, b) => a.d - b.d),
  };
}

/* ------------------------------------------------------------------ */
/*  포맷 유틸                                                          */
/* ------------------------------------------------------------------ */

function fmtNum(v, digits = 2) {
  if (v == null || isNaN(v)) return "-";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// 가격용: 큰 값(한국 주식 등)은 소수점 생략해 자릿수를 줄인다
function fmtPrice(v) {
  if (v == null || isNaN(v)) return "-";
  const digits = Math.abs(v) >= 1000 ? 0 : 2;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function colorOf(change) {
  if (change > 0) return UP;
  if (change < 0) return DOWN;
  return FLAT;
}

function signStr(v, digits = 2) {
  if (v == null || isNaN(v)) return "-";
  const s = v > 0 ? "+" : "";
  return s + fmtNum(v, digits);
}

// 데이터 기준 시각을 로컬 시간(MM/DD HH:mm)으로 표시
function fmtTime(ts) {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/*  캔들스틱 커스텀 Shape                                              */
/* ------------------------------------------------------------------ */

// Bar dataKey="range" ([low, high]) 기준으로 캔들 몸통/꼬리를 그림
function Candle(props) {
  const { x, y, width, height, payload } = props;
  const { open, high, low, close } = payload;
  if (high === low) return null;

  const rising = close >= open;
  const color = rising ? UP : DOWN;

  // y..y+height 가 high..low 픽셀 범위
  const pxPerPrice = height / (high - low);
  const openY = y + (high - open) * pxPerPrice;
  const closeY = y + (high - close) * pxPerPrice;
  const bodyTop = Math.min(openY, closeY);
  const bodyH = Math.max(1, Math.abs(closeY - openY));
  const cx = x + width / 2;

  return (
    <g>
      {/* 위/아래 꼬리 */}
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />
      {/* 몸통 */}
      <rect
        x={x}
        y={bodyTop}
        width={width}
        height={bodyH}
        fill={color}
        stroke={color}
      />
    </g>
  );
}

// Stochastic 강한 크로스 마커 (Scatter shape)
// 과매도 골든크로스=상승 삼각형(▲ 빨강), 과매수 데드크로스=하락 삼각형(▼ 파랑).
// 일반 크로스는 stochMarkerY가 없어 그려지지 않는다.
function StochMarker(props) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload?.stochMarkerY == null) return null;
  const golden = payload.stochCross === "golden";
  const color = golden ? UP : DOWN;
  const s = 6; // 삼각형 반경
  // golden은 위로(▲), 마커를 선 아래쪽에 / dead는 아래로(▼), 선 위쪽에
  const oy = golden ? cy + 12 : cy - 12;
  const tri = golden
    ? `${cx},${oy - s} ${cx - s},${oy + s} ${cx + s},${oy + s}`
    : `${cx},${oy + s} ${cx - s},${oy - s} ${cx + s},${oy - s}`;
  return <polygon points={tri} fill={color} stroke={color} strokeWidth={1.5} />;
}

// 다이버전스 마커 (Scatter shape) — 속 빈 마름모(◇)로 스토캐스틱 삼각형과 구분.
//  강세(bull)=빨강·저점 아래, 약세(bear)=파랑·고점 위. field로 어느 오실레이터의
//  방향 키(rsiDiv/macdDiv)를 읽을지 지정한다(RSI·MACD 차트에 각각 사용).
function DivMarker(props) {
  const { cx, cy, payload, field } = props;
  if (cx == null || cy == null) return null;
  const dir = payload?.[field];
  if (!dir) return null;
  const bull = dir === "bull";
  const color = bull ? UP : DOWN;
  const s = 5;
  const oy = bull ? cy + 13 : cy - 13; // bull은 저점 아래, bear는 고점 위
  const pts = `${cx},${oy - s} ${cx + s},${oy} ${cx},${oy + s} ${cx - s},${oy}`;
  return <polygon points={pts} fill="none" stroke={color} strokeWidth={1.8} />;
}

/* ------------------------------------------------------------------ */
/*  공통 차트 스타일                                                   */
/* ------------------------------------------------------------------ */

const axisStyle = { fontSize: 10, fill: "#888" };
const tooltipStyle = {
  backgroundColor: "#1a1a1a",
  border: "1px solid #333",
  borderRadius: 6,
  fontSize: 12,
  color: "#eee",
};

// x축 라벨 과밀 방지: 일정 간격만 노출
function makeTickFormatter(data) {
  const step = Math.max(1, Math.floor(data.length / 8));
  return (val, index) => (index % step === 0 ? val.slice(0, 7) : "");
}

/* ------------------------------------------------------------------ */
/*  확장 차트 패널                                                     */
/* ------------------------------------------------------------------ */

// 신호 근거 → 차트 세로 하이라이트 색상
const HL_COLOR = "#ffd24d";

/* ------------------------------------------------------------------ */
/*  펀더멘털 참고 표시 (FMP · 점수 미반영)                              */
/* ------------------------------------------------------------------ */
//  빌드타임에 src/data/fundamentals.json 으로 구워 둔 정적 스냅샷.
//  (MCP/REST 키 노출·CORS·rate limit 회피 — scripts/fetch-fundamentals.mjs 로 갱신)
//  미국 개별주만 존재. ETF·한국(.KS)·미커버 종목은 키 자체가 없어 표시되지 않는다.
const FUNDAMENTALS = fundamentalsData.data || {};
const FUNDAMENTALS_META = fundamentalsData.meta || {};

function FundamentalsBox({ symbol, lastClose }) {
  const f = FUNDAMENTALS[symbol];
  if (!f) return null; // ETF·한국주·미커버 종목 = 조용히 생략(기존 패턴)

  // 상승여력 = 목표 컨센서스 대비 현재가. 앱이 받은 실시간 종가로 계산해 신선도 유지.
  const upside =
    f.targetConsensus != null && lastClose
      ? ((f.targetConsensus - lastClose) / lastClose) * 100
      : null;
  const upColor = upside == null ? "#aaa" : upside >= 0 ? UP : DOWN;
  // PEG는 음수/과대값이면 의미가 없어 가린다(성장 대비 밸류의 정상 범위만 표기)
  const pegShow = f.peg != null && f.peg > 0 && f.peg < 5;

  const cell = (label, value, color) => (
    <div style={styles.fbCell} key={label}>
      <span style={styles.fbLabel}>{label}</span>
      <span style={{ ...styles.fbValue, ...(color ? { color } : null) }}>{value}</span>
    </div>
  );

  return (
    <div style={styles.fbBox}>
      <div style={styles.fbRow}>
        {cell("PER", f.per != null ? `${fmtNum(f.per, 1)}배` : "-")}
        {cell("PBR", f.pbr != null ? `${fmtNum(f.pbr, 1)}배` : "-")}
        {pegShow && cell("PEG", fmtNum(f.peg, 2))}
        {cell("배당수익률", f.divYield ? `${fmtNum(f.divYield * 100, 2)}%` : "0%")}
        {f.targetConsensus != null &&
          cell(
            "목표가(컨센서스)",
            <>
              ${fmtNum(f.targetConsensus, 0)}
              {upside != null && (
                <span style={{ color: upColor, marginLeft: 6 }}>({signStr(upside, 1)}%)</span>
              )}
            </>,
          )}
        {f.targetHigh != null &&
          cell("목표 범위", `$${fmtNum(f.targetLow, 0)} ~ $${fmtNum(f.targetHigh, 0)}`)}
      </div>
      <div style={styles.fbNote}>
        ⚠️ 참고용 펀더멘털 · <b>신호 점수에 미반영</b> · 출처 FMP · 기준 {FUNDAMENTALS_META.generatedAt}
      </div>
    </div>
  );
}

function ChartPanel({ symbol, highlight }) {
  const [range, setRange] = useState("1y");
  const [interval, setIntervalSel] = useState("1d");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  // 차트별 래퍼 ref (신호 클릭 시 해당 차트로 스크롤)
  const chartRefs = {
    price: useRef(null),
    rsi: useRef(null),
    stoch: useRef(null),
    macd: useRef(null),
  };
  // 잠깐 빛나게 할 차트 키
  const [flashKey, setFlashKey] = useState(null);

  // 신호 근거 배지를 누르면 해당 신호 기준으로 차트를 강제 전환.
  //  일봉 신호 = 1년 일봉, 주봉 추세 신호 = 3년 주봉(주봉 MA60 표시에 필요).
  useEffect(() => {
    if (!highlight) return;
    const weekly = highlight.interval === "1wk";
    setRange(weekly ? "3y" : "1y");
    setIntervalSel(weekly ? "1wk" : "1d");
  }, [highlight?.nonce]);

  // 데이터가 준비되면 해당 차트로 스크롤 + 글로우 (확장 애니메이션이 끝난 뒤)
  useEffect(() => {
    if (!highlight || !data) return;
    const ref = chartRefs[highlight.chart];
    if (!ref?.current) return;
    const t = setTimeout(() => {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashKey(highlight.chart);
    }, 420);
    const t2 = setTimeout(() => setFlashKey(null), 2200);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [highlight?.nonce, data]);

  // 하이라이트 대상 날짜가 현재 데이터에 존재할 때만 세로선 표시
  const hlDate =
    highlight && data && data.some((d) => d.date === highlight.date)
      ? highlight.date
      : null;

  // chartKey 차트에 그릴 세로 하이라이트선 (대상 차트는 강조, 나머지는 옅게)
  const hlLine = (chartKey) => {
    if (!hlDate) return null;
    const target = highlight.chart === chartKey;
    return (
      <ReferenceLine
        x={hlDate}
        stroke={target ? HL_COLOR : "#5a5a5a"}
        strokeWidth={target ? 1.6 : 1}
        strokeDasharray={target ? undefined : "3 3"}
        ifOverflow="extendDomain"
        label={
          target
            ? { value: "◆ 신호", position: "top", fill: HL_COLOR, fontSize: 10, fontWeight: 700 }
            : undefined
        }
      />
    );
  };

  // 차트 래퍼 공통 스타일 (글로우 효과 포함)
  const wrap = (key) => ({
    borderRadius: 8,
    padding: "2px 6px",
    margin: "0 -6px",
    transition: "box-shadow 0.4s ease, background 0.4s ease",
    boxShadow:
      flashKey === key
        ? `0 0 0 2px ${HL_COLOR}, 0 0 18px rgba(255,210,77,0.35)`
        : "none",
    background: flashKey === key ? "rgba(255,210,77,0.05)" : "transparent",
  });

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(false);
    // 차트는 **표시 경로**라 장중 미완성 봉을 그대로 그린다(현재가 확인용).
    //  단, 그 봉에는 신호 마커(스토캐스틱 크로스·다이버전스)를 찍지 않는다 —
    //  미완성 봉의 마커는 종가에 사라질 수 있어(repaint) '지나간 자리'로 오독된다.
    //  채점(신호 종합 패널)은 이 봉을 아예 쓰지 않는다(fetchSeries).
    fetchSeriesLive(symbol, range, interval)
      .then(({ rows, live }) => {
        if (!alive) return;
        if (!rows.length) throw new Error("empty");
        const ind = computeIndicators(rows);
        if (live && ind.length) {
          const i = ind.length - 1;
          ind[i] = {
            ...ind[i],
            stochMarkerY: undefined,
            rsiDivY: undefined,
            macdDivY: undefined,
          };
        }
        setData(ind);
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [symbol, range, interval]);

  const rangeLabel =
    RANGE_OPTIONS.find((o) => o.range === range)?.label || range;
  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.interval === interval)?.label || interval;

  const toolbar = (
    <div style={styles.chartToolbar}>
      <div style={styles.btnGroup}>
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.range}
            onClick={() => setRange(o.range)}
            style={{
              ...styles.toolBtn,
              ...(range === o.range ? styles.toolBtnActive : null),
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div style={styles.btnGroup}>
        {INTERVAL_OPTIONS.map((o) => (
          <button
            key={o.interval}
            onClick={() => setIntervalSel(o.interval)}
            style={{
              ...styles.toolBtn,
              ...(interval === o.interval ? styles.toolBtnActive : null),
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (err)
    return (
      <div style={{ padding: "8px 16px 20px" }}>
        {toolbar}
        <div style={{ padding: 24, color: "#ff7a7a" }}>
          데이터 오류 — 프록시(corsproxy.io)·네트워크 문제일 수 있습니다. 잠시 후 다시 열어
          보세요.
        </div>
      </div>
    );
  if (!data)
    return (
      <div style={{ padding: "8px 16px 20px" }}>
        {toolbar}
        <div style={{ padding: 24, color: "#888" }}>차트 Loading...</div>
      </div>
    );

  const tickFmt = makeTickFormatter(data);

  return (
    <div style={{ padding: "8px 16px 20px" }}>
      {toolbar}
      <FundamentalsBox symbol={symbol} lastClose={data[data.length - 1]?.close} />
      {/* 차트 1: 가격 + 이동평균선 (캔들스틱) */}
      <div ref={chartRefs.price} style={wrap("price")}>
      <ChartTitle>{`가격 / 이동평균선 (${rangeLabel} ${intervalLabel})`}</ChartTitle>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis
            domain={["auto", "auto"]}
            tick={axisStyle}
            width={60}
            tickFormatter={(v) => fmtNum(v, 0)}
            orientation="right"
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: "#aaa" }}
            formatter={(v, n) => [fmtNum(v, 2), n]}
          />
          {/* 볼린저 밴드 (상단/하단 점선, 가운데 생략) */}
          <Line type="monotone" dataKey="bbUpper" stroke="#5a6b8c" dot={false} strokeWidth={1} strokeDasharray="3 3" name="볼밴 상단" isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="bbLower" stroke="#5a6b8c" dot={false} strokeWidth={1} strokeDasharray="3 3" name="볼밴 하단" isAnimationActive={false} connectNulls />
          <Bar dataKey="range" shape={<Candle />} isAnimationActive={false} />
          <Line type="monotone" dataKey="ma5" stroke={MA_COLORS.ma5} dot={false} strokeWidth={1} name="MA5" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma20" stroke={MA_COLORS.ma20} dot={false} strokeWidth={1} name="MA20" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma60" stroke={MA_COLORS.ma60} dot={false} strokeWidth={1} name="MA60" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma120" stroke={MA_COLORS.ma120} dot={false} strokeWidth={1} name="MA120" isAnimationActive={false} />
          {hlLine("price")}
        </ComposedChart>
      </ResponsiveContainer>
      <Legend />
      </div>

      {/* 차트 2: RSI */}
      <div ref={chartRefs.rsi} style={wrap("rsi")}>
      <ChartTitle info={RSI_INFO}>RSI (14)</ChartTitle>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} tick={axisStyle} width={60} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(v, 2)} />
          <ReferenceLine y={70} stroke="#ff4d4d" strokeDasharray="4 4" />
          <ReferenceLine y={30} stroke="#4d8bff" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="rsi" stroke="#e0e0e0" dot={false} strokeWidth={1.2} name="RSI" isAnimationActive={false} />
          <Scatter dataKey="rsiDivY" shape={<DivMarker field="rsiDiv" />} isAnimationActive={false} legendType="none" />
          {hlLine("rsi")}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={styles.crossLegend}>
        <span style={{ color: UP }}>◇ 강세 다이버전스(가격 저점↓ · RSI 저점↑)</span>
        <span style={{ color: DOWN }}>◇ 약세 다이버전스(가격 고점↑ · RSI 고점↓)</span>
      </div>
      </div>

      {/* 차트 3: Stochastic + 골든/데드 크로스 마커 */}
      <div ref={chartRefs.stoch} style={wrap("stoch")}>
      <ChartTitle info={STOCH_INFO}>Slow Stochastic (14, 3, 3)</ChartTitle>
      <ResponsiveContainer width="100%" height={160}>
        <ComposedChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis domain={[0, 100]} ticks={[0, 20, 50, 80, 100]} tick={axisStyle} width={60} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(v, 2)} />
          <ReferenceLine y={80} stroke="#ff4d4d" strokeDasharray="4 4" />
          <ReferenceLine y={20} stroke="#4d8bff" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="k" stroke="#ffd24d" dot={false} strokeWidth={1.2} name="%K" isAnimationActive={false} />
          <Line type="monotone" dataKey="d" stroke="#4dffb0" dot={false} strokeWidth={1.2} name="%D" isAnimationActive={false} />
          <Scatter dataKey="stochMarkerY" shape={<StochMarker />} isAnimationActive={false} legendType="none" />
          {hlLine("stoch")}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={styles.crossLegend}>
        <span style={{ color: UP }}>▲ 과매도 골든크로스(강한 매수)</span>
        <span style={{ color: DOWN }}>▼ 과매수 데드크로스(강한 매도)</span>
        <span style={{ color: "#888" }}>일반 크로스는 신뢰도가 낮아 생략</span>
      </div>
      </div>

      {/* 차트 4: MACD (마지막 차트라 도움말은 위로 펼침) */}
      <div ref={chartRefs.macd} style={wrap("macd")}>
      <ChartTitle info={MACD_INFO} infoPlacement="top">MACD (12 / 26 / 9)</ChartTitle>
      <ResponsiveContainer width="100%" height={160}>
        <ComposedChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis domain={["auto", "auto"]} tick={axisStyle} width={60} tickFormatter={(v) => fmtNum(v, 1)} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(v, 3)} />
          <ReferenceLine y={0} stroke="#555" />
          <Bar dataKey="macdHist" name="히스토그램" isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.macdHist >= 0 ? "#ff4d4d" : "#4d8bff"} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="macd" stroke="#ffd24d" dot={false} strokeWidth={1.2} name="MACD" isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="macdSignal" stroke="#4dffb0" dot={false} strokeWidth={1.2} name="Signal" isAnimationActive={false} connectNulls />
          <Scatter dataKey="macdDivY" shape={<DivMarker field="macdDiv" />} isAnimationActive={false} legendType="none" />
          {hlLine("macd")}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={styles.crossLegend}>
        <span style={{ color: UP }}>◇ 강세 다이버전스(가격 저점↓ · MACD 저점↑)</span>
        <span style={{ color: DOWN }}>◇ 약세 다이버전스(가격 고점↑ · MACD 고점↓)</span>
      </div>
      </div>
    </div>
  );
}

function ChartTitle({ children, info, infoPlacement }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        color: "#bbb",
        fontSize: 13,
        fontWeight: 600,
        margin: "14px 0 4px",
      }}
    >
      {children}
      {info && <InfoButton info={info} placement={infoPlacement} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  보조지표 설명 (핵심만)                                              */
/* ------------------------------------------------------------------ */

const RSI_INFO = {
  title: "RSI (14)",
  lines: [
    "최근 14일 상승·하락 강도를 0~100으로 표현",
    "70 이상 = 과매수(조정 가능) · 30 이하 = 과매도(반등 가능)",
    "50 위 = 강세 / 아래 = 약세. 추세 강도 확인용 (느린 지표)",
  ],
};

const STOCH_INFO = {
  title: "Slow Stochastic (14, 3, 3)",
  lines: [
    "최근 14일 고가~저가 범위에서 현재가 위치",
    "Slow %K = 원시%K의 3일 평균 · %D = Slow %K의 3일 평균",
    "원시(Fast) %K를 한 번 더 평활해 가짜 크로스를 줄인 업계 표준",
    "80 이상 = 과매수 · 20 이하 = 과매도",
    "%K가 %D 상향 돌파(▲) = 매수 / 하향 돌파(▼) = 매도 신호",
    "과매도 구간 골든크로스·과매수 구간 데드크로스는 강신호",
  ],
};

const MACD_INFO = {
  title: "MACD (12 / 26 / 9)",
  lines: [
    "단기(12)·장기(26) 지수이동평균의 차이로 추세 전환 포착",
    "MACD선이 시그널선을 상향 돌파 = 매수 / 하향 돌파 = 매도",
    "히스토그램(막대) = MACD−시그널. 0선 위로 전환 = 상승 모멘텀",
    "RSI·Stochastic(위치 지표)과 달리 추세 방향을 보완 확인",
  ],
};

// 제목 옆 "?" 버튼: 클릭 시 핵심 설명 팝오버 토글
// placement="top"이면 팝오버를 버튼 위로 펼침 (마지막 차트에서 잘림 방지)
function InfoButton({ info, placement }) {
  const [open, setOpen] = useState(false);
  const popStyle =
    placement === "top"
      ? { ...styles.infoPop, top: "auto", bottom: 22 }
      : styles.infoPop;
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...styles.infoBtn, ...(open ? styles.infoBtnActive : null) }}
        aria-label="지표 설명"
      >
        ?
      </button>
      {open && (
        <div style={popStyle}>
          <div style={styles.infoPopTitle}>{info.title}</div>
          {info.lines.map((l, i) => (
            <div key={i} style={styles.infoPopLine}>
              • {l}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

function Legend() {
  const items = [
    ["MA5", MA_COLORS.ma5],
    ["MA20", MA_COLORS.ma20],
    ["MA60", MA_COLORS.ma60],
    ["MA120", MA_COLORS.ma120],
    ["볼린저밴드", "#5a6b8c"],
  ];
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#999", marginTop: 4 }}>
      {items.map(([label, color]) => (
        <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 12, height: 2, background: color, display: "inline-block" }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  환율 위젯 (우상단)                                                 */
/* ------------------------------------------------------------------ */

function ExchangeRateWidget({ name, symbol }) {
  const { q, err } = useQuote(symbol);
  const color = q ? colorOf(q.change) : FLAT;

  return (
    <div style={styles.fxWidget}>
      <span style={styles.fxLabel}>환율</span>
      <span style={styles.fxUnit}>$/₩</span>
      {err && !q ? (
        <span style={styles.errText}>오류</span>
      ) : !q ? (
        <span style={{ color: "#666" }}>···</span>
      ) : (
        <>
          <span style={{ ...styles.fxPrice, color }}>{fmtNum(q.price, 2)}</span>
          <span style={{ ...styles.fxChange, color }}>
            {signStr(q.change, 2)} ({signStr(q.changePct, 2)}%)
          </span>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  시장 레짐 요약 바 (VIX·ADX)                                        */
/* ------------------------------------------------------------------ */

// VIX → 위험선호/회피, S&P500 ADX → 추세장/횡보장 한 줄 요약. (점수 무관·표시용)
//  VIX < 20 위험선호 / 20~30 중립 / > 30 위험회피(공포)
//  ADX ≥ 25 추세장 / 20~25 전환 구간 / < 20 횡보장
function MarketRegimeWidget() {
  const { vix, adx, loading, err } = useMarketRegime();
  if (err) return null; // 보조 정보라 실패 시 위젯 숨김

  const riskTone =
    vix == null
      ? null
      : vix < 20
      ? { t: "위험 선호", c: UP }
      : vix > 30
      ? { t: "위험 회피(공포)", c: DOWN }
      : { t: "중립", c: "#bbb" };
  const trendTone =
    adx == null
      ? null
      : adx >= 25
      ? { t: "추세장", c: "#ffd24d" }
      : adx < 20
      ? { t: "횡보장", c: "#888" }
      : { t: "전환 구간", c: "#bbb" };

  return (
    <div style={styles.regimeBar}>
      <span style={styles.regimeLabel}>🌐 시장 레짐</span>
      {loading ? (
        <span style={{ color: "#666" }}>분석 중…</span>
      ) : (
        <>
          <span style={styles.regimeItem}>
            VIX <b>{vix != null ? fmtNum(vix, 1) : "-"}</b>
            {riskTone && (
              <em style={{ ...styles.regimeTag, color: riskTone.c }}>{riskTone.t}</em>
            )}
          </span>
          <span style={styles.regimeDivider}>·</span>
          <span style={styles.regimeItem}>
            S&amp;P500 <b>ADX {adx != null ? fmtNum(adx, 0) : "-"}</b>
            {trendTone && (
              <em style={{ ...styles.regimeTag, color: trendTone.c }}>{trendTone.t}</em>
            )}
          </span>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  신호 종합 패널                                                      */
/* ------------------------------------------------------------------ */

// 점수 → 라벨/색상
// 만점(매수 +17 / 매도 −16) 기준 등급컷(±7/±3).
//  ⚠️ 라벨은 '신호가 얼마나 모였나'라는 사실만 말한다. "적극 매수" 같은 행동 권유가
//  아니다 — 이 점수의 초과수익은 15년 검증에서 +0.1%p(= 차이 없음)였다(INDICATORS.md 2-b).
function signalGrade(score) {
  if (score >= 7) return { label: "매수신호 강함", color: "#ff4d4d" };
  if (score >= 3) return { label: "매수신호 있음", color: "#ff8c4d" };
  if (score <= -7) return { label: "매도신호 강함", color: "#4d8bff" };
  if (score <= -3) return { label: "매도신호 있음", color: "#6fa8ff" };
  return { label: "중립", color: "#999" };
}

// 각 신호가 '왜' 매수/매도 신호인지에 대한 짧은 설명(배지 hover 툴팁용).
//  reason.label을 키로 조회한다. 라벨을 바꾸면 여기 키도 같이 고칠 것.
//  (점수표·판정 기준은 computeSignal / INDICATORS.md와 동기화)
const SIGNAL_TIPS = {
  "MACD 골든크로스(0선 위)":
    "MACD선이 시그널선을 0선 위에서 상향 돌파. 상승 추세가 이어질 가능성이 큰, 신뢰도 높은 매수 타이밍 신호입니다.",
  "MACD 골든크로스(0선 아래·약)":
    "MACD 골든크로스지만 0선 아래라 하락 구간의 일시 반등일 수 있어, 신뢰도가 약한 매수 신호입니다.",
  "MACD 데드크로스(0선 아래)":
    "MACD선이 시그널선을 0선 아래에서 하향 돌파. 하락 추세가 이어지는, 신뢰도 높은 매도 신호입니다.",
  "MACD 데드크로스(0선 위·약)":
    "MACD 데드크로스지만 0선 위라 상승 구간의 눌림일 수 있어, 신뢰도가 약한 매도 신호입니다.",
  "스토캐스틱 과매도 골든크로스":
    "과매도 구간(20 이하)에서 %K가 %D를 상향 돌파. 노이즈를 거른, 신뢰도 높은 반등 매수 타이밍입니다.",
  "스토캐스틱 과매수 데드크로스":
    "과매수 구간(80 이상)에서 %K가 %D를 하향 돌파. 신뢰도 높은 조정 매도 신호입니다.",
  "RSI 과매도(<30)":
    "RSI가 30 미만. 통계적으로 과하게 빠진 위치로, 반등이 나올 수 있는 평균회귀 매수 영역입니다.",
  "RSI 과매도(지수 약세·가중↓)":
    "RSI 30 미만 과매도지만, 지수가 하락추세/급락 국면이라 '떨어지는 칼' 위험이 커 신뢰도를 낮춰 +2→+1로 가중 축소했습니다.",
  "RSI 과매수(>70)":
    "RSI가 70 초과. 과열 구간으로 조정이 나올 수 있는 위치입니다.",
  "RSI 과매수(지수 강세·가중↓)":
    "RSI 70 초과 과매수지만, 지수가 상승추세/급등 국면이라 과매수 되돌림 매도가 추세에 역행해 자주 틀립니다. 신뢰도를 낮춰 −2→−1로 가중 축소했습니다.",
  "볼린저 하단 이탈/근접":
    "종가가 밴드 하단(−2σ) 5% 이내(%B ≤ 0.05)까지 내려오거나 이탈. 통계적으로 과도하게 빠져 평균회귀 반등을 기대하는 자리입니다. 밴드 폭으로 정규화(%B)해 판정하므로 변동성이 낮은 종목에서 남발되지 않습니다.",
  "볼린저 하단(지수 약세·가중↓)":
    "볼린저 하단 이탈/근접이지만, 지수가 하락추세/급락 국면이라 평균회귀 반등 신뢰도를 낮춰 +2→+1로 가중 축소했습니다.",
  "볼린저 상단 이탈/근접":
    "종가가 밴드 상단(+2σ) 5% 이내(%B ≥ 0.95)까지 올라오거나 이탈. 과도하게 올라 조정 가능성이 있는 자리입니다.",
  "볼린저 상단(지수 강세·가중↓)":
    "볼린저 상단 이탈/근접이지만, 지수가 상승추세/급등 국면이라 추세에 역행하는 매도 신뢰도를 낮춰 −2→−1로 가중 축소했습니다.",
  "정배열(MA5>20>60)":
    "이동평균이 MA5>20>60으로 정렬. 상승 추세를 확인하는 보조 신호입니다.",
  "역배열(MA5<20<60)":
    "이동평균이 MA5<20<60으로 정렬. 하락 추세를 확인하는 보조 신호입니다.",
  "거래량 급증+상승":
    "거래량이 20일 평균의 1.5배 이상이면서 양봉(종가≥시가). 매수세 유입을 확인하는 보조 신호입니다.",
  "주봉 상승추세":
    "주봉 MA20이 MA60 위. 큰 흐름(주봉)이 상승추세로, 일봉 매수신호의 신뢰도를 높이는 멀티 타임프레임 필터입니다.",
  "주봉 하락추세":
    "주봉 MA20이 MA60 아래. 큰 흐름(주봉)이 하락추세로, 일봉 매수신호를 상쇄해 역추세(칼받이) 진입을 억제합니다.",
  "시장 대비 강세":
    "벤치마크(미국=SPY, 한국=KOSPI)보다 단기·중기 둘 다 강한 종목. 같은 매수 신호라도 이후 성과가 더 좋은 경향이 있는 확인 신호입니다.",
  "시장 대비 약세":
    "벤치마크(미국=SPY, 한국=KOSPI)보다 단기·중기 둘 다 약한 종목임을 확인하는 신호입니다.",
  "강세 다이버전스":
    "가격은 더 낮은 저점을 찍었는데 RSI/MACD는 더 높은 저점을 만든 엇갈림. 하락 동력이 약해지는 추세 반전(반등) 조짐입니다.",
  "약세 다이버전스":
    "가격은 더 높은 고점을 찍었는데 RSI/MACD는 더 낮은 고점을 만든 엇갈림. 상승 동력이 약해지는 추세 반전(조정) 조짐입니다.",
  "추세장 추세신호 정합":
    "추세가 강한 국면(종목 ADX≥25)에서 추세추종 신호(MACD 0선 돌파·MA 배열)가 함께 떴습니다. 추세장엔 추세추종이 잘 통해 신뢰도를 ±1 가산하는 확인 보조 신호입니다.",
  "횡보장 평균회귀 정합":
    "추세가 약한 국면(종목 ADX<20)에서 평균회귀 신호(RSI 과매도/과매수·볼린저 밴드)가 함께 떴습니다. 횡보장엔 평균회귀가 잘 통해 신뢰도를 ±1 가산하는 확인 보조 신호입니다.",
};

// 신호 신선도 표기 — "당일 발생 / N봉 전 · 이후 ±X%". 타이밍 신호(fresh 필드 보유)만.
//  옛날에 켜진 신호를 지금 자리로 착각하지 않도록, 발생 시점과 그 후 가격 이동을 명시한다.
function freshText(fresh) {
  if (!fresh) return null;
  const { barsAgo, moveSince } = fresh;
  const when = barsAgo === 0 ? "당일 발생" : `${barsAgo}봉 전`;
  const mv = `${moveSince >= 0 ? "+" : ""}${moveSince.toFixed(0)}%`;
  return `${when} · 이후 ${mv}`;
}

// 신호 근거 배지. 차트로 위치를 짚을 수 있는 신호는 클릭 시 차트 이동(↗),
// 차트로 못 짚는 신호(시장 대비 RS 등)는 클릭 시 이유·의미 설명 팝오버(ⓘ).
// 어느 배지든 마우스를 올리면(hover) 그 신호의 의미를 짧은 툴팁으로 보여준다.
function ReasonBadge({ symbol, reason, color, onReasonClick, isNew }) {
  const [showInfo, setShowInfo] = useState(false);
  const [hover, setHover] = useState(false);
  const chartClickable = !!(reason.chart && reason.date && onReasonClick);
  const infoClickable = !chartClickable && !!reason.explain;
  const clickable = chartClickable || infoClickable;
  const tip = SIGNAL_TIPS[reason.label]; // 신호 의미 (hover 툴팁)

  const handleClick = () => {
    if (chartClickable) onReasonClick(symbol, reason);
    else if (infoClickable) setShowInfo((v) => !v);
  };

  // hover 툴팁 하단의 클릭 동작 안내
  const actionHint = chartClickable
    ? reason.interval === "1wk"
      ? "클릭 → 주봉 차트로 이동"
      : "클릭 → 차트에서 위치 보기"
    : infoClickable
    ? "클릭 → 자세히 보기"
    : null;

  // ⓘ 상세 팝오버가 열려 있으면 hover 툴팁은 숨겨 중복 방지
  const showTip = hover && !!tip && !showInfo;

  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className={clickable ? "sig-reason clk" : "sig-reason"}
        onClick={clickable ? handleClick : undefined}
        style={{
          ...styles.badge,
          borderColor: color,
          color,
          cursor: clickable ? "pointer" : "default",
        }}
      >
        {isNew && (
          <span style={styles.newTag} title="직전 완성 봉엔 없던 신호입니다">
            🆕{" "}
          </span>
        )}
        {reason.label}{" "}
        <b style={{ fontVariantNumeric: "tabular-nums" }}>
          ({reason.points > 0 ? `+${reason.points}` : reason.points})
        </b>
        {reason.fresh && (
          <span
            style={reason.fresh.stale ? styles.freshChipStale : styles.freshChip}
          >
            {" "}
            {freshText(reason.fresh)}
          </span>
        )}
        {chartClickable && <span style={styles.badgeArrow}> ↗</span>}
        {infoClickable && <span style={styles.badgeArrow}> ⓘ</span>}
      </span>
      {showTip && (
        <div style={styles.reasonTip}>
          <div style={styles.reasonTipText}>{tip}</div>
          {actionHint && <div style={styles.reasonTipHint}>{actionHint}</div>}
        </div>
      )}
      {showInfo && (
        <div style={styles.reasonPop}>
          <div style={styles.reasonPopTitle}>{reason.label}</div>
          {reason.explain.split("\n\n").map((p, idx) => (
            <div key={idx} style={styles.reasonPopText}>
              {p}
            </div>
          ))}
          <div style={styles.reasonPopHint}>
            ⓘ 특정 봉(날짜)에 묶이지 않는 신호라 차트로 이동하지 않습니다.
          </div>
        </div>
      )}
    </span>
  );
}

// 점수 상세 모달 — 각 신호가 종합 점수에 어떻게 가산/감산됐는지 항목별로 보여준다.
//  카드는 우세 방향 배지만 표시하지만, 여기서는 매수(+)·매도(−) 양쪽을 모두 합산해
//  최종 점수가 어떻게 나왔는지와 노출/등급 기준을 함께 설명한다.
function ScoreBreakdownModal({ item, grade, onClose }) {
  const buySum = item.buy.reduce((s, b) => s + b.points, 0);
  const sellSum = item.sell.reduce((s, b) => s + b.points, 0);

  const Row = ({ r }) => (
    <div style={styles.mbRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.mbLabel}>{r.label}</div>
        {SIGNAL_TIPS[r.label] && (
          <div style={styles.mbSub}>{SIGNAL_TIPS[r.label]}</div>
        )}
        {r.fresh && (
          <div
            style={{
              ...styles.mbSub,
              color: r.fresh.stale ? "#ffae57" : "#7bd88f",
            }}
          >
            ⏱ {freshText(r.fresh)}
            {r.fresh.stale
              ? " — 발생 후 가격이 이미 그 방향으로 움직였습니다(참고). 점수에는 반영하지 않습니다."
              : " — 최근 발생한 신호입니다."}
          </div>
        )}
      </div>
      <b style={{ ...styles.mbPts, color: r.points > 0 ? UP : DOWN }}>
        {r.points > 0 ? `+${r.points}` : r.points}
      </b>
    </div>
  );

  // 노출/등급 안내 (현재 점수 기준 동적 문구)
  let verdict;
  if (item.score >= 3) verdict = "+3 이상이라 매수 쪽 신호 목록에 노출됩니다. (노출 기준일 뿐, 매수 권유가 아닙니다)";
  else if (item.score <= -3) verdict = "−3 이하라 매도 쪽 신호 목록에 노출됩니다. (노출 기준일 뿐, 매도 권유가 아닙니다)";
  else verdict = `현재 ${item.score > 0 ? "+" : ""}${item.score}점은 중립 구간(−2~+2)이라 목록에 노출되지 않습니다. (+3 이상=매수 쪽 / −3 이하=매도 쪽)`;

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <span style={styles.modalTitle}>{item.name}</span>
            <span style={styles.modalSym}>{item.symbol}</span>
          </div>
          <button style={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={styles.modalScoreLine}>
          <span style={{ color: "#999" }}>종합 점수</span>
          <b style={{ ...styles.modalScore, color: grade.color }}>
            {item.score > 0 ? `+${item.score}` : item.score}점
          </b>
          <span style={{ ...styles.modalGrade, color: grade.color }}>
            {grade.label}
          </span>
        </div>

        {item.buy.length > 0 && (
          <>
            <div style={styles.mbSectionTitle}>가산 신호 (매수 +)</div>
            {item.buy.map((r, i) => (
              <Row key={i} r={r} />
            ))}
            <div style={styles.mbSubtotal}>
              <span>소계</span>
              <b style={{ color: UP }}>+{buySum}</b>
            </div>
          </>
        )}

        {item.sell.length > 0 && (
          <>
            <div style={styles.mbSectionTitle}>감산 신호 (매도 −)</div>
            {item.sell.map((r, i) => (
              <Row key={i} r={r} />
            ))}
            <div style={styles.mbSubtotal}>
              <span>소계</span>
              <b style={{ color: DOWN }}>{sellSum}</b>
            </div>
          </>
        )}

        {item.buy.length === 0 && item.sell.length === 0 && (
          <div style={styles.mbSub}>충족한 신호가 없습니다.</div>
        )}

        <div style={styles.mbTotal}>
          <span>
            {item.buy.length > 0 && `+${buySum}`}
            {item.sell.length > 0 && ` ${sellSum}`}
            {" ="}
          </span>
          <b style={{ color: grade.color }}>
            {item.score > 0 ? `+${item.score}` : item.score}점
          </b>
        </div>

        <div style={styles.mbHint}>
          {verdict}
          <br />
          가중치 위계: 타이밍(±3) &gt; 위치(±2) &gt; 추세·확인 보조(±1). 만점 매수
          +17 / 매도 −16. 등급컷: 강함 ±7 / 있음 ±3.
          <br />
          <b style={{ color: "#ffae57" }}>
            ⚠️ 이 점수는 "오를 종목"을 고르지 못합니다.
          </b>{" "}
          15년 일봉(하락장 포함) 검증에서 +3 이상 종목의 10일 수익률은 아무 날에나
          산 것보다 <b>+0.1%p</b> 나았을 뿐입니다(= 차이 없음). 이 점수는{" "}
          <b>여러 지표가 같은 방향을 가리키는 정도</b>이지 수익 예측이 아닙니다.
        </div>
      </div>
    </div>
  );
}

// 오늘의 상태 요약 — 이미 계산된 두 사실을 규칙 그대로 한 줄에 합칠 뿐,
//  새 점수·가중을 만들지 않는다:
//   ① 신호 종합 점수 → 방향(매수/매도 쪽)·강도(신호가 얼마나 모였나)
//   ② 진입 위치(⑬ entry.level) → 지금 자리(🟢 근처 / 🟡 확장 / 🔴 크게 확장 / ⚠️ 반대로 급락·급등)
//  ⚠️ 이것은 '행동 지시'가 아니라 '상태 서술'이다. 이 조합이 실제로 유리한지는
//  검증되지 않았다(종합 점수 초과수익 +0.1%p — INDICATORS.md 2-b). 문구에 '진입/매수/
//  축소' 같은 행동 동사나 '적합/무난/유리' 같은 적합성 판정을 다시 넣지 말 것.
function todayVerdict(item) {
  const s = item.score;
  const lvl = item.entry ? item.entry.level : null;
  const strong = Math.abs(s) >= 7;
  const dist = item.entry
    ? ` (MA20 ${item.entry.extATR >= 0 ? "+" : "−"}${Math.abs(item.entry.extATR).toFixed(1)}×ATR)`
    : "";
  if (s >= 3) {
    if (lvl === "knife")
      return {
        tone: "#ff7043",
        tag: "매수신호 ↔ 급락 상충",
        text: `매수 쪽 신호가 떴지만 추세가 이탈했고 급락 중입니다. 두 사실이 상충합니다.${dist}`,
      };
    if (lvl === "hot")
      return {
        tone: "#e67e22",
        tag: "매수신호 · 20일선에서 크게 확장",
        text: `매수 쪽 신호가 떴으나 현재가가 20일선 위로 크게 벌어져 있습니다. 손절까지 거리가 먼 자리입니다.${dist}`,
      };
    if (lvl === "stretched")
      return {
        tone: "#f1c40f",
        tag: strong ? "매수신호 강함 · 다소 확장" : "매수신호 있음 · 다소 확장",
        text: `매수 쪽 신호가 ${strong ? "여럿 겹쳤고" : "일부 떴고"} 현재가는 20일선에서 다소 벌어져 있습니다.${dist}`,
      };
    return strong
      ? {
          tone: "#2ecc71",
          tag: "매수신호 강함 · 20일선 근처",
          text: `매수 쪽 신호가 여럿 겹쳤고, 현재가는 20일선에서 크게 벌어져 있지 않습니다. 이 조합이 실제로 유리한지는 검증되지 않았습니다.${dist}`,
        }
      : {
          tone: "#7bd88f",
          tag: "매수신호 있음 · 20일선 근처",
          text: `매수 쪽 신호가 일부 떴고, 현재가는 20일선에서 크게 벌어져 있지 않습니다.${dist}`,
        };
  }
  if (s <= -3) {
    if (lvl === "knife")
      return {
        tone: "#5dade2",
        tag: "매도신호 ↔ 급등 상충",
        text: `매도 쪽 신호가 떴지만 현재가는 급등 중입니다. 두 사실이 상충합니다.${dist}`,
      };
    if (lvl === "hot")
      return {
        tone: "#5dade2",
        tag: "매도신호 · 이미 크게 하락",
        text: `매도 쪽 신호가 떴으나 현재가가 20일선 아래로 크게 벌어져 있습니다(낙폭과대 구간).${dist}`,
      };
    if (lvl === "stretched")
      return {
        tone: "#5dade2",
        tag: "매도신호 · 다소 확장",
        text: `매도 쪽 신호가 떴고, 현재가는 20일선에서 다소 벌어져 있습니다.${dist}`,
      };
    return strong
      ? {
          tone: "#4d8bff",
          tag: "매도신호 강함",
          text: `매도 쪽 신호가 여럿 겹쳤고, 현재가는 20일선에서 크게 벌어져 있지 않습니다.${dist}`,
        }
      : {
          tone: "#6fa8ff",
          tag: "매도신호 있음",
          text: `매도 쪽 신호가 일부 떴고, 현재가는 20일선에서 크게 벌어져 있지 않습니다.${dist}`,
        };
  }
  return null;
}

function SignalCard({ item, onReasonClick }) {
  const grade = signalGrade(item.score);
  const reasons = item.score >= 0 ? item.buy : item.sell;
  const verdict = todayVerdict(item);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showRecord, setShowRecord] = useState(false);
  // 변화 감지(U3): 직전 완성 봉 대비 점수 변화. 첫 조회면 delta=null → 표시 안 함.
  const d = item.delta;
  const newLabels = d ? d.newLabels : [];
  return (
    <div style={styles.sigCard}>
      <div style={styles.sigHead}>
        <span style={styles.sigName}>{item.name}</span>
        <span style={{ ...styles.sigGrade, color: grade.color }}>
          {grade.label}
        </span>
      </div>
      <div style={styles.sigMeta}>
        <span>{fmtNum(item.price, 2)}</span>
        <span style={{ color: "#777" }}>
          RSI {item.rsi != null ? fmtNum(item.rsi, 0) : "-"}
        </span>
        {d && d.scoreDelta !== 0 && (
          <span
            style={{ ...styles.deltaChip, color: d.scoreDelta > 0 ? UP : DOWN }}
            title={`${d.baseDate} 완성 봉 대비 ${d.scoreDelta > 0 ? "+" : ""}${d.scoreDelta}점`}
          >
            {d.scoreDelta > 0 ? `▲${d.scoreDelta}` : `▼${Math.abs(d.scoreDelta)}`}
          </span>
        )}
        <button
          style={{ ...styles.sigScore, ...styles.sigScoreBtn, color: grade.color }}
          onClick={() => setShowBreakdown(true)}
          title="점수 계산 자세히 보기"
        >
          {item.score > 0 ? `+${item.score}` : item.score}점 ▸
        </button>
      </div>
      {/* 장중 배지 — 왜 점수가 안 움직이는지를 먼저 말해 준다.
          채점은 완성 봉만 쓰므로(장중 repaint 방지) 현재가와 기준 봉이 다르다. */}
      {item.intraday && (
        <div style={styles.intradayBar}>
          🕐 장중 · 신호는 <b>{item.barDate} 종가</b> 기준입니다
          {item.livePrice != null && ` (현재가 ${fmtNum(item.livePrice, 2)})`}
          <div style={styles.intradayNote}>
            오늘 봉은 아직 안 끝나서 채점에 쓰지 않습니다. 장중에 켜졌다 꺼지는 신호를
            보지 않으려는 것이며, 아래 수치는 모두 그 종가 기준입니다.
          </div>
        </div>
      )}
      {item.selfBench && (
        <div style={styles.selfBenchNote}>
          ℹ️ 이 종목은 <b>벤치마크 자신</b>입니다 — 시장 대비 상대강도(RS)는 자기 자신과의
          비교라 적용하지 않습니다.
        </div>
      )}
      {verdict && (
        <div style={{ ...styles.verdictBar, borderLeftColor: verdict.tone }}>
          <div style={{ ...styles.verdictTag, color: verdict.tone }}>
            오늘 상태 · {verdict.tag}
          </div>
          <div style={styles.verdictText}>{verdict.text}</div>
        </div>
      )}
      {item.risk && (
        <div style={styles.riskGrid}>
          <div style={styles.riskCell}>
            <span style={styles.riskLabel}>손절</span>
            <b style={{ ...styles.riskVal, color: DOWN }}>
              {fmtPrice(item.risk.stop)}
            </b>
          </div>
          <div style={styles.riskCell}>
            <span style={styles.riskLabel}>목표</span>
            <b style={{ ...styles.riskVal, color: UP }}>
              {fmtPrice(item.risk.target)}
            </b>
          </div>
          <div style={styles.riskCell}>
            <span style={styles.riskLabel}>손익비</span>
            <b style={{ ...styles.riskVal, color: "#ddd" }}>
              {item.risk.rr != null ? `${fmtNum(item.risk.rr, 1)} : 1` : "-"}
            </b>
          </div>
          <div style={styles.riskCell}>
            <span style={styles.riskLabel}>변동성</span>
            <b style={{ ...styles.riskVal, color: "#bbb" }}>
              {fmtNum(item.risk.atrPct, 1)}%
            </b>
          </div>
        </div>
      )}
      <div style={styles.badgeWrap}>
        {reasons.length ? (
          reasons.map((r, i) => (
            <ReasonBadge
              key={i}
              symbol={item.symbol}
              reason={r}
              color={grade.color}
              onReasonClick={onReasonClick}
              isNew={newLabels.includes(r.label)}
            />
          ))
        ) : (
          <span style={{ ...styles.badge, color: "#777", borderColor: "#444" }}>
            특이 신호 없음
          </span>
        )}
      </div>
      <div style={styles.sigCardBtns}>
        <button style={styles.breakdownBtn} onClick={() => setShowBreakdown(true)}>
          🧮 점수 계산 자세히
        </button>
        <button style={styles.recordBtn} onClick={() => setShowRecord(true)}>
          📝 기록
        </button>
      </div>
      {showBreakdown && (
        <ScoreBreakdownModal
          item={item}
          grade={grade}
          onClose={() => setShowBreakdown(false)}
        />
      )}
      {showRecord && (
        <TradeEntryModal item={item} onClose={() => setShowRecord(false)} />
      )}
    </div>
  );
}

function RecommendPanel({ onReasonClick }) {
  const { loading, data, error, time, refresh } = useSignals();

  // 변화 감지(U3): 직전 완성 봉 대비 델타를 종목별로 붙이고 패널 요약을 만든다.
  const { items, summary, nextSnap } = useMemo(() => computeDeltas(data), [data]);
  // 스냅샷 저장은 렌더 후 부수효과로(순수 계산과 분리). 같은 data면 nextSnap이
  //  안정적이라 매 렌더 쓰지 않는다.
  useEffect(() => {
    if (nextSnap) writeSnap(nextSnap);
  }, [nextSnap]);

  // 종합 점수(확신) 기준으로만 정렬한다. 진입 위치(⑬)·신선도(⑫)는 점수/순서에
  //  개입하지 않고 카드의 표시 정보로만 보여준다(검증되지 않은 가중을 순위에 넣지 않음).
  const { buys, sells } = useMemo(() => {
    if (!items) return { buys: [], sells: [] };
    const b = items.filter((d) => d.score >= 3).sort((x, y) => y.score - x.score);
    const s = items.filter((d) => d.score <= -3).sort((x, y) => x.score - y.score);
    return { buys: b, sells: s };
  }, [items]);

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={styles.recHead}>
        <h2 style={{ ...styles.h2, margin: 0 }}>
          📊 신호 종합 — 매수 쪽 신호가 모인 종목
        </h2>
        <div style={styles.recHeadRight}>
          {time > 0 && (
            <span style={styles.recTime}>분석 {fmtTime(time / 1000)}</span>
          )}
          <button
            style={styles.toolBtn}
            onClick={refresh}
            disabled={loading}
          >
            {loading ? "분석 중…" : "↻ 새로고침"}
          </button>
        </div>
      </div>

      {/* 정직성 고지 — 접을 수 없다. 주장(카드)과 반증(검증 결과)을 같은 화면에 둔다. */}
      <div style={styles.recWarn}>
        <b>⚠️ 이 점수는 "오를 종목"을 고르지 못합니다.</b> 15년 일봉(하락장 포함)
        검증 결과, 이 점수가 +3 이상인 종목의 10일 수익률은{" "}
        <b>아무 날에나 산 것보다 +0.1%p</b> 나았을 뿐입니다(= 차이 없음). 이
        목록은 <b>"지금 여러 지표가 같은 방향을 가리키는 종목"</b>이지{" "}
        <b>"오를 종목"이 아닙니다.</b> → 아래 🔬 신호 검증 패널에서 직접
        확인하세요.
      </div>

      {/* 변화 감지(U3): 직전 완성 봉 대비 목록 진입/이탈 요약. 사실만 서술한다.
          첫 조회(summary=null)면 표시하지 않는다 — 기준이 없으면 델타도 없다. */}
      {summary && (summary.newlyExposed.length > 0 || summary.dropped.length > 0) && (
        <div style={styles.changeBar}>
          <span style={styles.changeTag}>🔁 직전 완성 봉 대비</span>
          {summary.newlyExposed.length > 0 && (
            <span style={styles.changeGroup}>
              <span style={{ color: "#9a9a9a" }}>새로 ±3 진입:</span>{" "}
              {summary.newlyExposed
                .map((x) => `${x.name}(${x.score > 0 ? "+" : ""}${x.score})`)
                .join(", ")}
            </span>
          )}
          {summary.dropped.length > 0 && (
            <span style={styles.changeGroup}>
              <span style={{ color: "#9a9a9a" }}>목록에서 빠짐:</span>{" "}
              {summary.dropped
                .map((x) => `${x.name}(${x.prevScore > 0 ? "+" : ""}${x.prevScore}→중립)`)
                .join(", ")}
            </span>
          )}
        </div>
      )}

      {error ? (
        <div style={styles.recEmpty}>
          분석 데이터를 불러오지 못했습니다. 데이터 제공 프록시(corsproxy.io) 또는
          네트워크 문제일 수 있습니다 — <b>↻ 새로고침</b>을 눌러 다시 시도해 보세요.
        </div>
      ) : loading && !data ? (
        <div style={styles.recEmpty}>
          관심종목 {WATCHLIST.length}개의 지표를 분석하는 중…
        </div>
      ) : (
        <>
          {buys.length === 0 && sells.length === 0 && (
            <div style={styles.recEmpty}>
              현재 ±3점을 넘는 종목이 없습니다. (모두 중립 구간)
            </div>
          )}
          {buys.length > 0 && (
            <div style={styles.sigGrid}>
              {buys.map((item) => (
                <SignalCard key={item.symbol} item={item} onReasonClick={onReasonClick} />
              ))}
            </div>
          )}
          {sells.length > 0 && (
            <>
              <div style={styles.recSubTitle}>📉 매도 쪽 신호가 모인 종목</div>
              <div style={styles.sigGrid}>
                {sells.map((item) => (
                  <SignalCard key={item.symbol} item={item} onReasonClick={onReasonClick} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      <div style={styles.recNote}>
        <b>정렬: 종합 점수(신호가 모인 정도) 순.</b> 카드의 진입 위치(🟢/🟡/🔴/⚠️)와
        신선도(N봉 전·이후 ±X%)는 <b>점수·순위에 넣지 않고 참고 정보로만</b>{" "}
        보여줍니다 — "지금 이 자리에 들어갈지"는 그 정보를 보고 직접 판단하세요.
        {" "}
        <br />
        RSI·스토캐스틱·MACD·이동평균·볼린저밴드·거래량에 더해 주봉 추세(멀티
        타임프레임)·시장 대비 상대강도(RS)·다이버전스·레짐 정합(ADX)까지 종합해{" "}
        <b>방향 합의도를 점수화한 것</b>입니다. <b>이 점수의 예측력은 검증되지
        않았습니다</b>(15년 검증 초과수익 +0.1%p → 🔬 신호 검증 패널). (일봉 1년
        기준 · 투자 참고용) · 근거 배지(↗)를 누르면 차트에서 해당 신호 위치로
        이동하고, 점수 칩이나 「🧮 점수 계산 자세히」를 누르면 항목별 가산·감산
        내역을 볼 수 있습니다.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  신호 검증(백테스트) 패널                                            */
/* ------------------------------------------------------------------ */

// 평균수익률 셀: 부호 반영 후 색상(양수=적중=빨강 / 음수=파랑). 표본수 함께 노출.
//  ★ 핵심은 셋째 줄 '초과' — 기준선(아무 봉에나 진입) 대비 차이다. 절대 수익률은
//   강세장 표본이라 웬만하면 (+)로 나오므로, 초과가 (+)여야 비로소 신호의 능력(알파)이다.
//   초과가 0 이하면 회색으로 죽여 "근거 없음"이 눈에 보이게 한다.
//  중앙값·표준편차·최악값은 셀 tooltip(hover)에 넣는다 — 평균만 보면 꼬리 위험이 안 보인다.
function BtCell({ stat }) {
  if (!stat) return <div style={styles.btCell}><span style={{ color: "#555" }}>—</span></div>;
  const c = stat.avg > 0 ? UP : stat.avg < 0 ? DOWN : "#bbb";
  const ex = stat.exAvg;
  const tip =
    `중앙값 ${signStr(stat.median, 1)}%  ·  표준편차 ${fmtNum(stat.sd, 1)}%p  ·  ` +
    `최악 ${signStr(stat.min, 1)}%  ·  표본 n=${stat.n}`;
  return (
    <div style={styles.btCell} title={tip}>
      <b style={{ ...styles.btAvg, color: c }}>{signStr(stat.avg, 1)}%</b>
      <span style={styles.btSub}>
        승률 {fmtNum(stat.win, 0)}% · n{stat.n}
      </span>
      {ex != null && (
        <span style={{ ...styles.btEx, color: ex > 0 ? UP : "#6e6e6e" }}>
          {ex > 0 ? "" : "⚠ "}초과 {signStr(ex, 1)}%p · 승 {signStr(stat.exWin, 0)}%p
        </span>
      )}
    </div>
  );
}

function BtTable({ rows, showDir = true, head = "신호" }) {
  if (!rows.length)
    return <div style={styles.btEmpty}>표본이 부족해 집계된 신호가 없습니다.</div>;
  return (
    <div style={styles.btTable}>
      <div style={{ ...styles.btRow, ...styles.btHeadRow }}>
        <div style={styles.btLabelCell}>{head}</div>
        {BT_HOLD.map((p) => (
          <div key={p} style={styles.btCell}>{p}일 후</div>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={styles.btRow}>
          <div style={styles.btLabelCell}>
            {showDir && (
              <span style={{ color: r.dir === "buy" ? UP : DOWN, fontWeight: 700 }}>
                {r.dir === "buy" ? "▲" : "▼"}
              </span>
            )}{" "}
            {r.label}
          </div>
          {BT_HOLD.map((p) => (
            <BtCell key={p} stat={r.stats[p]} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ATR 청산(손절 2×ATR / 목표 3×ATR) 성과 — 카드가 '표시하는' 청산 규칙의 검증.
//  기대 R = 평균 손익 ÷ 1R(=2×ATR). 목표 도달이 +1.5R, 손절이 −1R이므로
//  손익비 1.5:1이 성립하려면 목표 도달률이 대략 40% 이상이어야 기대 R > 0이 된다.
function BtAtrTable({ rows }) {
  const shown = rows.filter((r) => r.atr && r.atr.n > 0);
  if (!shown.length)
    return <div style={styles.btEmpty}>표본이 부족해 집계된 구간이 없습니다.</div>;
  return (
    <div style={styles.btTable}>
      <div style={{ ...styles.btRow5, ...styles.btHeadRow }}>
        <div style={styles.btLabelCell}>구간</div>
        <div style={styles.btCell}>기대 R</div>
        <div style={styles.btCell}>목표 도달</div>
        <div style={styles.btCell}>손절 도달</div>
        <div style={styles.btCell}>시간 청산</div>
      </div>
      {shown.map((r, i) => {
        const a = r.atr;
        return (
          <div key={i} style={styles.btRow5}>
            <div style={styles.btLabelCell}>
              <span style={{ color: r.dir === "buy" ? UP : DOWN, fontWeight: 700 }}>
                {r.dir === "buy" ? "▲" : "▼"}
              </span>{" "}
              {r.label}
            </div>
            <div style={styles.btCell}>
              <b style={{ ...styles.btAvg, color: a.avgR > 0 ? UP : a.avgR < 0 ? DOWN : "#bbb" }}>
                {signStr(a.avgR, 2)}R
              </b>
              <span style={styles.btSub}>n{a.n}</span>
            </div>
            <div style={styles.btCell}>
              <b style={{ ...styles.btAvg, color: "#ddd" }}>{fmtNum(a.targetRate, 0)}%</b>
            </div>
            <div style={styles.btCell}>
              <b style={{ ...styles.btAvg, color: "#ddd" }}>{fmtNum(a.stopRate, 0)}%</b>
            </div>
            <div style={styles.btCell}>
              <b style={{ ...styles.btAvg, color: "#ddd" }}>{fmtNum(a.timeRate, 0)}%</b>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 레짐 분해(STEP 1-3) — 진입 시점의 시장 국면(벤치마크 200일선 위/아래)별 성과.
//  ⚠️ 초과는 반드시 '같은 레짐의 기준선' 대비다. 강세장 신호를 전체 기준선과 비교하면
//   강세장 드리프트가 신호의 알파로 둔갑한다. 표본에 하락장이 없던 시절의 착시를 막는 표.
function BtRegimeTable({ rows, hold }) {
  const shown = rows.filter((r) => r && (r.reg.bull[hold] || r.reg.bear[hold]));
  if (!shown.length) return <div style={styles.btEmpty}>레짐을 판정할 표본이 없습니다.</div>;
  const cell = (s, isBase) => {
    if (!s) return <div style={styles.btCell}><span style={{ color: "#555" }}>—</span></div>;
    const c = s.avg > 0 ? UP : s.avg < 0 ? DOWN : "#bbb";
    return (
      <div style={styles.btCell} title={`중앙값 ${signStr(s.median, 1)}% · 최악 ${signStr(s.min, 1)}% · 표본 n=${s.n}`}>
        <b style={{ ...styles.btAvg, color: c }}>{signStr(s.avg, 1)}%</b>
        <span style={styles.btSub}>승률 {fmtNum(s.win, 0)}% · n{s.n}</span>
        {!isBase && s.exAvg != null && (
          <span style={{ ...styles.btEx, color: s.exAvg > 0 ? UP : "#6e6e6e" }}>
            {s.exAvg > 0 ? "" : "⚠ "}초과 {signStr(s.exAvg, 1)}%p
          </span>
        )}
      </div>
    );
  };
  return (
    <div style={styles.btTable}>
      <div style={{ ...styles.btRow, ...styles.btHeadRow, gridTemplateColumns: "minmax(150px, 1.6fr) repeat(2, 1fr)" }}>
        <div style={styles.btLabelCell}>신호 ({hold}일 보유)</div>
        <div style={styles.btCell}>강세장 (벤치 &gt; MA200)</div>
        <div style={styles.btCell}>약세장 (벤치 &lt; MA200)</div>
      </div>
      {shown.map((r, i) => (
        <div key={i} style={{ ...styles.btRow, gridTemplateColumns: "minmax(150px, 1.6fr) repeat(2, 1fr)" }}>
          <div style={styles.btLabelCell}>
            <span style={{ color: r.dir === "buy" ? UP : DOWN, fontWeight: 700 }}>
              {r.dir === "buy" ? "▲" : "▼"}
            </span>{" "}
            {r.label}
          </div>
          {cell(r.reg.bull[hold], r.kind === "baseline")}
          {cell(r.reg.bear[hold], r.kind === "baseline")}
        </div>
      ))}
    </div>
  );
}

function BacktestPanel() {
  const { loading, started, data, error, time, run, refresh } = useBacktest();
  const [open, setOpen] = useState(false);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !started) run(); // 펼칠 때 1회만 계산(lazy)
  };

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={styles.recHead}>
        <h2 style={{ ...styles.h2, margin: 0 }}>🔬 신호 검증 (간이 백테스트)</h2>
        <div style={styles.recHeadRight}>
          {open && time > 0 && (
            <span style={styles.recTime}>분석 {fmtTime(time / 1000)}</span>
          )}
          {open && started && (
            <button style={styles.toolBtn} onClick={refresh} disabled={loading}>
              {loading ? "검증 중…" : "↻ 다시 계산"}
            </button>
          )}
          <button style={styles.toolBtn} onClick={handleToggle}>
            {open ? "▲ 접기" : "▼ 펼치기"}
          </button>
        </div>
      </div>

      {!open ? (
        <div style={styles.btIntro}>
          현재 점수 체계의 각 신호가 <b>과거에 실제로 맞았는지</b> 검증합니다. 관심종목
          {" "}{WATCHLIST.length}개의 <b>15년 일봉(2015·2018·2020·2022 하락장 포함)</b>에서
          신호가 처음 켜진 시점에 진입했다고 가정하고, 5·10·20일 후 수익률·승률·표본수(n)를
          {" "}<b>기준선(아무 봉에나 진입) 대비 초과수익</b>과 함께 집계합니다. 강세장/약세장
          {" "}<b>레짐별 분해</b>, ATR 손절·목표 청산 성과, 지연 진입 성과도 함께 봅니다.
          (무거운 계산이라 펼칠 때 1회 실행)
        </div>
      ) : error ? (
        <div style={styles.recEmpty}>
          백테스트 데이터를 불러오지 못했습니다. 프록시(corsproxy.io)·네트워크 문제일 수
          있으니 잠시 후 다시 시도해 보세요.
        </div>
      ) : loading && !data ? (
        <div style={styles.recEmpty}>
          관심종목 {WATCHLIST.length}개의 15년 일봉으로 과거 신호를 검증하는 중… (시세 내려받기
          포함 10~30초 소요)
        </div>
      ) : data ? (
        <>
          <div style={styles.btBaseBox}>
            <div style={styles.btBaseTitle}>
              📏 기준선 (전체 봉 진입) — <b>모든 성과는 이 값과 비교해야 의미가 있습니다</b>
            </div>
            <BtTable
              rows={[data.baseline.buy, data.baseline.sell].filter(Boolean)}
              head="기준선"
            />
            <div style={styles.btBaseNote}>
              신호와 무관하게 <b>아무 봉에나 진입</b>했을 때의 성과입니다. ⚠️ 표본은 <b>15년
              일봉</b>(하락장 포함)이지만 관심종목이 <b>반도체·빅테크 생존자</b> 15개라,
              절대 수익률·승률은 신호가 없어도 구조적으로 (+)가 나옵니다. 따라서 어떤 신호든
              {" "}<b>기준선을 넘는 만큼(초과)</b> 만이 그 신호의 능력(알파)이고, 초과가 0
              이하면 그건 그냥 시장 흐름(베타)입니다. 아래 표의 각 칸 셋째 줄이
              {" "}<b>초과(%p)</b> 이며, <b>0 이하면 회색 ⚠</b> 으로 표시됩니다.
            </div>
          </div>

          <div style={styles.btSubTitle}>① 개별 신호별 성과</div>
          <BtTable rows={data.signals} />

          <div style={styles.btSubTitle}>② 종합 점수 구간별 성과</div>
          <BtTable rows={data.grades} />

          <div style={styles.btSubTitle}>
            ③ ATR 청산 성과 — 손절 {BT_ATR_STOP}×ATR / 목표 {BT_ATR_TARGET}×ATR (카드가
            표시하는 규칙)
          </div>
          <BtAtrTable
            rows={[data.baseline.buy, data.baseline.sell, ...data.grades].filter(Boolean)}
          />
          <div style={styles.btMiniNote}>
            ①·②는 <b>고정 N봉 종가 청산</b>이지만, 신호 카드가 실제로 제시하는 청산 규칙은
            <b> ATR 손절·목표</b>입니다. 이 표는 그 규칙 그대로(최대 {BT_ATR_MAXBARS}봉 보유,
            같은 봉에 둘 다 닿으면 보수적으로 손절 우선) 검증합니다. <b>1R = 손절폭
            ({BT_ATR_STOP}×ATR)</b>, 목표 도달 = +1.5R / 손절 도달 = −1R. <b>기대 R이 0
            이하면 표시 중인 손익비(1.5:1)가 이 종목군에서 성립하지 않는다</b>는 뜻입니다.
          </div>

          <div style={styles.btSubTitle}>
            ⑤ 레짐 분해 — 강세장 vs 약세장 (진입 시점 벤치마크 200일선 기준)
          </div>
          <BtRegimeTable
            rows={[data.baseline.buy, data.baseline.sell, ...data.signals, ...data.grades]}
            hold={BT_REGIME_HOLD}
          />
          <div style={styles.btMiniNote}>
            표본에 <b>하락장이 없으면</b> "신호가 맞았다"와 "그냥 시장이 올랐다"를 구분할 수
            없습니다. 그래서 진입 시점의 벤치마크(미국=SPY / 한국=KOSPI)가 <b>200일선 위면
            강세장, 아래면 약세장</b>으로 나눠, <b>같은 레짐 안의 기준선</b>과 비교합니다
            (판정은 진입 시점 정보만 씁니다 — 미래를 보지 않습니다). <b>어떤 신호가 진짜
            우위라면 두 레짐 모두에서 초과가 (+)여야</b> 합니다. 한쪽에서만 (+)라면 그건
            국면에 얹혀 간 것입니다.
          </div>

          <div style={styles.btSubTitle}>
            ④ 지연 진입 성과 — 타이밍 신호(MACD·스토캐스틱·다이버전스)
          </div>
          <BtTable rows={data.delays} showDir={false} head="진입 시점" />
          <div style={styles.btMiniNote}>
            타이밍 신호는 되돌아보며 탐지하므로(MACD 5봉·스토캐스틱 3봉·다이버전스 12봉),
            사용자는 <b>신호 발생 며칠 뒤에 카드를 보고</b> 삽니다. ①·②가 재는 "발생 봉
            종가 진입"과 실제 진입 시점이 다른 것입니다. 이 표는 N봉 늦게 들어갔을 때
            우위가 얼마나 소진되는지를 보여줍니다 — <b>⑫ 신선도 배지(1×ATR·5봉 경고)가
            실제로 근거가 있는지</b>를 판단하는 자료입니다.
          </div>

          <div style={styles.recNote}>
            표본 {data.total.toLocaleString()}건(기준선 제외) · 종목 {data.symbols}개 합산 ·
            {" "}<b>15년 일봉</b>(2015·2018·2020·2022 하락장 포함). <b>매수(▲) 신호는 상승,
            매도(▼) 신호는 하락을 적중</b>으로 보아 수익률 부호를 맞췄습니다(승률 = 적중
            비율). 거래비용은 <b>왕복 미국 {BT_COST_US}%p / 한국 {BT_COST_KR}%p</b>
            (수수료·슬리피지·거래세 근사)를 차감했습니다 — 기준선에도 똑같이 적용하므로{" "}
            <b>초과수익에는 영향이 없습니다</b>. 각 칸에 <b>마우스를 올리면</b> 중앙값·
            표준편차·최악값이 뜹니다(평균만 보면 꼬리 위험이 안 보입니다).
            <br />
            ⚠️ <b>한계 ① 생존 편향.</b> 관심종목은 <b>지금까지 살아남은</b> 대형주라, "깊은
            과매도에서 반등"류 신호는 구조적으로 좋게 나옵니다(망한 종목도 과매도를 찍지만
            반등 없이 사라집니다). 여기 수치는 <b>상한선으로 읽어야</b> 합니다.
            <br />
            ⚠️ <b>한계 ② 표본이 보이는 것만큼 많지 않습니다.</b> 보유기간이 겹치는
            (overlapping) 진입을 모두 세므로 표시된 n은 <b>독립 표본 수가 아닙니다</b>.
            게다가 관심종목이 사실상 <b>반도체·나스닥 단일 팩터</b>라 서로 강하게 상관돼,
            실질 독립 표본은 n보다 훨씬 적습니다. 승률·평균의 신뢰구간을 실제보다 좁게
            착각하지 마세요 — <b>초과 ±0.5%p 안팎은 노이즈와 구분되지 않습니다.</b>
            <br />
            ⚠️ <b>한계 ③ 종목별 이력 길이가 다릅니다.</b> MAGS(2023년 상장) 등 신생 종목은
            15년치가 없어 표본에 적게 들어갑니다. 주봉 추세·상대강도(RS)·지수 레짐 보정은
            과거 시점 재현이 어려워 검증에서 제외했습니다(그래서 RSI·볼린저는 레짐 축소 없는
            원점수로 집계). Yahoo 시세는 분할은 반영하지만 <b>배당은 미반영</b>입니다. 이
            결과는 <b>가중치 조정의 참고 근거</b>이며, 점수 체계 자체는 바꾸지 않습니다.
          </div>
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  지수 카드                                                          */
/* ------------------------------------------------------------------ */

function IndexCard({ name, symbol }) {
  const { q, err } = useQuote(symbol);

  const color = q ? colorOf(q.change) : FLAT;

  return (
    <div style={styles.card}>
      <div style={styles.cardName}>{name}</div>
      {err && !q ? (
        <div style={styles.errText}>데이터 오류</div>
      ) : !q ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <div style={{ ...styles.cardPrice, color }}>{fmtNum(q.price, 2)}</div>
          <div style={{ ...styles.cardChange, color }}>
            {signStr(q.change, 2)} ({signStr(q.changePct, 2)}%)
          </div>
          {q.marketTime != null && (
            <div style={styles.cardTime}>기준 {fmtTime(q.marketTime)}</div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  관심종목 행                                                        */
/* ------------------------------------------------------------------ */

function WatchRow({ name, symbol, expanded, onToggle, highlight }) {
  const { q, err } = useQuote(symbol);

  const color = q ? colorOf(q.change) : FLAT;

  return (
    <div style={styles.rowWrap}>
      <div
        style={{ ...styles.row, background: expanded ? "#202020" : "#1a1a1a" }}
        onClick={onToggle}
      >
        <div style={styles.rowArrow}>{expanded ? "▼" : "▶"}</div>
        <div style={styles.rowName}>{name}</div>
        {err && !q ? (
          <div style={{ ...styles.errText, flex: 1, textAlign: "right" }}>데이터 오류</div>
        ) : !q ? (
          <div style={{ flex: 1, textAlign: "right" }}>
            <Skeleton lines={1} inline />
          </div>
        ) : (
          <>
            <div style={{ ...styles.rowCell, color }}>{fmtNum(q.price, 2)}</div>
            <div style={{ ...styles.rowCell, color }}>{signStr(q.change, 2)}</div>
            <div style={{ ...styles.rowCell, color }}>{signStr(q.changePct, 2)}%</div>
          </>
        )}
      </div>
      {/* 부드러운 확장 애니메이션 */}
      <div
        style={{
          maxHeight: expanded ? 1800 : 0,
          opacity: expanded ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.45s ease, opacity 0.4s ease",
          background: "#141414",
          borderBottom: expanded ? "1px solid #2a2a2a" : "none",
        }}
      >
        {expanded && <ChartPanel symbol={symbol} highlight={highlight} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  스켈레톤 로더                                                      */
/* ------------------------------------------------------------------ */

function Skeleton({ lines = 1, inline = false }) {
  const bar = (w) => (
    <div
      style={{
        height: 12,
        width: w,
        background: "linear-gradient(90deg,#222,#2e2e2e,#222)",
        backgroundSize: "200% 100%",
        animation: "sk 1.2s infinite",
        borderRadius: 4,
        margin: inline ? "0 0 0 auto" : "6px 0",
      }}
    />
  );
  return (
    <div>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i}>{bar(i === 0 ? "70%" : "50%")}</div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  매매일지 (U4) — 내 재량 판단을 측정한다                                 */
/* ------------------------------------------------------------------ */
// 15년 백테스트가 말하는 건 "이 10개 신호를 기계적으로 합산하면 우위가 없다"이지,
//  "당신의 판단에 우위가 없다"가 아니다. 화면을 보고 실적·뉴스·업황을 얹어 내리는
//  재량 판단은 한 번도 측정된 적이 없다. 그걸 재는 유일한 방법이 '기록'이다.
//  ⚠️ 진입 시점의 점수·신호 라벨을 '그때 그대로' 박제한다(나중에 재계산 금지).
//  ⚠️ 절대 수익률만 보면 베타(시장이 오른 것)를 알파(내 판단)로 착각한다 →
//   청산 시 같은 기간 벤치마크 대비 '초과'를 함께 박제한다(백테스트와 같은 언어).
const JOURNAL_KEY = "stockdash.journal.v1";
const journalListeners = new Set();
function loadJournal() {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY))?.trades || [];
  } catch {
    return [];
  }
}
function saveJournal(trades) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify({ trades }));
  } catch {
    /* 용량 초과 등은 무시 */
  }
  journalListeners.forEach((fn) => fn());
}
const journalStore = {
  get: loadJournal,
  add(t) {
    const ts = loadJournal();
    ts.push(t);
    saveJournal(ts);
  },
  update(id, patch) {
    saveJournal(loadJournal().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  },
  remove(id) {
    saveJournal(loadJournal().filter((t) => t.id !== id));
  },
  merge(incoming) {
    // id 기준 병합(가져온 것이 우선). 브라우저 하나 날려도 export 파일로 복구된다.
    const byId = new Map(loadJournal().map((t) => [t.id, t]));
    for (const t of incoming) if (t && t.id) byId.set(t.id, t);
    saveJournal([...byId.values()]);
  },
};
function useJournal() {
  const [trades, setTrades] = useState(loadJournal);
  useEffect(() => {
    const fn = () => setTrades(loadJournal());
    journalListeners.add(fn);
    return () => journalListeners.delete(fn);
  }, []);
  return trades;
}

const jMean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const jMedian = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
const todayYmd = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 청산 시 벤치마크(미국=SPY / 한국=KOSPI) 같은 기간 수익률 대비 초과를 계산해 박제.
async function computeBenchExcess(trade, exitPrice, exitDate) {
  try {
    const bench = benchmarkFor(trade.symbol);
    const { rows } = await fetchSeriesLive(bench, "2y", "1d");
    const entryRow = rows.find((r) => r.date >= trade.entryDate);
    const exitRow = [...rows].reverse().find((r) => r.date <= exitDate);
    if (!entryRow?.close || !exitRow?.close) return { benchRetPct: null, exPct: null };
    const benchRet = ((exitRow.close - entryRow.close) / entryRow.close) * 100;
    const dir = trade.side === "buy" ? 1 : -1;
    const myRet = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * dir;
    // 방향 보정: 매도 거래의 기준선은 시장 하락(= −benchRet).
    return { benchRetPct: benchRet, exPct: myRet - dir * benchRet };
  } catch {
    return { benchRetPct: null, exPct: null };
  }
}

function aggregateJournal(trades) {
  const closed = trades.filter((t) => t.exit);
  if (!closed.length) return null;
  const rets = closed.map((t) => t.exit.retPct);
  const exs = closed.map((t) => t.exit.exPct).filter((v) => v != null);
  const Rs = closed.map((t) => t.exit.R).filter((v) => v != null);
  const dates = closed.map((t) => t.exit.exitDate).sort();
  return {
    n: closed.length,
    avgRet: jMean(rets),
    medRet: jMedian(rets),
    winRate: (rets.filter((r) => r > 0).length / rets.length) * 100,
    avgEx: jMean(exs),
    exN: exs.length,
    avgR: jMean(Rs),
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

// 진입 기록 모달. 점수·신호·ATR은 '여는 순간' 박제한다(재계산 금지).
function TradeEntryModal({ item, onClose }) {
  const [side, setSide] = useState(item.score >= 0 ? "buy" : "sell");
  const [entryDate, setEntryDate] = useState(todayYmd());
  const [entryPrice, setEntryPrice] = useState(String(item.livePrice ?? item.price ?? ""));
  const [memo, setMemo] = useState("");
  const snap = useRef({
    score: item.score,
    barDate: item.barDate,
    signals: activeLabels(item),
    entryLevel: item.entry?.level ?? null,
    atr: item.risk?.atr ?? null,
    riskDist: item.risk?.atr != null ? 2 * item.risk.atr : null, // 1R = 2×ATR(카드 손절폭)
  }).current;

  const save = () => {
    const price = parseFloat(entryPrice);
    if (!price || price <= 0) return;
    journalStore.add({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: item.symbol,
      name: item.name,
      side,
      entryDate,
      entryPrice: price,
      score: snap.score,
      barDate: snap.barDate,
      signals: snap.signals,
      entryLevel: snap.entryLevel,
      atr: snap.atr,
      riskDist: snap.riskDist,
      memo: memo.trim(),
      createdAt: Date.now(),
      exit: null,
    });
    onClose();
  };

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <span style={styles.modalTitle}>{item.name}</span>
            <span style={styles.modalSym}>진입 기록</span>
          </div>
          <button style={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={styles.jForm}>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>방향</span>
            <div style={styles.jSideGroup}>
              {[
                ["buy", "매수"],
                ["sell", "매도"],
              ].map(([v, l]) => (
                <button
                  key={v}
                  onClick={() => setSide(v)}
                  style={{
                    ...styles.jSideBtn,
                    ...(side === v
                      ? { borderColor: v === "buy" ? UP : DOWN, color: v === "buy" ? UP : DOWN }
                      : null),
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>진입일</span>
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              style={styles.jInput}
            />
          </div>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>진입가</span>
            <input
              type="number"
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              style={styles.jInput}
            />
          </div>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>메모</span>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="이 진입의 재량 근거(실적·뉴스·업황 등). 나중에 승률과 함께 되돌아본다."
              style={styles.jTextarea}
            />
          </div>
        </div>

        <div style={styles.jSnapBox}>
          <b>박제되는 값</b> (진입 시점 그대로 · 나중에 재계산하지 않음)
          <div style={styles.jSnapLine}>
            점수 {snap.score > 0 ? `+${snap.score}` : snap.score} · 기준봉 {snap.barDate} ·
            1R {snap.riskDist != null ? fmtNum(snap.riskDist, 2) : "-"}
          </div>
          <div style={styles.jSnapLine}>
            신호: {snap.signals.length ? snap.signals.join(", ") : "없음"}
          </div>
        </div>

        <div style={styles.jActions}>
          <button style={styles.toolBtn} onClick={onClose}>
            취소
          </button>
          <button style={styles.jPrimaryBtn} onClick={save}>
            기록
          </button>
        </div>
      </div>
    </div>
  );
}

// 청산 기록 모달. 수익률·R·보유일 자동 계산 + 벤치마크 초과 박제.
function CloseTradeModal({ trade, onClose }) {
  const [exitDate, setExitDate] = useState(todayYmd());
  const [exitPrice, setExitPrice] = useState("");
  const [reason, setReason] = useState("재량");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const price = parseFloat(exitPrice);
    if (!price || price <= 0) return;
    const dir = trade.side === "buy" ? 1 : -1;
    const retPct = ((price - trade.entryPrice) / trade.entryPrice) * 100 * dir;
    const R = trade.riskDist ? ((price - trade.entryPrice) * dir) / trade.riskDist : null;
    const holdDays = daysBetween(trade.entryDate, exitDate);
    setBusy(true);
    const { benchRetPct, exPct } = await computeBenchExcess(trade, price, exitDate);
    journalStore.update(trade.id, {
      exit: { exitDate, exitPrice: price, reason, retPct, R, holdDays, benchRetPct, exPct },
    });
    setBusy(false);
    onClose();
  };

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <span style={styles.modalTitle}>{trade.name}</span>
            <span style={styles.modalSym}>청산 기록</span>
          </div>
          <button style={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={styles.jSnapLine}>
          {trade.side === "buy" ? "매수" : "매도"} · 진입 {trade.entryDate} @{" "}
          {fmtNum(trade.entryPrice, 2)}
        </div>
        <div style={styles.jForm}>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>청산일</span>
            <input
              type="date"
              value={exitDate}
              onChange={(e) => setExitDate(e.target.value)}
              style={styles.jInput}
            />
          </div>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>청산가</span>
            <input
              type="number"
              value={exitPrice}
              onChange={(e) => setExitPrice(e.target.value)}
              style={styles.jInput}
            />
          </div>
          <div style={styles.jFormRow}>
            <span style={styles.jFormLabel}>사유</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)} style={styles.jInput}>
              {["목표", "손절", "시간", "재량"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={styles.jActions}>
          <button style={styles.toolBtn} onClick={onClose} disabled={busy}>
            취소
          </button>
          <button style={styles.jPrimaryBtn} onClick={save} disabled={busy}>
            {busy ? "계산 중…" : "청산 확정"}
          </button>
        </div>
      </div>
    </div>
  );
}

function JournalPanel() {
  const trades = useJournal();
  const [closing, setClosing] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const open = trades.filter((t) => !t.exit);
  const closed = trades
    .filter((t) => t.exit)
    .sort((a, b) => (a.exit.exitDate < b.exit.exitDate ? 1 : -1));
  const agg = aggregateJournal(trades);
  const fileRef = useRef(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ trades }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stockdash-journal-${todayYmd()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const arr = Array.isArray(parsed) ? parsed : parsed.trades;
        if (Array.isArray(arr)) journalStore.merge(arr);
      } catch {
        /* 잘못된 파일 무시 */
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  const pctColor = (v) => (v == null ? "#999" : v > 0 ? UP : v < 0 ? DOWN : "#bbb");
  const fmtPct = (v, d = 1) => (v == null ? "-" : `${v > 0 ? "+" : ""}${fmtNum(v, d)}%`);

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={styles.recHead}>
        <h2 style={{ ...styles.h2, margin: 0 }}>📓 매매일지 — 내 판단을 측정한다</h2>
        <div style={styles.recHeadRight}>
          <button style={styles.toolBtn} onClick={exportJson} disabled={!trades.length}>
            ⬇ 내보내기
          </button>
          <button style={styles.toolBtn} onClick={() => fileRef.current?.click()}>
            ⬆ 가져오기
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={importJson}
            style={{ display: "none" }}
          />
        </div>
      </div>

      <div style={styles.jHelp}>
        신호 점수 자체는 15년 검증에서 우위가 없었습니다(초과수익 +0.1%p). 하지만{" "}
        <b>화면을 보고 내리는 재량 판단</b>은 측정된 적이 없습니다. 그걸 재는 유일한 방법이
        기록입니다. 카드의 <b>📝 기록</b>으로 진입을 남기고 청산하면, 같은 기간{" "}
        <b>벤치마크 대비 초과수익</b>으로 집계합니다(절대 수익률만 보면 시장이 오른 것을 내
        실력으로 착각합니다).
      </div>

      {trades.length === 0 ? (
        <div style={styles.recEmpty}>
          아직 기록이 없습니다. 신호 종합 카드의 <b>📝 기록</b> 버튼으로 진입을 남겨 보세요.
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <>
              <div style={styles.jSubTitle}>열린 포지션 ({open.length})</div>
              <div style={styles.jTable}>
                {open.map((t) => (
                  <div key={t.id} style={styles.jRow}>
                    <span style={styles.jRowMain}>
                      <b>{t.name}</b>
                      <span style={{ color: t.side === "buy" ? UP : DOWN, marginLeft: 6 }}>
                        {t.side === "buy" ? "매수" : "매도"}
                      </span>
                    </span>
                    <span style={styles.jRowSub}>
                      {t.entryDate} @ {fmtNum(t.entryPrice, 2)} · 점수{" "}
                      {t.score > 0 ? `+${t.score}` : t.score}
                    </span>
                    <span style={styles.jRowActions}>
                      <button style={styles.jSmallBtn} onClick={() => setClosing(t)}>
                        청산
                      </button>
                      <button
                        style={styles.jDelBtn}
                        title="기록 삭제"
                        onClick={() => journalStore.remove(t.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {agg && (
            <div style={styles.jAggBox}>
              <div style={styles.jAggGrid}>
                <div style={styles.jStat}>
                  <span style={styles.jStatLabel}>청산 거래</span>
                  <b style={styles.jStatVal}>{agg.n}건</b>
                </div>
                <div style={styles.jStat}>
                  <span style={styles.jStatLabel}>평균 / 중앙 수익</span>
                  <b style={{ ...styles.jStatVal, color: pctColor(agg.avgRet) }}>
                    {fmtPct(agg.avgRet)} / {fmtPct(agg.medRet)}
                  </b>
                </div>
                <div style={styles.jStat}>
                  <span style={styles.jStatLabel}>승률</span>
                  <b style={styles.jStatVal}>{fmtNum(agg.winRate, 0)}%</b>
                </div>
                <div style={styles.jStat}>
                  <span style={styles.jStatLabel}>기대 R</span>
                  <b style={{ ...styles.jStatVal, color: pctColor(agg.avgR) }}>
                    {agg.avgR == null ? "-" : `${agg.avgR > 0 ? "+" : ""}${fmtNum(agg.avgR, 2)}R`}
                  </b>
                </div>
                <div style={styles.jStat}>
                  <span style={styles.jStatLabel}>평균 초과 (벤치 대비)</span>
                  <b style={{ ...styles.jStatVal, color: pctColor(agg.avgEx) }}>
                    {agg.avgEx == null ? "-" : fmtPct(agg.avgEx)}
                  </b>
                </div>
              </div>
              <div style={styles.jAggNote}>
                기간 {agg.from} ~ {agg.to} · 초과 표본 n={agg.exN}
                {agg.n < 30 && (
                  <b style={{ color: "#ffae57" }}>
                    {" "}
                    · ⚠️ 표본 부족(n&lt;30) — 결론 내지 말 것.
                  </b>
                )}
                <br />
                <b>초과 = 내 수익 − 같은 기간 벤치마크(방향 보정).</b> 겹치는 보유기간·소수
                종목 상관 때문에 <b>실질 독립 표본은 n보다 적습니다.</b> 사후에 합격 기준을
                만들지 마세요(&ldquo;이번만 빼면&rdquo; 류 금지).
              </div>
            </div>
          )}

          {closed.length > 0 && (
            <>
              <button style={styles.jToggle} onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? "▲ 청산 거래 접기" : `▼ 청산 거래 ${closed.length}건 보기`}
              </button>
              {showClosed && (
                <div style={styles.jTable}>
                  {closed.map((t) => (
                    <div key={t.id} style={styles.jRow}>
                      <span style={styles.jRowMain}>
                        <b>{t.name}</b>
                        <span style={{ color: t.side === "buy" ? UP : DOWN, marginLeft: 6 }}>
                          {t.side === "buy" ? "매수" : "매도"}
                        </span>
                        <span style={{ color: "#777", marginLeft: 6, fontSize: 11 }}>
                          {t.exit.reason}
                        </span>
                      </span>
                      <span style={styles.jRowSub}>
                        {t.entryDate}→{t.exit.exitDate} ({t.exit.holdDays}일) ·{" "}
                        <b style={{ color: pctColor(t.exit.retPct) }}>{fmtPct(t.exit.retPct)}</b>
                        {t.exit.R != null && ` · ${fmtNum(t.exit.R, 2)}R`}
                        {t.exit.exPct != null && (
                          <>
                            {" "}
                            · 초과{" "}
                            <b style={{ color: pctColor(t.exit.exPct) }}>{fmtPct(t.exit.exPct)}</b>
                          </>
                        )}
                      </span>
                      <span style={styles.jRowActions}>
                        <button
                          style={styles.jDelBtn}
                          title="기록 삭제"
                          onClick={() => journalStore.remove(t.id)}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {closing && <CloseTradeModal trade={closing} onClose={() => setClosing(null)} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  메인                                                               */
/* ------------------------------------------------------------------ */

export default function StockDashboard() {
  const [openSymbol, setOpenSymbol] = useState(null);
  // 신호 근거 클릭 시 강조할 차트 위치 { symbol, chart, date, interval, nonce }
  const [highlight, setHighlight] = useState(null);

  const toggle = useCallback((symbol) => {
    setOpenSymbol((cur) => (cur === symbol ? null : symbol));
    setHighlight(null); // 수동 토글 시 하이라이트 해제
  }, []);

  // 신호 카드의 근거 배지 클릭 → 해당 종목 차트를 펼치고 신호 위치로 이동
  const handleReasonClick = useCallback((symbol, reason) => {
    if (!reason.chart || !reason.date) return;
    setOpenSymbol(symbol);
    setHighlight({
      symbol,
      chart: reason.chart,
      date: reason.date,
      interval: reason.interval || "1d", // 주봉 신호는 "1wk"로 차트 전환
      nonce: Date.now(), // 같은 배지를 다시 눌러도 재트리거되도록
    });
  }, []);

  return (
    <div style={styles.app}>
      <style>{`
        @keyframes sk { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background:#333; border-radius:4px; }
        .sig-reason { transition: background 0.15s, filter 0.15s, transform 0.1s; }
        .sig-reason.clk:hover { background: rgba(255,255,255,0.1) !important; filter: brightness(1.2); }
        .sig-reason.clk:active { transform: scale(0.96); }
      `}</style>

      <div style={styles.titleRow}>
        <h1 style={styles.title}>📈 My Stock Dashboard</h1>
        <ExchangeRateWidget {...EXCHANGE_RATE} />
      </div>

      {/* ① 지수 패널 */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={styles.h2}>지수</h2>
        <MarketRegimeWidget />
        <div style={styles.indexGrid}>
          {INDICES.map((idx) => (
            <IndexCard key={idx.symbol} {...idx} />
          ))}
        </div>
      </section>

      {/* ②  신호 종합 패널 */}
      <RecommendPanel onReasonClick={handleReasonClick} />

      {/* ②-b 신호 검증(백테스트) */}
      <BacktestPanel />

      {/* ②-c 매매일지 (U4) */}
      <JournalPanel />

      {/* ③ 관심 종목 */}
      <section>
        <h2 style={styles.h2}>관심 종목</h2>
        <div style={styles.listHeader}>
          <div style={styles.rowArrow} />
          <div style={styles.rowName}>종목</div>
          <div style={styles.rowCell}>현재가</div>
          <div style={styles.rowCell}>대비</div>
          <div style={styles.rowCell}>등락률</div>
        </div>
        <div style={styles.list}>
          {WATCHLIST.map((w) => (
            <WatchRow
              key={w.symbol}
              {...w}
              expanded={openSymbol === w.symbol}
              onToggle={() => toggle(w.symbol)}
              highlight={
                highlight && highlight.symbol === w.symbol ? highlight : null
              }
            />
          ))}
        </div>
      </section>

      <div style={styles.footer}>
        데이터: Yahoo Finance (비공식) · corsproxy.io 경유 · 투자 참고용
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  스타일                                                             */
/* ------------------------------------------------------------------ */

const styles = {
  regimeBar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    fontSize: 12,
    color: "#bbb",
    margin: "0 0 14px",
    padding: "8px 12px",
    background: "#161616",
    border: "1px solid #242424",
    borderRadius: 8,
  },
  regimeLabel: { fontWeight: 700, color: "#ddd" },
  regimeItem: { display: "inline-flex", alignItems: "center", gap: 5 },
  regimeTag: {
    fontStyle: "normal",
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 10,
    border: "1px solid currentColor",
  },
  regimeDivider: { color: "#555" },

  app: {
    minHeight: "100vh",
    background: "#0f0f0f",
    color: "#f0f0f0",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Malgun Gothic', sans-serif",
    padding: "24px 32px 60px",
  },
  titleRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  title: { fontSize: 24, fontWeight: 700, margin: 0 },
  fxWidget: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 14,
    whiteSpace: "nowrap",
  },
  fxLabel: { color: "#888", fontSize: 12 },
  fxUnit: { color: "#555", fontSize: 12, fontWeight: 600 },
  fxPrice: { fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums" },
  fxChange: { fontSize: 12, fontVariantNumeric: "tabular-nums" },

  h2: { fontSize: 16, fontWeight: 600, color: "#ccc", margin: "0 0 12px" },

  indexGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 14,
  },
  card: {
    background: "#1a1a1a",
    borderRadius: 10,
    padding: "16px 18px",
    border: "1px solid #242424",
    minHeight: 110,
  },
  chartToolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    alignItems: "center",
    marginBottom: 4,
  },
  crossLegend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 14,
    fontSize: 11,
    marginTop: 4,
  },
  fbBox: {
    background: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "8px 12px",
    margin: "6px 0 10px",
  },
  fbRow: { display: "flex", flexWrap: "wrap", gap: 18, alignItems: "baseline" },
  fbCell: { display: "flex", flexDirection: "column", gap: 1 },
  fbLabel: { fontSize: 10, color: "#888" },
  fbValue: { fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  fbNote: { fontSize: 10.5, color: "#777", marginTop: 6 },
  btnGroup: { display: "flex", gap: 6 },
  toolBtn: {
    background: "#1a1a1a",
    color: "#aaa",
    border: "1px solid #333",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    transition: "all 0.15s",
  },
  toolBtnActive: {
    background: "#2d6cff",
    color: "#fff",
    borderColor: "#2d6cff",
    fontWeight: 600,
  },

  infoBtn: {
    width: 16,
    height: 16,
    lineHeight: "14px",
    padding: 0,
    borderRadius: "50%",
    border: "1px solid #555",
    background: "transparent",
    color: "#999",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  infoBtnActive: { background: "#2d6cff", color: "#fff", borderColor: "#2d6cff" },
  infoPop: {
    position: "absolute",
    top: 22,
    left: 0,
    zIndex: 20,
    width: 280,
    background: "#1c1c1c",
    border: "1px solid #383838",
    borderRadius: 8,
    padding: "10px 12px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    fontWeight: 400,
  },
  infoPopTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    marginBottom: 6,
  },
  infoPopLine: {
    fontSize: 12,
    color: "#bbb",
    lineHeight: 1.6,
  },

  cardName: { fontSize: 13, color: "#999", marginBottom: 8 },
  cardPrice: { fontSize: 22, fontWeight: 700 },
  cardChange: { fontSize: 13, marginTop: 4 },
  cardTime: { fontSize: 11, color: "#666", marginTop: 6 },

  // 신호 종합 패널
  recHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  recHeadRight: { display: "flex", alignItems: "center", gap: 10 },
  recTime: { fontSize: 11, color: "#666" },
  recSubTitle: { fontSize: 13, color: "#999", margin: "18px 0 10px", fontWeight: 600 },
  recEmpty: {
    background: "#1a1a1a",
    border: "1px solid #242424",
    borderRadius: 10,
    padding: "20px 18px",
    color: "#888",
    fontSize: 13,
  },
  recNote: { marginTop: 12, fontSize: 11, color: "#555", lineHeight: 1.6 },
  // 상시 정직성 고지 (접기 불가). 주장 바로 옆에 검증 결과를 붙인다.
  recWarn: {
    margin: "0 0 14px",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #6b4a1f",
    background: "#241a0d",
    color: "#e7c489",
    fontSize: 12,
    lineHeight: 1.7,
  },

  // 신호 검증(백테스트) 패널
  btIntro: {
    background: "#161616",
    border: "1px dashed #2e2e2e",
    borderRadius: 10,
    padding: "14px 16px",
    color: "#999",
    fontSize: 12.5,
    lineHeight: 1.7,
  },
  btSubTitle: { fontSize: 13, color: "#bbb", fontWeight: 600, margin: "16px 0 8px" },
  btTable: {
    border: "1px solid #242424",
    borderRadius: 10,
    overflow: "hidden",
    background: "#161616",
  },
  btRow: {
    display: "grid",
    gridTemplateColumns: "minmax(150px, 1.6fr) repeat(3, 1fr)",
    alignItems: "stretch",
    borderBottom: "1px solid #1f1f1f",
  },
  btRow5: {
    display: "grid",
    gridTemplateColumns: "minmax(150px, 1.6fr) repeat(4, 1fr)",
    alignItems: "stretch",
    borderBottom: "1px solid #1f1f1f",
  },
  btHeadRow: {
    fontSize: 11,
    color: "#888",
    fontWeight: 700,
    background: "#1b1b1b",
  },
  btLabelCell: {
    padding: "10px 12px",
    fontSize: 12,
    color: "#ddd",
    display: "flex",
    alignItems: "center",
    gap: 4,
    lineHeight: 1.4,
  },
  btCell: {
    padding: "8px 12px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 2,
    borderLeft: "1px solid #1f1f1f",
    textAlign: "right",
    alignItems: "flex-end",
  },
  btAvg: { fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  btSub: { fontSize: 10.5, color: "#777", fontVariantNumeric: "tabular-nums" },
  btEx: {
    fontSize: 10.5,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    marginTop: 1,
  },
  btBaseBox: {
    border: "1px solid #3a3320",
    background: "#1d1a12",
    borderRadius: 10,
    padding: 12,
    marginBottom: 18,
  },
  btBaseTitle: { fontSize: 12.5, color: "#e0c97a", marginBottom: 8, fontWeight: 700 },
  btBaseNote: {
    fontSize: 11.5,
    color: "#a99a72",
    lineHeight: 1.65,
    marginTop: 8,
  },
  btMiniNote: {
    fontSize: 11.5,
    color: "#7d7d7d",
    lineHeight: 1.65,
    margin: "8px 2px 4px",
  },
  btEmpty: {
    border: "1px solid #242424",
    borderRadius: 10,
    padding: "16px",
    color: "#777",
    fontSize: 12.5,
    background: "#161616",
  },

  sigGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 12,
  },
  sigCard: {
    background: "#1a1a1a",
    border: "1px solid #242424",
    borderRadius: 10,
    padding: "14px 16px",
  },
  sigHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  sigName: { fontSize: 15, fontWeight: 700 },
  sigGrade: { fontSize: 13, fontWeight: 700 },
  sigMeta: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
    marginBottom: 10,
  },
  sigScore: { marginLeft: "auto", fontWeight: 700 },
  riskGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    columnGap: 14,
    rowGap: 6,
    fontSize: 12,
    padding: "8px 0",
    marginBottom: 8,
    borderTop: "1px solid #242424",
    borderBottom: "1px solid #242424",
  },
  riskCell: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 6,
    minWidth: 0,
  },
  riskLabel: { color: "#777", fontSize: 11, whiteSpace: "nowrap" },
  riskVal: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  badgeWrap: { display: "flex", flexWrap: "wrap", gap: 6 },
  badge: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 12,
    border: "1px solid",
    background: "rgba(255,255,255,0.02)",
  },
  badgeArrow: { fontSize: 10, opacity: 0.7 },
  // 신선도 칩: 신호 발생 시점·이후 이동. 유효(초록)/소진(주황)으로 구분.
  freshChip: { fontSize: 10, opacity: 0.85, color: "#7bd88f", fontWeight: 600 },
  freshChipStale: { fontSize: 10, opacity: 0.9, color: "#ffae57", fontWeight: 600 },
  // 오늘의 상태 배너 (표시 전용 요약): 점수(신호 합의도)+진입위치(⑬)를 한 줄 서술로.
  verdictBar: {
    padding: "7px 10px",
    marginTop: 8,
    borderRadius: 6,
    borderLeft: "3px solid",
    background: "rgba(255,255,255,0.04)",
  },
  verdictTag: { fontSize: 12.5, fontWeight: 700, lineHeight: 1.3 },
  verdictText: { fontSize: 11, color: "#b9b9b9", lineHeight: 1.45, marginTop: 3 },
  intradayBar: {
    padding: "6px 10px",
    marginTop: 8,
    borderRadius: 6,
    border: "1px dashed #5a5a3a",
    background: "rgba(255,210,77,0.06)",
    fontSize: 11.5,
    color: "#e0d9b8",
    lineHeight: 1.4,
  },
  intradayNote: { fontSize: 10.5, color: "#9a927a", lineHeight: 1.45, marginTop: 3 },
  selfBenchNote: {
    padding: "6px 10px",
    marginTop: 8,
    borderRadius: 6,
    border: "1px solid #333",
    background: "rgba(255,255,255,0.02)",
    fontSize: 11,
    color: "#a8a8a8",
    lineHeight: 1.45,
  },
  changeBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "6px 16px",
    padding: "8px 12px",
    marginBottom: 14,
    borderRadius: 6,
    border: "1px solid #333",
    background: "rgba(255,255,255,0.03)",
    fontSize: 12,
    color: "#cfcfcf",
  },
  changeTag: { fontWeight: 700, color: "#bdbdbd" },
  changeGroup: { lineHeight: 1.5 },
  deltaChip: {
    fontSize: 11,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    marginLeft: 2,
  },
  newTag: { fontSize: 10 },
  sigCardBtns: { display: "flex", gap: 6, marginTop: 8 },
  recordBtn: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #3a4a5a",
    background: "rgba(120,160,220,0.08)",
    color: "#9fc0e8",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  jHelp: {
    padding: "9px 12px",
    marginBottom: 12,
    borderRadius: 6,
    border: "1px solid #333",
    background: "rgba(255,255,255,0.02)",
    fontSize: 12,
    color: "#c2c2c2",
    lineHeight: 1.55,
  },
  jSubTitle: { fontSize: 12.5, fontWeight: 700, color: "#bdbdbd", margin: "10px 0 6px" },
  jTable: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 },
  jRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "7px 10px",
    borderRadius: 6,
    border: "1px solid #2e2e2e",
    background: "rgba(255,255,255,0.02)",
  },
  jRowMain: { fontSize: 13, minWidth: 110 },
  jRowSub: { fontSize: 11.5, color: "#aaa", flex: 1, minWidth: 180 },
  jRowActions: { display: "flex", gap: 6, marginLeft: "auto" },
  jSmallBtn: {
    padding: "4px 10px",
    borderRadius: 5,
    border: "1px solid #4a4a4a",
    background: "#2a2a2a",
    color: "#ddd",
    fontSize: 11.5,
    cursor: "pointer",
  },
  jDelBtn: {
    padding: "4px 8px",
    borderRadius: 5,
    border: "1px solid #443",
    background: "transparent",
    color: "#977",
    fontSize: 11,
    cursor: "pointer",
  },
  jToggle: {
    background: "none",
    border: "none",
    color: "#8ab",
    fontSize: 12,
    cursor: "pointer",
    padding: "4px 0",
  },
  jAggBox: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #333",
    background: "rgba(255,255,255,0.03)",
    marginBottom: 8,
  },
  jAggGrid: { display: "flex", flexWrap: "wrap", gap: "10px 22px" },
  jStat: { display: "flex", flexDirection: "column", gap: 2 },
  jStatLabel: { fontSize: 10.5, color: "#8a8a8a" },
  jStatVal: { fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  jAggNote: { fontSize: 11, color: "#9a9a9a", lineHeight: 1.5, marginTop: 8 },
  jForm: { display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" },
  jFormRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  jFormLabel: { width: 52, fontSize: 12.5, color: "#aaa", paddingTop: 6, flexShrink: 0 },
  jInput: {
    flex: 1,
    padding: "6px 9px",
    borderRadius: 6,
    border: "1px solid #444",
    background: "#1c1c1c",
    color: "#eee",
    fontSize: 13,
  },
  jTextarea: {
    flex: 1,
    minHeight: 54,
    padding: "6px 9px",
    borderRadius: 6,
    border: "1px solid #444",
    background: "#1c1c1c",
    color: "#eee",
    fontSize: 12.5,
    resize: "vertical",
    fontFamily: "inherit",
  },
  jSideGroup: { display: "flex", gap: 6, flex: 1 },
  jSideBtn: {
    flex: 1,
    padding: "6px 0",
    borderRadius: 6,
    border: "1px solid #444",
    background: "#1c1c1c",
    color: "#999",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  jSnapBox: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px dashed #444",
    background: "rgba(255,255,255,0.02)",
    fontSize: 11.5,
    color: "#bbb",
    lineHeight: 1.5,
  },
  jSnapLine: { fontSize: 11.5, color: "#9a9a9a", marginTop: 3 },
  jActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  jPrimaryBtn: {
    padding: "7px 16px",
    borderRadius: 6,
    border: "1px solid #3a6a4a",
    background: "rgba(80,180,120,0.15)",
    color: "#7bd88f",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  reasonTip: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 25,
    width: 220,
    background: "#1c1c1c",
    border: "1px solid #383838",
    borderRadius: 8,
    padding: "8px 10px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    fontWeight: 400,
    whiteSpace: "normal",
    textAlign: "left",
    pointerEvents: "none", // 툴팁이 hover 판정을 가로채지 않도록
  },
  reasonTipText: { fontSize: 11.5, color: "#cfcfcf", lineHeight: 1.55 },
  reasonTipHint: {
    fontSize: 10.5,
    color: "#888",
    marginTop: 6,
    paddingTop: 5,
    borderTop: "1px solid #2e2e2e",
  },
  reasonPop: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 30,
    width: 250,
    background: "#1c1c1c",
    border: "1px solid #383838",
    borderRadius: 8,
    padding: "10px 12px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    fontWeight: 400,
    whiteSpace: "normal",
    textAlign: "left",
    cursor: "default",
  },
  reasonPopTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    marginBottom: 6,
  },
  reasonPopText: {
    fontSize: 12,
    color: "#bbb",
    lineHeight: 1.6,
    marginBottom: 6,
  },
  reasonPopHint: {
    fontSize: 11,
    color: "#888",
    borderTop: "1px solid #2e2e2e",
    paddingTop: 6,
    marginTop: 2,
  },

  // 점수 칩(클릭 → 상세 모달) / 카드 하단 상세 버튼
  sigScoreBtn: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  breakdownBtn: {
    marginTop: 10,
    width: "100%",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid #2e2e2e",
    borderRadius: 8,
    color: "#aaa",
    fontSize: 11.5,
    padding: "6px 0",
    cursor: "pointer",
  },

  // 점수 상세 모달
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalBox: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "85vh",
    overflowY: "auto",
    background: "#181818",
    border: "1px solid #333",
    borderRadius: 12,
    padding: "16px 18px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
  },
  modalHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  modalTitle: { fontSize: 17, fontWeight: 700 },
  modalSym: { fontSize: 12, color: "#777", marginLeft: 8 },
  modalClose: {
    background: "none",
    border: "none",
    color: "#888",
    fontSize: 16,
    cursor: "pointer",
    lineHeight: 1,
  },
  modalScoreLine: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    paddingBottom: 12,
    marginBottom: 6,
    borderBottom: "1px solid #2a2a2a",
  },
  modalScore: { fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  modalGrade: { fontSize: 13, fontWeight: 700, marginLeft: "auto" },
  mbSectionTitle: {
    fontSize: 11.5,
    color: "#888",
    fontWeight: 700,
    marginTop: 12,
    marginBottom: 4,
  },
  mbRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "6px 0",
    borderBottom: "1px solid #232323",
  },
  mbLabel: { fontSize: 12.5, color: "#e0e0e0", lineHeight: 1.4 },
  mbSub: { fontSize: 11, color: "#888", lineHeight: 1.5, marginTop: 3 },
  mbPts: {
    fontSize: 14,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  mbSubtotal: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    color: "#aaa",
    padding: "6px 2px 2px",
    fontVariantNumeric: "tabular-nums",
  },
  mbTotal: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 12,
    paddingTop: 10,
    borderTop: "2px solid #333",
    fontSize: 15,
    fontWeight: 700,
    color: "#ccc",
    fontVariantNumeric: "tabular-nums",
  },
  mbHint: {
    marginTop: 12,
    fontSize: 11,
    color: "#888",
    lineHeight: 1.6,
    background: "rgba(255,255,255,0.02)",
    borderRadius: 8,
    padding: "8px 10px",
  },

  list: { borderRadius: 10, overflow: "hidden", border: "1px solid #242424" },
  listHeader: {
    display: "flex",
    alignItems: "center",
    padding: "8px 16px",
    fontSize: 12,
    color: "#777",
  },
  rowWrap: { borderBottom: "1px solid #1f1f1f" },
  row: {
    display: "flex",
    alignItems: "center",
    padding: "14px 16px",
    cursor: "pointer",
    transition: "background 0.2s",
    userSelect: "none",
  },
  rowArrow: { width: 24, color: "#777", fontSize: 11 },
  rowName: { width: 120, fontWeight: 600, fontSize: 15 },
  rowCell: { flex: 1, textAlign: "right", fontSize: 14, fontVariantNumeric: "tabular-nums" },

  errText: { color: "#ff7a7a", fontSize: 13, fontWeight: 600 },
  footer: { marginTop: 40, fontSize: 11, color: "#555", textAlign: "center" },
};
