---
name: pax-sso
description: "PAX(preview) · 회사 계정(pable studio·스튜디오) 로그인 연동 — \"로그인 붙여줘\", \"회사 계정으로 로그인\", \"MS·오피스365·아웃룩·Entra 계정 로그인\", \"사내 구성원·조직도·회의실·캘린더·메일 불러와\" 요청에 사용. 사내 앱은 스튜디오 SSO가 기본이며 MS 직접 연동보다 우선. Google·Kakao 등 외부 소셜·일반 로그인은 대상 아님."
---

<!--
  SYNC: 이 파일은 내장 스킬 사본과 쌍둥이다 → (PAX repo) skills/pax-sso/SKILL.md
  코어 규칙·코드·references 는 두 사본을 동일하게 유지. body 는 env 배선/참조 로딩만 다름.
  pable studio 화면 라벨의 정본 출처 = VibeWare app/admin/page.tsx TABS (가이드 문서 라벨은 stale 가능).
-->

# pable studio SSO 연동 (회사 계정 로그인) — 로컬 개발

**Codex:** PAX 연결은 호스트가 자동 전달하는 현재 채팅의 `threadId`로 선택됩니다. 도구 인자에 채팅 ID를 만들거나 다른 채팅의 값을 넣지 마세요. 연결은 `connect`, 해제는 `disconnect`, 스킬 저장은 `sync_skills` 도구를 사용합니다. `session_required`면 Codex 업데이트·재시작을 안내하고 최근 연결이나 폴더 연결로 우회하지 않습니다. 로컬 파일을 바꾸기 전에는 연결 서비스와 작업 폴더가 맞는지 확인하세요. Claude Code의 기존 호출 방식은 유지합니다.

로컬에서 이어 개발하는 앱에 **회사 계정(pable studio) 로그인**을 붙이고, 로그인 뒤에는 **pable studio Bearer API 로 사내 데이터**(구성원·회의실·본인 캘린더/메일·프레즌스)를 불러올 수 있다. 로그인은 **SSO v2** 다 — 인가 코드 + PKCE + client secret 으로 pable studio 접근 토큰(ES256)을 받아 자체 세션 쿠키를 만든다. **로그인 코드는 같은 폴더의 `references/sso-v2.md` 레시피를 그대로 쓴다**(이미 v1 로 만들어진 기존 앱의 유지보수만 예외 — 규칙 -0.5).

## 규칙 -1 — 스코프 가드 (먼저 판정, 무조건 시작 금지)

이 스킬의 범위는 두 가지다.

1. **pable studio SSO(회사 계정 로그인) 연동**
2. **pable studio Bearer API 로 사내 데이터 조회·발송** — 조직 구성원(임직원·조직도)·프로필 사진·회의실 free/busy·본인 캘린더/연락처/메일·프레즌스·메일 발송. Microsoft 365(Graph) 사내 데이터는 pable studio가 프록시한다. 상세는 같은 폴더의 `references/portal-api.md`.

**로그인 라우팅 규칙** — "Microsoft/MS 계정 로그인"·"오피스365/아웃룩 계정 로그인"·"Entra(Azure AD) 로그인"·"회사 계정 로그인" 요청은 **전부 1번(pable studio SSO)이 기본 경로다**. pable studio 자체가 회사 Microsoft(Entra) 계정 SSO 라서, 사내 사용자 대상 앱은 pable studio 로그인이 곧 MS 로그인이다 — MS 직접 연동을 먼저 제안하지 마라(비개발자 사용자는 이 구분을 모른다). 판별이 필요하면 질문은 하나만: **"이 앱은 회사 동료들이 쓰나요, 회사 밖 사람들도 쓰나요?"** 회사 동료 대상이면 그대로 pable studio SSO 로 진행하고(추가 확인 불필요), 회사 밖 사용자가 각자 개인/타조직 Microsoft 계정으로 로그인해야 하는 앱만 직접 MS 연동 대상이다(아래 "직접 MS 연동은 명시 요청 시에만" 준수).

**연동 상태 선확인 (로그인 코드보다 먼저)** — pable studio SSO 로 진행하기로 했으면 `get_portal_registration` MCP 도구로 이 프로젝트의 연동 상태(`supportsSso`)부터 확인한다. 신규 프로젝트는 **SSO 연동이 꺼진 채(중립) 등록**되므로 대개 꺼져 있다 — 이때는 코드를 만들기 전에 **"pable studio SSO 연동을 켜고 키 발급을 신청해야 해요. 한 번 켜면 끌 수 없어요(해제는 등록 삭제뿐)"라고 안내하고 사용자 확인을 받은 뒤**, `request_portal_sso_key` 를 `enableConfirmed: true` 로 호출한다(연동 켜기+신청을 함께 수행 — 여기서 바로 되며 웹으로 건너갈 필요 없다). 동의 없이 호출하면 도구가 거부한다. 확인 없이 켜도록 유도하지 마라. 단 **사용자가 "pable studio가 아니라 진짜 Microsoft 로그인"이라고 명시하면 이 안내·확인 흐름을 강요하지 말고 막지도 마라** — 그대로 직접 MS 연동 경로로 진행한다.

**사내 데이터 라우팅 규칙** — 회사 구성원·임직원·조직도·동료 목록·회의실 현황·사내 캘린더/메일/연락처/자리 여부(프레즌스) 등 **실제 사내 시스템의 데이터를 불러오려는 요청이면 2번으로 진행**한다. MS Graph 직접 연동·MS 토큰 입력을 유도하지 말고, 브라우저 개발자도구(Network 탭)에서 API 주소나 토큰을 채집하도록 안내하지도 마라. 단:

- **선행조건 동일** — pable studio 데이터 조회도 SSO 키(`SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`) 발급 + 해당 스코프 승인이 필요하다. 키 미발급 상태면 데이터 코드보다 먼저 아래 "SSO 키 발급" 워크스루(+필요 스코프 체크)로 안내한다.
- **pable studio 미지원 데이터**(그룹/팀 멤버 목록·Teams·OneDrive·SharePoint·타인 캘린더)는 "pable studio에서 아직 지원되지 않아요"라고 명확히 안내하되, 막다른 길로 끝내지 말고 대안을 순서대로 제시한다: ① 전체 구성원 목록을 불러온 뒤 앱에서 필요한 인원만 골라 쓰기(권장 — `graph.User.Read.All` 스코프 필요) ② 명단을 엑셀·CSV 로 받아 반영 ③ 그룹 단위 조회가 꼭 필요하면 pable studio 관리자에게 기능 추가 요청. 브라우저에서 복사한 MS 액세스 토큰을 설정값으로 저장하는 우회는 먼저 제안하지 마라 — 그 토큰은 보통 1시간이면 만료돼 앱이 곧 깨진다.
- **이 레시피가 아직 지원하지 않는 로그인 형태** — ① Teams 탭(pable studio [Teams 앱으로 만들기]) 안에서의 로그인 ② 기능 단위 사내망 제한(사내에서만 출퇴근 기록 등 — 세션의 `network_zone` 으로 막는 것도 금지, `sso-v2.md` 규칙 11) ③ 도메인 경로 아래(`https://host/app`·Next `basePath`)에 둔 앱. 요청받으면 만들지 말고 "pable studio 로그인으로는 아직 지원되지 않아요"라고 안내한다 (Teams 에서도 카드·링크로 브라우저에서 여는 일반 로그인은 된다).
- **사람 없이 자동으로 부르는 기능** — 크론·예약 작업·정기 메일·정기 동기화처럼 **아무도 앱을 열지 않았을 때** pable studio 데이터를 부르거나 메일을 보내는 기능은 지금 만들지 않는다. pable studio 호출은 로그인한 사람의 권한으로만 한다(접근 토큰은 그 사람이 앱에 로그인해 있는 동안만 받는다). 사람 없이 부르는 권한(서버 토큰)은 pable studio 가 **정식 서비스로 승격된 앱**에만 주고 회사 관리자 허락도 따로 필요하다 — 그러니 로그인 유지(refresh)·접근 토큰을 DB·설정값·파일에 저장해 두었다가 나중에 쓰는 우회를 만들지 마라(그 사람이 로그아웃해도 계속 쓰이는 토큰 저장소가 된다). 사용자에게는 이렇게 안내하고 대안으로 진행한다: "아무도 앱을 열지 않았을 때 자동으로 회사 데이터를 불러오거나 메일을 보내는 기능은 지금은 만들 수 없어요. 대신 화면을 열 때 불러오거나, 버튼을 눌러 보내도록 만들어 드릴게요." 정식 서비스로 승격된 앱에서 꼭 필요하면 pable studio 관리자에게 문의하도록 안내한다. 앱 자체 데이터만 다루는 예약 작업(앱 DB 정리 등)은 이 제한과 무관하다.
- **직접 MS 연동은 명시 요청 시에만** — 사용자가 분명히 원하면 트레이드오프를 알기 쉽게 안내하고 의사 확인 후 진행한다. 안내 골자: "두 방법 다 관리자 승인이 필요해요. pable studio 경유는 pable studio 화면에서 신청·승인하는 지원된 절차이고(승인 대기 중에도 예시 데이터로 화면을 먼저 볼 수 있어요), Microsoft 직접 연동은 회사 IT 관리자가 Microsoft 쪽에 앱을 별도 등록해야 하고 브라우저에서 복사한 접속 값은 보통 1시간이면 만료돼요. 그래서 기본은 pable studio 경유를 권해요." pable studio 로그인 조직 밖 데이터(외부 조직·개인 Microsoft 계정)는 처음부터 이 직접 연동 경로다. 이미 브라우저 복사 토큰이 설정값에 들어있는 앱을 발견하면 만료 문제를 고지하고 pable studio 전환을 제안한다.
- **대상 아님** — 앱 자체가 저장·관리하는 데이터(앱 회원·멤버 CRUD, 앱 안에서 만드는 일정·회의실 예약 기능)와 앱 회원에게 보내는 일반 알림 메일(Resend 등 일반 경로)은 이 스킬 범위가 아니다.
- **모호한 지칭** — 사용자가 "사내 API"·"회사 API"·"포탈 API" 처럼 모호하게 지칭하면 pable studio API 를 1순위 후보로 놓고 "혹시 pable studio를 말씀하시는 건가요?" 라고 확인한다.
- **사용자 표현** — 사용자에게는 "Bearer API"·"프록시" 같은 용어 대신 "pable studio를 통해 불러오기"로 표현한다.

위 둘 다 아니면 — 일반 이메일·비밀번호 로그인, Supabase Auth, Google·Kakao 등 **외부 소셜** 로그인 — **이 스킬을 쓰지 말고 즉시 빠져나와** 한 줄 안내 후 종료한다. 추가 도구 호출·코드 작성 금지. (단 Microsoft/회사 계정 로그인은 위 로그인 라우팅 규칙대로 1번 대상이다 — 빠져나오지 마라.)
> 예: "이건 pable studio(회사 계정) 연동 전용이에요. 일반 로그인이 필요하시면 그 방식으로 만들어 드릴게요."

## 규칙 -0.5 — 로그인 방식: 새 앱은 전부 v2

pable studio 는 **새 등록에 v2 만 발급한다** — 등록마다 처음 키를 신청할 때 방식이 정해지고 바뀌지 않는다. **사용자는 방식을 모른다** — v1·v2(옛·새 방식)는 코드 레시피를 고르는 내부 구분일 뿐이니 사용자에게 묻지도 말하지도 마라. 사용자에겐 그냥 "pable studio 로그인"(간편 로그인·SSO)이다. 로그인 코드를 쓰기 전에 `get_portal_registration` 의 **`ssoProtocol`** 을 본다:

| `ssoProtocol` | 할 일 |
|---|---|
| `'v2'` | **같은 폴더의 `references/sso-v2.md` 를 먼저 읽고 그 코드 그대로** 만든다 — 설정값 `SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`·`PORTAL_URL` |
| `null` (키 신청 전) | 아래 "SSO 키 발급" 흐름으로 신청한다 — 새 신청은 v2 로 정해진다. 기다리는 동안의 DEV_BYPASS mock 화면도 **v2 레시피(`references/sso-v2.md`) 파일로** 만든다(키가 없어도 `/login` 안내로 degrade 해 로컬 실행·배포가 깨지지 않는다) |
| `'v1'` (기존 등록) | **앱에 v1 로그인 코드가 이미 있을 때 그 유지보수만** — 같은 폴더의 `references/sso-v1.md`. 앱에 아직 로그인 코드가 없으면 **만들지 말고 멈춘다**: "이 서비스에는 지금 pable studio 로그인을 붙일 수 없어요. pable studio 관리자에게 문의해 주세요." |

- `request_portal_sso_key` 가 신청하지 않고 멈추거나(`reason: "v2_unavailable"` — pable studio 가 아직 새 방식을 지원하지 않는다), 신청 결과가 v1 이면(`loginCodeBlocked: true`) **로그인 코드를 만들지 말고** 도구가 준 안내를 사용자에게 전하고 멈춘다. DEV_BYPASS mock 화면은 v2 파일로 둬도 된다.
- **두 방식을 섞지 마라** — v2 앱에 토큰을 주소로 받는 진입점·`SSO_SECRET`·`SSO_SERVICE_ID` 를 두지 않고, v1 앱에 v2 파일을 더하지 않는다. 키를 기다리며 만든 다른 방식 파일이 있으면 정해진 방식으로 **바꾼다**(옆에 더하지 않는다).
- 등록 조회가 안 되는 경우(사용자가 pable studio에서 직접 만든 등록 — 아래 "직접 등록해 둔 경우") 그 카드 "SSO 키 · 스코프" 창에 **서비스 ID(`dev-…`)·비밀 키·pable studio 주소** 세 값이 보이면 v2 다. **서명 키 하나**만 보이면 기존 v1 등록이다 — 위 `'v1'` 행대로 한다.

**혼동 금지 — 아래는 전부 그대로 진행한다(중단하지 마라):** 여러 회사 사용자가 각자 자기 계정으로 로그인하는 앱 / 회사별 데이터 분리 / 특정 회사만 허용(`ALLOWED_TENANT_IDS`) / 역할별 화면 분기.

이 레시피는 **계정 하나로 로그인하는 앱**용이다. **한 사용자가 앱 안에서 회사 계정 A·B 를 동시에 붙잡고 전환**하는 계정 전환기는 이 스킬에 검증된 레시피가 없으니 **코드를 즉석에서 지어내지 마라** — 한 줄 안내 후 종료하고 **추가 도구 호출·코드 작성 금지**.
> 예: "한 앱에 회사 계정을 여러 개 등록해 번갈아 쓰는 기능은 아직 만들어 드릴 수 없어요. pable studio 관리자에게 '다중 계정 연동'을 문의해 주세요. 계정 하나로 로그인하는 기능이면 지금 바로 만들어 드릴게요."

## 규칙 0 — 선행조건 (코드 쓰기 전 필수)

등록 상태 확인·등록 생성·키 신청·수령/배선이 **전부 MCP 도구로 여기서 된다**(`get_portal_registration`·`register_portal_service`·`request_portal_sso_key`·`claim_portal_sso_key`) — **관리자 승인만 사람 절차다.** 단 `claim_portal_sso_key` 는 프로젝트 설정값 저장소와 배포(Vercel) 환경에만 키를 저장한다 — **사용자 로컬 PC 의 `.env` 파일에는 들어가지 않고**, **`SSO_CLIENT_SECRET` 값 자체를 브리지가 내려주지도 않는다**(`SSO_CLIENT_ID`·`PORTAL_URL` 은 공개값이라 `get_public_env` 의 `publicKeys` 로 내려온다). 로컬 실왕복 테스트용 값은 아래 "로컬에서 SSO_CLIENT_SECRET 구하기" 순서로 받는다.

1. **먼저 DEV_BYPASS mock으로 돌린다.** 실제 키가 없어도 `DEV_BYPASS_SSO=true`로 로그인·역할 등급이 도는 화면을 즉시 보여줄 수 있다(`references/sso-v2.md` 의 `buildDevMockSession`). v2 레시피는 설정값이 없으면 `/login?error=config` 안내로 degrade 하므로 코드를 키보다 먼저 만들어도 안전하다.
2. **실제 SSO는 키가 있어야 한다.** 사용자가 아직 키가 없으면 아래 **"SSO 키 발급"** 워크스루로 안내. 키가 준비되면 아래 **env 배선**의 배포/로컬 경로로 넣는다.
3. `SSO_CLIENT_SECRET` 값을 채팅으로 보여주거나 되묻지 마라. 사용자에게 값만 받아 파일/원격에 넣고, 이후엔 키 이름만 확인한다(값 미출력).

## 동작 개요 + 만들 파일

```
[사용자] → pable studio 카드 클릭 → {앱}/auth/sso?iss={pable studio}&login_hint={계정}&theme={컬러 모드}
  → /auth/sso: state·PKCE 를 암호화 쿠키에 두고 pable studio 인가 화면으로
    → (pable studio 에 로그인돼 있으면 화면 없이) {앱}/auth/sso/callback?code=…&state=…
      → callback: 서버에서 code 교환(client secret) → 접근 토큰(ES256) 검증 → 앱 세션 쿠키 → /

[세션 없음·만료] → 페이지가 /auth/sso 로 보낸다 → 위 흐름(대개 화면 없이 다시 로그인)
```

파일 목록·코드·규칙은 **같은 폴더의 `references/sso-v2.md` 를 읽고 그대로** 쓴다(`lib/sso.ts`·`lib/portal-token.ts`·`app/auth/sso/route.ts`·`app/auth/sso/callback/route.ts`·`app/login/page.tsx`·`app/auth/logout/route.ts`). 앱에 다크 모드가 있으면 카드의 컬러 모드를 레시피의 "컬러 모드" 절대로 적용한다(없으면 건너뛴다). 경로(`/auth/sso`·`/auth/sso/callback`)를 바꾸지 마라 — pable studio 가 등록 주소마다 이 두 경로를 자동으로 등록해 둔다. 기억으로 코드를 지어내지 마라. 로컬 AI는 이 파일들을 **로컬 파일시스템에 직접 작성**한다.

## SSO 키 발급 (승인만 사람 — 등록·신청·수령/배선은 MCP 도구가 자동)

관리자 승인만 사람 절차다. 아래 도구 작업은 **이 대화에서 바로** 진행한다. 순서(딥링크 `{PORTAL_URL}/dashboard/dev` — **`{PORTAL_URL}` 자리는 `get_portal_registration` 응답의 `portalUrl` 값으로 채워** 실제 링크로 안내한다. pable studio 주소를 사용자에게 묻지 마라):

1. **등록 확인** — `get_portal_registration` 으로 확인한다. `registered: false` 여도 **"등록 안 됨" 으로 단정하지 마라** — 이 도구는 PAX 가 만든 등록만 본다(아래 "pable studio에 직접 등록해 둔 경우" 참조). 사용자에게 직접 등록 여부를 물어 **없다고 하면** `register_portal_service` 를 `confirmedNew: true` 로 호출한다(**등록은 SSO 연동이 꺼진 중립 상태로 생성됨**).
2. **연동 켜기 + 키 신청** — 사용자 확인(규칙 -1 "연동 상태 선확인") 후 `request_portal_sso_key` 를 `enableConfirmed: true` 로 호출한다: 연동이 꺼져 있으면 먼저 켜고(**비가역 — 한 번 켜면 끌 수 없음, 해제는 등록 삭제뿐**) 이어서 신청한다(**스코프 없는 기본 키만**). 신청되면 상태가 "관리자 승인 대기 중"이 된다.
3. **관리자 승인** — **관리자**(다른 사람)가 `{PORTAL_URL}/admin` → **"SSO 발급 승인"** 탭에서 승인 → 상태 "승인됨 — 확인 대기". 여기만 사람이 한다.
4. **수령·배선** — `claim_portal_sso_key` 가 client_id·client secret 을 수령해 프로젝트 설정값 저장소 + 배포(Vercel) 환경에 `SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`(+`PORTAL_URL` 이 없으면 pable studio 발급자 주소)으로 자동 저장한다(값 미노출) + 재배포. **사용자 로컬 PC 의 `.env.development.local` 에는 안 들어간다** — 로컬 실왕복 테스트에 필요한 값은 아래 "로컬에서 SSO_CLIENT_SECRET 구하기" 순서로 받는다.
5. **스코프가 필요해지면** — 사용자가 pable studio "SSO 키 · 스코프" 창에서 스코프를 골라 신청 → 관리자 승인 → **키·배선·배포 그대로**(다음 로그인부터 반영). `request_portal_sso_key` 로 다시 신청하지 마라(빈 스코프로 신청하면 승인된 스코프가 빠진다 — 도구도 하지 않는다).

**승인 대기가 "막힘"이 되지 않게** — 3에서 승인을 기다리는 동안에도 DEV_BYPASS mock 으로 앱이 도는 걸 보여주고, 승인 후 4로 전환한다.

> **키 재발급**(유출·한도 소진 등)은 사용자가 pable studio "SSO 키 · 스코프" 창에서 한다 — 이전 키가 1시간 함께 통과해 배포 앱 로그인이 바로 끊기지 않는다(유출 대응이면 즉시 중단). 재발급은 등록마다 **24시간에 3번까지**다(넘으면 pable studio가 `429 rotate_limit` 으로 거절한다 — 되풀이하지 말고 하루 뒤). 재발급 뒤 `claim_portal_sso_key` 를 `force: true` 로 호출해 교체 배선 → 재배포. 로컬 값도 그때 교체.

### client_id 확인 (먼저 도구로 조회 — 사용자에게 바로 묻지 마라)

client_id(`dev-{번호}`)는 pable studio 가 등록에 준 식별자이고 **지어내는 값이 아니다.** 토큰의 `aud` 와 같고, 정식 서비스로 승격해도 바뀌지 않는다. 비밀이 아니다.

1. **`get_portal_registration` 도구를 먼저 호출한다** (웹 채팅·로컬 MCP 동일 이름·동일 동작). 응답의 `clientId` 가 곧 `SSO_CLIENT_ID` 값이다 — `claim_portal_sso_key` 가 배포 환경에 자동 저장하므로 코드에 적지 않는다.
2. `registered: false` 면: 사용자에게 직접 등록 여부를 먼저 묻고, 없다고 하면 `register_portal_service` 를 `confirmedNew: true` 로 호출한다(등록만 — 키 발급은 별개). 이미 있다고 하면 아래 "pable studio에 직접 등록해 둔 경우" 로 간다.
3. 도구가 조회 실패(일시 오류)를 반환하면 **미등록으로 단정하지 말고** 잠시 후 다시 조회한다. 사용자에게 확인을 부탁할 때는 pable studio `{PORTAL_URL}/dashboard/dev` → "내 서비스" 카드의 **"서비스 ID" 칩**(`dev-…`)을 본다 — 칩은 "SSO 연동"이 켜져 있어야 보인다.

### pable studio에 직접 등록해 둔 경우 (도구로 안 보인다)

`get_portal_registration` 은 **PAX 가 만든 등록만** 조회할 수 있다. 사용자가 pable studio 대시보드에서 직접 만든 등록은 조회·신청·수령이 **전부 불가능**하고 `registered: false` 로 보인다. 그 상태에서 `register_portal_service` 를 부르면 같은 repo 에 **두 번째 등록**이 생겨 서비스 ID 가 갈린다(식별자가 다르면 충돌 에러도 안 난다). 그래서 `confirmedNew` 확인이 필요하다.

사용자가 "직접 등록했다" 고 하면 **새로 만들지 말고** 이렇게 한다:

1. **그 카드의 GitHub 주소가 이 프로젝트의 repo 와 같은지 사용자에게 확인받는다** — PAX 는 이걸 대조할 수 없으니 사람이 확인해야 한다. repo 주소를 화면에 적어 주고 비교하게 하라.
2. 카드 "SSO 키 · 스코프" 창에 보이는 값으로 배선한다: **서비스 ID**(`dev-…`) → `set_vercel_env` `SSO_CLIENT_ID`, **비밀 키** → `set_vercel_env` `SSO_CLIENT_SECRET`(값은 채팅에 다시 출력하지 않는다), **pable studio 주소** → `set_vercel_env` `PORTAL_URL`(토큰 발급자 검증값이라 **그 창의 값을 글자 그대로** — 이 경로는 `claim_portal_sso_key` 를 거치지 않아 자동 배선이 없다) → `request_vercel_deploy`. 서명 키 하나만 보이면 기존 v1 등록이다(규칙 -0.5 `'v1'` 행).
3. **로그인 1회로 확정한다** — 실패하면 `references/sso-v2.md` 의 "증상 → 원인 찾기" 표로 원인을 찾는다.

⚠️ 이 경로에서는 `supportsSso`·`ssoKeyStatus`·`revealCount` 를 **전부 조회할 수 없다.** "키를 알려주세요" 라고만 하면, SSO 연동이 꺼져 있어 "SSO 키 확인" 버튼 자체가 없는 사용자가 그 자리에서 막힌다. 선결 조건부터 안내하라: 카드에서 SSO 연동이 켜져 있는지 → 키를 신청했는지 → 관리자 승인이 났는지 → 그 다음 카드의 "SSO 키 확인" → "키 확인". 남은 확인 횟수도 모르므로 **추측하지 말고** "누적 5회 한도" 라는 사실만 말한다.

## 로컬에서 SSO_CLIENT_SECRET 구하기 (순서를 지킬 것)

`SSO_CLIENT_SECRET` 은 브리지 도구로 못 받는다 — 브리지가 내려주는 비밀은 Supabase 값(편집자/소유자의 `get_service_role_key`)뿐이다. `SSO_CLIENT_ID`·`PORTAL_URL` 은 `get_public_env` 의 `publicKeys` 로 온다. 그래서 비밀값은 사용자에게 받아야 하는데, **어디서 받는지가 중요하다.**

1. **PAX 웹 작업공간의 `.env.local`에서 복사** ← **먼저 이걸 안내한다.**
   - PAX 웹에서 이 프로젝트를 열면 파일 목록에 `.env.local`이 있고, 거기 `SSO_CLIENT_SECRET`이 그대로 보인다(편집자 이상 + GitHub 쓰기 권한).
   - **pable studio 확인 횟수를 소모하지 않는다.** 이미 `claim_portal_sso_key`로 배선했거나 `set_vercel_env`로 넣은 프로젝트면 항상 이 경로가 가능하다(둘 다 설정값 저장소에 기록한다).
2. **pable studio "키 확인"** (1이 안 될 때만)
   - `{PORTAL_URL}/dashboard/dev` → 내 서비스 카드 → **"SSO 키 확인"** → **"키 확인"**.
   - ⚠️ **누적 5회 한도**이고 시간이 지나도 복구되지 않는다. 소진되면 키 재발급이 필요하다.
   - 남은 횟수는 `get_portal_registration` 응답의 `revealCount`/`revealLimit`으로 확인해 사용자에게 알린다. 단 **사용자가 pable studio에서 직접 등록한 서비스는 이 값을 조회할 수 없다** — 그때는 "누적 5회 한도"라는 사실만 말하고 남은 횟수를 추측하지 마라.
3. **아예 키 없이** — 실왕복이 급하지 않으면 `DEV_BYPASS_SSO=true` mock으로 먼저 화면을 만든다.

받은 값은 **채팅에 다시 출력하지 말고** 파일에만 쓴다(secret-safety).

그리고 **pable studio 등록에 로컬 포트가 있어야** `http://localhost:{포트}/auth/sso/callback` 이 돌아갈 주소로 등록된다(포트가 다르면 pable studio 화면이 "등록되지 않은 서비스"로 멈춘다). PAX 는 등록할 때와 키를 신청할 때 포트가 비어 있으면 **3000**(`next dev` 기본)으로 채운다 — `get_portal_registration` 의 `localPort` 로 확인하고, 다른 포트로 띄우면 사용자가 pable studio 등록 수정에서 포트를 바꾼다. 정식 서비스로 승격되면 돌아갈 주소가 배포 주소(https) 하나로 줄어 **로컬·개발 주소 로그인은 끊긴다**(그 뒤 로컬 확인은 `DEV_BYPASS_SSO` mock 으로).

## env 배선

- **배포 SSO** (실제 서비스에서 동작): 기본은 `claim_portal_sso_key`(`SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`·`PORTAL_URL` 자동 배선). 수동이면 MCP `set_vercel_env`로 `SSO_CLIENT_ID` = "SSO 키 · 스코프" 창의 서비스 ID / `SSO_CLIENT_SECRET` = <사용자가 준 비밀 키> / `PORTAL_URL` = <claim 결과가 알려 준 발급자 주소 — 직접 등록이면 "SSO 키 · 스코프" 창의 "pable studio 주소" 값을 글자 그대로. 사용자에게 따로 묻지 않는다(`get_portal_registration` 의 `portalUrl` 은 안내 링크용)> / (선택) `ALLOWED_TENANT_IDS`.
  - 그 다음 `request_vercel_deploy`로 재배포해야 반영된다. 값은 프로젝트 설정값 저장소와 배포(Vercel) 환경 양쪽에 저장되지만, **사용자 PC 의 `.env.development.local`엔 안 들어간다**. **채팅에 값 재출력 금지.**
  - ⚠️ 이 앱은 토큰 발급자를 `PORTAL_URL` 로 검증한다 — 발급자와 한 글자라도 다르면 로그인이 실패한다(claim 결과가 다르면 알려 준다). 코드·저장소 파일에 주소를 적지 마라(env 로만).
- **로컬 SSO** (로컬에서 실제 pable studio 왕복 테스트): 사용자가 준 값을 받아 **AI가 `.env.development.local`에 `SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`·`PORTAL_URL`을 직접 추가**한다(사용자는 값만 제공, 편집기 직접 열 필요 없음 — `SSO_CLIENT_ID`·`PORTAL_URL` 은 `get_public_env` 의 `publicKeys` 값). (선택)`ALLOWED_TENANT_IDS`도 같이. 그리고 **`DEV_BYPASS_SSO` 줄을 지우거나 `false` 로** 바꾼다 — 켜져 있으면 실제 로그인 대신 mock 세션이 뜬다(`references/sso-v2.md` 규칙 10). 바꾼 뒤 개발 서버를 다시 띄운다. **값은 채팅에 다시 출력하지 말고**(secret-safety), 이후엔 키 존재만 확인.
- **로컬 mock** (키 없이 즉시 확인): `.env.development.local`에 `DEV_BYPASS_SSO=true` (+ 선택 `DEV_BYPASS_SCENARIO`). 실제 키 없이 로그인·등급 왕복.
- 🚫 `SSO_SECRET`·`SSO_SERVICE_ID` 를 만들지 마라 — 이 레시피의 앱은 읽지 않는다.

> `set_vercel_env`는 프로젝트 설정값 저장소와 배포(Vercel) 환경 양쪽에 저장하지만 **사용자 PC 의 `.env.development.local`엔 안 들어간다** — 로컬은 따로 넣어야 한다(PAX 웹 [코드] 탭의 `.env.local`에서 복사하는 것이 가장 빠르다). 로그인이 `/login?error=config`·`failed` 로 끝나면 `references/sso-v2.md` 의 "증상 → 원인 찾기" 를 보고, 배포 쪽은 `get_deploy_logs`(pax-infra-ops)로 로그를 본다. 자세한 secret 취급은 `pax-secret-safety`, 인프라 도구는 `pax-infra-ops` 스킬 참조.

> ⚠️ `SSO_CLIENT_SECRET` 은 프로젝트 설정값 저장소에 보관된다 — 편집 권한자는 웹 [코드] 탭의 `.env.local` 에서 값을 볼 수 있다. 앱 세션 서명 키도 이 값에서 유도하므로 보유자는 유효 세션을 위조할 수 있다 — 사용자에게 이 점을 알린다.

## 추가 자료 (필요할 때 같은 폴더에서 읽기)

- **SSO v2 레시피 — 로그인 코드는 반드시 여기서**(시작·콜백·접근 토큰·로그아웃 코드, 출시 전 체크리스트, 오류 표) → **`references/sso-v2.md`를 읽으세요**.
- 멀티테넌트 데이터 격리·서버 role 재검증·borrowing·운영 admin 임명·DEV_BYPASS 5시나리오 상세가 필요하면 → **`references/multitenant.md`를 읽으세요**.
- pable studio Bearer API 호출(조직/사용자·아바타·회의실 free/busy·본인 캘린더/연락처/메일·프레즌스·메일 발송·스코프)이 필요하면 → **`references/portal-api.md`를 읽으세요**.
- pable studio 등록·SSO 키 라이프사이클(상태머신·재발급·reveal 한도·도구가 대행하는 범위)이 필요하면 → **`references/registration.md`를 읽으세요**.
- 기존 v1 앱 유지보수 전용(`ssoProtocol: 'v1'` 이고 v1 코드가 이미 있는 앱만 — 새 앱에 쓰지 마라) → **`references/sso-v1.md`**.
