# 프롬프트 파일

이 폴더의 `.md` 파일은 서버가 기동할 때마다 다시 읽습니다(요청 시점에 파일을 읽으므로 재시작 없이 수정이 반영됩니다).

## 파일 형식

```
(시스템 프롬프트: 역할, 규칙, 출력 형식. 이 부분은 프롬프트 캐싱되므로 자주 바꾸지 않는 내용만)

=== USER ===

(사용자 메시지 템플릿. {{변수}} 자리에 데이터가 들어감)
```

`=== USER ===` 구분선 위가 시스템 프롬프트, 아래가 사용자 메시지입니다. 구분선이 없으면 전체가 사용자 메시지로 쓰입니다.

## 파일별 변수

| 파일 | 용도 | 사용 가능한 변수 |
|---|---|---|
| `briefing_detail.md` | 오전/오후 상세 브리핑 | `{{stock_name}}` `{{stock_code}}` `{{session_label}}` `{{date}}` `{{avg_price}}` `{{quantity}}` `{{data_json}}` `{{missing_list}}` `{{notes_list}}` `{{market_state}}` `{{previous_summary}}` |
| `briefing_summary.md` | 상세 브리핑을 3줄 요약 (알림 본문) | `{{stock_name}}` `{{stock_code}}` `{{session_label}}` `{{date}}` `{{detail}}` `{{market_state}}` |
| `company_overview.md` | 종목 상세 > 회사 소개 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` `{{notes_list}}` |
| `value_analysis.md` | 종목 상세 > 가치투자 분석 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` `{{notes_list}}` |
| `technical_analysis.md` | 종목 상세 > 기술적 분석 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` `{{notes_list}}` `{{market_state}}` |
| `account_briefing.md` | 계좌 한 장 브리핑의 설명 (3-31) | `{{date}}` `{{session_label}}` `{{facts}}` |

- `{{data_json}}`: 수집된 데이터 전체(JSON). 없는 항목은 `null` 이고 `{{missing_list}}` 에 받으려다 실패한 항목 이름이 나열됩니다.
- `{{notes_list}}`: 원래 제공되지 않는 데이터(미국 종목 수급, DART 키 없음, SEC 에 없는 ETF 등). 실패가 아닙니다.
- `{{market_state}}`: 그 시점의 장 상태 한 줄 (한국 정규장·NXT·휴장, 미국 정규장·프리·애프터·주간거래).
- `{{avg_price}}` / `{{quantity}}`: 보유 정보가 없으면 "미입력" 으로 들어갑니다.
- `{{facts}}` (계좌 브리핑): 코드로 계산한 사실 목록(날짜·총 평가금액·당일 손익·기여 상위와 그 외·지수·원/달러와 환율 효과·오늘 일정·최근 공시, 한국 휴장이면 '참고' 한 줄). `backend/src/services/accountNumbers.ts` 의 `factsText` 가 만듭니다.
  - 모델 설명의 숫자는 값·단위(원·%·포인트)·부호(적었으면)가 모두 맞는 숫자가 목록에 있어야 합니다. 날짜·시각(9/25·22:30)은 목록의 날짜·시각과만 맞춰 봅니다(장 시간 20:00 이 '20%'를 통과시키지 않게). 순서·개수로 쓴 10 이하 정수(1위·3종목·2건)만 목록에 없어도 됩니다. 쉼표 자리가 틀린 숫자('-30,0890원')도 틀린 것으로 봅니다.
  - 매매 지시·행동 제안·전망 표현(매수·매도·추천·전망·예상·예측·가능성·반등·기대·비중·좋겠·고려해·~하세요 등)이 있어도 버립니다. 단 목록에 그대로 있는 공시 제목(예: 주식매수선택권부여에관한신고)을 옮겨 쓴 것은 괜찮습니다.
  - 이런 설명은 버리고 숫자로 만든 기본 설명을 씁니다. 그래서 숫자는 목록의 표기 그대로 옮기라는 규칙을 지우면 기본 설명이 자주 쓰입니다.

## 주의

- 데이터에 없는 수치를 지어내지 말라는 규칙은 지워도 되지만, 지우면 브리핑 신뢰도가 떨어집니다.
- 출력은 마크다운으로 앱에서 그대로 렌더링됩니다.
