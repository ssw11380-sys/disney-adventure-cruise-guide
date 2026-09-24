# DB 백업·복구

운영 DB 는 Railway 볼륨(`/app/data`) 안의 SQLite 파일(`/app/data/dev.db`)입니다.

## 무엇을, 언제, 어디에

| 항목 | 내용 |
|---|---|
| 넣는 것 | 운영(SQLite): 한 시점의 DB 파일 전체(`VACUUM INTO`, 쓰는 중이어도 일관됨). Postgres 로 옮긴 경우: 등록 종목·meta·브리핑·분석·기기·앱 오류를 한 트랜잭션에서 JSON 으로 |
| 주기 | 하루 1번, 한국 07시대 (미국 장 마감 뒤·NXT 개장 전). 26시간 넘게 못 했으면 바로. 실패하면 3시간 뒤 다시 |
| 보관 | 볼륨 안 `/app/data/backups/backup-YYYYMMDD-HHMMSS.sbk`, 날짜별 1개씩 최근 7일 (같은 날 수동 백업은 가장 새것만) |
| 암호화 | gzip → AES-256-GCM, 키는 Railway 변수 `BACKUP_KEY` 를 scrypt(파일마다 salt)로 늘려 씀. 저장소에는 키·백업 없음 |
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
   SQLite 백업이면 그 시점의 DB 파일이 `restored.db` 로 생기고, 출력의 `restored` 에 표별 건수가 나옵니다 (JSON 백업은 `RESTORE_DATABASE_URL=postgres://...` 로 Postgres 에도 넣을 수 있음).
3. **확인**: 등록 종목 수, `meta` 의 `krw_cost_book`, 브리핑 건수가 백업 때(`/health` 의 `backup.lastCounts`)와 같은지 봅니다.
4. **운영에 넣기**: Railway 에서 서비스를 멈추고(Replicas 0) 볼륨의 `dev.db` 를 `restored.db` 로 바꾼 뒤 다시 켭니다.
   **같은 폴더의 `dev.db-wal`·`dev.db-shm` 은 반드시 지우거나 옮깁니다** (옛 WAL 이 남으면 새 파일이 깨질 수 있음).
   볼륨 파일을 바꾸기 어려우면 새 볼륨·새 서비스에 `restored.db` 를 올리고 앱의 서버 주소를 바꿉니다.
5. 켜진 뒤 `/health` 의 `quotes`·`backup` 과 앱 잔고 화면을 확인합니다. 캐시(종목 마스터·현재가)는 기동 때 다시 받습니다.

## 리허설 기록

| 날짜 | 백업 파일 | 결과 | 걸린 시간 |
|---|---|---|---|
| 2026-09-24 | backup-20260924-104311.sbk (1.1MB, 운영에서 수동 실행) | 새 SQLite 에 복구: 등록 종목 18·meta 60·브리핑 41·분석 32·앱 오류 1 모두 백업 때와 같음, 원화 장부 14종목·마지막 브리핑 9/24 확인 | 3초 (백업 실행·내려받기·복구) |
