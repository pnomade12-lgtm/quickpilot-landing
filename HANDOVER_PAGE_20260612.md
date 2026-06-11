# 페이지 세션 인수인계 (2026-06-12 07:36)

세션: 똘똘이개발자_QP_페이지 (Sonnet 4.6 / quickpilot-landing 도메인 owner)
폴더: `C:\Users\rlasn\Documents\quickpilot-landing`

## 이번 세션 산출물 (배포 완료)

### 1. admin-applications.html — 승인 시 안내문자 미리채움 + 문구 편집창
- HQ 지시문: `Obsidian\05_HQ관제\지시함\승인_안내문자.md`
- 커밋: `1a543aa`
- 동작:
  - 승인 버튼 클릭 → `location.href = "sms:" + phone + "?body=" + encodeURIComponent(본문)` → 그 다음 status approved 등록 (탭 제스처 안에서 동기 호출)
  - 이름 두 글자 = `name.trim().slice(1)` (성 첫 글자 제거. 복성은 디렉터 보내기 직전 화면서 확인)
  - 본문 = `landing/sms_template`의 `{이름}` 치환
  - 번호 또는 문구 미설정 시: 문자 안 띄움, status approved만 + 경고 1줄
- 문구 편집창:
  - 우측 하단 `💬` fixed 버튼 (`bottom:24px; right:24px; z-index:100`)
  - 클릭 시 인라인 패널 — textarea + 저장/취소
  - RTDB 경로 `landing/sms_template` (디렉터 쓰기 권한 있음. `applications_meta`는 rules 미정의로 막힘)
  - 새로고침해도 유지 [데이터확인]
- 미검증: 삼성 메시지 body 미리채움 실기기 1건 승인 시 [실기기검증] 잔여

### 2. hub.html — 내부 네비게이션 인덱스 (신규)
- 커밋: `1a543aa`
- 노출 X (noindex), 유저 공유 X, 디렉터 내부 사용
- 3그룹: 대외(랜딩·apply·가이드·100문답·데이터 리포트) / 운영(monitor-all·server·serverops·admin-applications) / 보관함(접힘 — 시연·도구·일회성·구버전·시안 20개)
- lv2 자식 계층 (`└` 표시), 폴더 라벨, 비공개·제작중 태그

### 3. settings.json — 모델 Sonnet 4.6 전환
- `C:\Users\rlasn\.claude\settings.json` — model `claude-sonnet-4-6`, fastMode false, effort high, ultracode false
- 6/11 디렉터 명시 절약모드 (~6/16 화 04시 리셋까지)

### 4. 관제일지 기록
- `Obsidian\05_HQ관제\관제일지.md` 22:00 페이지 수신+결과 2줄 append (커밋 1a543aa 시점에는 미반영 — 보고 시점이 commit 전이라 `[미검증] firebase hosting deploy` 라벨만 등록)
- HQ CLOSED 대조 대기 중

## 배포 상태

- Firebase Hosting: `firebase deploy --only hosting` 완료 (2026-06-12 07:35경)
- Hosting URL: https://quickpilot-39d72.web.app
- 296 files, 변경분 1 file 업로드

## 보호 자산 (절대 제거 금지)

페이지 세션이 만지면 안 되는 코드/노드/파일:

### admin-applications.html 내부
- 승인 버튼 onclick 순서: **sms: 호출 먼저 → status 설정 나중** (탭 제스처 안에서 동기 호출 필수. 순서 바꾸면 안드로이드가 sms intent 차단)
- 이름 추출: `nm.trim().slice(1)` (복성 edge는 디렉터가 직접 확인 — 코드 자동 추정 X. uncertainty-protocol)
- RTDB 경로 `landing/sms_template` (다른 경로로 옮기면 rules 막힘. `applications_meta`는 rules 미정의)
- 거절/삭제/대기 버튼은 sms 호출 X — 승인일 때만

### 도메인 경계
- functions/monitorSummary, RTDB `v1/app/monitor_summary`, `v1/app/data_maps` 노드 = 모니터 세션 소유. 페이지가 통째 덮기·구조 변경 X
- guide.html 등 다른 html 본문 편집 금지 (6/3 사고 — 페이지가 노트 직접 추가). qp-beta.apk 덮기 + deploy는 똘똘이(AS) 정상 절차
- functions/ 내부 = 모니터 owner

### 라우팅
- 디렉터 폰 2대 (S22·S26) 공용 사용 → 문구 저장은 로컬스토리지 X, 무조건 서버(RTDB)

## OPEN 과제 (인수받는 세션)

### 페이지 세션 OPEN
- 없음. 승인안내문자+문구편집창 완료·배포·관제일지 결과 등록 완료 (HQ CLOSED 대기)
- 잔여 검증: [실기기검증] — 디렉터 폰에서 승인 1건 실행 시 삼성 메시지 body 미리채움 확인. 이상하면 page 세션 부활해서 디버그

### 타 세션 OPEN (참고만)
- AS: 53f2bbf 인성완료viewId·29428a7 예약칩 — 설치+발화 [실기기검증] 잔여
- AS: 6/12 00:30 예약칩 시간가드 (지시함/예약칩_시간가드.md) — `\d시`가 "N시간" 소요시간 오발 → `시(?!간)` 가드
- 모니터: data_maps 진단 항목4 = `dataMapsTick`/`reconcileShadow` line 633~637 computeAggregate 호출 또는 line 639~640 read throw 의심. 함수로그 미확인
- HQ 보류: 카카오 완료추적 신설 (인성 설치검증 후)

## 도메인 owner 매핑 (변경 없음)

| 폴더 | Owner |
|---|---|
| `quickpilot-landing/*.html` (admin·hub·landing·apply·guide·vision·리포트) | 페이지 (나) |
| `quickpilot-landing/monitor-all.html`·`server.html`·`serverops.html`·`functions/` | 모니터 |
| `QuickPilot_beta/` (앱 소스) | AS (똘똘이) |

## 부활 프롬프트

```
QP 페이지 세션 부활. 너는 QuickPilot 대외 웹페이지 담당 (똘똘이개발자_QP_페이지).

폴더: C:\Users\rlasn\Documents\quickpilot-landing
모델: Sonnet 4.6 (settings.json — fastMode false, effort high, ultracode false / 6/11 절약모드 ~6/16 04시까지)

시작 시 한 번 읽기:
1. C:\Users\rlasn\Documents\quickpilot-landing\HANDOVER_PAGE_20260612.md (이 인계)
2. C:\Users\rlasn\Obsidian\00_규칙\08_관제프로토콜.md
3. C:\Users\rlasn\Obsidian\05_HQ관제\관제일지.md — 자기 페이지 세션 OPEN 행 확인

관제 프로토콜 (6/11 디렉터 제정):
- 결과 보고 채팅 코드블록 X
- Obsidian\05_HQ관제\관제일지.md에 수신 1줄·결과 1줄 append-only
- 커밋해시 + [실기기검증/logcat확인/데이터확인/빌드검증/미검증] 라벨 1개 의무

도메인 경계:
- admin-applications.html·hub.html·landing-v2.html·apply.html·guide.html·vision.html·리포트들 = 페이지 owner
- monitor-all.html·server.html·serverops.html·functions/ = 모니터 owner (만지지 마)
- QuickPilot_beta/ 앱 소스 = AS owner

절대 게이트:
- deploy(firebase hosting)는 디렉터가 그 순간 "밀어/배포해/deploy" 명시할 때만. 빌드까지만 하고 멈춤
- 다른 html 본문 편집 X. 노트는 텍스트 코드블럭으로 디렉터에게 전달
- deploy 전 git status로 타 세션 변경 확인

지금은 OPEN 과제 없음. 디렉터 새 지시 받으면 진행.
```

## 백업

- Git: 커밋 1a543aa, master 푸시 완료 (https://github.com/pnomade12-lgtm/quickpilot-landing)
- Firebase Hosting: 6/12 07:35경 release complete
- 관제일지: vault 2f0ac56 푸시 완료

세션 종료.
