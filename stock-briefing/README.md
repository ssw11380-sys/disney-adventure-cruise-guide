# 주식 브리핑 앱 (stock-briefing)

보유/관심 한국 주식을 등록하면 매일 오전·오후 브리핑을 생성해 푸시로 알려주고, 종목별 회사 소개·가치투자·기술적 분석을 보여주는 모바일 앱.

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
                              KIS Open API → Yahoo Finance     + 회사 개요               + 공시(DART)
                                        │
                                        ▼
                              SQLite(개발) / Postgres(운영)  ← Kysely (두 DB 공용 쿼리)
```

핵심 설계 원칙

- **데이터 소스는 인터페이스 뒤에 둔다.** `QuoteProvider`, `StockSearchProvider`, `MasterProvider`(1단계), `FinancialsProvider`, `NewsProvider`(2단계). 구현체는 교체·체인 가능.
- **폴백 체인.** KIS 키가 없거나 장애면 Yahoo Finance(yfinance 가 쓰는 동일 엔드포인트)로 자동 대체. 모든 소스가 실패해도 API는 200 + `quoteError` 로 응답하고, 브리핑에는 "데이터 미확인"을 남긴다.
- **모든 시각은 Asia/Seoul.** 서버 TZ 와 무관하게 `lib/time.ts` 로 계산.
- **프롬프트는 파일로.** `backend/prompts/*.md` (2단계) — 코드 수정 없이 편집 가능.
- **단일 사용자 v1.** 인증/멀티유저는 범위 밖. 배포 시 네트워크(VPN, 방화벽)로 보호.

## 폴더 구조

```
stock-briefing/
├── README.md
├── backend/
│   ├── .env.example            # 모든 API 키/설정 항목
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
│   │   │   ├── market/         # kis, yahoo, kisMaster(종목 마스터), investorFlow(수급), chain(폴백)
│   │   │   ├── news/           # naver(검색 API), googleRss(키 불필요), chain(폴백)
│   │   │   └── dart/           # DART 회사 개요·공시·재무제표·배당
│   │   ├── llm/                # generator(Anthropic SDK 래퍼, 캐싱·폴백), prompts(파일 로더·템플릿)
│   │   ├── analysis/           # indicators (SMA/EMA/RSI/MACD/볼린저/지지저항, 직접 구현)
│   │   ├── services/           # stockService, collector(데이터 수집), briefingService, analysisService
│   │   ├── scheduler.ts        # node-cron (Asia/Seoul) 오전/오후 브리핑
│   │   ├── routes/             # stocks, analysis, briefings, admin
│   │   ├── lib/                # time(KST), errors
│   │   └── scripts/            # refreshMaster, runBriefing
│   └── test/                   # vitest (네트워크 없이 가짜 프로바이더로 검증)
└── app/                        # (3단계) Expo + TypeScript
```

## 단계별 계획

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 백엔드 뼈대, 종목 검색/등록 API, 시세 어댑터(KIS → Yahoo 폴백), SQLite | **완료** |
| 2 | 브리핑 파이프라인(시세·뉴스·공시·재무 수집 → 프롬프트 → Claude → 저장), node-cron 스케줄러, 프롬프트 파일 5종, 브리핑·분석 조회 API | **완료** |
| 3 | Expo 앱: 종목 목록/등록, 브리핑 목록·상세(요약/상세 토글, 날짜별), 종목 상세 4탭(회사 소개·가치·기술·뉴스/공시), 캔들 차트 | 대기 |
| 4 | Expo Push 연동, 기기 토큰 등록, 알림 시간 사용자 설정 | 대기 |
| 5 | 기술적 지표(SMA/RSI/MACD/볼린저) 직접 구현 + 단위 테스트, 브리핑 파이프라인 통합 테스트 | 2단계에서 선행 구현 (지표 + 파이프라인 테스트 포함). 실제 키로 통합 검증만 남음 |

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
| `ANTHROPIC_API_KEY` | 브리핑/분석이 `failed` 로 저장되고 사유가 남음 (수집은 정상) |
| `KIS_APP_KEY/SECRET` | 시세는 Yahoo, 수급(투자자별 매매동향)은 미확인, PER/PBR 없음 |
| `DART_API_KEY` | 공시·재무제표·배당·회사 개요 미확인 |
| `NAVER_CLIENT_ID/SECRET` | 뉴스는 Google News RSS |

서버 없이 브리핑 한 번 돌려보기: `npm run briefing -- morning` (전체) 또는 `npm run briefing -- afternoon 000660`.

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 상태, 현재 시세 소스, 고지 문구 |
| GET | `/api/stocks/search?q=하이닉스&limit=20` | 종목명/코드 검색 (마스터 → Yahoo 폴백). 본주가 ETF 보다 먼저 |
| GET | `/api/stocks?quotes=1` | 등록 종목 목록 (+현재가, 평가손익) |
| POST | `/api/stocks` | `{ code, quantity?, avgPrice?, memo? }` 등록 |
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
- 모델: `ANTHROPIC_MODEL` (기본 `claude-opus-5`). 시스템 프롬프트는 1시간 프롬프트 캐싱, 서버측 refusal fallback 기본 활성. 상세는 effort medium, 요약은 low, 회사/가치 분석은 high.
- 종목 상세 탭 분석은 요청 시 생성 후 캐시(회사 30일, 가치 7일, 기술 1일). `?refresh=1` 로 강제 재생성.
- 공휴일에는 시세가 전일과 같은 상태로 브리핑이 생성됩니다(휴장일 달력은 v1 범위 밖).

## 데이터 소스 메모

- **KIS Open API**: `KIS_APP_KEY`/`KIS_APP_SECRET` 설정 시 1차 소스. 토큰은 24시간 캐시. 실서버 초당 20건 제한이라 종목은 순차 조회. 이 저장소 개발 환경에는 키가 없어 **KIS 호출 코드는 공식 문서 기준으로 작성됐고 실제 키로는 아직 검증되지 않음** — 키를 넣고 `GET /api/stocks/000660/quote?fresh=1` 로 확인 필요.
- **Yahoo Finance**: 비공식 엔드포인트. `PER/PBR/시가총액`은 제공되지 않아 `null`. 주봉 조회 시 진행 중인 주가 별도 봉으로 붙는 경우가 있음.
- **DART**: 무료 키 (일 20,000회). 첫 조회 때 `corpCode.xml`(약 3,500개 상장사 매핑)을 내려받아 DB에 캐시. 재무제표는 사업보고서(11011) 주요계정으로 당기/전기/전전기를 한 번에 받아 5개년을 2회 호출로 구성. 실제 키로는 아직 검증되지 않음.
- **네이버 뉴스 API**: 일 25,000회 무료. 없으면 Google News RSS(키 불필요, 실제 동작 확인됨).
- **Anthropic**: 브리핑 2회(상세+요약) + 분석 3종. 종목 5개 기준 하루 약 20회 호출.
- **종목 마스터**: KIS 가 공개 배포하는 `kospi_code.mst` / `kosdaq_code.mst` (cp949 고정폭). 배포 서버가 간헐적으로 503 을 내서 3회 재시도.
