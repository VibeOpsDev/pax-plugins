# pable studio 등록·SSO 키 라이프사이클 (도구 대행 범위와 사람 절차)

> ⚠️ **이 문서가 설명하는 pable studio 등록 API 를 생성 앱 코드에 넣지 마라.** 등록·상태 조회는
> PAX 도구(`get_portal_registration`·`register_portal_service`)가 서버에서 대행한다.
> 앱이 스스로 자기 등록을 만들거나 조회하는 코드(사용자 바인딩 Bearer)는 금지 — 권한 모델이
> 다르고 사용자 토큰이 앱에 유출된다. 앱 코드가 쓸 수 있는 pable studio API 는 portal-api.md 의
> 데이터 조회뿐이다.

## 도구가 하는 일 / 사람이 하는 일

| 단계 | 주체 |
|---|---|
| 서비스 등록 생성 | 자동 — 프로젝트 생성 시 "pable studio에 서비스 등록" 체크, 또는 `register_portal_service` (웹·로컬 공통, 멱등 — 재호출 무해. **`confirmedNew` 필요**). **SSO 연동은 꺼진 중립 상태로 생성** |
| 등록 상태·서비스 ID 조회 | 자동 — `get_portal_registration` (웹 채팅·로컬 MCP 동일 이름, `supportsSso`·`revealCount` 포함) |
| SSO 연동 켜기 | 자동(웹·로컬 공통) — `request_portal_sso_key` 가 신청 직전 활성화. **비가역(끄기 불가 — 해제는 등록 삭제뿐)이므로 반드시 사용자 확인 후** |
| SSO 키 발급 신청 | 자동(웹·로컬 공통) — `request_portal_sso_key` (**스코프 없는 기본 키만**) / 스코프가 필요한 신청은 사람이 pable studio에서 |
| 발급 승인 | **사람 — pable studio 관리자 (유일한 사람 필수 단계)** |
| 키 수령·설정값 배선 | 자동(웹·로컬 공통) — `claim_portal_sso_key` (SSO_CLIENT_ID·SSO_CLIENT_SECRET(+PORTAL_URL) 저장, 값 미노출, 누적 5회 한도 공유) / 수동 폴백 = pable studio "키 확인" + 입력 카드(웹 manage_env request_input · 로컬 set_vercel_env) |
| 스코프 변경 | 사람 — pable studio "SSO 키 · 스코프" 창에서 스코프 신청 → 관리자 승인(키·배선·배포 그대로) |
| 키 재발급 | 사람 — pable studio "SSO 키 · 스코프" 창(이전 키 1시간 함께 통과, 유출이면 즉시 중단 · 등록마다 24시간에 3번까지, 넘으면 `429 rotate_limit`) → `claim_portal_sso_key` force 로 교체 배선 |
| 등록 수정·삭제 | 사람 — pable studio 대시보드 (도구 대행 없음) |

**스코프 정책**: 도구 신청은 항상 `requested_scopes: []` (기본 키). 사내 데이터(pable studio Bearer API)
스코프는 파급이 커서 사용자가 pable studio 화면에서 직접 선택·신청한다 — AI 가 스코프 신청을 대행하지
않는다. 스코프 변경은 키를 바꾸지 않는다(재배선·재배포 불필요).

등록·신청·수령 도구는 **웹 채팅과 로컬 브리지 양쪽에 같은 이름으로 있다**(1.1.0 부터).
`claim_portal_sso_key` 는 프로젝트 설정값 저장소(웹 [코드] 탭 `.env.local` 로 편집 권한자에게
보임)와 배포(Vercel) 환경에 저장한다 — **사용자 로컬 PC 의 `.env` 파일에는 들어가지 않는다.**
로컬 실왕복 테스트 값은 사용자가 직접 넣어야 하고, 그 값은 **웹 [코드] 탭 `.env.local` 에서 복사**하는
것이 우선이다(pable studio "키 확인"은 누적 5회 한도를 소모한다).

⚠️ **사용자가 pable studio에서 직접 만든 등록은 이 도구들로 조회·신청·수령이 전부 불가능하다**
(pable studio가 bearer 접근을 등록 출처로 제한한다 — 목록·id 조회·중복 응답 세 경로 모두). `registered:
false` 를 "미등록" 으로 단정하지 말고 사용자에게 직접 등록 여부를 먼저 확인할 것. 이미 있으면
새로 만들지 말고 그 카드 "SSO 키 · 스코프" 창의 값으로 배선한다 — 서비스 ID(`dev-…`) → `SSO_CLIENT_ID` · 비밀 키 → `SSO_CLIENT_SECRET` ·
pable studio 주소 → `PORTAL_URL`(토큰 발급자 — 글자 그대로). 서명 키 하나만 보이면 기존 v1 등록이다(SKILL.md 규칙 -0.5).

## 로그인 방식 (`ssoProtocol`) — 새 등록은 전부 v2

- pable studio가 **등록마다 처음 키를 신청할 때 한 번** 정하고 바꾸지 않는다. **새 신청은 v2 다**(client_id `dev-{등록 id}` + client secret, 인가 코드 + PKCE + ES256) —
  pable studio 는 새 등록에 v1 을 발급하지 않는다. `'v1'`(서비스별 HS256 키 `SSO_SECRET`)은 **이미 v1 키를 받은 기존 등록**뿐이고, 그 앱의
  유지보수만 `sso-v1.md` 로 한다(앱에 v1 코드가 없으면 만들지 않는다 — SKILL.md 규칙 -0.5). `null` = 신청 전.
  사용자는 몰라도 된다 — 코드 레시피를 고르는 근거일 뿐이다.
- **pable studio 가 아직 v2 를 지원하지 않으면**(상태 응답에 `sso_protocol` 칸이 없다 — migration 010 이전 pable studio) `request_portal_sso_key` 가
  **신청하지 않고** `reason: "v2_unavailable"` 로 멈춘다. 그대로 신청하면 그 등록이 v1 으로 영구 고정되기 때문이다. 신청 결과가 v1 으로 오면
  (`loginCodeBlocked: true`) 로그인 코드를 만들지 않고 안내만 한다.
- `request_portal_sso_key` 결과의 `protocol`, `get_portal_registration` 의 `ssoProtocol`·`clientId`·`scopeChangePending` 으로 본다.
- client_id 는 **정식 서비스로 승격해도 바뀌지 않는다**(`serviceClaimHint` 도 client_id).
- **배포 주소는 도메인 루트**(`https://도메인`)여야 한다 — pable studio 는 경로 아래 주소(`https://host/app`)도 받지만 돌아갈 주소를 **그 경로 아래**로 등록해, 도메인 루트 전용인 PAX 로그인 코드와 맞지 않는다. 그래서 `request_portal_sso_key` 가 경로 있는 주소는 `url_has_path` 로 신청하지 않는다. 키를 받은 뒤 배포 주소에 경로를 붙여도 로그인이 끊긴다("등록되지 않은 서비스").
- **(v2 출시 전 확인) 로그인 유지 스위치** — pable studio 운영자 설정의 SSO v2 **'로그인 유지' 전역 스위치가 켜져 있어야** 한다.
  꺼져 있으면 refresh token 이 발급되지 않아 **로그인 1분쯤 뒤부터** `getAccessToken()` 이 `login_required` 다 — ① pable studio API(Bearer)
  호출이 멈추고(데이터 API `sso_required`) ② `requireLiveSession()` 으로 연 민감한 동작(삭제·권한 변경·외부 발송 — 레시피 규칙 12)이 누를 때마다
  다시 로그인을 요구한다. 둘 다 없는 앱(읽기 화면만)은 영향이 없다. '사내망 전용' 서비스는 스위치와 무관하게 로그인 유지가 없다. 코드로 고칠 수 없으니
  사용자에게 pable studio 관리자 확인을 요청한다(레시피 `sso-v2.md` 의 출시 전 체크리스트).

## SSO 연동 플래그 (`supportsSso`) — 상태머신보다 먼저

- 등록은 **꺼짐(false)** 으로 생성된다 — pable studio 카드는 토큰 없이 URL 직행, 서비스 ID 칩 미표시.
- 켜기는 `request_portal_sso_key` 가 신청 직전에 수행한다(pable studio PATCH — 이미 켜져 있으면 멱등).
- **forward-only**: 한 번 켜면 끌 수 없다(pable studio 400 `supports_sso_forward_only`) — 해제는 등록
  삭제뿐. 그래서 켜기 전 사용자 확인이 필수다(SKILL.md 규칙 -1 "연동 상태 선확인").
- 꺼진 상태에서 키를 신청하면 pable studio가 400 `sso_not_enabled` 를 반환한다 — 도구가 자동으로
  켜고 재신청하므로 모델이 직접 처리할 일은 없다.

## SSO 키 상태머신 (`ssoKeyStatus`)

`NONE → REQUESTED → APPROVED → REVEALED`

- **NONE**: 미신청 — `request_portal_sso_key` 로 신청할 수 있다(웹·로컬 공통). 단 **REQUESTED/
  APPROVED 를 본 적이 있는데 NONE 으로 돌아왔다면 관리자 거절/신청 회수 신호다** — 자동
  재신청을 유도하지 마라(재신청은 관리자 알림을 다시 발송해 핑퐁이 된다). 도구도 신청 이력이
  있으면 거부한다 — 사용자에게 표면화하고, 사용자가 명시하면 `force: true` 로만 재신청.
- **REQUESTED**: 관리자 승인 대기 — 사람 절차라 수 시간~수 일 걸릴 수 있다. 기다리는 동안
  DEV_BYPASS mock 으로 화면을 먼저 보여준다 (SKILL.md 규칙 0).
- **APPROVED**: 승인됨 — `claim_portal_sso_key` 로 수령·배선한다(웹·로컬 공통. 또는 사용자가
  pable studio에서 "키 확인"으로 직접 수령 — 수동 폴백, 5회 한도 소모).
- **REVEALED**: 수령 완료 — `manage_env list_keys`(웹) 또는 `list_vercel_env`(로컬)로 `SSO_CLIENT_SECRET`
  배선 여부를 확인한다. 배선이 비어 있으면 `claim_portal_sso_key` 가 재수령·배선한다
  (수령 카운터 1 소모). **이 상태에서 다시 신청하면 스코프 변경**이다(빈 스코프면 승인 스코프가 빠진다) — 도구는 신청하지 않고 안내만 한다.
  스코프 변경 신청은 `scopeChangePending: true` 로 보이고, 그동안 키·로그인은 그대로다. (기존 v1 등록은 이 상태의 재신청이 키 회전이라 도구가 막는다.)

## client_id (`clientId`)

- 토큰의 `aud` 이자 `SSO_CLIENT_ID` 값(`dev-{등록 id}`). `serviceClaimHint` 도 같은 값이다. 승격해도 바뀌지 않는다 — 비밀이 아니다.
- `claim_portal_sso_key` 가 저장한다. 코드에 적지 않는다(env 로만).
- (기존 v1 등록의 서비스 ID 잠정값 규칙은 `sso-v1.md` §2.)

## 함정·한도

- **키 수령(키 확인·claim 도구 공유)은 누적 5회 한도** — 시간이 지나도 복구되지 않고,
  키 재발급만이 복구 경로다(이전 키 1시간 유예, 확인 횟수는 처음부터). claim 재시도 루프 금지 — 실패 시 남은 횟수를 표면화.
- **진행 중 등록 상한 = 사용자당 20개**: 등록 도구가 `registration_limit_reached` 를 반환하면
  사용자가 pable studio 대시보드에서 사용하지 않는 등록을 정리해야 한다(도구로 삭제 불가).
- **프로젝트를 삭제해도 pable studio 등록은 남는다** — 정리는 pable studio 대시보드에서 사용자가 직접.
- 등록 도구의 일시 오류(503류)는 "미등록"이 아니다 — 미등록 단정 전에 재조회하거나 사용자에게
  pable studio 확인을 안내한다.
