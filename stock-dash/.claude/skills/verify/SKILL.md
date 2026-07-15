---
name: verify
description: stock-dash 앱을 실제 브라우저로 띄워 변경을 눈으로 확인한다 (신호 카드·차트·점수 안정성)
---

# stock-dash 검증 (실제 구동)

이 앱의 표면은 **브라우저 픽셀**이다. 지표·점수는 순수 함수지만, 그걸 직접 호출해 보는 건
검증이 아니다(그건 단위 테스트다). **앱을 띄우고 카드·차트를 봐야 한다.**

## 1. dev 서버

```bash
npm run dev -- --port 5199 --strictPort   # background로
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5199/   # 200 확인
```

## 2. 브라우저 (Playwright) — 최초 1회 셋업

⚠️ **corsproxy.io는 서버사이드 요청(curl)을 403으로 막는다.** 반드시 진짜 브라우저로 띄워야
Yahoo 데이터가 들어온다. `curl`로 프록시를 찔러 보고 "네트워크가 안 된다"고 결론내지 말 것.

⚠️ **`npx playwright install --with-deps`는 sudo가 필요해 실패한다.** 시스템 라이브러리를
사용자 디렉터리에 풀어서 `LD_LIBRARY_PATH`로 물린다:

```bash
cd <scratchpad> && npm init -y && npm i playwright
npx playwright install chromium            # --with-deps 빼고

# 누락 라이브러리(libnspr4/libnss3/libasound)를 root 없이 설치
mkdir -p libs/debs && cd libs/debs
apt-get download libnspr4 libnss3 libasound2t64
cd .. && for d in debs/*.deb; do dpkg-deb -x "$d" root; done

# 실행할 때마다
LD_LIBRARY_PATH=<scratchpad>/libs/root/usr/lib/x86_64-linux-gnu node drive.mjs
```

## 3. 무엇을 볼 것인가

- **신호 카드**: `점 ▸` 버튼을 가진 요소가 카드다. 이름·등급·점수·배지를 `innerText`로 긁는다.
- **점수 안정성(repaint)**: 페이지를 **3회 새로고침**해 `이름=점수` 맵이 동일한지 본다.
  (모듈 레벨 `signalCache`는 리로드하면 초기화되므로 매번 실제로 재fetch한다 — 진짜 테스트다.)
- **장중 배지**: 장중이면 미국 종목 카드에 `🕐 장중 · 신호는 {날짜} 종가 기준`이 떠야 한다.
  **한국 종목(.KS)에는 뜨면 안 된다**(KRX 마감 시각이 다르므로) — 시장별 판정이 맞는지의 증거다.
- **차트가 오늘 봉을 그리는가**: recharts 툴팁은 headless에서 잘 안 뜬다. 대신
  `page.on("response")`로 Yahoo 응답을 가로채 봉 수를 세고,
  `.recharts-bar-rectangle` 개수와 **대조**한다. 같으면 차트가 미완성 봉까지 그린 것이다.
- 관심종목 목록의 행은 `<tr>`이 아니라 div다. `▶`로 시작하는 텍스트를 찾아 클릭한다.

## 4. 백테스트 회귀 (점수 로직 무변경 증명)

`npm run backtest` 출력 비교는 **장 마감 후에만** 신뢰할 수 있다. 장중에 확실히 증명하려면
Yahoo를 **한 번만** 받아 변경 전(`git show HEAD:./src/StockDashboard.jsx`)·변경 후 엔진에
똑같이 먹여 `aggregateBacktest` 결과를 비교할 것. (esbuild로 두 소스를 각각 번들 →
산출물은 `scripts/` 안에 써야 react/recharts external이 해석된다.)
