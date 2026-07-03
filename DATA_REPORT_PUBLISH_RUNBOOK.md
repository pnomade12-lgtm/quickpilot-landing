# 데이터 리포트 발행 런북

QuickPilot 유저용 데이터 리포트 발행 절차. 앱 코드/APK를 건드리지 않고, Hosting 페이지와 RTDB 목록 등록으로 앱 데이터 리포트 메뉴에 노출한다.

## 기본 구조

- 리포트 파일명: `column-N-slug.html`
- 공개 위치: `public/column-N-slug.html`
- 영구 URL: `https://quickpilot-39d72.web.app/column-N-slug.html`
- 앱 목록 소스: RTDB `/v1/reports/colN`
- 앱 목록 값:

```json
{
  "title": "데이터 리포트 N호 · 제목",
  "ts": 1783060793277,
  "url": "https://quickpilot-39d72.web.app/column-N-slug.html"
}
```

## 발행 순서

1. 최종 HTML을 루트와 `public`에 맞춘다.
   - `column-N-slug.html`
   - `public/column-N-slug.html`

2. 금지 표현과 개인정보성 문구를 검사한다.
   - 예: `중위값`, `칼럼`, `짐 신호`, 전화번호 패턴, 불필요한 내부 표현

3. Hosting 배포한다.

```powershell
firebase.cmd deploy --only hosting --project quickpilot-39d72
```

4. RTDB 목록에 `colN`을 등록한다. PowerShell에서 BOM 없는 UTF-8 임시파일을 사용한다.

```powershell
$payload = [ordered]@{
  title = "데이터 리포트 N호 · 제목"
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  url = "https://quickpilot-39d72.web.app/column-N-slug.html"
} | ConvertTo-Json -Compress
$tmp = Join-Path $env:TEMP "qp-report-colN.json"
[System.IO.File]::WriteAllText($tmp, $payload, [System.Text.UTF8Encoding]::new($false))
firebase.cmd database:set /v1/reports/colN $tmp --project quickpilot-39d72 --force
```

5. 확인한다.

```powershell
firebase.cmd database:get /v1/reports/colN --project quickpilot-39d72
```

```powershell
Invoke-WebRequest -Uri "https://quickpilot-39d72.web.app/column-N-slug.html" -UseBasicParsing
```

6. 미공개 초안이 공개되지 않았는지 확인한다.

```powershell
Invoke-WebRequest -Uri "https://quickpilot-39d72.web.app/column-3-night.html" -UseBasicParsing
Invoke-WebRequest -Uri "https://quickpilot-39d72.web.app/column-3-weekend.html" -UseBasicParsing
```

두 파일은 404여야 한다.

## 5호에서 확인된 함정

5호 발행 때 `col5`를 RTDB에 등록했는데 앱에는 5호가 안 떴다.

원인:

- 앱은 `/v1/reports`를 못 읽으면 서버 목록 대신 앱 내부 기본 목록을 보여준다.
- 내부 기본 목록은 1~4호와 특별 리포트까지만 들어 있었다.
- 그래서 서버에는 `col5`가 있어도 앱 화면에는 4호까지만 보였다.

조치:

- `database.rules.json`에서 `/v1/reports` 읽기를 `true`로 열었다.
- 앱이 쓰는 `orderByChild("ts")` 조회를 위해 `.indexOn`: `["ts"]`를 추가했다.
- `firebase.cmd deploy --only database --project quickpilot-39d72`로 rules 배포했다.

확인:

```powershell
$url='https://quickpilot-39d72-default-rtdb.asia-southeast1.firebasedatabase.app/v1/reports.json?orderBy=%22ts%22&limitToLast=50'
Invoke-WebRequest -Uri $url -UseBasicParsing
```

응답에 `col5`와 5호 제목이 포함돼야 한다.

## 5호 발행 기록

- 파일: `column-5-cargo-load.html`
- 공개 파일: `public/column-5-cargo-load.html`
- URL: `https://quickpilot-39d72.web.app/column-5-cargo-load.html`
- RTDB: `/v1/reports/col5`
- 제목: `데이터 리포트 5호 · 짐을 많이 실을수록 요금을 많이 줄까?`
- 확인:
  - live 페이지 200
  - `/v1/reports/col5` 등록 확인
  - 익명 REST 정렬 조회에서 `col5` 확인
  - `column-3-night.html`, `column-3-weekend.html` 404 확인
