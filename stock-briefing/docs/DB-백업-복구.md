# DB 백업·복구

운영 DB 는 Railway 볼륨(`/app/data`) 안의 SQLite 파일(`/app/data/dev.db`)입니다.

## 무엇을, 언제, 어디에

| 항목 | 내용 |
|---|---|
| 넣는 것 | 등록 종목(수량·평단), meta(원화 매입 장부·토스 평가 기준·알림 설정 등), 브리핑, 분석, 기기, 앱 오류 |
| 빼는 것 | 다시 받을 수 있는 캐시: 종목 마스터, 현재가 캐시, DART 코드 |
| 주기 | 하루 1번, 한국 04~06시 (26시간 넘게 못 했으면 바로) |
| 보관 | 볼륨 안 `/app/data/backups/backup-YYYYMMDD-HHMMSS.sbk`, 최근 7개 |
| 암호화 | gzip → AES-256-GCM. 키는 Railway 변수 `BACKUP_KEY` (저장소에는 없음) |
| 확인 | `GET /health` 의 `backup` (마지막 시각·파일·표별 건수·오류), 관리 API `GET /api/admin/backups` |

`BACKUP_KEY` 가 없으면 백업하지 않고 `backup.lastError` 에 이유를 남깁니다. **키를 잃으면 백업을 풀 수 없으니** Railway 변수 값을 비밀번호 관리자에도 한 부 적어 두세요.

같은 볼륨에 있는 백업은 "잘못된 수정·배포로 데이터가 망가진 경우"를 막습니다. 볼륨 자체를 잃는 경우에 대비하려면 아래 둘 중 하나를 더 합니다.
- Railway 대시보드 → 서비스 → Volume → Backups 에서 일일 백업 켜기 (Railway 요금제에 따라 가능)
- 관리 API 로 암호화 파일을 내려받아 다른 곳에 보관 (3-8 텔레그램 연결 후 자동화 예정)

## 지금 바로 백업하기

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" https://<서버>/api/admin/backups/run
```

## 복구 (30분 목표)

1. **내려받기**: `GET /api/admin/backups` 로 파일 이름 확인 →
   `curl -H "Authorization: Bearer $API_TOKEN" -o b.sbk https://<서버>/api/admin/backups/<파일 이름>`
2. **새 DB 에 풀기** (운영 DB 를 바로 가리키지 말 것 — 이미 행이 있는 표는 건너뜀):
   ```bash
   cd stock-briefing/backend
   BACKUP_KEY=<Railway 값> RESTORE_DATABASE_URL=./data/restored.db npm run backup:restore -- b.sbk
   ```
   출력의 `restored` 에서 표별 건수를 확인합니다 (Postgres 로 옮길 때는 `RESTORE_DATABASE_URL=postgres://...`).
3. **확인**: 등록 종목 수, `meta` 의 `krw_cost_book`, 브리핑 건수가 백업 때(`/health` 의 `backup.lastCounts`)와 같은지 봅니다.
4. **운영에 넣기**: Railway 에서 서비스를 멈추고(Replicas 0) 볼륨의 `dev.db` 를 `restored.db` 로 바꾼 뒤 다시 켭니다.
   볼륨 파일을 바꾸기 어려우면 새 볼륨·새 서비스에 `restored.db` 를 올리고 앱의 서버 주소를 바꿉니다.
5. 켜진 뒤 `/health` 의 `quotes`·`backup` 과 앱 잔고 화면을 확인합니다. 캐시(종목 마스터·현재가)는 기동 때 다시 받습니다.

## 리허설 기록

| 날짜 | 백업 파일 | 결과 | 걸린 시간 |
|---|---|---|---|
| (첫 배포 뒤 기록) | | | |
