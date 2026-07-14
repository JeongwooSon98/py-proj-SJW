import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  ComposedChart,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Bar,
  CartesianGrid,
} from "recharts";

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
  { name: "USD/KRW", symbol: "USDKRW=X" },
  { name: "NASDAQ", symbol: "^IXIC" },
  { name: "S&P 500", symbol: "^GSPC" },
  { name: "Dow Jones", symbol: "^DJI" },
];

const WATCHLIST = [
  { name: "NVDA", symbol: "NVDA" },
  { name: "TSLA", symbol: "TSLA" },
  { name: "AAPL", symbol: "AAPL" },
  { name: "MSFT", symbol: "MSFT" },
  { name: "GOOGL", symbol: "GOOGL" },
  { name: "AMZN", symbol: "AMZN" },
  { name: "QQQ", symbol: "QQQ" },
  { name: "SPY", symbol: "SPY" },
  { name: "SOXX", symbol: "SOXX" },
  { name: "삼성전자", symbol: "005930.KS" },
  { name: "하이닉스", symbol: "000660.KS" },
];

const MA_COLORS = {
  ma5: "#ffd24d",
  ma20: "#4dffb0",
  ma60: "#b04dff",
  ma120: "#ff8c4d",
};

/* ------------------------------------------------------------------ */
/*  데이터 fetch 유틸                                                  */
/* ------------------------------------------------------------------ */

// Yahoo Finance chart API 호출 (corsproxy 경유)
async function fetchChart(symbol, range = "1d", interval = "1d") {
  const target = `${BASE}${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
  const url = `${PROXY}${encodeURIComponent(target)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data");
  return result;
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
  return { price, change, changePct };
}

// 3년 일봉 + 지표 계산용 시계열
async function fetchSeries(symbol) {
  const result = await fetchChart(symbol, "3y", "1d");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    const d = new Date(ts[i] * 1000);
    rows.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getDate()).padStart(2, "0")}`,
      open: o,
      high: h,
      low: l,
      close: c,
    });
  }
  return rows;
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

function computeIndicators(rows) {
  const closes = rows.map((r) => r.close);
  const highs = rows.map((r) => r.high);
  const lows = rows.map((r) => r.low);
  const n = rows.length;

  // 이동평균선
  const out = rows.map((r, i) => ({
    ...r,
    ma5: sma(closes, 5, i),
    ma20: sma(closes, 20, i),
    ma60: sma(closes, 60, i),
    ma120: sma(closes, 120, i),
    // 캔들스틱용 범위 (low~high) + 색상 판단
    range: [r.low, r.high],
    rising: r.close >= r.open,
  }));

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

  // Stochastic %K(14), %D = SMA3 of %K
  const kPeriod = 14;
  const kArr = [];
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1) {
      kArr.push(null);
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = i - kPeriod + 1; k <= i; k++) {
      if (highs[k] > hh) hh = highs[k];
      if (lows[k] < ll) ll = lows[k];
    }
    const k = hh === ll ? 0 : ((closes[i] - ll) / (hh - ll)) * 100;
    kArr.push(k);
    out[i].k = k;
  }
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1 + 2) continue;
    if (kArr[i] == null || kArr[i - 1] == null || kArr[i - 2] == null) continue;
    out[i].d = (kArr[i] + kArr[i - 1] + kArr[i - 2]) / 3;
  }

  return out;
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

function ChartPanel({ symbol }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(false);
    fetchSeries(symbol)
      .then((rows) => {
        if (!alive) return;
        if (!rows.length) throw new Error("empty");
        setData(computeIndicators(rows));
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (err)
    return <div style={{ padding: 24, color: "#ff7a7a" }}>데이터 오류</div>;
  if (!data)
    return (
      <div style={{ padding: 24, color: "#888" }}>차트 Loading...</div>
    );

  const tickFmt = makeTickFormatter(data);

  return (
    <div style={{ padding: "8px 16px 20px" }}>
      {/* 차트 1: 가격 + 이동평균선 (캔들스틱) */}
      <ChartTitle>가격 / 이동평균선 (3년 일봉)</ChartTitle>
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
          <Bar dataKey="range" shape={<Candle />} isAnimationActive={false} />
          <Line type="monotone" dataKey="ma5" stroke={MA_COLORS.ma5} dot={false} strokeWidth={1} name="MA5" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma20" stroke={MA_COLORS.ma20} dot={false} strokeWidth={1} name="MA20" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma60" stroke={MA_COLORS.ma60} dot={false} strokeWidth={1} name="MA60" isAnimationActive={false} />
          <Line type="monotone" dataKey="ma120" stroke={MA_COLORS.ma120} dot={false} strokeWidth={1} name="MA120" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <Legend />

      {/* 차트 2: RSI */}
      <ChartTitle>RSI (14)</ChartTitle>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} tick={axisStyle} width={60} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(v, 2)} />
          <ReferenceLine y={70} stroke="#ff4d4d" strokeDasharray="4 4" />
          <ReferenceLine y={30} stroke="#4d8bff" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="rsi" stroke="#e0e0e0" dot={false} strokeWidth={1.2} name="RSI" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      {/* 차트 3: Stochastic */}
      <ChartTitle>Stochastic (%K 14 / %D 3)</ChartTitle>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} syncId="stk" margin={{ left: 10, right: 20 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisStyle} tickFormatter={tickFmt} minTickGap={20} />
          <YAxis domain={[0, 100]} ticks={[0, 20, 50, 80, 100]} tick={axisStyle} width={60} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNum(v, 2)} />
          <ReferenceLine y={80} stroke="#ff4d4d" strokeDasharray="4 4" />
          <ReferenceLine y={20} stroke="#4d8bff" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="k" stroke="#ffd24d" dot={false} strokeWidth={1.2} name="%K" isAnimationActive={false} />
          <Line type="monotone" dataKey="d" stroke="#4dffb0" dot={false} strokeWidth={1.2} name="%D" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTitle({ children }) {
  return (
    <div style={{ color: "#bbb", fontSize: 13, fontWeight: 600, margin: "14px 0 4px" }}>
      {children}
    </div>
  );
}

function Legend() {
  const items = [
    ["MA5", MA_COLORS.ma5],
    ["MA20", MA_COLORS.ma20],
    ["MA60", MA_COLORS.ma60],
    ["MA120", MA_COLORS.ma120],
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
/*  지수 카드                                                          */
/* ------------------------------------------------------------------ */

function IndexCard({ name, symbol }) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchQuote(symbol)
      .then((r) => alive && setQ(r))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [symbol]);

  const color = q ? colorOf(q.change) : FLAT;

  return (
    <div style={styles.card}>
      <div style={styles.cardName}>{name}</div>
      {err ? (
        <div style={styles.errText}>데이터 오류</div>
      ) : !q ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <div style={{ ...styles.cardPrice, color }}>{fmtNum(q.price, 2)}</div>
          <div style={{ ...styles.cardChange, color }}>
            {signStr(q.change, 2)} ({signStr(q.changePct, 2)}%)
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  관심종목 행                                                        */
/* ------------------------------------------------------------------ */

function WatchRow({ name, symbol, expanded, onToggle }) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchQuote(symbol)
      .then((r) => alive && setQ(r))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [symbol]);

  const color = q ? colorOf(q.change) : FLAT;

  return (
    <div style={styles.rowWrap}>
      <div
        style={{ ...styles.row, background: expanded ? "#202020" : "#1a1a1a" }}
        onClick={onToggle}
      >
        <div style={styles.rowArrow}>{expanded ? "▼" : "▶"}</div>
        <div style={styles.rowName}>{name}</div>
        {err ? (
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
          maxHeight: expanded ? 820 : 0,
          opacity: expanded ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.45s ease, opacity 0.4s ease",
          background: "#141414",
          borderBottom: expanded ? "1px solid #2a2a2a" : "none",
        }}
      >
        {expanded && <ChartPanel symbol={symbol} />}
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
/*  메인                                                               */
/* ------------------------------------------------------------------ */

export default function StockDashboard() {
  const [openSymbol, setOpenSymbol] = useState(null);

  const toggle = useCallback((symbol) => {
    setOpenSymbol((cur) => (cur === symbol ? null : symbol));
  }, []);

  return (
    <div style={styles.app}>
      <style>{`
        @keyframes sk { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background:#333; border-radius:4px; }
      `}</style>

      <h1 style={styles.title}>📈 My Stock Dashboard</h1>

      {/* ① 지수 패널 */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={styles.h2}>지수</h2>
        <div style={styles.indexGrid}>
          {INDICES.map((idx) => (
            <IndexCard key={idx.symbol} {...idx} />
          ))}
        </div>
      </section>

      {/* ② 관심 종목 */}
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
  app: {
    minHeight: "100vh",
    background: "#0f0f0f",
    color: "#f0f0f0",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Malgun Gothic', sans-serif",
    padding: "24px 32px 60px",
  },
  title: { fontSize: 24, fontWeight: 700, margin: "0 0 24px" },
  h2: { fontSize: 16, fontWeight: 600, color: "#ccc", margin: "0 0 12px" },

  indexGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, 1fr)",
    gap: 14,
  },
  card: {
    background: "#1a1a1a",
    borderRadius: 10,
    padding: "16px 18px",
    border: "1px solid #242424",
    minHeight: 92,
  },
  cardName: { fontSize: 13, color: "#999", marginBottom: 8 },
  cardPrice: { fontSize: 22, fontWeight: 700 },
  cardChange: { fontSize: 13, marginTop: 4 },

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
