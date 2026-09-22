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
                              KIS → 네이버 증권 → Yahoo        + 회사 개요               + 공시(DART)
                              (미국 종목은 Yahoo)
                                        │
                                        ▼
                              SQLite(개발) / Postgres(운영)  ← Kysely (두 DB 공용 쿼리)
```

핵심 설계 원칙

- **데이터 소스는 인터페이스 뒤에 둔다.** `QuoteProvider`, `StockSearchProvider`, `MasterProvider`(1단계), `FinancialsProvider`, `NewsProvider`(2단계). 구현체는 교체·체인 가능.
- **폴백 체인.** 한국 종목은 KIS(키 있을 때) → 네이버 증권(키 불필요, KRX 확정 종가 + NXT 야간 가격) → Yahoo Finance 순. 미국 종목은 Yahoo. 모든 소스가 실패해도 API는 200 + `quoteError` 로 응답하고, 브리핑에는 "데이터 미확인"을 남긴다.
- **한국 + 미국 종목.** 코드는 6자리 숫자(한국) 또는 티커(미국, `AAPL`·`BRK-B`). 미국 종목은 통화가 USD 이고 공시·수급·재무제표(DART/KIS)가 없어 브리핑에 "미국 종목 미지원"으로 표시된다. 검색은 티커나 영문 회사명으로만 된다(Yahoo 검색이 한글명을 모름).
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
│   │   │   ├── market/         # kis, naver(한국 시세+NXT), yahoo(한국 폴백·미국), kisMaster(종목 마스터), investorFlow(수급), chain(폴백)
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
| `KIS_APP_KEY/SECRET` | 시세는 네이버 증권(→ Yahoo 폴백), 수급(투자자별 매매동향)은 미확인 |
| `DART_API_KEY` | 공시·재무제표·배당·회사 개요 미확인 |
| `NAVER_CLIENT_ID/SECRET` | 뉴스는 Google News RSS |

서버 없이 브리핑 한 번 돌려보기: `npm run briefing -- morning` (전체) 또는 `npm run briefing -- afternoon 000660`.

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 상태, 현재 시세 소스, 고지 문구 |
| GET | `/api/stocks/search?q=하이닉스&limit=20` | 종목명/코드 검색 (마스터 → Yahoo 폴백, 티커처럼 보이면 미국 종목도 함께). 본주가 ETF 보다 먼저 |
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
```

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
| 내 종목 | 보유 합계(평가금액·손익, 원화/달러 따로), 종목별 현재가·등락·평가손익, 한국 종목은 NXT 야간 가격, + 버튼으로 등록 |
| 종목 등록 | 이름/코드/미국 티커 검색(300ms 디바운스) → 선택 → 수량·평단(선택, 미국은 $) → 등록 |
| 종목 상세 | 시세 헤더(시·고·저·거래량·52주·시총·PER/PBR, NXT 야간 가격), 일/주/월 캔들 차트(길게 눌러 값 보기), 탭: 회사 소개·가치투자·기술적 분석(마크다운, 캐시 표시, 다시 생성)·뉴스/공시(링크), 최근 브리핑 3건. 헤더 연필 아이콘으로 수정/삭제 |
| 브리핑 | 종목별 최신 브리핑, 요약/상세 토글, 오전·오후 즉시 생성 버튼 |
| 브리핑 상세 | 요약/상세 토글, 브리핑 시점 가격·손익, 미확인 데이터, 같은 종목 지난 브리핑 목록(날짜별 이동) |
| 설정 | 서버 주소 저장/연결 확인, 서버 데이터 소스 상태, 알림 시간, 앱 업데이트 확인(현재 버전·새 APK·OTA) |

### 토스·네이버 앱과 종가가 다르게 보일 때

장 마감 후 토스나 네이버 앱에 보이는 가격은 대개 **넥스트레이드(NXT) 애프터마켓**(15:40~20:00) 체결가입니다. 이 앱의 현재가·등락률·차트는 **KRX 정규장**(09:00~15:30) 기준이고, NXT 가격은 그 아래 "NXT 야간 …" 한 줄로 따로 보여줍니다. 브리핑도 정규장 종가를 기준으로 쓰고 NXT 가격을 한 줄 덧붙입니다. 거래량도 정규장만 집계하므로 통합 거래량을 보여주는 앱보다 적게 나옵니다.

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
- 모델: Anthropic 직접이면 `ANTHROPIC_MODEL`(기본 `claude-opus-5`, 서버측 refusal fallback 활성), Bedrock 이면 `BEDROCK_MODEL`(기본 `anthropic.claude-opus-4-8`, 도쿄 리전). 시스템 프롬프트는 1시간 프롬프트 캐싱. 상세는 effort medium, 요약은 low, 회사/가치 분석은 high.
- 종목 상세 탭 분석은 요청 시 생성 후 캐시(회사 30일, 가치 7일, 기술 1일). `?refresh=1` 로 강제 재생성.
- 공휴일에는 시세가 전일과 같은 상태로 브리핑이 생성됩니다(휴장일 달력은 v1 범위 밖).

## 배포 (6단계)

브리핑은 서버가 만들고 푸시만 보내므로, 알림 시간에 서버가 켜져 있어야 합니다. 세 가지 방법 중 하나를 고르세요.

### 공통: 보안 설정

서버를 인터넷에 노출한다면 `.env` 에 `API_TOKEN` 을 반드시 설정하고(예: `openssl rand -hex 24`), 앱 **설정 탭 > 서버 주소 아래 토큰 칸**에 같은 값을 넣습니다. 설정하면 `/api/*` 전체가 `Authorization: Bearer <토큰>` 을 요구하고 `/health` 만 열려 있습니다. 로컬 Wi-Fi 안에서만 쓸 때는 비워 두어도 됩니다.

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
- **네이버 증권**: 모바일 앱이 쓰는 비공식 JSON (`polling.finance.naver.com`, `m.stock.naver.com/api`, `api.stock.naver.com/chart`). 키 불필요, 한국 종목 전용. KRX 확정 종가·PER/PBR/52주·NXT 프리/애프터마켓 가격을 준다. Yahoo 는 15:30 동시호가 전 가격이 종가로 남거나 거래량이 일부만 잡히는 경우가 있어 한국 종목은 네이버를 먼저 쓴다. 응답 형식이 바뀌면 Yahoo 로 폴백.
- **Yahoo Finance**: 비공식 엔드포인트. 미국 종목의 1차 소스이자 한국 종목 폴백. `PER/PBR/시가총액`은 제공되지 않아 `null`. 주봉 조회 시 진행 중인 주가 별도 봉으로 붙는 경우가 있음. 검색은 티커/영문명만 됨.
- **DART**: 무료 키 (일 20,000회). 첫 조회 때 `corpCode.xml`(약 3,500개 상장사 매핑)을 내려받아 DB에 캐시. 재무제표는 사업보고서(11011) 주요계정으로 당기/전기/전전기를 한 번에 받아 5개년을 2회 호출로 구성. 실제 키로는 아직 검증되지 않음.
- **네이버 뉴스 API**: 일 25,000회 무료. 없으면 Google News RSS(키 불필요, 실제 동작 확인됨).
- **Anthropic / Bedrock**: 브리핑 2회(상세+요약) + 분석 3종. 종목 5개 기준 하루 약 20회 호출. Bedrock 은 `@anthropic-ai/bedrock-sdk` 의 Messages API 엔드포인트(bedrock-mantle)를 쓰며 실제 키로는 아직 검증되지 않음(가짜 키로 엔드포인트 연결·인증 오류 응답만 확인).
- **Expo Push Service**: 서버 키 불필요(계정에서 Enhanced push security 를 켠 경우만 `EXPO_ACCESS_TOKEN`). 실제 기기 토큰으로는 아직 검증되지 않음(이 환경에 Android 기기 없음).
- **종목 마스터**: KIS 가 공개 배포하는 `kospi_code.mst` / `kosdaq_code.mst` (cp949 고정폭). 배포 서버가 간헐적으로 503 을 내서 3회 재시도.
