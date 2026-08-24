---
name: pax-sso
description: 회사 계정(pable studio·스튜디오) 로그인 연동 — "로그인 붙여줘", "회사 계정으로 로그인", "MS·오피스365·아웃룩·Entra 계정 로그인", "사내 구성원·조직도·회의실·캘린더·메일 불러와" 요청에 사용. 사내 앱은 스튜디오 SSO가 기본이며 MS 직접 연동보다 우선. Google·Kakao 등 외부 소셜·일반 로그인은 대상 아님.
---

<!--
  SYNC: 이 파일은 내장 스킬 사본과 쌍둥이다 → (PAX repo) skills/pax-sso/SKILL.md
  코어 규칙·코드·references 는 두 사본을 동일하게 유지. body 는 env 배선/참조 로딩만 다름.
  pable studio 화면 라벨의 정본 출처 = VibeWare app/admin/page.tsx TABS (가이드 문서 라벨은 stale 가능).
-->

# pable studio SSO 연동 (회사 계정 로그인) — 로컬 개발

로컬에서 이어 개발하는 앱에 **회사 계정(pable studio) 로그인**을 붙이고, 로그인 뒤에는 **pable studio Bearer API 로 사내 데이터**(구성원·회의실·본인 캘린더/메일·프레즌스)를 불러올 수 있다. 프로토콜은 HTTP 리디렉트 + HS256 JWT 쿠키뿐: pable studio가 60초 JWT 발급 → 이 서비스가 자체 세션 JWT로 **재서명**해 쿠키 저장.

## 규칙 -1 — 스코프 가드 (먼저 판정, 무조건 시작 금지)

이 스킬의 범위는 두 가지다.

1. **pable studio SSO(회사 계정 로그인) 연동**
2. **pable studio Bearer API 로 사내 데이터 조회·발송** — 조직 구성원(임직원·조직도)·프로필 사진·회의실 free/busy·본인 캘린더/연락처/메일·프레즌스·메일 발송. Microsoft 365(Graph) 사내 데이터는 pable studio가 프록시한다. 상세는 같은 폴더의 `references/portal-api.md`.

**로그인 라우팅 규칙** — "Microsoft/MS 계정 로그인"·"오피스365/아웃룩 계정 로그인"·"Entra(Azure AD) 로그인"·"회사 계정 로그인" 요청은 **전부 1번(pable studio SSO)이 기본 경로다**. pable studio 자체가 회사 Microsoft(Entra) 계정 SSO 라서, 사내 사용자 대상 앱은 pable studio 로그인이 곧 MS 로그인이다 — MS 직접 연동을 먼저 제안하지 마라(비개발자 사용자는 이 구분을 모른다). 판별이 필요하면 질문은 하나만: **"이 앱은 회사 동료들이 쓰나요, 회사 밖 사람들도 쓰나요?"** 회사 동료 대상이면 그대로 pable studio SSO 로 진행하고(추가 확인 불필요), 회사 밖 사용자가 각자 개인/타조직 Microsoft 계정으로 로그인해야 하는 앱만 직접 MS 연동 대상이다(아래 "직접 MS 연동은 명시 요청 시에만" 준수).

**연동 상태 선확인 (로그인 코드보다 먼저)** — pable studio SSO 로 진행하기로 했으면 `get_portal_registration` MCP 도구로 이 프로젝트의 연동 상태(`supportsSso`)부터 확인한다. 신규 프로젝트는 **SSO 연동이 꺼진 채(중립) 등록**되므로 대개 꺼져 있다 — 이때는 코드를 만들기 전에 **"pable studio SSO 연동을 켜고 키 발급을 신청해야 해요. 한 번 켜면 끌 수 없어요(해제는 등록 삭제뿐)"라고 안내하고 사용자 확인을 받은 뒤**, 웹 PAX 채팅에서 연동 켜기+신청(`request_portal_sso_key`)을 진행하도록 안내한다(로컬 브리지는 조회만 가능 — 웹 도구도 사용자 동의 없인 실행을 거부한다). 확인 없이 켜도록 유도하지 마라. 단 **사용자가 "pable studio가 아니라 진짜 Microsoft 로그인"이라고 명시하면 이 안내·확인 흐름을 강요하지 말고 막지도 마라** — 그대로 직접 MS 연동 경로로 진행한다.

**사내 데이터 라우팅 규칙** — 회사 구성원·임직원·조직도·동료 목록·회의실 현황·사내 캘린더/메일/연락처/자리 여부(프레즌스) 등 **실제 사내 시스템의 데이터를 불러오려는 요청이면 2번으로 진행**한다. MS Graph 직접 연동·MS 토큰 입력을 유도하지 말고, 브라우저 개발자도구(Network 탭)에서 API 주소나 토큰을 채집하도록 안내하지도 마라. 단:

- **선행조건 동일** — pable studio 데이터 조회도 SSO 키(`SSO_SECRET`) 발급 + 해당 스코프 승인이 필요하다. 키 미발급 상태면 데이터 코드보다 먼저 아래 "SSO 키 발급" 워크스루(+필요 스코프 체크)로 안내한다.
- **pable studio 미지원 데이터**(그룹/팀 멤버 목록·Teams·OneDrive·SharePoint·타인 캘린더)는 "pable studio에서 아직 지원되지 않아요"라고 명확히 안내하되, 막다른 길로 끝내지 말고 대안을 순서대로 제시한다: ① 전체 구성원 목록을 불러온 뒤 앱에서 필요한 인원만 골라 쓰기(권장 — `graph.User.Read.All` 스코프 필요) ② 명단을 엑셀·CSV 로 받아 반영 ③ 그룹 단위 조회가 꼭 필요하면 pable studio 관리자에게 기능 추가 요청. 브라우저에서 복사한 MS 액세스 토큰을 설정값으로 저장하는 우회는 먼저 제안하지 마라 — 그 토큰은 보통 1시간이면 만료돼 앱이 곧 깨진다.
- **직접 MS 연동은 명시 요청 시에만** — 사용자가 분명히 원하면 트레이드오프를 알기 쉽게 안내하고 의사 확인 후 진행한다. 안내 골자: "두 방법 다 관리자 승인이 필요해요. pable studio 경유는 pable studio 화면에서 신청·승인하는 지원된 절차이고(승인 대기 중에도 예시 데이터로 화면을 먼저 볼 수 있어요), Microsoft 직접 연동은 회사 IT 관리자가 Microsoft 쪽에 앱을 별도 등록해야 하고 브라우저에서 복사한 접속 값은 보통 1시간이면 만료돼요. 그래서 기본은 pable studio 경유를 권해요." pable studio 로그인 조직 밖 데이터(외부 조직·개인 Microsoft 계정)는 처음부터 이 직접 연동 경로다. 이미 브라우저 복사 토큰이 설정값에 들어있는 앱을 발견하면 만료 문제를 고지하고 pable studio 전환을 제안한다.
- **대상 아님** — 앱 자체가 저장·관리하는 데이터(앱 회원·멤버 CRUD, 앱 안에서 만드는 일정·회의실 예약 기능)와 앱 회원에게 보내는 일반 알림 메일(Resend 등 일반 경로)은 이 스킬 범위가 아니다.
- **모호한 지칭** — 사용자가 "사내 API"·"회사 API"·"포탈 API" 처럼 모호하게 지칭하면 pable studio API 를 1순위 후보로 놓고 "혹시 pable studio를 말씀하시는 건가요?" 라고 확인한다.
- **사용자 표현** — 사용자에게는 "Bearer API"·"프록시" 같은 용어 대신 "pable studio를 통해 불러오기"로 표현한다.

위 둘 다 아니면 — 일반 이메일·비밀번호 로그인, Supabase Auth, Google·Kakao 등 **외부 소셜** 로그인 — **이 스킬을 쓰지 말고 즉시 빠져나와** 한 줄 안내 후 종료한다. 추가 도구 호출·코드 작성 금지. (단 Microsoft/회사 계정 로그인은 위 로그인 라우팅 규칙대로 1번 대상이다 — 빠져나오지 마라.)
> 예: "이건 pable studio(회사 계정) 연동 전용이에요. 일반 로그인이 필요하시면 그 방식으로 만들어 드릴게요."

## 규칙 -0.5 — 프로토콜 버전 (이 스킬은 v1 전용)

이 스킬은 **SSO v1(HS256 리디렉트)** 전용이다. pable studio에는 다중 Entra 계정용 **SSO v2**(Authorization Code + PKCE + ES256/JWKS)도 있지만 v1 은 계속 지원되고, **회사 계정 하나로 로그인하는 보통의 앱은 v1 로 충분하다** — 규칙 0 판정을 마친 뒤 아래 레시피로 진행한다.

**혼동 금지 — 아래는 전부 v1 그대로 진행한다(중단하지 마라):** 여러 회사 사용자가 각자 자기 계정으로 로그인하는 앱 / 회사별 데이터 분리 / 특정 회사만 허용(`ALLOWED_TENANT_IDS`) / 역할별 화면 분기.

v2 가 필요한 경우는 하나뿐이다 — **한 사용자가 앱 안에서 회사 계정 A·B 를 동시에 붙잡고 전환**하는 계정 전환기. 이때는 v1 으로 구조적으로 불가능하니 **v2 코드를 즉석에서 지어내지 마라**(이 스킬엔 검증된 v2 레시피가 없다). 한 줄 안내 후 종료하고 **추가 도구 호출·코드 작성 금지**.
> 예: "한 앱에 회사 계정을 여러 개 등록해 번갈아 쓰는 기능은 지금 방식(SSO v1)으로는 만들 수 없어요. pable studio 관리자에게 'SSO v2(다중 계정) 연동'을 문의해 주세요. 계정 하나로 로그인하는 기능이면 지금 바로 만들어 드릴게요."

## 규칙 0 — 선행조건 (코드 쓰기 전 필수)

서비스 **등록 상태는 자동으로 확인할 수 있다**(`get_portal_registration` MCP 도구). 등록 생성·키 신청·수령/배선은 **웹 PAX 채팅의 도구**(`register_portal_service`·`request_portal_sso_key`·`claim_portal_sso_key`)가 대행하고, **관리자 승인만 사람 절차다** — 로컬 브리지는 조회 전용이니 그 작업들은 웹 채팅으로 안내한다. 웹의 `claim_portal_sso_key` 는 프로젝트 설정값 저장소와 배포(Vercel) 환경에 키를 저장한다 — **사용자 로컬 PC 의 `.env` 파일에는 들어가지 않고**, **`SSO_SECRET` 같은 서버 서명키는 브리지가 로컬로 내려주지 않는다**(브리지가 주는 건 Supabase 값뿐) — 로컬 실왕복 테스트용 값은 사용자가 pable studio에서 확인해 직접 줘야 한다.

1. **먼저 DEV_BYPASS mock으로 돌린다.** 실제 키가 없어도 `DEV_BYPASS_SSO=true`로 로그인·역할 등급이 도는 화면을 즉시 보여줄 수 있다. 코드는 이걸 전제로 먼저 작성해도 안전(런타임 throw 없음).
2. **실제 SSO는 키가 있어야 한다.** 사용자가 아직 키가 없으면 아래 **"SSO 키 발급"** 워크스루로 안내. 키가 준비되면 아래 **env 배선**의 배포/로컬 경로로 넣는다.
3. `SSO_SECRET` 값을 채팅으로 보여주거나 되묻지 마라. 사용자에게 값만 받아 파일/원격에 넣고, 이후엔 키 이름만 확인한다(값 미출력).

## 동작 개요 + 만들 파일

```
[사용자] → pable studio 대시보드에서 서비스 카드 클릭
  → pable studio가 60초 JWT 발급 → 서비스의 /auth/sso?token=... 로 리디렉트
    → /auth/sso: 토큰 검증 → 자체 세션 JWT 재서명 → 쿠키 저장 → / 로 이동
```

| 파일 | 역할 |
|---|---|
| `app/auth/sso/route.ts` | SSO 진입점 — pable studio JWT 검증·재서명·쿠키 발급 |
| `app/page.tsx` (보호 페이지) | 세션 검증 + **역할 기반 기능 등급** |
| `app/login/page.tsx` | **공개** "pable studio 대시보드로 접속" 안내 페이지 (비로그인 랜딩) |
| `app/auth/logout/route.ts` | 세션 쿠키 삭제 후 `/login` |

로컬 AI는 이 파일들을 **로컬 파일시스템에 직접 작성**한다.

## SSO 키 발급 (승인만 사람 — 등록·신청·수령/배선은 웹 채팅 도구가 자동)

관리자 승인만 사람 절차다. 로컬 브리지는 조회 전용 — 아래 도구 작업은 **웹 PAX 채팅**에서 진행하도록 안내한다. 순서(딥링크 `{PORTAL_URL}/dashboard/dev` — **`{PORTAL_URL}` 자리는 `get_portal_registration` 응답의 `portalUrl` 값으로 채워** 실제 링크로 안내한다. pable studio 주소를 사용자에게 묻지 마라):

1. **등록 확인** — `get_portal_registration` 으로 이 프로젝트의 pable studio 등록 여부를 확인한다. 미등록이면 웹 PAX 채팅에서 등록하도록 안내하거나(로컬 브리지로는 등록 불가 — **등록은 SSO 연동이 꺼진 중립 상태로 생성됨**), 사용자가 pable studio `{PORTAL_URL}/dashboard/dev` → **내 서비스** 카드에서 직접 등록(이름·URL·포트). ⚠️ **사용자가 pable studio에서 직접 만든 등록은 도구로 조회·신청되지 않는다**(다른 출처) — 그 등록으로 키를 받으려면 등록 수정에서 "SSO 연동"을 켜고 pable studio에서 직접 신청해야 한다.
2. **연동 켜기 + 키 신청** — 사용자 확인(규칙 -1 "연동 상태 선확인") 후 웹 채팅의 `request_portal_sso_key` 가 대행한다: 연동이 꺼져 있으면 먼저 켜고(**비가역 — 한 번 켜면 끌 수 없음, 해제는 등록 삭제뿐**) 이어서 신청한다(**스코프 없는 기본 키만**). pable studio Bearer API(사내 데이터)까지 쓰려면 사용자가 pable studio 화면에서 필요한 스코프를 선택해 직접 신청/재발급해야 한다. 신청되면 상태가 "관리자 승인 대기 중"이 된다.
3. **관리자 승인** — **관리자**(다른 사람)가 `{PORTAL_URL}/admin` → **"SSO 발급 승인"** 탭에서 승인 → 상태 "승인됨 — 확인 대기". 여기만 사람이 한다.
4. **수령·배선** — 웹 채팅의 `claim_portal_sso_key` 가 키를 수령해 프로젝트 설정값 저장소 + 배포(Vercel) 환경(`SSO_SECRET`·`SSO_SERVICE_ID`)으로 자동 저장한다(값 미노출) + 재배포. **사용자 로컬 PC 의 `.env.development.local` 에는 안 들어간다** — 로컬 실왕복 테스트가 필요하면 사용자가 pable studio **"확인하기"**(모달 "SSO 서명 키 확인")로 복사한 값을 받아 아래 env 배선의 로컬 경로로 넣는다. 수령·확인은 **누적 5회 한도**(초과 시 재발급 신청만이 복구).
5. **스코프가 필요해지면(재발급=회전)** — 사용자가 pable studio에서 스코프 선택 후 재발급 신청 → 관리자 승인 → 웹 채팅 `claim_portal_sso_key` 로 새 키 교체 배선 → 재배포. 로컬 값도 그때 새 값으로 교체.

**승인 대기가 "막힘"이 되지 않게** — 3에서 승인을 기다리는 동안에도 아래 DEV_BYPASS mock으로 앱이 도는 걸 보여주고, 승인 후 4로 전환한다.

> **⚠️ 스코프 추가 = 키 회전** — 이미 키를 수령(REVEALED)한 뒤 스코프를 바꿔 재발급 신청하면 **이전 키가 즉시 무효화**돼 배포된 앱의 로그인이 그 자리에서 끊긴다. 새 키 수령 → `SSO_SECRET` 교체 → 재배포까지 한 흐름으로 안내한다(승인 후 웹 채팅 `claim_portal_sso_key` 가 교체 배선을 대행). 그래서 회전은 도구가 먼저 제안하지 않는다 — 사용자가 pable studio에서 진행한다.

### 내 "서비스 ID" 확인 (먼저 도구로 조회 — 사용자에게 바로 묻지 마라)

pable studio에 등록된 식별자이고 **지어내는 값이 아니다.** JWT 의 `service`·`aud` 클레임에 실리는 값과 항상 같다.

1. **`get_portal_registration` 도구를 먼저 호출한다** (웹 채팅·로컬 MCP 동일 이름). 등록돼 있으면 응답의 `serviceClaimHint` 가 곧 이 값이다 — `SERVICE_ID` 상수(또는 `SSO_SERVICE_ID` env)에 그대로 넣는다.
2. 미등록(`registered: false`)이면: 웹 채팅에선 `register_portal_service` 로 대행 등록할 수 있고(사용자 동의 후 — 등록만, 키 발급은 별개), 로컬에선 웹 PAX 채팅 또는 pable studio 직접 등록을 안내한다.
3. 도구가 조회 실패(일시 오류)를 반환하면 **미등록으로 단정하지 말고**, 사용자가 pable studio `{PORTAL_URL}/dashboard/dev` → "내 서비스" 카드의 **"서비스 ID" 칩**(라벨 + 모노스페이스 값 + 복사 아이콘)을 확인해 알려주게 한다. 칩은 "SSO 연동"이 켜져 있어야 보인다 — **자동 등록 직후는 연동 꺼짐이라 칩이 없을 수 있으니**, 그 경우 도구 재조회가 유일한 확인 경로다(잠시 후 재시도).

- **`serviceClaimPinned: false` = 잠정값** — 관리자가 승인할 때 다른 최종 ID 로 확정할 수 있다.
- **`serviceClaimPinned: true` 라도 래치가 아니다** — 승격 서비스 삭제·등록 재오픈 시 원래 값으로 되돌아온다. 어느 쪽이든 **배포 직전 재조회해 대조**하고, 달라졌으면 `SSO_SERVICE_ID` env 로 교체한다.
- **비밀이 아니다** — `SSO_SECRET` 과 달리 채팅으로 다뤄도 된다(입력 카드 불필요).

**AI 행동 규칙**: DEV_BYPASS mock 으로 화면을 먼저 만드는 단계에서는 `'my-service'` 자리표시자로 진행해도 된다(규칙 0). 단 **실제 SSO 를 켜는 시점**(`SSO_SECRET` 배선·배포 직전)에 반드시 도구 재조회 값으로 교체하고, 교체 전에는 배포하지 마라. 자리표시자인 채로 배포되면 pable studio가 이 앱을 찾지 못해 **에러 화면에 서비스 이름이 비어 보이고 복귀 흐름이 조용히 어긋난다.** 사용자가 아직 등록을 안 했으면 위 1~2번부터 진행한다.

**희망 ID 가 기존 정식 서비스와 겹치면** — 대행 등록이 자동으로 다른 식별자(`-2` 접미 등)를 시도하고, 최종 ID 는 관리자가 승인 단계에서 확정한다. 도구 재조회 값을 따르면 된다.

## env 배선 (SSO_SECRET은 브리지가 안 내려줌)

`SSO_SECRET`은 브리지 도구로 자동으로 못 받는다 — 브리지가 내려주는 건 Supabase 값(`get_public_env`의 anon key·URL, 편집자/소유자의 `get_service_role_key`)뿐이고 SSO 키는 대상이 아니다. 사용자가 5단계에서 복사한 키를 받아 넣는다 — **두 경로**:

- **배포 SSO** (실제 서비스에서 동작): MCP `set_vercel_env`로 올린다.
  - `set_vercel_env` `SSO_SECRET` = <사용자가 준 값> / `PORTAL_URL` = <`get_portal_registration` 응답의 `portalUrl` 값 — 사용자에게 묻지 않는다> / (선택) `ALLOWED_TENANT_IDS`.
  - 그 다음 `request_vercel_deploy`로 재배포해야 반영된다. 값은 서버→Vercel 런타임 전용이라 로컬 `.env`엔 안 들어간다. **채팅에 값 재출력 금지.**
- **로컬 SSO** (로컬에서 실제 pable studio 왕복 테스트): 사용자가 준 키 값을 받아 **AI가 `.env.development.local`에 `SSO_SECRET`을 직접 추가**한다(사용자는 값만 제공, 편집기 직접 열 필요 없음). `PORTAL_URL`(= `get_portal_registration` 응답의 `portalUrl` — 사용자에게 묻지 않는다)·(선택)`ALLOWED_TENANT_IDS`도 같이. **값은 채팅에 다시 출력하지 말고**(secret-safety), 이후엔 키 존재만 확인.
- **로컬 mock** (키 없이 즉시 확인): `.env.development.local`에 `DEV_BYPASS_SSO=true` (+ 선택 `DEV_BYPASS_SCENARIO`). 실제 키 없이 로그인·등급 왕복.

- **(선택) `SSO_SERVICE_ID`** — 승인 시 확정 ID 가 희망 ID 와 달라졌을 때만. 배포는 `set_vercel_env` + `request_vercel_deploy`, 로컬은 `.env.development.local` 에 추가. 코드의 `SERVICE_ID` 리터럴을 고칠 필요 없다.

> `set_vercel_env`는 Vercel 런타임에만 반영되고 로컬 `.env`엔 안 들어간다 — 배포와 로컬은 독립. 자세한 secret 취급은 `pax-secret-safety`, 인프라 도구는 `pax-infra-ops` 스킬 참조.

## 코어 코드

**`SERVICE_ID` 는 pable studio가 준 값**이다 — 위 "내 서비스 ID 확인" 절차로 받아서 그대로 넣는다(지어내지 마라). **`COOKIE_NAME` 은 반대로 임의 고유값**이면 된다(다른 서비스와만 안 겹치면 됨, 예: `scheduler_sso`).

### 세션 타입 (`SSOPayload`)

세션 사용자 정보 타입. **별도 파일이 아니라 아래 `app/page.tsx` 상단에 함께 정의**한다(유일 소비자 — route.ts는 jose `payload`를 직접 쓰므로 이 타입 불필요). 필드: `sub`(이메일)·`name`·`service`·`role`(`viewer`|`editor`|`owner`, 2026-05부 `admin` 폐기)·`tenant_id`·`tenant_name`(표시 전용)·`service_owner_tenant_id`·`is_owner_tenant`·`borrowing_active`·`via`(감사 전용)·`scopes`·`portal_origin`(pable studio 주소 해석)·`oid`(안정 식별자)·`auth_time`. 전체 정의는 page.tsx 코드 블록 참조.

`getSession()` 은 검증된 payload 에 **원본 쿠키 토큰을 함께 담아**(`Session = SSOPayload & { token }`) 반환한다 — 토큰이 없으면 pable studio Bearer API 를 호출할 수 없다.

### `app/auth/sso/route.ts` — 진입점 (규칙 1·2·3)

```ts
import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify, SignJWT } from 'jose'

// 🚫 하드코딩 폴백(`?? 'http://localhost:13000'`) 금지 — 미설정 배포본이 사용자를
// 개발자 로컬 주소로 보내고 pable studio 접속 로그에 아무 흔적도 안 남는다.
// 🚫 `process.env.PORTAL_URL!` 도 금지 — 값이 없으면 `"undefined/dashboard"` 가 되어
//    NextResponse.redirect 가 TypeError 500 을 던진다(죽은 링크보다 나쁘다).
const PORTAL_URL = process.env.PORTAL_URL
// ← pable studio "내 서비스" 카드의 **"서비스 ID" 칩**과 정확히 같은 값 (지어내지 마라).
//   승인 시 관리자가 다른 ID 로 확정하면 코드를 고치지 말고 SSO_SERVICE_ID env 로 덮는다.
const SERVICE_ID = process.env.SSO_SERVICE_ID ?? 'my-service'
const COOKIE_NAME = 'my_service_sso' // ← 서비스별 고유 (임의 값)

// pable studio 복귀 헬퍼 — PORTAL_URL 이 없으면 죽은 절대주소 대신 자체 안내 페이지로 degrade
const portalBack = (code: string, req: NextRequest) =>
  PORTAL_URL
    ? NextResponse.redirect(`${PORTAL_URL}/dashboard?error=${code}&service=${SERVICE_ID}`)
    : NextResponse.redirect(new URL('/login', req.url))
const SESSION_TTL = 3600             // native 세션(초) — 1시간 이내 권장
const BORROWING_TTL = 600            // borrowing 세션(초) — 잔존 윈도우 단축
// 표준 JWT claim 만 drop. 나머지(tenant_id·scopes·is_owner_tenant…)는 spread 로 승계.
const STANDARD_JWT_CLAIMS = ['iat', 'exp', 'nbf', 'iss', 'aud', 'jti']

function getSecret() {
  const s = process.env.SSO_SECRET
  if (!s) throw new Error('SSO_SECRET 미설정')
  return new TextEncoder().encode(s)
}

// (선택) 특정 회사만 허용. 비우면 null → pable studio service_grants 에 위임(자동 허용). 절대 throw 금지.
function getAllowedTenantIds(): Set<string> | null {
  // pable studio 가이드는 EXPECTED_TENANT_ID 라는 이름을 쓴다 — 별칭으로 수용(단일 UUID 도 동작).
  // 🚫 키 이름을 교체하지는 마라: 기존 생성 앱들이 ALLOWED_TENANT_IDS 로 배선돼 있다.
  // 가이드는 미설정 시 부팅 차단(fail-closed)을 권하지만, 여기선 미리보기·배포 파손을
  // 막기 위해 의도적으로 fail-open 이다(규칙 0). 비우면 pable studio service_grants 에 위임.
  const raw = process.env.ALLOWED_TENANT_IDS ?? process.env.EXPECTED_TENANT_ID
  if (!raw) return null
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return ids.length ? new Set(ids) : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

// 화이트리스트 외(legacy 'admin'·임의값)는 fail-closed 로 viewer 강등 — 절대 승격 금지.
const ROLE_WHITELIST = ['viewer', 'editor', 'owner'] as const
function normalizeRole(raw: unknown): 'viewer' | 'editor' | 'owner' {
  return typeof raw === 'string' && (ROLE_WHITELIST as readonly string[]).includes(raw)
    ? (raw as 'viewer' | 'editor' | 'owner')
    : 'viewer'
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  // 토큰 없이 진입 = pable studio 미경유 직접 접근 → 자체 안내 페이지로 (pable studio로 튕기지 않음)
  if (!token) return NextResponse.redirect(new URL('/login', req.url))

  try {
    // 규칙 1: pable studio JWT 검증 (60초, HS256 고정 — 가이드 §2 MUST)
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] })

    // SERVICE_ID 드리프트 탐지 — 상수가 pable studio 확정 ID 와 어긋나면 복귀 쿼리(?service=)가
    // 무의미해지는데 증상은 "그냥 안 된다" 뿐이라 원인 추적이 불가능하다. 토큰이 정답을
    // 들고 오므로 대조해 로그만 남긴다.
    // 🚫 거부하지 마라 — 승인 시 ID 가 바뀌는 건 정상 흐름이고, 하드 거부하면 전 사용자
    //    로그인 불가가 된다. 서명이 이미 "우리 서비스용 토큰"임을 보장하므로 이 비교는
    //    보안 경계가 아니라 진단이다. 같은 이유로 jwtVerify 에 audience 옵션도 켜지 않는다.
    if (payload.service && payload.service !== SERVICE_ID) {
      console.warn('[sso] SERVICE_ID 불일치 — SSO_SERVICE_ID env 로 교정하세요', {
        expected: SERVICE_ID, received: payload.service, // 서비스 ID 는 비밀이 아님
      })
    }

    // pable studio 토큰엔 항상 sub(이메일)이 있어야 함 — 누락은 변조/구버전 pable studio
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return portalBack('sso_failed', req)
    }

    // 규칙 2: 유효한 tenant_id(UUID) 필수 + (선택) 회사 화이트리스트
    const tenantId = payload.tenant_id
    if (!isUuid(tenantId)) {
      return portalBack('sso_failed', req)
    }
    const allowed = getAllowedTenantIds()
    if (allowed && !allowed.has(tenantId)) {
      return portalBack('sso_failed', req)
    }

    // 규칙 3: borrowing 가드 + TTL 분기
    if (payload.via === 'grant' && payload.borrowing_active !== true) {
      return portalBack('sso_failed', req)
    }
    const effectiveTtl = payload.borrowing_active === true ? BORROWING_TTL : SESSION_TTL

    // 규칙 1: spread 재서명 — 표준 claim 만 제거, 나머지 승계, 신뢰 claim 은 뒤에서 재명시(변조 방어)
    const userClaims = Object.fromEntries(
      Object.entries(payload).filter(([k]) => !STANDARD_JWT_CLAIMS.includes(k)),
    )
    const sessionToken = await new SignJWT({
      ...userClaims,
      sub: payload.sub,
      name: payload.name,
      service: payload.service,
      role: normalizeRole(payload.role), // 화이트리스트 외 값은 viewer 강등(fail-closed)
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${effectiveTtl}s`)
      .sign(getSecret())

    const res = NextResponse.redirect(new URL('/', req.url))
    res.cookies.set(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: effectiveTtl,
    })
    return res
  } catch {
    // 실제 검증 실패 = 설정 문제 → pable studio로 신호(관리자 로깅·트러블슈팅)
    return portalBack('sso_failed', req)
  }
}
```
> 🚫 인증 판단에 `Referer`/`Origin` 헤더를 쓰지 마라 — JWT 서명(`SSO_SECRET`) + `exp`만으로 검증한다. "pable studio에서 온 요청만 통과" 게이트는 정상 사용자를 차단하고(브라우저가 Referer를 비움) 위조도 가능해 보안 효용이 0이다. CSRF는 위 `SameSite=Lax` 쿠키로 충분.

### `app/page.tsx` — 세션 가드 + 역할 기반 기능 등급 (규칙 4·6·7)

```tsx
import { cookies } from 'next/headers'
import { jwtVerify } from 'jose'
import { redirect } from 'next/navigation'

// 세션 사용자 정보 (재서명 JWT 페이로드) — 별도 파일 아님, 이 파일 상단에 함께 둔다
interface SSOPayload {
  sub: string
  name: string
  service: string
  role: 'viewer' | 'editor' | 'owner'   // 2026-05부 'admin' 발급 중단
  tenant_id?: string
  tenant_name?: string | null           // 표시 전용 (권한 결정 금지)
  service_owner_tenant_id?: string | null
  is_owner_tenant?: boolean
  borrowing_active?: boolean
  via?: 'owner' | 'global' | 'grant'    // 감사 전용 (권한 게이트 금지)
  scopes?: string[]
  portal_origin?: string  // 발급 pable studio origin — pable studio API 호출 대상 (아래 resolvePortalOrigin)
  oid?: string            // Entra object id — 이메일과 달리 안 바뀌는 안정 식별자
  auth_time?: number      // pable studio 인증 시각(epoch 초)
}

// 세션 = 검증된 payload + 원본 쿠키 토큰. 토큰이 있어야 pable studio Bearer API 를 호출할 수 있다.
// token 이 nullable 인 이유: DEV_BYPASS mock 에는 pable studio가 발급한 토큰이 없다.
type Session = SSOPayload & { token: string | null }

// route.ts 와 **별개 파일**이라 스코프를 공유하지 않는다 — 여기에도 선언한다
// (COOKIE_NAME·getSecret 을 두 파일에 중복 선언하는 것과 같은 이유).
const COOKIE_NAME = 'my_service_sso'
const SERVICE_ID = process.env.SSO_SERVICE_ID ?? 'my-service'  // route.ts 와 같은 값
function getSecret() {
  const s = process.env.SSO_SECRET
  if (!s) throw new Error('SSO_SECRET 미설정')
  return new TextEncoder().encode(s)
}

/**
 * pable studio 주소 해석 — 세션의 portal_origin 우선, 없으면 env PORTAL_URL 폴백.
 * pable studio 도메인이 바뀌어도 다음 토큰부터 새 주소가 실려 앱 수정 없이 따라간다.
 * ⚠️ 반드시 **jwtVerify 를 통과한** payload 에서만 읽을 것 — 미검증 토큰의 주소로
 *    Bearer 를 보내면 위조 토큰이 자격증명을 임의 호스트로 빼돌릴 수 있다.
 */
function resolvePortalOrigin(session?: { portal_origin?: unknown } | null): string | null {
  const raw = typeof session?.portal_origin === 'string' ? session.portal_origin : ''
  try {
    const u = new URL(raw)
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    // 이 주소로 Bearer 자격증명이 나간다 — https 만, 로컬 pable studio만 http 예외
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal)) return u.origin
  } catch { /* URL 아님 → 폴백 */ }
  return process.env.PORTAL_URL ?? null
}

async function getSession(): Promise<Session | null> {
  // DEV_BYPASS: pable studio 없이 로컬에서 로그인·등급을 즉시 테스트 (production 에선 무시)
  if (process.env.DEV_BYPASS_SSO === 'true' && process.env.NODE_ENV !== 'production') {
    return buildDevMockSession()
  }
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value
    if (!token) return null
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] })
    return { ...(payload as unknown as SSOPayload), token }
  } catch {
    return null
  }
}

export default async function Page() {
  const session = await getSession()
  // 규칙 7: 세션 없으면 pable studio로 곧장 튕기지 말고 자체 안내 페이지로
  if (!session) redirect('/login')

  // 규칙 6: 역할 기반 기능 등급 (role 만 사용; via/tenant_name 은 권한 게이트 금지)
  const canEdit = ['editor', 'owner'].includes(session.role)          // editor·owner
  const canManageMembers = session.role === 'owner'                    // owner
  // 규칙 4: 운영 admin 게이트 (cross-tenant 관리 등) — is_owner_tenant 필수
  const isServiceAdmin = session.is_owner_tenant === true && session.role === 'owner'

  return (
    <main>
      <p>{session.name} ({session.role})</p>
      {canEdit && <button>편집</button>}
      {canManageMembers && <button>멤버 관리</button>}
      {isServiceAdmin && <section>{/* 운영 관리 패널 — 여기에 cross-tenant 관리 UI를 넣으세요 */}운영 관리</section>}
      <a href="/auth/logout">로그아웃</a>
    </main>
  )
}

// 로컬 DEV_BYPASS mock — DEV_BYPASS_SCENARIO 로 5가지 전환 (기본 owner_native)
function buildDevMockSession(): Session {
  const s = process.env.DEV_BYPASS_SCENARIO ?? 'owner_native'
  const T_OWNER = '00000000-0000-0000-0000-000000000001'
  const T_USER  = '00000000-0000-0000-0000-000000000002'
  // token: null — mock 에는 pable studio 발급 토큰이 없어 pable studio API 호출이 불가하다(401).
  // 'dev-token' 같은 가짜 문자열을 넣지 마라 — 결과는 같은 401 인데 "토큰이 있다"는
  // 잘못된 신호만 남는다. portal_origin 도 의도적으로 비운다(env 폴백을 타게).
  const base = { sub: 'dev@local', name: '개발자', service: SERVICE_ID, token: null,
                 scopes: [] as string[], oid: '00000000-0000-0000-0000-0000000000aa',
                 auth_time: Math.floor(Date.now() / 1000) } as const
  switch (s) {
    case 'super_admin_cross': return { ...base, role: 'owner',  tenant_id: T_USER,  tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: true,  borrowing_active: true,  via: 'grant' }
    case 'borrowed_owner':    return { ...base, role: 'owner',  tenant_id: T_USER,  tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: false, borrowing_active: true,  via: 'grant' }
    case 'borrowed_viewer':   return { ...base, role: 'viewer', tenant_id: T_USER,  tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: false, borrowing_active: true,  via: 'grant' }
    case 'global':            return { ...base, role: 'viewer', tenant_id: T_USER,  tenant_name: 'B회사', service_owner_tenant_id: null,    is_owner_tenant: false, borrowing_active: false, via: 'global' }
    default:                  return { ...base, role: 'owner',  tenant_id: T_OWNER, tenant_name: 'A회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: true,  borrowing_active: false, via: 'owner' }
  }
}
```
> ⚠️ **UI 분기만으론 부족(보안)** — 편집·관리·삭제 같은 보호 동작은 **서버 라우트에서도 role 을 재검증**해야 한다(클라이언트 분기는 URL 직접 호출을 못 막음). 서버 가드 코드는 이 스킬의 **멀티테넌트 참조 문서**에서 확인한다.

### `app/login/page.tsx` — 공개 "pable studio 대시보드로 접속" 안내 (규칙 7)

세션이 필요 없는 **공개 페이지**여야 한다(아니면 무한 리다이렉트).

```tsx
const PORTAL_URL = process.env.PORTAL_URL  // 하드코딩 폴백 금지

export default function LoginPage() {
  return (
    <main>
      <h1>pable studio를 통해 접속해 주세요</h1>
      <p>
        이 서비스는 pable studio 대시보드를 통해서만 들어올 수 있어요.
        pable studio 대시보드에서 이 서비스로 들어와 주세요.
        (pable studio에 로그인돼 있지 않으면 자동으로 로그인 화면이 떠요.)
      </p>
      {/* 주소를 모르면 죽은 링크 대신 아무것도 렌더하지 않는다 */}
      {PORTAL_URL
        ? <a href={`${PORTAL_URL}/dashboard`}>pable studio 대시보드 열기</a>
        : <p>pable studio 주소가 설정되지 않았어요. 관리자에게 <code>PORTAL_URL</code> 설정을 요청해 주세요.</p>}
    </main>
  )
}
```

### `app/auth/logout/route.ts`

```ts
import { NextResponse } from 'next/server'
const COOKIE_NAME = 'my_service_sso'
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/login', req.url))
  res.cookies.set(COOKIE_NAME, '', { path: '/', maxAge: 0 })
  return res
}
```

## 에러 프로토콜 (규칙 5)

| 코드 | 상황 | 처리 |
|---|---|---|
| `sso_required` | 세션 만료/직접 접근 (정상) | 자체 `/login` 안내 페이지 |
| `sso_failed` | 실제 검증 실패 (키·tenant 불일치) | pable studio `?error=sso_failed` (관리자 로깅) |
| `sso_not_issued` | 키 미승인 (pable studio가 진입 전 차단·발급 — 이 서비스는 emit·handle 안 함) | 관리자 승인 대기 안내 (코드 수정 대상 아님) |

에러가 보이면 **코드를 다시 고치기 전에 pable studio부터 확인**하도록 안내:
`sso_failed` → `SSO_SECRET` 불일치 / "SSO 연동" 체크 누락(토큰 미수신) / **`SERVICE_ID` 불일치**.
`sso_not_issued` → 관리자 키 승인 대기. 배포 게이트/로그가 막히면 `get_pr_gate_status`·`get_deploy_logs`(pax-infra-ops).

### 증상 → 원인 찾기

| 증상 | 1순위 원인 | 확인·조치 |
|---|---|---|
| pable studio로 튕기는데 에러 화면에 서비스 이름이 비어 보인다 | `SERVICE_ID` 가 pable studio 값과 다름 (가장 흔함) | **주소창의 `?service=` 값**이 pable studio "내 서비스" 카드의 **"서비스 ID" 칩**과 글자 그대로 같은지 대조 → 다르면 `SSO_SERVICE_ID` env 로 교정 후 재배포 |
| 로그인은 되는데 pable studio 데이터가 401 | 스코프 미승인, 또는 DEV_BYPASS mock(`token: null`) | pable studio에서 스코프 승인 상태 확인. mock 은 원래 pable studio API 를 못 부른다 |
| pable studio로 갔는데 아무 안내도 없다 | 화이트리스트 밖 코드를 보냈다 | 이 서비스가 보내는 코드는 `sso_failed` 뿐이어야 한다. 임의 코드를 지어내지 마라 |

> 서버 로그에도 단서가 있다 — `SERVICE_ID` 불일치는 `[sso] SERVICE_ID 불일치` 경고로 남는다. 로컬 AI 는 `get_deploy_logs`(pax-infra-ops)로 배포 로그를 바로 볼 수 있다.

## 추가 자료 (필요할 때 같은 폴더에서 읽기)

- 멀티테넌트 데이터 격리·서버 role 재검증·borrowing·운영 admin 임명·DEV_BYPASS 5시나리오 상세가 필요하면 → **`references/multitenant.md`를 읽으세요**.
- pable studio Bearer API 호출(조직/사용자·아바타·회의실 free/busy·본인 캘린더/연락처/메일·프레즌스·메일 발송·스코프)이 필요하면 → **`references/portal-api.md`를 읽으세요**.
- pable studio 등록·SSO 키 라이프사이클(상태머신·키 회전·reveal 한도·도구가 대행하는 범위)이 필요하면 → **`references/registration.md`를 읽으세요**.
