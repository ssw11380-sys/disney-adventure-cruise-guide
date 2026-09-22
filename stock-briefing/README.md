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
│   ├── prompts/                # (2단계) briefing_detail.md, briefing_summary.md, company_overview.md,
│   │                           #          value_analysis.md, technical_analysis.md
│   ├── src/
│   │   ├── index.ts            # 부팅: 설정 → DB 마이그레이션 → 프로바이더 조립 → 서버
│   │   ├── app.ts              # Fastify 인스턴스, 에러 핸들러, 라우트 등록 (테스트에서 재사용)
│   │   ├── config.ts           # .env → zod 검증
│   │   ├── domain/types.ts     # ListedStock, RegisteredStock, Quote, Candle ...
│   │   ├── db/                 # Kysely 스키마 + 마이그레이션 + 커넥션
│   │   ├── providers/
│   │   │   ├── index.ts        # 설정에 따라 실제 소스 조립
│   │   │   └── market/         # types(인터페이스), kis, yahoo, kisMaster(종목 마스터), chain(폴백)
│   │   ├── services/           # stockService (검색/등록/시세 캐시)
│   │   ├── routes/             # stocks, admin
│   │   ├── lib/                # time(KST), errors
│   │   └── scripts/            # refreshMaster
│   └── test/                   # vitest (네트워크 없이 가짜 프로바이더로 검증)
└── app/                        # (3단계) Expo + TypeScript
```

## 단계별 계획

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 백엔드 뼈대, 종목 검색/등록 API, 시세 어댑터(KIS → Yahoo 폴백), SQLite | **완료** |
| 2 | 브리핑 파이프라인(시세·뉴스·공시·재무 수집 → 프롬프트 → Claude → 저장), node-cron 스케줄러, 프롬프트 파일 5종, 브리핑 조회 API | 대기 |
| 3 | Expo 앱: 종목 목록/등록, 브리핑 목록·상세(요약/상세 토글, 날짜별), 종목 상세 4탭(회사 소개·가치·기술·뉴스/공시), 캔들 차트 | 대기 |
| 4 | Expo Push 연동, 기기 토큰 등록, 알림 시간 사용자 설정 | 대기 |
| 5 | 기술적 지표(SMA/RSI/MACD/볼린저) 직접 구현 + 단위 테스트, 브리핑 파이프라인 통합 테스트 | 대기 |

## 1단계: 실행 방법

```bash
cd stock-briefing/backend
npm install
cp .env.example .env        # KIS 키가 없으면 그대로 두어도 됨 (Yahoo 로 동작)
npm run dev                  # http://localhost:3000
```

기동 시 종목 마스터(KOSPI/KOSDAQ 약 4,400건)가 비어 있으면 KIS 공개 마스터 파일을 자동으로 내려받습니다. 수동 갱신은 `npm run master:refresh`.

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
| GET | `/api/admin/master` | 종목 마스터 건수/갱신 시각 |
| POST | `/api/admin/master/refresh` | 종목 마스터 갱신 |

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

## 데이터 소스 메모

- **KIS Open API**: `KIS_APP_KEY`/`KIS_APP_SECRET` 설정 시 1차 소스. 토큰은 24시간 캐시. 실서버 초당 20건 제한이라 종목은 순차 조회. 이 저장소 개발 환경에는 키가 없어 **KIS 호출 코드는 공식 문서 기준으로 작성됐고 실제 키로는 아직 검증되지 않음** — 키를 넣고 `GET /api/stocks/000660/quote?fresh=1` 로 확인 필요.
- **Yahoo Finance**: 비공식 엔드포인트. `PER/PBR/시가총액`은 제공되지 않아 `null` (2단계에서 DART/KIS 로 보완). 주봉 조회 시 진행 중인 주가 별도 봉으로 붙는 경우가 있음.
- **종목 마스터**: KIS 가 공개 배포하는 `kospi_code.mst` / `kosdaq_code.mst` (cp949 고정폭). 배포 서버가 간헐적으로 503 을 내서 3회 재시도.
