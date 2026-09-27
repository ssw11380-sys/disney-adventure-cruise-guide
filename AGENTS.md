# AGENTS.md — 코딩 에이전트(Codex 등) 작업 안내

이 저장소에서 코드를 고치는 에이전트가 먼저 읽는 파일입니다. 사람·Claude 용 규칙은 `CLAUDE.md` 에 있고, 여기는 그 규칙을 에이전트용으로 옮긴 것입니다.
앱 폴더(`stock-briefing/app/`)를 고칠 때는 `stock-briefing/app/AGENTS.md`(Expo 안내, 영어)도 함께 따릅니다. 두 파일이 부딪히면 **이 파일이 먼저**입니다(예: 그 파일의 `npx expo install`·EAS 빌드 안내는 여기서 금지).

지금 맡은 일의 작업지시: `stock-briefing/docs/작업지시/브리핑-2차.md` (그림: 같은 폴더 `브리핑-2차/`).

---

## 1. 프로젝트 한눈에

- 한 사람(한국어 사용자, 컴퓨터 초보)이 쓰는 주식 브리핑 앱입니다. 보유·관심 종목의 오전(08:30)·오후(16:00) 브리핑, 계좌 한 장 브리핑, 시장 전체 요약, 홈 화면 위젯, 푸시 알림.
- 폰: 갤럭시 Z 폴드8 — **접은 화면 475×751dp**, **펼친 화면 가로 933×704dp / 세로 704×933dp**. 울트라(411dp 폭)도 봅니다.
- 폴더
  - `stock-briefing/backend/` — Fastify + TypeScript 서버 (Node 22, ESM, Kysely: 개발 SQLite / 운영 Postgres). 테스트 vitest.
    - 브리핑 문장 프롬프트: `backend/prompts/*.md` (요청마다 파일을 새로 읽음 → **기존 파일을 고치면 배포 즉시 운영에 반영**. 새 동작은 새 파일 + 플래그로).
  - `stock-briefing/app/` — Expo SDK 57 · React Native 0.86 · Expo Router 앱(안드로이드). 테스트 vitest(`test/miniRender.ts` 로 가짜 렌더).
  - `stock-briefing/shared/fixtures/` — 서버·앱이 같은 글·숫자를 내는지 두 쪽 테스트가 함께 보는 픽스처.
  - `stock-briefing/docs/` — `기능-플래그.md`(플래그 표), `디자인-규칙.md`(토큰·접근성), `진행상황.md`·`로드맵.md`(Claude 가 관리), `작업지시/`.
  - 저장소 루트 `Dockerfile`·`railway.json` — 서버 배포 설정(건드리지 않음).
- 배포 (에이전트는 하지 않음 — Claude 가 검토 뒤 함)
  - 서버: `main` 에 머지되면 Railway 가 자동 배포.
  - 앱: Claude 가 이 PC 의 Expo 로그인으로 OTA(`eas update`, runtime **1.4.0**)를 냄. 새 APK 는 사용자가 따로 설치해야 해서 이번 작업에서는 쓰지 않습니다.

## 2. 반드시 지킬 규칙

1. **한국어**: 앱에 보이는 글, 코드 주석, 커밋 메시지, PR 제목·본문은 한국어로 씁니다. 쉬운 말로 씁니다(사용자는 컴퓨터 초보). 테스트 이름도 한국어로 씁니다(기존 테스트처럼).
2. **비밀값 금지**: 토큰·키·비밀번호를 저장소·로그·PR·출력에 넣지 않습니다. `.env` 파일을 만들지 않습니다. 테스트는 비밀값 없이 가짜 프로바이더로 돕니다. CI 가 gitleaks 로 검사합니다.
3. **로그인이 필요한 비공식 API 를 쓰지 않습니다.** 이번 작업에서는 새 외부 데이터 출처도 추가하지 않습니다.
4. **투자 권유로 읽히는 말을 쓰지 않고, 고지 문구를 지킵니다.**
   - 고지 문구: 앱 `app/src/lib/disclaimer.ts` 의 `DISCLAIMER`, 서버 `backend/src/app.ts` 의 `DISCLAIMER` — 바꾸거나 지우지 않습니다.
   - `app/test/wording.test.ts` 가 `app/src`·`backend/src` 의 모든 파일에서 금지 문구('매수 추천'·'목표주가'·'목표 주가'·'사세요' 등)를 **글자 그대로** 찾습니다. 검사기를 만들 때도 이 글자를 그대로 쓰지 말고 정규식 조각(`목표 ?주가`)으로 씁니다.
   - 모든 프롬프트 파일에는 `매수/매도 … 금지|하지 않|없이` 규칙 한 줄이 있어야 합니다(같은 테스트).
5. **새 APK 가 필요한 변경 금지** — OTA(runtime 1.4.0)로 나갈 수 있는 JS/TS 변경만 합니다.
   - 고치지 않는 파일: `app/app.json`, `app/app.config.js`, `app/eas.json`, `app/package.json`·`package-lock.json`(의존성 추가·버전 변경 금지), 네이티브 폴더.
   - `npx expo install`, `npm install <패키지>` 를 하지 않습니다. 서버 `backend/package.json` 의존성도 늘리지 않습니다.
6. **새 기능은 기능 플래그 뒤에** (`docs/기능-플래그.md`)
   - 서버 `backend/src/services/featureService.ts` 의 `FEATURES` 에 `{ default: true, description }` 한 줄.
   - 앱은 `useFeature("키", false)` (앱 fallback 은 **false** — 예전 서버·처음 실행에서는 꺼짐).
   - `docs/기능-플래그.md` 표에 한 줄(키 · 기본 · 끄면).
   - **끄면 지금과 똑같아야** 합니다(화면·알림·서버 작업). 이것을 테스트로 확인합니다. 기존 스냅숏(`app/test/__snapshots__`)은 끈 상태의 증거이므로 `-u` 로 고치지 않습니다.
   - 버그 수정은 플래그 없이 합니다 — 작업지시에 '플래그 없음'이라고 적힌 항목만.
7. **숫자는 코드가 계산합니다.** 화면·알림의 숫자는 서버·앱 코드가 만든 값만 씁니다. 모델(AI)이 쓴 글에 '숫자는 코드가 넣음' 같은 **사실이 아닌 표시를 붙이지 않습니다.**
8. **알림은 세션(오전·오후)마다 1건**입니다. 알림 수를 늘리지 않습니다.
9. **화면 크기**: 접은 475×751, 펼친 933×704·704×933, 울트라 411, 글자 130%(가능하면 200%)에서 글자가 잘리거나 겹치지 않게 합니다. 넓은 창 판단(`useFoldLayout`·`isWide`)은 바꾸지 않습니다.
10. **디자인 토큰**: 색·간격·글자 크기는 `app/src/tokens.ts`(테마 훅은 `app/src/theme.ts`) 토큰만 씁니다. 숫자·hex 를 직접 쓰면 `npm run lint` 가 막습니다. 아이콘은 Ionicons 만. 다크·라이트 두 테마 모두 맞아야 합니다. 자세한 규칙: `docs/디자인-규칙.md`.
11. **접근성**: 누르는 곳은 보이는 높이 + hitSlop 이 44dp 이상(`touch.min`, `slopFor`). `Pressable` 에는 `accessibilityRole` 과 `accessibilityLabel` 을 둘 다. 숫자가 여럿인 줄은 화면 읽기(TalkBack) 한 문장으로(`app/src/lib/a11y.ts` — `+2.86%` → "2.86% 상승"). 글자 확대 상한은 `fontCap`.
12. **테스트는 고정 시계로**: `new Date("2026-12-28T08:30:00+09:00")` 를 `now` 로 넘기거나 `vi.setSystemTime`. 모든 시각은 한국 시간(`TZ=Asia/Seoul`). 네트워크를 부르지 않습니다(`backend/test/helpers.ts` 의 가짜 프로바이더).
13. **휴장·조기 폐장·수능일 목록**은 서버 `backend/src/services/marketContext.ts` 와 앱 `app/src/lib/marketTime.ts` 에 같이 있습니다. 한쪽을 바꾸면 다른 쪽도 바꿉니다(테스트가 같은지 봄).
14. **서버·앱 같은 문구**: 알림 문구(`backend/src/notifications/digest.ts` ↔ `app/src/lib/briefingDigest.ts`)처럼 두 쪽에 같은 글이 있으면 둘 다 고치고, 두 쪽 테스트에 같은 기대 문자열을 적습니다.

## 3. 설치와 검사 명령

설치 (Codex 환경 설정 스크립트와 같음):

```bash
export TZ=Asia/Seoul
cd stock-briefing/backend && npm ci --no-audit --no-fund
cd ../app && npm ci --no-audit --no-fund
```

PR 을 열기 전에 **모두 통과**해야 합니다:

```bash
# 서버
cd stock-briefing/backend
npx tsc -p tsconfig.json --noEmit
npx vitest run

# 앱
cd stock-briefing/app
npm run -s typecheck   # tsc --noEmit && tsc --noEmit -p test
npm run -s lint        # expo lint (디자인 토큰 규칙 포함)
npx vitest run
```

- Postgres 테스트(`backend/test/postgres.test.ts`)는 `TEST_PG_URL` 이 없으면 건너뜁니다. 에이전트 환경에서는 건너뛰는 것이 정상입니다(CI 가 Postgres 로 돌림). `REQUIRE_PG` 를 켜지 않습니다.
- 서버 운영 빌드 확인이 필요하면 `npm run build`(tsc)도 돌립니다.
- 테스트를 지우거나 `skip` 하지 않습니다. 작업지시가 '뒤집으라'고 한 테스트만 기대값을 바꿉니다.

## 4. PR 규칙

- **항목마다 PR 하나**, base 는 `main`. 브랜치 이름 `codex/briefing2-<항목번호>-<짧은-영문>` (예: `codex/briefing2-7-us-holiday-monday`).
- 순서는 작업지시의 순서(7 → 4 → 6 → 2+3)를 따릅니다. 앞 PR 이 아직 머지되지 않았는데 다음 항목을 해야 하면, 앞 PR 브랜치 위에 쌓고 PR 본문 첫 줄에 `이 PR 은 #번호 위에 쌓았습니다` 라고 적습니다.
- PR 제목: `[브리핑 2차 #7] 미국 금요일 휴장 다음 월요일 휴장 줄 빠짐 고치기` 처럼 한국어.
- PR 본문(한국어, 휴대폰에서 읽기 쉽게 짧은 줄로):
  1. 무엇을 왜 바꿨나 (2~4줄)
  2. 바뀐 파일 목록
  3. 플래그: 키 · 기본값 · 끄면 어떻게 되나 (버그 수정이면 '플래그 없음')
  4. 검사 결과: 위 명령과 통과·건너뜀 수
  5. 작업지시의 '완료 기준' 체크리스트 (항목마다 [x]/[ ])
  6. 모르는 것 · 남은 위험 · 작업지시와 코드가 달랐던 곳
- 커밋 메시지는 한국어. **`Co-Authored-By: Claude …` 나 'Generated with Claude Code' 같은 Claude 표기를 넣지 않습니다.**
- 작업지시에 없는 개선·정리(리팩터링, 이름 바꾸기, 포맷 변경)는 하지 않습니다. 필요해 보이면 PR 본문 '제안'에만 적습니다.
- 작업지시의 줄 번호는 `main` 6d24b83 기준 힌트입니다. 코드가 다르면 코드를 따르고 PR 본문에 적습니다.

## 5. 하지 않는 일 (Claude 가 검토하고 배포합니다)

- PR 머지, `main` 에 직접 푸시, force push, 태그.
- 배포: `eas update`·`eas build`·`eas-cli` 어떤 명령도, Railway 명령, 서버 관리 API(`/api/admin/*`) 호출.
- `docs/진행상황.md`·`docs/로드맵.md` 수정 (Claude 가 배포 뒤 갱신). `docs/기능-플래그.md` 는 새 플래그 줄을 넣기 위해 고칩니다.
- 스냅숏 갱신(`vitest -u`), 의존성 추가, 네이티브·설정 파일 수정.
- 운영 서버·실제 토스/네이버 API 를 부르는 스크립트 실행.

## 6. 자주 보는 곳

| 무엇 | 파일 |
|---|---|
| 기능 플래그 목록 | `backend/src/services/featureService.ts` (`FEATURES`), 앱 `useFeature` (`app/src/api/hooks.ts`) |
| 브리핑 탭 | `app/src/app/(tabs)/briefings.tsx` |
| 계좌 카드·넓은 창 계좌 줄 | `app/src/components/AccountBriefingCard.tsx` |
| 계좌 상세 | `app/src/components/AccountBriefingBody.tsx`, 순수 함수 `app/src/lib/accountBriefing.ts` |
| 시장 요약 카드·줄·상세 | `app/src/components/MarketSummaryCard.tsx`·`MarketSummaryBody.tsx`, 순수 함수 `app/src/lib/marketSummary.ts` |
| 종목 브리핑 카드·목록 줄·상세 | `app/src/components/BriefingCard.tsx`·`BriefingList.tsx`·`BriefingBody.tsx` |
| 알림 문구 | 서버 `backend/src/notifications/digest.ts`, 앱 `app/src/lib/briefingDigest.ts` |
| 계좌 숫자·문장·검사기 | `backend/src/services/accountNumbers.ts`, 생성 `accountBriefingService.ts` |
| 종목 브리핑 생성 | `backend/src/services/briefingService.ts`, 프롬프트 `backend/prompts/`, 로더 `backend/src/llm/prompts.ts` |
| 장 시간·휴장 | `backend/src/services/marketContext.ts`, `liveSession.ts`, 앱 `app/src/lib/marketTime.ts` |
| 토큰·테마 | `app/src/tokens.ts`, `app/src/theme.ts` |
| 가짜 렌더 테스트 예 | `app/test/foldBriefings.test.tsx`, `app/test/accountBriefingScreen.test.tsx` |
