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
| `briefing_detail.md` | 오전/오후 상세 브리핑 | `{{stock_name}}` `{{stock_code}}` `{{session_label}}` `{{date}}` `{{avg_price}}` `{{quantity}}` `{{data_json}}` `{{missing_list}}` |
| `briefing_summary.md` | 상세 브리핑을 3줄 요약 (알림 본문) | `{{stock_name}}` `{{stock_code}}` `{{session_label}}` `{{date}}` `{{detail}}` |
| `company_overview.md` | 종목 상세 > 회사 소개 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` |
| `value_analysis.md` | 종목 상세 > 가치투자 분석 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` |
| `technical_analysis.md` | 종목 상세 > 기술적 분석 | `{{stock_name}}` `{{stock_code}}` `{{date}}` `{{data_json}}` `{{missing_list}}` |

- `{{data_json}}`: 수집된 데이터 전체(JSON). 없는 항목은 `null` 이고 `{{missing_list}}` 에 "데이터 미확인" 항목 이름이 나열됩니다.
- `{{avg_price}}` / `{{quantity}}`: 보유 정보가 없으면 "미입력" 으로 들어갑니다.

## 주의

- 데이터에 없는 수치를 지어내지 말라는 규칙은 지워도 되지만, 지우면 브리핑 신뢰도가 떨어집니다.
- 출력은 마크다운으로 앱에서 그대로 렌더링됩니다.
