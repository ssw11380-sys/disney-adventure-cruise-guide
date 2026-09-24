# 주식 브리핑 앱 (stock-briefing)

보유/관심 한국·미국 주식을 등록하면 매일 오전·오후 브리핑을 생성해 푸시로 알려주고, 종목별 회사 소개·가치투자·기술적 분석을 보여주는 모바일 앱.

> 투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.

## 아키텍처

```
┌─────────────────────┐        HTTPS/JSON        ┌──────────────────────────────────────┐
│  app/ (Expo RN)     │ ◄──────────────────────► │  backend/ (Fastify + TypeScript)     │
│  - 종목 목록/등록    │   Expo Push (알림)        │  - REST API  /api/stocks, /api/...   │
│  - 브리핑 목록/상세  │ ◄──────────────────────  │  - 스케줄러  08:30 / 16:00 KST        │
│  - 종목 상세 4탭     │                          │  - 브리핑 파이프라인                   │
└─────────────────────┘                          │     수집 → 프롬프트 조립 → Claude → 저장│
                                                 └───────┬───────────┬──────────┬───────┘
                                                         │           │          │
                                        ┌────────────────┘           │          └──────────────┐
                                        ▼                            ▼                         ▼
                              시세/차트 (QuoteProvider 체인)    재무 (DART)              뉴스 (네이버)
                              KIS → 토스증권 → 네이버 → Yahoo   + 회사 개요               + 공시(DART)
                              검색: 토스증권 → Yahoo (+마스터)
                                        │
                                        ▼
                              SQLite(개발) / Postgres(운영)  ← Kysely (두 DB 공용 쿼리)
```

핵심 설계 원칙

- **데이터 소스는 인터페이스 뒤에 둔다.** `QuoteProvider`, `StockSearchProvider`, `MasterProvider`(1단계), `FinancialsProvider`, `NewsProvider`(2단계). 구현체는 교체·체인 가능.
- **폴백 체인.** 시세는 KIS(키 있을 때) → 토스증권(키 불필요, 한국은 KRX+NXT 통합 가격 = 토스 앱과 같은 숫자, 미국은 USD + 원화 환산) → 네이버 증권(한국, KRX 정규장 종가 + NXT 야간 가격) → Yahoo Finance 순. 모든 소스가 실패해도 API는 200 + `quoteError` 로 응답하고, 브리핑에는 "데이터 미확인"을 남긴다. 어떤 기준의 가격인지는 `quote.priceBasis` 로 알 수 있다.
- **한국 + 미국 종목.** 코드는 숫자로 시작하는 6자리(한국, `000660`·`0162Z0`) 또는 티커(미국, `AAPL`·`BRK-B`). 미국 종목은 통화가 USD 이고 공시·수급·재무제표(DART/KIS)가 없어 브리핑에 "미국 종목 미지원"으로 표시된다. 검색은 토스증권 검색을 먼저 써서 한글 이름("테슬라", "애플")으로도 미국 종목이 나오고, 등록되는 이름도 한글이라 뉴스 검색이 한국어로 된다.
- **모든 시각은 Asia/Seoul.** 서버 TZ 와 무관하게 `lib/time.ts` 로 계산.
- **프롬프트는 파일로.** `backend/prompts/*.md` (2단계) — 코드 수정 없이 편집 가능.
- **단일 사용자 v1.** 인증/멀티유저는 범위 밖. 배포 시 네트워크(VPN, 방화벽)로 보호.

## 폴더 구조

```
stock-briefing/
├── README.md
├── backend/
│   ├── .env.example            # 모든 API 키/설정 항목
│   ├── Dockerfile, docker-compose.yml, fly.toml   # 배포
│   ├── package.json
│   ├── prompts/                # briefing_detail.md, briefing_summary.md, company_overview.md,
│   │                           # value_analysis.md, technical_analysis.md (+ README: 변수 목록)
│   ├── src/
│   │   ├── index.ts            # 부팅: 설정 → DB 마이그레이션 → 프로바이더 조립 → 서버
│   │   ├── app.ts              # Fastify 인스턴스, 에러 핸들러, 라우트 등록 (테스트에서 재사용)
│   │   ├── config.ts           # .env → zod 검증
│   │   ├── domain/types.ts     # ListedStock, RegisteredStock, Quote, Candle ...
│   │   ├── db/                 # Kysely 스키마 + 마이그레이션 + 커넥션
│   │   ├── providers/
│   │   │   ├── index.ts        # 설정에 따라 실제 소스 조립 (키 없는 소스는 폴백 또는 null)
│   │   │   ├── market/         # kis, toss(시세·봉·검색, 한국+미국), naver(한국 폴백+NXT), yahoo(최종 폴백), kisMaster(종목 마스터), investorFlow(수급), chain(폴백)
│   │   │   ├── news/           # naver(검색 API), googleRss(키 불필요), chain(폴백)
│   │   │   └── dart/           # DART 회사 개요·공시·재무제표·배당
│   │   ├── llm/                # generator(Anthropic SDK 래퍼, 캐싱·폴백), prompts(파일 로더·템플릿)
│   │   ├── analysis/           # indicators (SMA/EMA/RSI/MACD/볼린저/지지저항, 직접 구현)
│   │   ├── notifications/      # settings(알림 시간 설정, cron 변환), push(Expo Push Service 전송)
│   │   ├── services/           # stockService, collector(데이터 수집), briefingService, analysisService,
│   │   │                       # deviceService(푸시 토큰), notificationService(브리핑 → 푸시, 영수증)
│   │   ├── scheduler.ts        # node-cron (Asia/Seoul) 오전/오후 브리핑
│   │   ├── routes/             # stocks, analysis, briefings, notifications(devices/settings/test), admin
│   │   ├── lib/                # time(KST), errors, codes(한국 6자리/미국 티커 규칙, 통화)
│   │   └── scripts/            # refreshMaster, runBriefing
│   └── test/                   # vitest (네트워크 없이 가짜 프로바이더로 검증)
└── app/                        # Expo(SDK 57) + TypeScript + Expo Router
    ├── app.json                # 앱 이름/스킴, extra.apiUrl(기본 서버 주소)
    ├── metro.config.js         # markdown-it 의 punycode 를 npm 패키지로 연결
    └── src/
        ├── app/                # 라우트 = 화면
        │   ├── (tabs)/         # 내 종목 / 브리핑 / 설정
        │   ├── stocks/add      # 종목 검색·등록 (모달)
        │   ├── stocks/[code]/  # 종목 상세(index: 시세·차트·4탭), edit: 보유 정보 수정·삭제
        │   └── briefings/[id]  # 브리핑 상세 (요약/상세 토글, 지난 브리핑)
        ├── api/                # client(fetch 래퍼), hooks(react-query), types(백엔드와 동일)
        ├── components/         # Screen(고지 footer), CandleChart, MarkdownView, BriefingCard, StockRow, ui,
        │                       # NotificationSettingsCard(알림 설정), NotificationBridge(알림 탭 → 브리핑 이동), AppUpdateCard(앱 업데이트 확인)
        ├── lib/                # settings(서버 주소 저장), notifications(권한·토큰·등록), format(원·$/%/날짜), appUpdate(release.json + expo-updates)
        └── theme.ts            # 라이트/다크 토큰
```

## 단계별 계획

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 백엔드 뼈대, 종목 검색/등록 API, 시세 어댑터(KIS → Yahoo 폴백), SQLite | **완료** |
| 2 | 브리핑 파이프라인(시세·뉴스·공시·재무 수집 → 프롬프트 → Claude → 저장), node-cron 스케줄러, 프롬프트 파일 5종, 브리핑·분석 조회 API | **완료** |
| 3 | Expo 앱: 종목 목록/등록, 브리핑 목록·상세(요약/상세 토글, 날짜별), 종목 상세 4탭(회사 소개·가치·기술·뉴스/공시), 캔들 차트 | **완료** |
| 4 | Expo Push 연동, 기기 토큰 등록, 알림 시간 사용자 설정 (Android 대상) | **완료** |
| 5 | 기술적 지표(SMA/RSI/MACD/볼린저) 직접 구현 + 단위 테스트, 브리핑 파이프라인 통합 테스트 | 2단계에서 선행 구현. Postgres 통합 테스트 추가. 실제 키로 검증만 남음 |
| 6 | 배포: Docker 이미지, Postgres 전환, API 토큰 인증, Fly.io/Railway/docker-compose 설정 | **완료** |

## 실행 방법

```bash
cd stock-briefing/backend
npm install
cp .env.example .env        # KIS 키가 없으면 그대로 두어도 됨 (Yahoo 로 동작)
npm run dev                  # http://localhost:3000
```

기동 시 종목 마스터(KOSPI/KOSDAQ 약 4,400건)가 비어 있으면 KIS 공개 마스터 파일을 자동으로 내려받습니다. 수동 갱신은 `npm run master:refresh`.

브리핑을 실제로 생성하려면 `.env` 에 `ANTHROPIC_API_KEY` 가 필요합니다. 나머지 키는 없어도 동작하며, 없는 데이터는 브리핑에 "데이터 미확인"으로 표시됩니다.

| 키 | 없으면 |
|---|---|
| `ANTHROPIC_API_KEY` 또는 Bedrock 키 | 브리핑/분석이 `failed` 로 저장되고 사유가 남음 (수집은 정상). 둘 중 하나면 됨 |
| `TOSS_CLIENT_ID/SECRET` | 공식 API 대신 토스 웹 비공식 API(→ 네이버 → Yahoo). 실시간·보유 종목 가져오기 없음 |
| `KIS_APP_KEY/SECRET` | 수급은 토스 Open API 가 있으면 그쪽, 없으면 미확인 |
| `DART_API_KEY` | 공시·재무제표·배당·회사 개요 미확인 |
| `NAVER_CLIENT_ID/SECRET` | 뉴스는 Google News RSS |

서버 없이 브리핑 한 번 돌려보기: `npm run briefing -- morning` (전체) 또는 `npm run briefing -- afternoon 000660`.

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 상태·고지 문구 (토큰을 보내면 시세 소스·스케줄·토스 연동 등 상세) |
| GET | `/api/stocks/search?q=테슬라&limit=20` | 종목명/코드/티커 검색 (토스증권 → 종목 마스터 → Yahoo). 한글로 미국 종목도 검색됨 |
| GET | `/api/stocks?quotes=1` | 등록 종목 목록 (+현재가, 평가손익). 현재가에 `currency`, 한국 종목은 `afterMarket`(NXT) 포함 |
| POST | `/api/stocks` | `{ code, quantity?, avgPrice?, memo? }` 등록. 코드는 `000660` 또는 `AAPL`(소문자 허용, 평단은 그 통화 기준) |
| GET | `/api/stocks/:code` | 등록 종목 + 현재가 |
| PATCH | `/api/stocks/:code` | 수량/단가/메모 수정 (null 로 비우기) |
| DELETE | `/api/stocks/:code` | 삭제 |
| GET | `/api/stocks/:code/quote?fresh=1` | 현재가 (60초 캐시, fresh=1 이면 강제 조회) |
| GET | `/api/stocks/:code/candles?period=D\|W\|M&count=120` | 봉차트 |
| GET | `/api/stocks/:code/analysis/company\|value\|technical?refresh=1` | 종목 상세 탭: 회사 소개 / 가치투자 / 기술적 분석 (캐시 30일/7일/1일) |
| GET | `/api/briefings/latest` | 등록 종목별 최신 브리핑 (홈 화면) |
| GET | `/api/briefings?code=&date=&session=&limit=` | 브리핑 목록 (요약+상세 포함, 최신순) |
| GET | `/api/briefings/:id` | 브리핑 상세 + 수집 데이터 스냅샷 |
| POST | `/api/briefings/run` | `{ session: "morning"\|"afternoon", codes?, force? }` 수동 실행 |
| GET | `/api/briefings/schedule` | cron 상태와 다음 실행 시각 |
| GET/POST | `/api/devices` | 푸시 기기 목록 / 등록 `{ token, platform, deviceName? }` |
| DELETE | `/api/devices/:token` | 기기 삭제 (알림 끄기) |
| GET/PUT | `/api/notifications/settings` | 알림 시간 설정 `{ morningTime, afternoonTime, morningEnabled, afternoonEnabled, weekdaysOnly, pushEnabled }` (PUT 즉시 스케줄 반영) |
| POST | `/api/notifications/test` | 등록 기기 전체에 테스트 알림 |
| POST | `/api/notifications/receipts` | Expo 푸시 영수증 즉시 확인 (기본은 전송 15분 뒤 자동) |
| GET | `/api/market/status` | 한국·미국 장 상태 (거래일 여부, 장중 여부, 다음 개장/종료 시각) |
| GET | `/api/market/indices?stale=1` | 지수 띠 (30초 캐시). `stale=1` 이면 출처가 실패한 항목도 마지막 값(받은 지 3시간까지)에 `stale: true`, 없으면(옛 앱) 예전 서버처럼 그 항목을 빼고, 모두 실패하면 직전 목록(3시간까지) |
| GET | `/api/discover/:market/rank/:category?page=&size=&v=&r=1` | 발견 탭 순위 (`v` = 첫 쪽 응답의 `ver`, 같은 목록에서 이어 받기. `r=1` 이면 그 판을 잃었을 때 빈 쪽 + `restart`, 없으면(옛 앱) 지금 목록의 쪽). market `KR`\|`US`, category `tradingValue`\|`volume`\|`gainers`\|`losers` |
| GET | `/api/discover/:market/themes?kind=theme\|sector&period=day\|week\|month` | 테마·업종 목록 (등락률, 상승·보합·하락 수, 대표 종목) |
| GET | `/api/discover/:market/themes/:id?kind=` | 테마·업종 구성 종목과 요약 |
| GET | `/api/admin/toss/status` | 토스 Open API 상태 (키 설정, 토큰, 서버 공인 IP, 실시간 구독) |
| POST | `/api/admin/toss/import-holdings` | 토스증권 보유 종목 → 등록 종목 (수량·평단 동기화) |
| GET | `/api/admin/master` | 종목 마스터 건수/갱신 시각 |
| POST | `/api/admin/master/refresh` | 종목 마스터 갱신 |
| POST | `/api/admin/dart/refresh` | DART 고유번호 매핑 갱신 (DART 키 필요, 첫 조회 시 자동) |

```bash
curl -G localhost:3000/api/stocks/search --data-urlencode "q=SK하이닉스"
curl -X POST localhost:3000/api/stocks -H 'content-type: application/json' \
     -d '{"code":"000660","quantity":10,"avgPrice":1500000}'
curl "localhost:3000/api/stocks?quotes=1"
```

### 테스트

```bash
npm run typecheck
npm test
# Postgres 방언까지 (건너뛰는 테스트 0개): TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/stockbriefing_test npm test
```

앱도 같은 명령으로 검사합니다(`cd app && npm run typecheck && npm run lint && npm test`). 앱 테스트는 평가·합계·위젯 합계·표기·실시간 체결 계산 같은 순수 함수와, 투자 권유 금지 문구·고지 문구를 봅니다. 서버와 앱의 평가 계산은 공용 픽스처 `shared/fixtures/evaluation.json` 으로 묶여 있어, 한쪽 계산만 바꾸면 양쪽 테스트 중 하나가 깨집니다(0원 차이 기준).

### CI 와 병합 규칙

- 모든 PR 과 main 푸시에서 GitHub Actions(`.github/workflows/ci.yml`)가 **서버**(타입·테스트·Postgres·빌드), **앱**(타입·린트·테스트), **비밀키 스캔**(gitleaks) 세 잡을 돌립니다. 하나라도 빨간불이면 병합하지 않습니다.
- Railway 는 `railway.json` 의 `watchPatterns` 에 걸린 파일(`stock-briefing/backend/**` 중 `test/` 제외, 루트 `Dockerfile`·`.dockerignore`·`railway.json`)이 바뀐 커밋만 다시 배포합니다. 앱만 바꾼 PR 은 서버를 재시작하지 않습니다.
- 병합 금지 시간(한국 시간, 평일): **08:20~08:40**(오전 브리핑·장 시작 직전), **15:50~16:15**(장 마감·오후 브리핑). 서버 재배포 중에는 실시간 시세와 브리핑 생성이 잠깐 멈추기 때문입니다.
- 앱 JS 오류는 서버에 자동으로 모입니다(`POST /api/app-errors`, 토큰·금액은 앱과 서버에서 두 번 지움, 분당 한도). 최근 N일 수는 `GET /api/admin/app-errors?days=7`, 앱 설정 → 서버 → "앱 오류 (7일)". OTA 를 올린 뒤 24시간은 이 숫자를 확인하고, 늘었으면 [OTA 되돌리기](docs/OTA-되돌리기.md) 절차로 이전 버전을 다시 게시합니다.
- DB 는 하루 한 번(04~06시) 암호화해 볼륨의 `data/backups/` 에 7개까지 백업합니다(Railway 변수 `BACKUP_KEY` 필요). 상태는 `/health` 의 `backup`, 복구는 [DB 백업·복구](docs/DB-백업-복구.md).
- 저장소 설정에서 켜 두면 좋은 것(저장소 관리자만 가능): main 브랜치 보호 규칙에 세 CI 잡을 필수 검사로 지정, Railway 서비스 설정의 "Wait for CI" 켜기.

## 앱 실행 (3단계)

```bash
cd stock-briefing/app
npm install
npx expo start          # QR 을 Expo Go 앱으로 스캔 (iOS/Android)
```

- 사용하는 네이티브 모듈(reanimated, gesture-handler, svg, async-storage, haptics)은 모두 Expo Go 에 포함되어 있어 별도 빌드 없이 Expo Go 로 바로 실행됩니다. 스토어 배포나 푸시 알림(4단계)부터는 `eas build` 개발 빌드가 필요합니다.
- 실기기에서는 앱의 **설정 탭 > 서버 주소** 에 백엔드를 실행한 PC 의 LAN IP(예: `http://192.168.0.10:3000`)를 입력하세요. 같은 Wi-Fi 에 있어야 합니다. 기본값은 iOS 시뮬레이터 `localhost:3000`, Android 에뮬레이터 `10.0.2.2:3000`. 빌드 시점에 `EXPO_PUBLIC_API_URL` 로도 지정할 수 있습니다.
- 확인 명령: `npm run typecheck`, `npm run lint`, `npx expo-doctor`, `npm run export:check`(Metro 번들 생성).

### 화면

| 화면 | 내용 |
|---|---|
| 내 종목 | 자산 요약 카드(총 평가금액·오늘 손익·총 손익, 원화 환산 합계), 정렬 칩(등록순·등락률·평가손익·평가금액·이름·시장), 종목별 현재가(실시간 깜빡임)·등락·평가손익, 길게 눌러 수정·삭제, + 버튼으로 등록 |
| 종목 등록 | 이름/코드/미국 티커 검색(300ms 디바운스, 결과에 현재가·등락률) → 선택 → 수량·평단(선택, 미국은 $) → 등록 |
| 종목 상세 | 시세 헤더(현재가·등락·원화 환산·NXT), 52주 범위 위치 바, 지표 타일(시·고·저·거래량·시총·PER·PBR·EPS·BPS·배당수익률·주당 배당·전일 종가), 일/주/월 캔들 차트(이평선 5·20·60·120, 기간 선택, 과거 이동), 탭: 회사 소개·가치투자·기술적 분석(마크다운, 캐시 표시, 다시 생성)·뉴스/공시(링크), 최근 브리핑 3건. 헤더 연필 아이콘으로 수정/삭제 |
| 브리핑 | 종목별 최신 브리핑, 요약/상세 토글, 오전·오후 즉시 생성 버튼 |
| 브리핑 상세 | 요약/상세 토글, 브리핑 시점 가격·손익, 미확인 데이터, 같은 종목 지난 브리핑 목록(날짜별 이동) |
| 설정 | 표시(미국 주식 원화로 보기, 기본 정렬), 알림 시간, 토스증권 연동, 앱 업데이트, 서버 상태, 고급(서버 주소·토큰, 접힘), 정보 |

### 화면 구성 (증권사 MTS 스타일)

- **테마**: 기본 다크(단색 바탕·얇은 구분선·작은 모서리). 설정 → 표시 → 화면에서 라이트/시스템으로 바꿀 수 있습니다.
- **잔고 탭**: 맨 위 지수 띠(코스피·코스닥·나스닥·S&P500·다우·필라반도체·원/달러·원/100엔·원/위안, 서버 `GET /api/market/indices`, 30초 갱신) → 계좌 평가(총 평가금액·평가손익·수익률·매입금액·당일손익, 국내/해외 구분과 적용 환율) → 보유 표 → 관심 표. 표 머리의 열 이름을 누르면 그 기준으로 정렬되고, 오른쪽 "▾" 로 다른 정렬을 고릅니다.
- **종목 상세**: 등락 색으로 칠한 현재가와 ▲▼ 전일대비 → 차트 → 시세표(시가·고가·저가·전일·거래량·시총·52주·PER·PBR·EPS·BPS·배당) → 잔고표 → 기업개요/가치분석/기술분석/뉴스·공시 탭.
- 가격은 원 단위 없이 호가 표기(국내 196,000 / 미국 44.52), 합계 금액만 "원"을 붙입니다.

### 홈 화면 위젯 (Android)

앱을 설치하면 위젯 목록에 세 가지가 생깁니다(홈 화면 길게 누르기 → 위젯 → 주식 브리핑). `react-native-android-widget` 로 만들었고, 서버 주소·토큰·원화 표시 설정은 앱과 같은 저장소(AsyncStorage)를 읽습니다.

| 위젯 | 크기 | 내용 |
|---|---|---|
| 내 종목 시세 | 4×2 (세로로 늘리면 한 번에 더 보임) | 총 평가금액·당일 손익 + 등록 종목 전체를 스크롤 목록으로(보유는 평가금액 큰 순, 관심은 이름 순). 행마다 현재가·등락률·수익률. 종목을 누르면 상세 화면, ↻ 를 누르면 즉시 새로고침 |
| 오늘의 브리핑 | 4×2 | 가장 최근 브리핑의 3줄 요약. 누르면 브리핑 상세 |
| 총 평가금액 | 2×1 | 총 평가금액과 오늘·총 손익 |

갱신: Android 최소 주기인 30분마다 자동, 앱을 열어 홈 데이터를 받을 때(1분에 한 번), ↻ 클릭 시. 코드: `app/src/widgets/` (위젯 JSX `widgets.tsx`, 데이터 `data.ts`, 이벤트 `widgetTaskHandler.tsx`), 진입점 `app/index.js`, 크기·라벨은 `app.json` 의 `react-native-android-widget` 플러그인.

### 미국 주식 원화 표시

설정 → 표시 → **미국 주식 원화로 보기**를 켜면 서버가 시세와 함께 주는 환율(`quote.fxRate`, 하나은행 고시 1분 갱신)로 가격·등락·평단·평가손익·자산 합계를 원화로 환산해 보여줍니다(토스 연동 시 토스 표시 환율을 먼저 씁니다). 끄면 달러 그대로 보이고 홈 자산 카드에는 원화 종목과 달러 종목이 따로 나옵니다.

### 토스증권 공식 Open API 연결 (실시간 시세 · 수급 · 보유 종목 자동 등록)

토스증권은 2026년 5월부터 공식 Open API(https://developers.tossinvest.com)를 제공합니다. 키를 넣으면 시세·차트·종목 마스터(한국+미국, 한글명)·투자자별 매매동향(수급)·보유 종목 가져오기·**실시간 체결(웹소켓)**이 모두 공식 API 로 동작하고, 키가 없으면 지금처럼 토스 웹 비공식 API → 네이버 → Yahoo 로 동작합니다.

1. **키 발급** — 토스증권 PC 웹(WTS, https://tossinvest.com)에 로그인 → **설정 → Open API** → `client_id` / `client_secret` 발급 (토스 앱 지문 승인). 휴대폰 브라우저는 "데스크톱 사이트 보기"로 열면 됩니다.
2. **허용 IP 등록** — 같은 화면 아래 **허용 IP 관리**에 서버의 공인 IP 를 등록합니다. 앱 **설정 → 토스증권 연동** 카드에 서버 IP 가 표시됩니다(`/health` 의 `tossOpenApi.outboundIp`). 등록되지 않은 IP 의 호출은 403 으로 차단됩니다.
   - Railway Hobby 플랜은 서버 IP 가 재배포·재시작 때 바뀔 수 있습니다. 바뀌면 앱 카드에 "IP 차단됨"이 뜨고 새 IP 가 보이니 다시 등록하면 됩니다. 고정 IP 가 필요하면 Railway Pro(Static Outbound IP) 또는 고정 IP 를 주는 VPS/Oracle Cloud 무료 VM 으로 옮기면 됩니다.
3. **서버 변수** — Railway → Variables 에 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET` 추가 → 자동 재배포. 기동 시 종목 마스터가 토스(한국+미국 약 1만 종목)로 바뀝니다.
4. 키가 들어가면 **보유 종목이 자동으로 맞춰집니다**: 서버 시작 15초 뒤, 장중(한국·미국 중 하나라도 거래 시간)에는 `TOSS_SYNC_MINUTES`(기본 10분)마다, 장 밖에는 1시간마다, 정기 브리핑 직전에 토스 계좌를 읽어 수량·평단을 갱신하고 새로 산 종목은 등록합니다(여러 계좌는 합산). 전량 매도한 종목은 지우지 않고 수량·평단만 비워 관심 종목으로 남깁니다. 토스에서 가져온 적 없는 등록 종목(다른 증권사 보유·관심 종목)은 건드리지 않습니다. 앱 **설정 → 토스증권 연동** 카드에서 마지막 동기화 시각·변경 수를 보고, **토스증권 보유 종목 가져오기**로 즉시 맞출 수 있습니다.

실시간: 앱은 켜져 있는 동안 서버의 웹소켓 `/api/stream` 에 붙어 있고(Authorization 헤더 또는 `?token=`, 서버 요청 로그에는 token 값을 가려 남깁니다), 서버는 토스 Open API 웹소켓 체결을 받는 즉시 앱으로 밀어 줍니다. 앱은 체결가로 등락·원화 환산·평가손익을 바로 다시 계산해 화면이 폴링 없이 즉시 바뀝니다(홈 카드에 "실시간 스트리밍"). 키가 없으면 서버가 앱이 붙어 있는 동안만 토스 웹에서 등록 종목 전체 현재가를 3초마다 요청 1개로 읽어 바뀐 값만 보냅니다. 스트림이 끊기면 앱은 1초→30초 간격으로 다시 붙고, 그동안은 예전처럼 3초 폴링으로 동작합니다(스트림 연결 중에는 30초 보정 폴링, 장 밖 1분, 앱이 뒤로 가면 소켓을 닫음). 가격이 바뀌면 오르면 빨강, 내리면 파랑으로 잠깐 깜빡입니다. 토스 Open API 키가 있으면 웹소켓 체결(`trade:kr`, `trade:us`)이 1순위로 덮어씁니다. 현재가 옆의 초록 점이 실시간 값이라는 표시입니다. 토큰은 클라이언트당 1개만 유효하므로 **같은 키를 다른 프로그램(챗GPT·클로드 연동 등)에 동시에 쓰면 서로 토큰을 무효화합니다** — 이 서버 전용 키를 쓰세요. 데이터는 토스증권 약관상 본인 매매 목적에 한해 쓸 수 있고 제3자 배포는 금지입니다.

### 토스 잔고와 같은 숫자 (잔고 일치)

토스 공식 Open API 로 받을 수 있는 값은 모두 토스와 같은 기준으로 씁니다.

- **평가금액·평가손익**: 토스 앱처럼 매도 시 예상 수수료·세금을 뺀 값입니다(설정 → 표시 → 수수료·세금 차감 평가, 기본 켬). 동기화 때마다 종목별 `amountAfterCost / amount` 비율과 매입금액을 저장해 두고(`meta.toss_holdings_detail`), 실시간 가격에 그대로 곱합니다.
- **원화 환산 평가금액**: 토스가 원화 표시에 쓰는 환율(토스 웹 시세의 `closeKrw / close`)을 씁니다.
- **해외 종목 원화 손익**: 토스 앱은 매수 당시 환율로 잡은 원화 매입금액 기준입니다(환차손익 포함). 공식 API 는 종목별 원화 매입금액을 주지 않아 `KrwCostBook`(`backend/src/services/krwCostBook.ts`)이 따로 관리합니다.
  - **exact**: 토스 앱 원화 보기의 "평가금액 − 평가손익"을 종목 편집 화면의 "원화 매입금액"에 넣은 값(또는 `PUT /api/admin/toss/krw-cost`). 이후 매도만 있으면 이동평균이라 비율대로 줄어 계속 정확합니다.
  - **estimated**: 추가 매수분은 주문 내역(`GET /api/v1/orders`, 종료 주문 + 일부 체결된 진행 중 주문)의 체결 시각에 토스 환율(`GET /api/v1/exchange-rate?dateTime=`)을 곱해 이어 붙입니다. 주문별로 이미 반영한 체결 수량·금액을 기억해 차이만 더하므로 부분 체결도 두 번 세지 않습니다. 계좌 전체 수익률(`profitLoss.rateAfterCost`)은 토스 내부 원화 매입금액 기준이라(실측 확인), 계좌가 하나면 동기화할 때마다 계좌 전체 원화 매입금액 구간을 좁혀 estimated 몫만 그 합계에 맞춥니다(exact 몫은 그대로). 화면에는 "추정"으로 표시됩니다.
  - 장부는 (계좌, 종목) 별입니다. 일시적인 조회 실패(429·네트워크·5xx)는 기존 값을 그대로 두고 다음 동기화에서 몇 번이든 다시 시도합니다. 주문 내역이 보유 달러 매입금액을 설명하지 못하거나(주문 목록 지연, 이관 입고, 체결 순서가 엇갈린 주문) 그 시점 환율이 토스에 아예 없으면(404, 조금 앞 시각들도 찾아본 뒤) 기다렸다가, 20분 넘게 계속되면 가진 값으로 보유에 맞추고 "추정"으로 표시합니다(없는 환율·모자란 달러 매입금액은 표시 환율로, 남는 매입금액은 비율대로 줄임). 계좌 목록이나 보유 응답이 통째로 비면 일시 오류로 보고 아무것도 지우지 않고, 다른 계좌는 보이는데 하루 넘게 목록에서 빠진 계좌의 항목만 지웁니다. 장부가 보유 전부와 맞을 때만 계좌 합계 보정을 합니다. 장부가 새 체결을 따라오기 전에는 늘어난 매입분만 현재 환율로 더해 보여 줍니다. `GET /api/admin/toss/krw-cost` 로 종목별 값·출처·보정 비율을 볼 수 있습니다.
  - 원화 매입금액 입력은 서버가 토스에서 보유 → 주문 → 보유를 다시 읽어, 그 사이 체결이 없고 주문 내역이 보유를 설명하는(또는 20분 넘게 설명되지 않은 이관 등) 종목만 저장합니다. 못 하면 이유와 다시 해볼 시각을 돌려주고 앱이 그대로 보여 줍니다. 여러 계좌에 나눠 있는 종목은 계좌별 값을 알 수 없어 추정으로 둡니다.
- **즉시 반영**: 공식 웹소켓 `personal:order` 를 구독해 토스 앱에서 체결되면 3초 뒤 잔고를 다시 맞추고 앱에 바로 알립니다. 동기화 도중 체결이 오면 끝난 뒤 한 번 더, 웹소켓이 끊겼다 다시 붙으면 그사이 체결을 위해 한 번 더 맞춥니다(10분 주기 동기화는 그대로 백업, `TOSS_SYNC_MINUTES=0` 이면 둘 다 꺼짐).
- 한계: 토스가 달러 예수금(미리 환전해 둔 달러)으로 산 경우의 원화 매입금액 규칙은 API 로 알 수 없어, 새 매수분은 추정이 됩니다. 정확히 맞추려면 그 종목의 원화 매입금액을 한 번 입력하면 됩니다.

### 발견 탭 (순위·테마)

잔고와 브리핑 사이의 **발견** 탭입니다. 위에서 한국주식/미국주식을 고르고, 거래대금·거래량·급상승·급하락·테마 중 하나를 고릅니다.

- **순위**: 50개씩 보여 주고 끝까지 내리면 더 받습니다. 누르면 종목 상세(등록하지 않은 종목은 미리 보기와 "관심 추가"), 길게 누르면 관심 종목에 추가합니다. 보유·관심 종목과 상장 첫날 종목에는 표시가 붙습니다.
- **제외 기준**: 모든 순위에서 ETF·ETN·스팩을 뺍니다. 미국은 우선주(GOOGM 같은 5글자 티커 포함)·거래소 상장 채권·권리·워런트·스팩 유닛도 뺍니다(MLP 지분 "… Units"는 남깁니다. 폐쇄형 펀드와 이름이 "Acquisition Corp"가 아닌 스팩 보통주는 남을 수 있습니다).
- **급상승·급하락**: 당일 등락률 순위에서 거래대금이 한국 10억 원, 미국 100만 달러보다 적은 종목은 뺍니다. 한국은 가격제한폭(±30%)을 넘는데 상장 첫날이 아닌 종목(정리매매·기준가 변경)도 뺍니다. 거래량·거래대금 순위에는 이런 종목이 그대로 나옵니다.
- **기준 표시**: 순위 값은 한국 KRX 시세(NXT 통합 아님), 미국 정규장 시세입니다. 종목 상세는 KRX+NXT 통합·시간외 체결을 보여 줄 수 있어 목록과 숫자가 다를 수 있습니다. 미국 원화 환산 환율은 토스 표시 환율(없으면 네이버·하나은행)입니다.
- **테마**: 테마/업종, 기간(오늘·1주·1개월), 목록/히트맵(등락률 색 타일), 상승률순/하락률순을 고릅니다. 맨 위에 오른 테마와 내린 테마의 비율 막대, 가장 강한·약한 테마가 나옵니다. 테마를 누르면 테마 등락률 요약과 구성 종목(등락률순)이 나옵니다.
- **자동 갱신과 상태 줄**: 값이 바뀌는 시간이면 30초마다 새로 받고 값이 바뀌면 깜빡입니다. 목록 위 상태 줄은 다음과 같습니다.
  - 한국: 정규장(09:00~15:30) "장중", 15:30~20:00 "시간외 거래 반영 중"(시간외 거래로 값이 계속 바뀜), 08:00~09:00 "장 시작 전 · 직전 거래일 기준", 그 밖·휴장일 "장 마감 · 마지막 거래 기준"
  - 미국: 정규장(뉴욕 09:30~16:00) "장중", 그 밖(프리·애프터 포함) "장 마감 · 직전 정규장 기준". 1주·1개월 테마를 정규장 값 없이 지금 값으로 보여 줄 때는 "장외 시간 · 현재가 기준"

| 항목 | 출처 | 기준 |
|---|---|---|
| 한국 순위 | 네이버 증권 `front-api/domestic/stock/list/sorted` | 네이버 순위 값(가격·거래량·거래대금 모두 KRX 시장 값, NXT 통합 값은 쓰지 않음) |
| 미국 순위 | 네이버 증권 `api.stock.naver.com/stock/nation/USA/*` | 정규장 값 (프리·애프터 제외), 보통주·ADR·MLP 지분 중심 |
| 한국 테마·업종 | 네이버 증권 `stock/sectors/all` (테마 264개, 업종 79개) | 네이버 등락률 — 테마는 구성 종목 단순 평균(거래정지 제외), 업종은 시가총액 가중 평균(실측 확인). 오늘 값은 상장 첫날 종목이 대표 종목에 들면 그 종목을 빼고 같은 방식(테마 단순 평균, 업종 현재 시가총액 가중)으로 다시 셉니다 |
| 미국 테마 | 토스증권 테마 분류(구성 종목) + 네이버 정규장 시세 | 오늘: 테마별 시가총액 상위 30종목의 전일 시가총액 가중 평균(단순 평균도 함께). 1주·1개월: 토스증권 미국 종목 기준 테마 등락률 |
| 미국 업종 | 네이버 증권 산업 분류(TRBC 137개) | 네이버 등락률(구성 종목 시가총액 가중 평균) |

- 서버 캐시: 값이 바뀌는 시간 30초(1주·1개월은 2~15분), 그 밖 5분~1시간. 조회가 실패하거나 2.5초 넘게 걸리면 직전 값을 줍니다(출처 요청은 10초에서 끊고, 시간 초과는 다시 부르지 않음). 장 상태·환율은 2~2.5초만 기다리고 추정값으로 대신합니다.
- 순위 "더 보기"(2쪽~)는 첫 쪽이 받은 목록에서 이어 줍니다(쪽마다 목록이 바뀌어 종목이 빠지거나 두 번 나오지 않게). 새 목록은 첫 쪽을 받을 때(당겨서 새로고침·자동 갱신) 받습니다. 출처 목록을 이어 받을 때는 바로 앞 쪽을 겹쳐 받아, 그 사이 순위가 올라온 종목이 쪽 경계에서 빠지지 않게 합니다.
- 앱 자동 갱신은 앞쪽 3쪽까지 볼 때만 합니다. 더 깊이 내리면 멈추고(당겨서 새로고침은 그대로), 다른 목록으로 옮기면 첫 쪽만 남깁니다.
- 장이 닫힌 직후에는 마감 전에 받은 목록·테마를 캐시 시간과 상관없이 새로 받아 최종 값과 마감 기준 시각을 보여 줍니다.
- 출처 초기화: 네이버는 미국 값을 뉴욕 03:40~04:00(한국 16:40~17:00, 겨울 17:40~18:00) 약 20분 비우고(순위 빈 목록, 시세 0%), 04:00 프리마켓부터 직전 정규장 값으로 되돌립니다(2026-09-23 실측). 한국은 장 시작 전 0% 목록을 줍니다. 그래서 값이 있을 때 DB `meta` 표에 저장본을 남기고(값이 바뀌었을 때만, 10분에 한 번), 초기화된 시간에는 그 저장본을 "직전 목록"으로 보여 줍니다(서버를 다시 켜도 유지, 14일 지나면 버림). 초기화는 줄의 90% 이상이 0%·거래량 0인지로 알아봅니다.
- 장 상태: 값과 같은 출처인 네이버 거래소 장 상태(`front-api/marketStatus`, 한국 KRX·미국 나스닥)를 씁니다. 휴장일, 수능일 10:00 개장 같은 특수일, 미국 조기 폐장이 그대로 반영되고, 세션 경계(09:00·09:30 ET 등)를 지나면 바로 다시 확인합니다. 못 받으면 마지막으로 받은 세션이 아직 유효한 동안 그것을 쓰고, 그다음은 토스 달력, 요일·시각 추정 순서로 대신합니다.
- 기준 시각: 한국은 장중·시간외에는 받은 시각, 장 마감·휴장일에는 실제 마지막 거래 마감(예: 추석 연휴 동안 9/23 20:00)입니다. 장 시작 전(08:00~09:00)에는 출처가 직전 마감을 알려 주지 않아, 마감 뒤에 본 값을 기억해 두었다가 씁니다(DB `meta` 표에도 저장). 기억이 없으면 틀린 날짜 대신 시각을 적지 않습니다. 미국은 출처의 체결 시각(정규장 끝 16:00 ET, 조기 폐장일 13:00)입니다.
- "더 보기" 목록 판: 순위 응답의 `ver`를 다음 쪽 요청(`&v=`)에 돌려주면, 그 사이 서버가 새 목록을 받았어도 같은 목록에서 이어 줍니다(최근 5판까지. 그보다 오래된 판이면 지금 목록으로 이어 주고 앱이 코드로 중복을 거릅니다).
- 테마·업종 상세의 상승·보합·하락 수는 목록(출처)과 같은 기준입니다(거래정지 제외 — 거래정지는 출처의 거래 가능 상태로 판정하고, 거래 없는 코넥스 종목은 보합으로 셉니다. 거래정지 종목에는 "거래정지" 표시가 붙습니다). 구성 종목은 등락률 상위 300개까지 받으므로, 그보다 많은 업종은 "등락률 상위 300종목만" 안내가 붙습니다.
- 미국 테마 1주·1개월은 토스 값이 그때의 현재가 기준이라, 미국 정규장 중에 받은 값(평일 뉴욕 12:50·15:50에도 받아 둠 — 조기 폐장일은 12:50 값)을 남겨 두고 장 밖에서는 가장 최근 정규장의 값만 씁니다. 그 값이 없거나 며칠 지났으면 지금 값을 받아 "장외 시간 · 현재가 기준"으로 밝힙니다.
- 테마 구성은 따로 관리할 필요가 없습니다. 한국은 볼 때마다 네이버에서 받고, 미국은 매일 21:00(한국 시간, 미국 정규장 전)에 토스 테마 분류로 새로 만들어(약 1분, 토스 약 500회 호출) DB `meta` 표에 저장합니다. 새 테마·새로 편입된 종목은 하루 안에 반영되고, 화면 아래에 "테마 구성 갱신" 시각이 나옵니다. 정기 갱신이 실패하면 옛 구성을 그대로 쓰고, 하루가 넘으면 다음 조회 때 다시 만듭니다. 토스가 일부만 답해 테마 수가 이전의 80% 밑으로 줄면 한 번은 거르고, 다음에도 비슷한 크기면 실제로 줄어든 것으로 보고 받아들입니다. 서버를 처음 켠 직후 1분 동안은 산업 분류로 대신 보여 줍니다.
- 한계: 토스 테마 화면의 미국 등락률은 한국 낮에 주간거래 가격이 섞여 이 앱의 값(정규장)과 다를 수 있습니다. 미국 테마의 1주·1개월 값은 토스 값이라 같은 이유로 조금 다를 수 있습니다. 토스·네이버 웹 JSON은 공식 API가 아니어서 예고 없이 바뀔 수 있습니다(로그인·쿠키는 쓰지 않습니다).

### 지수·환율 차트

홈 상단 지수 띠의 항목을 누르면 그 지수·환율 차트 화면(`/market/[code]`)이 열립니다. 종목 차트와 같은 차트(분·일·주·월, 이동평균·볼린저·RSI/MACD, 확대·십자선)를 쓰고, 값은 지수 포인트·원 단위로 소수 둘째 자리까지 보입니다. 화면 위 띠에서 다른 항목을 누르면 그 자리에서 바뀝니다.

- 서버: `GET /api/market/indices/:code/candles?period=1m|5m|30m|D|W|M&count=` (코드: KOSPI, KOSDAQ, NASDAQ, SPX, DJI, SOX, USDKRW, JPYKRW, CNYKRW). 네이버 증권 차트 JSON, 분봉 30초·일/주/월봉 10분 캐시, 조회 실패 시 직전 값.
- 국내 지수: 1·5·30분봉과 일·주·월봉 모두 네이버 기간 조회(시·고·저·종·거래량).
- 해외 지수: 일·주·월봉은 기간 조회, 분봉은 직전·당일 정규장 1분 시세(종가만)로 만든다. 시각은 뉴욕 현지.
- 환율(하나은행 매매기준율, 엔은 100엔 기준): 분봉은 당일 고시 회차, 일봉은 1년 일별 종가, 주·월봉은 5·10년 주별 종가·고저(시가는 직전 종가). 거래량은 없어 숨깁니다.

### 차트

직접 그리는 캔들 차트(react-native-svg)입니다.

- **기간**: 1분·5분·30분봉(토스 소스 필요, 서버 `period=1m|5m|30m`)과 일·주·월봉. 일봉은 약 3년(800봉), 주봉 5년, 월봉 10년, 1분봉 600개(약 1.5일), 5분봉 400개, 30분봉 300개를 받아 둡니다.
- **조작**: 한 손가락 드래그로 과거/최신 이동, 두 손가락 핀치로 확대·축소(최신 봉 고정), 길게 누른 뒤 드래그로 십자선(시·고·저·종·거래량·등락·이평 값). 칩(60일/120일/250일 등)과 ◀ ▶ 버튼도 그대로 있습니다.
- **축·거래량**: 오른쪽 가격 눈금, 아래 날짜(분봉은 시각) 눈금, 캔들 아래 거래량 막대.
- **기준선**: 내 평단(금색 점선, 범위 밖이면 ▲/▼ 태그), 현재가(등락 색 태그, 실시간 체결로 움직임), 52주 고가/저가(점선).
- **오버레이·지표**: 이동평균 5·10·20·60·120·200 중 선택, 볼린저 밴드(20, 2σ), RSI(14) 또는 MACD(12,26,9) 보조 pane. 선택은 기기에 기억됩니다.
- **실시간**: 스트림 체결이 오면 마지막 봉의 고·저·종이 즉시 바뀌고, 분봉은 구간이 넘어가면 새 봉이 붙습니다.
- **전체 화면**: 차트 오른쪽 위 확대 버튼 → 전체 화면. 앱은 세로 고정이라 "가로" 버튼을 누르면 화면을 90도 돌려 넓게 그립니다.
- 미국 주식은 십자선·축에서 소수점 둘째 자리까지 표시합니다.

### 토스·네이버 앱과 종가가 다르게 보일 때

장 마감 후 토스 앱에 보이는 가격은 **KRX 정규장 + 넥스트레이드(NXT) 애프터마켓**(15:40~20:00)을 합친 "통합" 가격입니다. 이 앱은 시세 1순위가 토스증권이라 평소에는 토스와 같은 숫자가 나오고, 종목 상세의 소스 표시에 "TOSS KRX+NXT 통합"이 붙습니다. 토스 API 가 응답하지 않아 네이버 증권으로 넘어간 경우에는 "NAVER KRX 정규장"으로 바뀌며 정규장 종가 아래 "NXT 야간 …" 한 줄이 따로 보입니다. 브리핑에도 어느 기준인지(`quote.priceBasis`) 같이 전달됩니다.

### 앱 업데이트

설정 탭 맨 아래 **앱 업데이트** 카드에서 **업데이트 확인**을 누르면 두 가지를 순서대로 확인합니다.

1. **새 APK** — 저장소의 `stock-briefing/release.json` 을 읽어 `version` 이 현재 앱보다 높고 `apkUrl` 이 있으면 "새 버전 설치" 버튼이 나옵니다. 누르면 APK 를 내려받아 기존 앱 위에 덮어씌워 설치되고, 등록 종목·설정은 유지됩니다. 네이티브 모듈이 바뀌거나 `app.json` 의 `version` 을 올렸을 때 이 경로를 씁니다.
2. **OTA (EAS Update)** — 화면·기능(JS)만 바뀐 경우. 내려받은 뒤 "지금 다시 시작"으로 바로 적용됩니다. 앱을 켤 때도 자동으로 확인해 다음 실행 때 적용됩니다(`updates.checkAutomatically: ON_LOAD`).

배포하는 쪽 절차:

```bash
cd stock-briefing/app
# (a) JS 만 바뀜 → OTA. 같은 runtimeVersion(= app.json version) 의 설치 앱에 즉시 배포
npx eas-cli update --channel preview --environment preview --message "설명"
# (b) 네이티브/버전 변경 → app.json 과 package.json 의 version 을 올리고 APK 빌드
npx eas-cli build --platform android --profile preview --non-interactive
# 빌드가 끝나면 APK 링크를 stock-briefing/release.json 의 apkUrl 에, version 도 같이 적어 main 에 커밋
```

`release.json` 은 GitHub raw 주소로 읽으므로 저장소가 공개여야 합니다(비공개로 바꾸면 `app/src/lib/appUpdate.ts` 의 `RELEASE_URL` 을 다른 곳으로 옮기세요).

모든 화면 하단에 "투자 판단의 책임은 본인에게 있으며 투자 권유가 아님" 고지가 고정됩니다. 라이트/다크 모드는 기기 설정을 따릅니다.

## 푸시 알림 (4단계, Android)

동작 방식은 두 가지이고, 앱 **설정 → 알림 → 이 기기에서 알림 받기**를 켜면 가능한 쪽이 자동으로 선택됩니다.

| 방식 | 조건 | 도착 시각 |
|---|---|---|
| 즉시 푸시 (FCM) | Firebase 연결 + FCM V1 키 업로드 + 재빌드 | 브리핑 생성 즉시 |
| 백그라운드 확인 | 없음 (기본) | 생성 후 15~30분 안에 (Android WorkManager 가 앱을 깨워 서버를 확인, 새 브리핑이면 로컬 알림). 배터리 절약 모드에서는 더 늦을 수 있고, 앱을 "강제 종료"하면 다음 실행까지 멈춥니다 |

백그라운드 확인 태스크(`app/src/lib/backgroundBriefings.ts`)는 위젯 갱신도 겸하므로 알림을 끄더라도 30분 간격으로 등록됩니다.

즉시 푸시로 바꾸려면 Firebase 를 한 번 연결해야 합니다.

동작 방식: 브리핑이 생성되면 서버가 등록된 모든 기기에 Expo Push Service 로 요약 3줄을 보냅니다(제목 "SK하이닉스 오전 브리핑"). 알림을 누르면 해당 브리핑 상세로 이동합니다. 알림 시간(= 브리핑 생성 시간)은 앱 설정에서 바꾸며 서버 DB 에 저장되어 재시작 후에도 유지됩니다. 전송 15분 뒤 영수증을 확인해 앱이 삭제된 기기(`DeviceNotRegistered`)는 자동으로 비활성화합니다.

Android 원격 푸시는 **Expo Go 에서 동작하지 않으므로** 개발 빌드가 필요합니다. 한 번만 하면 됩니다.

1. **EAS 프로젝트 만들기** (Expo 계정 필요, 무료)
   ```bash
   cd stock-briefing/app
   npm install -g eas-cli && eas login
   eas init            # app.json 에 extra.eas.projectId 가 추가됨 → 커밋
   ```
2. **Firebase(FCM) 연결**
   - https://console.firebase.google.com 에서 프로젝트 생성 → Android 앱 추가, 패키지명 `com.stockbriefing.app`
   - `google-services.json` 을 내려받아 `stock-briefing/app/google-services.json` 에 두고 `app.json` 의 `android.googleServicesFile` 을 `"./google-services.json"` 으로 설정 (이 파일은 .gitignore 에 있음)
   - Firebase **프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성** 으로 JSON 키를 받은 뒤
     `eas credentials` → `Android` → `production` → `Google Service Account` → `Manage your Google Service Account Key for Push Notifications (FCM V1)` → 업로드
3. **개발 빌드 설치**
   ```bash
   eas build --profile development --platform android   # 클라우드 빌드, APK 링크가 나옴
   ```
   휴대폰에서 APK 설치 후 `npx expo start --dev-client` 로 개발 서버에 연결합니다.
4. 앱 **설정 탭 > 알림 > "이 기기에서 알림 받기"** 를 켜고 "테스트 알림 보내기"로 확인합니다.

배포용 APK 는 `eas build --profile preview --platform android` (eas.json 의 `EXPO_PUBLIC_API_URL` 을 서버 주소로 바꿔 두세요).

주의: 서버가 휴대폰에서 접근 가능해야 알림 시간에 앱이 꺼져 있어도 브리핑이 생성됩니다(브리핑은 서버가 만들고 푸시만 보냄). 집 PC 에서 돌린다면 PC 가 켜져 있어야 하고, 외부에서 앱을 쓰려면 서버를 클라우드(예: Fly.io, Railway)에 올리거나 Tailscale 같은 VPN 을 쓰세요.

## 브리핑 파이프라인 (2단계)

```
스케줄러(08:30 / 16:00 KST, 평일) ─▶ BriefingService.runSession(session)
   └ 등록 종목마다 순차:
       DataCollector.collectBriefing  ─ 현재가, 일봉 160개 → 기술적 지표, 뉴스 8건, 공시 7일, 수급 10일
                                        (각 항목 독립 시도, 실패 → missing[] 에 기록)
       prompts/briefing_detail.md     ─ 시스템(캐시) + 사용자(데이터 JSON) → Claude → 상세 마크다운
       prompts/briefing_summary.md    ─ 상세를 3줄 요약 (알림 본문)
       briefings 테이블 upsert (code, date, session 유일) → 리스너 호출 (4단계 푸시가 여기 붙음)
```

- 같은 날 같은 세션이 이미 성공했으면 건너뜁니다(`force: true` 로 재생성). 실패 건은 다음 실행에서 자동 재시도.
- **휴장일**: 토스 시세의 `tradingEnd`/`nextTradingStart`(대표 종목 삼성전자·애플)로 한국·미국 달력을 판단해(`providers/market/calendar.ts`, 5분 캐시) 휴장일에는 그 시장의 종목을 `skipped` 로 건너뜁니다. 앱은 `GET /api/market/status` 로 같은 판단을 받아 "실시간 / 장 마감 / 휴장" 배지와 갱신 주기를 정합니다.
- **직전 브리핑 반영**: 상세 프롬프트에 직전 브리핑 요약이 들어가 "달라진 점" 위주로 쓰고 같은 문장을 반복하지 않게 합니다. 뉴스는 네이버 **종목 뉴스**(종목 페이지에 붙는 기사, 한국·미국 모두)를 먼저 쓰고 부족하면 이름 검색으로 채웁니다.
- **미국 종목 재무·공시**: SEC EDGAR(`providers/dart/edgar.ts`, 키 불필요)에서 10-K 연간 재무제표(매출·영업이익·순이익·자산·부채·자본)와 최근 공시(8-K, 10-Q, 10-K, Form 4 등)를 받아 DART 와 같은 형식으로 넣습니다. SEC 는 초당 10회 제한이라 6시간 캐시. 배당 이력은 네이버 보강의 배당수익률로 대신합니다.
- **상태 확인**: `/health` 의 `lastBriefing`(마지막 실행의 성공/실패/건너뜀 수와 마지막 오류)과 `llmConfigured` 를 앱 브리핑 탭 상단 배너로 보여줍니다. Anthropic 크레딧 부족·키 오류·서버 장애는 사람이 읽을 수 있는 문장으로 분류됩니다.
- 모델: Anthropic 직접이면 `ANTHROPIC_MODEL`(기본 `claude-opus-5`, 서버측 refusal fallback 활성), Bedrock 이면 `BEDROCK_MODEL`(기본 `anthropic.claude-opus-4-8`, 도쿄 리전). 시스템 프롬프트는 1시간 프롬프트 캐싱. 상세는 effort medium, 요약은 low, 회사/가치 분석은 high.
- 종목 상세 탭 분석은 요청 시 생성 후 캐시(회사 30일, 가치 7일, 기술 1일). `?refresh=1` 로 강제 재생성.
- 공휴일에는 시장 달력으로 건너뜁니다(위 참고).

## 배포 (6단계)

브리핑은 서버가 만들고 푸시만 보내므로, 알림 시간에 서버가 켜져 있어야 합니다. 세 가지 방법 중 하나를 고르세요.

### 공통: 보안 설정

서버를 인터넷에 노출한다면 `.env` 에 `API_TOKEN` 을 반드시 설정하고(예: `openssl rand -hex 24`), 앱 **설정 탭 > 서버 주소 아래 토큰 칸**에 같은 값을 넣습니다. 설정하면 `/api/*` 전체가 `Authorization: Bearer <토큰>` 을 요구합니다(경로를 퍼센트 인코딩해도 라우터가 고른 경로로 판단합니다). `/health` 는 열려 있지만 토큰이 없거나 틀리면 `ok`·시각·고지 문구와 `limited: true`(빈 `sources`)만 주고, 상세(구독 종목·서버 IP·출처 구성)는 올바른 토큰을 보낸 요청에만 줍니다. 앱은 늘 토큰을 보내므로 그대로 동작하고, 토큰이 없거나 틀리면 설정 탭에 "토큰 필요"가 뜹니다. 로컬 Wi-Fi 안에서만 쓸 때는 비워 두어도 됩니다.

### A. 집 PC / NAS 에서 Docker 로 (가장 간단)

```bash
cd stock-briefing/backend
cp .env.example .env        # 키와 API_TOKEN 입력
docker compose up -d        # http://<PC IP>:3000, 데이터는 ./data, 프롬프트는 ./prompts 를 그대로 마운트
```

외부에서도 앱을 쓰려면 공유기 포트포워딩 대신 Tailscale 같은 VPN 을 권장합니다.

### B. Fly.io (도쿄 리전, 월 수천 원 수준)

```bash
cd stock-briefing/backend
fly launch --copy-config --no-deploy     # fly.toml 사용, 앱 이름만 바꾸면 됨
fly volumes create data --size 1 --region nrt
fly secrets set ANTHROPIC_API_KEY=... API_TOKEN=... KIS_APP_KEY=... KIS_APP_SECRET=... DART_API_KEY=...
fly deploy
```

`auto_stop_machines = false` 로 두어야 스케줄러가 멈추지 않습니다. SQLite 파일은 볼륨에 남습니다.

### C. Railway / Render 등 (Postgres 사용)

Dockerfile 을 자동 인식합니다. Postgres 를 붙이면 `DATABASE_URL` 에 `postgres://...` 를 넣기만 하면 되고, 스키마는 기동 시 자동 생성됩니다(SQLite 와 같은 마이그레이션, id 컬럼만 identity 로 생성). localhost 가 아닌 주소는 SSL 을 자동으로 켭니다. Postgres 통합 테스트: `TEST_PG_URL=postgres://user:pass@host:5432/db npm test`.

배포 후 앱 설정에서 서버 주소를 `https://<앱>.fly.dev` 처럼 바꾸고 토큰을 입력하면 됩니다. 배포용 APK 를 만들 때는 `app/eas.json` 의 `preview` 프로필 `EXPO_PUBLIC_API_URL` 에 서버 주소를 넣어 두면 기본값으로 들어갑니다.

## 휴대폰만으로 운영하기 (PC 없이)

PC 명령 없이 웹 화면만으로 서버 배포, 앱 설치, 푸시 설정까지 할 수 있습니다. 필요한 계정: GitHub(있음), Anthropic, Railway, Expo, Firebase. 전부 휴대폰 브라우저에서 됩니다.

### 0. 브리핑 모델 키: Anthropic 또는 Amazon Bedrock (약 10~20분)

둘 중 하나만 있으면 됩니다. 한국 카드로 Anthropic 결제가 안 되면 Bedrock 을 쓰세요. 같은 Claude 모델이고 프롬프트·코드는 그대로입니다.

**A. Anthropic 직접** — https://console.anthropic.com 가입 → 결제 등록·크레딧 충전 → API Keys → Create Key. 서버 변수 `ANTHROPIC_API_KEY`.

**B. Amazon Bedrock** (휴대폰 브라우저 기준)
1. https://aws.amazon.com 에서 AWS 계정 만들기 (이메일, 카드, 휴대폰 인증). 카드 확인용으로 1달러가 잠깐 결제됐다 취소됩니다.
2. AWS 콘솔 상단 검색창에 `Bedrock` → Amazon Bedrock 열기. 오른쪽 위 리전을 **아시아 태평양(도쿄) ap-northeast-1** 로 바꿉니다.
3. 왼쪽 메뉴 **Model access** (모델 액세스) → Claude 모델들이 "Available"(사용 가능) 인지 확인. 필요하면 **Modify model access** 로 Anthropic 모델을 체크하고 저장(회사명·용도 입력란은 개인용으로 짧게 적으면 됩니다).
4. 왼쪽 메뉴 **API keys** → **Generate long-term API key** (장기 API 키 생성) → 만료 기간 선택 → 생성된 키 복사(`ABSK...` 형태, 한 번만 표시). 서버 변수 `AWS_BEARER_TOKEN_BEDROCK` 에 넣습니다.
5. 리전을 도쿄가 아닌 곳으로 했다면 `AWS_REGION` 도 같이 넣습니다. 모델은 기본 `anthropic.claude-opus-4-8` 이고, 더 싸게 쓰려면 `BEDROCK_MODEL=anthropic.claude-sonnet-5`.

호출 시 403 이 나면: 3번 모델 액세스가 안 됐거나, 키에 붙은 IAM 정책에 `bedrock-mantle:CreateInference` 가 없는 경우입니다. IAM → 사용자 → 키 생성 때 만들어진 사용자 → 권한 추가 → 인라인 정책에 아래를 넣으세요.
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": ["bedrock-mantle:*", "bedrock:*"], "Resource": "*" }] }
```
요금은 후불(사용한 만큼 월말 청구)이며 Anthropic 직접 요금과 같습니다.

### 1. 서버: Railway (약 15분)

1. https://railway.app 에 GitHub 로 로그인 → **New Project → Deploy from GitHub repo** → 이 저장소 선택 → 브랜치 `claude/stock-analysis-alert-app-g3zrxd`.
2. 서비스 **Settings → Root Directory** 를 `stock-briefing/backend` 로 지정 (Dockerfile 을 자동 인식).
3. **Variables** 에 추가: `ANTHROPIC_API_KEY` 또는 `AWS_BEARER_TOKEN_BEDROCK`(+ 필요 시 `AWS_REGION`), `API_TOKEN`(아무 긴 문자열), 있으면 `KIS_APP_KEY` `KIS_APP_SECRET` `DART_API_KEY` `NAVER_CLIENT_ID` `NAVER_CLIENT_SECRET`.
4. 데이터 보존: 프로젝트에 **+ New → Database → PostgreSQL** 추가 후 백엔드 Variables 에 `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` 추가. (SQLite 로 두려면 대신 **Volume** 을 `/app/data` 에 마운트.)
5. **Settings → Networking → Generate Domain** 으로 주소를 받습니다(예: `https://xxx.up.railway.app`). 브라우저에서 `https://xxx.up.railway.app/health` 가 열리면 완료.

Railway Hobby 요금(월 5달러, 사용량 포함)이 듭니다. 무료 체험이 끝나면 결제 등록이 필요합니다.

### 2. 앱: Expo 대시보드에서 APK 빌드 (약 20분, 빌드 대기 포함)

1. https://expo.dev 가입 → **Create a project** (이름 `stock-briefing`) → 프로젝트 **ID** 를 복사해 Claude 에게 보내면 `app.json` 에 넣어 커밋합니다. (또는 대시보드 **Environment variables** 에 `EAS_PROJECT_ID` 로 넣어도 됩니다.)
2. 프로젝트 **Settings → GitHub** 에서 저장소를 연결하고 **Base directory** 를 `stock-briefing/app` 으로 지정.
3. **Environment variables** 에 `EXPO_PUBLIC_API_URL` = Railway 주소, `EXPO_PUBLIC_API_TOKEN` = API_TOKEN 값 을 추가 (앱 설정 화면에서 나중에 바꿀 수도 있습니다).
4. **Builds → Build from GitHub** → 브랜치 선택, 플랫폼 Android, 프로필 `preview` → 완료되면 APK 다운로드 링크가 나옵니다. 휴대폰에서 열어 설치("출처를 알 수 없는 앱" 허용 필요).

설치한 앱은 Expo Go 없이 단독으로 동작합니다. 앱 코드를 바꾸면 같은 방법으로 다시 빌드합니다(10~15분).

### 3. 푸시 알림 (약 15분)

1. https://console.firebase.google.com → 프로젝트 만들기 → **Android 앱 추가**, 패키지명 `com.stockbriefing.app` → `google-services.json` 다운로드.
2. Expo 대시보드 **Environment variables → Create variable**: 이름 `GOOGLE_SERVICES_JSON`, 타입 **File**, 위 파일 업로드, visibility Secret. (`app.config.js` 가 이 값을 읽어 빌드에 넣습니다.)
3. Firebase **프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성** 으로 JSON 키 다운로드 → Expo 대시보드 **Credentials → Android → FCM V1 service account key → Add** 에 업로드.
4. 앱을 다시 빌드해서 설치한 뒤 **설정 탭 → 알림 → 이 기기에서 알림 받기** 를 켜고 **테스트 알림 보내기**.

### 제약

- 앱을 고칠 때마다 클라우드 빌드(10~15분)를 거칩니다. PC 가 있으면 Expo Go 로 즉시 확인할 수 있어 훨씬 빠릅니다.
- 브리핑 내용 수정(프롬프트)은 GitHub 웹에서 `backend/prompts/*.md` 를 편집하면 Railway 가 자동 재배포합니다.

## 데이터 소스 메모

- **KIS Open API**: `KIS_APP_KEY`/`KIS_APP_SECRET` 설정 시 1차 소스. 토큰은 24시간 캐시. 실서버 초당 20건 제한이라 종목은 순차 조회. 이 저장소 개발 환경에는 키가 없어 **KIS 호출 코드는 공식 문서 기준으로 작성됐고 실제 키로는 아직 검증되지 않음** — 키를 넣고 `GET /api/stocks/000660/quote?fresh=1` 로 확인 필요.
- **토스증권 공식 Open API** (`TOSS_CLIENT_ID/SECRET`): OAuth2 client credentials, 허용 IP 필수. 현재가 API 는 가격·시각만 주므로 전일 대비는 일봉으로 계산하고, 캔들은 1분·일봉만 있어 주봉·월봉은 일봉을 묶어 만든다(최대 200개/페이지, `before` 페이지네이션). 한국 시세는 KRX+NXT 통합. Rate limit 은 그룹별 초당 N회(429 는 Retry-After 뒤 1회 재시도). 실시간 웹소켓은 연결당 구독 100건, 60초마다 PING.
- **토스증권 (웹 비공식)**: 토스증권 웹(tossinvest.com)이 쓰는 내부 JSON API (`wts-info-api.tossinvest.com`). 공식 개발자 API 가 아니라 예고 없이 바뀔 수 있고 이용약관상 자동 수집을 금지할 수 있으니 개인 용도로만, 호출은 최소한으로(현재가 60초 캐시, 종목당 하루 브리핑 2회). 한국은 `A`+종목코드, 미국은 내부 상품코드(`US20100629001`)라 티커로 한 번 검색해 `meta` 테이블에 캐시한다. 응답이 바뀌면 체인이 네이버/Yahoo 로 넘어간다.
- **네이버 밸류에이션 보강**: 토스 시세에는 PER/PBR/EPS/BPS/배당/52주가 없어 네이버에서 채운다. 한국은 `m.stock.naver.com/api/stock/{코드}/integration`, 미국은 `api.stock.naver.com/stock/{로이터코드}/basic` (나스닥 `TSLA.O`, NYSE·AMEX 는 접미사 없음, 클래스 주식 `BRKb`). 환율은 `api.stock.naver.com/marketindex/exchange/FX_USDKRW`. 종목당 1시간 캐시, 실패해도 시세는 그대로.
- **네이버 증권**: 모바일 앱이 쓰는 비공식 JSON (`polling.finance.naver.com`, `m.stock.naver.com/api`, `api.stock.naver.com/chart`). 키 불필요, 한국 종목 전용. KRX 확정 종가·PER/PBR/52주·NXT 프리/애프터마켓 가격을 준다. Yahoo 는 15:30 동시호가 전 가격이 종가로 남거나 거래량이 일부만 잡히는 경우가 있어 한국 종목은 네이버를 먼저 쓴다. 응답 형식이 바뀌면 Yahoo 로 폴백.
- **Yahoo Finance**: 비공식 엔드포인트. 미국 종목의 1차 소스이자 한국 종목 폴백. `PER/PBR/시가총액`은 제공되지 않아 `null`. 주봉 조회 시 진행 중인 주가 별도 봉으로 붙는 경우가 있음. 검색은 티커/영문명만 됨.
- **DART**: 무료 키 (일 20,000회). 첫 조회 때 `corpCode.xml`(약 3,500개 상장사 매핑)을 내려받아 DB에 캐시. 재무제표는 사업보고서(11011) 주요계정으로 당기/전기/전전기를 한 번에 받아 5개년을 2회 호출로 구성. 실제 키로는 아직 검증되지 않음.
- **네이버 뉴스 API**: 일 25,000회 무료. 없으면 Google News RSS(키 불필요, 실제 동작 확인됨).
- **Anthropic / Bedrock**: 브리핑 2회(상세+요약) + 분석 3종. 종목 5개 기준 하루 약 20회 호출. Bedrock 은 `@anthropic-ai/bedrock-sdk` 의 Messages API 엔드포인트(bedrock-mantle)를 쓰며 실제 키로는 아직 검증되지 않음(가짜 키로 엔드포인트 연결·인증 오류 응답만 확인).
- **Expo Push Service**: 서버 키 불필요(계정에서 Enhanced push security 를 켠 경우만 `EXPO_ACCESS_TOKEN`). 실제 기기 토큰으로는 아직 검증되지 않음(이 환경에 Android 기기 없음).
- **종목 마스터**: KIS 가 공개 배포하는 `kospi_code.mst` / `kosdaq_code.mst` (cp949 고정폭). 배포 서버가 간헐적으로 503 을 내서 3회 재시도.
