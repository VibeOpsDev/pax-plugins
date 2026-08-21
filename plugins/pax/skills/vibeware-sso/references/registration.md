# 포탈 등록·SSO 키 라이프사이클 (도구 대행 범위와 사람 절차)

> ⚠️ **이 문서가 설명하는 포탈 등록 API 를 생성 앱 코드에 넣지 마라.** 등록·상태 조회는
> VibeAgent 도구(`get_portal_registration`·`register_portal_service`)가 서버에서 대행한다.
> 앱이 스스로 자기 등록을 만들거나 조회하는 코드(사용자 바인딩 Bearer)는 금지 — 권한 모델이
> 다르고 사용자 토큰이 앱에 유출된다. 앱 코드가 쓸 수 있는 포탈 API 는 portal-api.md 의
> 데이터 조회뿐이다.

## 도구가 하는 일 / 사람이 하는 일

| 단계 | 주체 |
|---|---|
| 서비스 등록 생성 | 자동 — 프로젝트 생성 시 "pable studio에 서비스 등록" 체크, 또는 웹 채팅 `register_portal_service` (멱등 — 재호출 무해). **SSO 연동은 꺼진 중립 상태로 생성** |
| 등록 상태·서비스 ID 조회 | 자동 — `get_portal_registration` (웹 채팅·로컬 MCP 동일 이름, `supportsSso` 포함) |
| SSO 연동 켜기 | 자동(웹) — `request_portal_sso_key` 가 신청 직전 활성화. **비가역(끄기 불가 — 해제는 등록 삭제뿐)이므로 반드시 사용자 확인 후** |
| SSO 키 발급 신청 | 자동(웹) — `request_portal_sso_key` (**스코프 없는 기본 키만**) / 스코프가 필요한 신청은 사람이 포탈에서 |
| 발급 승인 | **사람 — 포탈 관리자 (유일한 사람 필수 단계)** |
| 키 수령·설정값 배선 | 자동(웹) — `claim_portal_sso_key` (SSO_SECRET·SSO_SERVICE_ID 저장, 값 미노출, 누적 5회 한도 공유) / 수동 폴백 = 포탈 "확인하기" + manage_env request_input |
| 스코프 변경(재발급=회전) | 사람 — 포탈에서 스코프 선택 후 재발급 → 승인 후 `claim_portal_sso_key` 로 교체 배선 |
| 등록 수정·삭제 | 사람 — 포탈 대시보드 (도구 대행 없음) |

**스코프 정책**: 도구 신청은 항상 `requested_scopes: []` (기본 키). 사내 데이터(포탈 Bearer API)
스코프는 파급이 커서 사용자가 포탈 화면에서 직접 선택·신청한다 — AI 가 스코프 신청을 대행하지
않는다. 스코프 재발급(회전) 완료 후 사용자가 알려주면 `claim_portal_sso_key` 로 새 키를 교체한다.

로컬(플러그인) 환경엔 조회 도구만 있다 — 등록·신청·수령은 웹 VibeAgent 채팅 또는 포탈에서.
웹 `claim_portal_sso_key` 는 프로젝트 설정값 저장소(웹 [코드] 탭 `.env.local` 로 편집 권한자에게
보임)와 배포(Vercel) 환경에 저장한다 — **사용자 로컬 PC 의 `.env` 파일에는 들어가지 않는다**
(로컬 실왕복 테스트 값은 사용자가 직접 넣어야 함).

## SSO 연동 플래그 (`supportsSso`) — 상태머신보다 먼저

- 등록은 **꺼짐(false)** 으로 생성된다 — 포탈 카드는 토큰 없이 URL 직행, 서비스 ID 칩 미표시.
- 켜기는 `request_portal_sso_key` 가 신청 직전에 수행한다(포탈 PATCH — 이미 켜져 있으면 멱등).
- **forward-only**: 한 번 켜면 끌 수 없다(포탈 400 `supports_sso_forward_only`) — 해제는 등록
  삭제뿐. 그래서 켜기 전 사용자 확인이 필수다(SKILL.md 규칙 -1 "연동 상태 선확인").
- 꺼진 상태에서 키를 신청하면 포탈이 400 `sso_not_enabled` 를 반환한다 — 도구가 자동으로
  켜고 재신청하므로 모델이 직접 처리할 일은 없다.

## SSO 키 상태머신 (`ssoKeyStatus`)

`NONE → REQUESTED → APPROVED → REVEALED`

- **NONE**: 미신청 — 웹 채팅 `request_portal_sso_key` 로 신청할 수 있다. 단 **REQUESTED/
  APPROVED 를 본 적이 있는데 NONE 으로 돌아왔다면 관리자 거절/신청 회수 신호다** — 자동
  재신청을 유도하지 마라(재신청은 관리자 알림을 다시 발송해 핑퐁이 된다). 도구도 신청 이력이
  있으면 거부한다 — 사용자에게 표면화하고, 사용자가 명시하면 `force: true` 로만 재신청.
- **REQUESTED**: 관리자 승인 대기 — 사람 절차라 수 시간~수 일 걸릴 수 있다. 기다리는 동안
  DEV_BYPASS mock 으로 화면을 먼저 보여준다 (SKILL.md 규칙 0).
- **APPROVED**: 승인됨 — 웹 채팅 `claim_portal_sso_key` 로 수령·배선한다(또는 사용자가
  포탈에서 "확인하기"로 직접 수령 — 수동 폴백).
- **REVEALED**: 수령 완료 — `manage_env list_keys`(웹) 또는 env 파일(로컬)로 `SSO_SECRET`
  배선 여부를 확인한다. 배선이 비어 있으면 `claim_portal_sso_key` 가 재수령·배선한다
  (수령 카운터 1 소모). **이 상태에서 재발급 신청은 회전** — 도구가 차단하며 포탈에서 사람이.

## 서비스 ID (`serviceClaimHint`) 규칙

- 발급될 JWT 의 `service`/`aud` 클레임 값. **언제든 최신 조회값이 권위** — 저장·기억해 둔
  값을 믿지 말고 배포 직전 `get_portal_registration` 으로 재조회한다.
- `serviceClaimPinned: false` = 잠정값(승인 시 관리자가 다른 최종 ID 로 확정 가능).
- `serviceClaimPinned: true` 도 **래치가 아니다** — 승격 서비스 삭제·등록 재오픈 시 원래
  값으로 되돌아온다.
- 코드의 `SERVICE_ID` 리터럴과 달라졌으면 `SSO_SERVICE_ID` env 로 교체한다(코드 수정 불필요).

## 함정·한도

- **스코프 추가 = 키 회전**: REVEALED 상태에서 재발급 신청하면 이전 키가 **즉시 무효화**돼
  배포된 앱의 로그인이 끊긴다. 회전은 사용자가 포탈에서 진행(도구는 차단)하고, 승인 후
  `claim_portal_sso_key` 로 새 키 교체 → 재배포를 한 흐름으로 안내한다.
- **키 수령(확인하기·claim 도구 공유)은 누적 5회 한도** — 시간이 지나도 복구되지 않고,
  재발급 신청(=회전)만이 복구 경로다. claim 재시도 루프 금지 — 실패 시 남은 횟수를 표면화.
- **진행 중 등록 상한 = 사용자당 20개**: 등록 도구가 `registration_limit_reached` 를 반환하면
  사용자가 포탈 대시보드에서 사용하지 않는 등록을 정리해야 한다(도구로 삭제 불가).
- **프로젝트를 삭제해도 포탈 등록은 남는다** — 정리는 포탈 대시보드에서 사용자가 직접.
- 등록 도구의 일시 오류(503류)는 "미등록"이 아니다 — 미등록 단정 전에 재조회하거나 사용자에게
  포탈 확인을 안내한다.
