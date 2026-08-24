# pable studio API 호출 (Bearer)

SSO 로그인 후 만든 서비스가 **pable studio 데이터(조직·사용자·회의실·캘린더·연락처·메일·프레즌스)를 조회/발송**해야 할 때 참조. 출처: VibeWare `external-api-reference.md` — 전 엔드포인트를 여기 요약했다(Microsoft Graph 프록시 포함).

> 이 엔드포인트들은 **생성된 앱의 런타임 서버 코드**가 호출한다 — 네가 작성하는 라우트 코드의 일부이지, 에이전트(너)가 직접 호출하는 게 아니다. **`web_fetch`로 pable studio를 치지 마라**: 작성 시점엔 유효한 60초 토큰이 없고, `web_fetch`는 `Authorization` 헤더를 떼므로 401만 돌아온다.

## 인증 모델

- 호출 인증 = **세션 쿠키에 담긴 재서명 JWT를 그대로 `Authorization: Bearer`** 로 전달. 서비스의 `SSO_SECRET`(서비스별 키)으로 HS256 서명된 토큰이면 된다.
- `payload.service` 클레임이 자기 서비스 ID와 정확히 일치해야 한다(다른 서비스 키로 서명하면 401).
- **Bearer 호출 자격** = pable studio에 SSO 키가 발급돼 있고(`sso_secret_enc IS NOT NULL`) `granted_scopes`가 1개 이상. 스코프 0개면 self-read 조차 401.
- **호출 대상 주소는 세션의 `portal_origin` 우선, env `PORTAL_URL` 폴백** (SKILL.md 의 `resolvePortalOrigin`). env 고정 주소로 호출하면 pable studio 도메인이 바뀔 때 cross-origin 리다이렉트에서 `Authorization` 헤더가 삭제돼 **전부 401** 이 된다.
- **쿠키를 직접 읽지 마라** — 반드시 `getSession()`(서명 검증 통과)을 거친다. 검증 전 토큰의 `portal_origin` 으로 호출하면 위조 토큰이 Bearer 자격증명을 임의 호스트로 빼돌릴 수 있다.

```ts
// 서버 라우트 안에서 — 검증된 세션의 토큰과 origin 을 함께 쓴다
const session = await getSession()            // SKILL.md 의 헬퍼 (jwtVerify 통과)
// ⚠️ getSession·resolvePortalOrigin 은 **이 라우트 파일에도 그대로 복사 선언**한다.
//    import 하지 마라 — page.tsx 에서 export 하면 Next 가 타입 에러로 막는다
//    (COOKIE_NAME·getSecret 을 파일마다 중복 선언하는 것과 같은 이유).
if (!session?.token) return new Response(null, { status: 401 })
const origin = resolvePortalOrigin(session)   // portal_origin → env → null
if (!origin) return new Response(null, { status: 503 })  // pable studio 주소 미설정 — 호출 자체를 안 한다

const res = await fetch(`${origin}/api/org/users/${encodeURIComponent(email)}`, {
  headers: { Authorization: `Bearer ${session.token}` },
})
```

> **DEV_BYPASS 함정** — mock 세션은 `token: null` 이라 pable studio API 호출이 불가능하다(401). 로컬 mock 으로는 pable studio 데이터 화면을 확인할 수 없으니, 픽스처나 빈 상태로 폴백하고 **실제 데이터는 실제 SSO 왕복으로** 확인한다.

## 엔드포인트 카탈로그

| 메서드 | 경로 | 요구 스코프 | 용도 |
|---|---|---|---|
| GET | `/api/org/users` | `graph.User.Read.All` (또는 `.app`) | 조직 구성원 전체 |
| GET | `/api/org/users/{email}` | 동일 (**본인 조회는 scope 면제**) | 특정 사용자 + 프로필 사진 |
| GET | `/api/graph/places` | `graph.Place.Read.All` (위임) | 조직 회의실 목록 |
| GET | `/api/graph/places/availability` | `graph.Calendars.Read` **AND** `graph.Place.Read.All` (둘 다, 위임) | 회의실 free/busy + 예약 상세 |
| GET | `/api/graph/me/calendar` | `graph.Calendars.Read` (위임) | 호출자 본인 캘린더 |
| GET | `/api/graph/me/contacts` | `graph.Contacts.Read` (위임) | 본인 Outlook 개인 연락처 |
| GET | `/api/graph/me/messages` | `graph.Mail.Read` (위임·민감) | 본인 받은편지함 위젯 |
| GET | `/api/graph/presence/{email}` | `graph.Presence.Read.All` (**본인 면제**) | 프레즌스 단건 |
| POST | `/api/graph/presence` | `graph.Presence.Read.All` (면제 없음) | 프레즌스 배치 (최대 650명) |
| POST | `/api/graph/mail/send` | `graph.Mail.Send` (위임·민감) | 본인 명의 메일 발송 |
| POST | `/api/graph/mail/send-as` | `graph.Mail.Send.app` (앱·민감) | 시스템 계정 메일 발송 (사용자 로그인 무관) |

그 외(개발등록 워크플로우 도구용, 일반 앱에선 드묾): GET `/api/contest/registrations`(`portal.DevRegistrations.Read`), POST `/api/admin/dev-registrations/{id}/approve`·`/reject`(Bearer + portalRole ≥ service_manager).

> ⚠️ **여기 없는 Graph 기능은 pable studio가 프록시하지 않는다** — 그룹/팀 멤버(owners·members)·Teams·OneDrive·SharePoint·타인 캘린더/메일 등. 이 경우 "pable studio에서 아직 지원되지 않아요"라고 안내하고 대안을 순서대로 제시한다: ① 전체 구성원 조회(`/api/org/users`) 후 앱에서 필요한 인원만 선별(`graph.User.Read.All` 필요) ② 명단을 엑셀·CSV 로 받아 반영 ③ pable studio 관리자에게 기능 추가 요청. 브라우저에서 복사한 MS 액세스 토큰을 설정값으로 저장하는 우회는 먼저 제안하지 마라(보통 1시간 만료). 직접 Microsoft(Entra) 연동은 사용자가 명시 요청할 때만 — IT 관리자의 앱 등록·승인이 필요함을 안내하고 진행한다.

`graph.*` **위임** 스코프 공통: 대상 사용자가 **pable studio에 최소 1회 로그인**했어야 하고, `/me/*` 는 JWT `sub` 본인 고정(타인 캘린더·메일 조회 불가). `send-as` 만 앱 권한이라 로그인 무관.

## 엔드포인트별 핵심 스펙

### GET /api/graph/places — 회의실 목록

- 파라미터 없음. 응답 `{ places: { id, displayName, emailAddress?, capacity?, building?, floorLabel? }[] }` (Graph `$top=100`, pable studio 5분 캐시)
- `emailAddress` 가 availability 조회의 키.

### GET /api/graph/places/availability — 회의실 free/busy (한 번에)

- 쿼리: `start`·`end`(ISO 8601 필수, 최대 62일) / `interval`(15|30|60분, 기본 30) / `includeSubject`(기본 true — `false` 시 subject·location 제거, privacy 강화)
- 응답 `{ rooms: [{ id, displayName, emailAddress, slotMinutes, availabilityView, scheduleItems: [{ status, subject?, location?, isPrivate?, start, end }] }], errors: [{ chunkIndex, status, message }] }`
  - `availabilityView` = 슬롯 비트맵 문자열(0=Free 1=Tentative 2=Busy 3=OOF 4=WorkingElsewhere), `status` 는 free/tentative/busy/oof/workingElsewhere
  - 개인 일정(`isPrivate`)은 subject 가 `(비공개)` 로 치환. 부분 실패는 `errors[]` 에 누적되고 성공한 회의실은 정상 반환. 캐시 없음(실시간)
- **두 스코프 AND 게이트** — 하나만 승인된 서비스는 403 `scope_mismatch`.

### GET /api/graph/me/calendar — 본인 캘린더

- 쿼리: `start`·`end` (ISO 8601 필수, 최대 90일)
- 응답 `{ events: { id, subject, start: {dateTime, timeZone}, end: {…}, location?, organizer?, isAllDay?, isCancelled? }[] }` (시작시각 오름차순, 최대 250건)

### GET /api/graph/me/contacts — 본인 개인 연락처

- 조직 디렉터리가 아니라 사용자가 Outlook 에 직접 저장한 개인 주소록. 파라미터 없음.
- 응답 `{ contacts: { id, displayName, emailAddresses?: {name?, address?}[], businessPhones? }[] }` (최대 100건)

### GET /api/graph/me/messages — 받은편지함 위젯 (민감)

- 쿼리: `folder`(기본 `inbox` — well-known 이름 또는 folder ID) / `top`(1~50, 기본 20) / `unreadOnly` / `search`(allowlist `^[\p{L}\p{N}\s.@_-]{1,128}$` — 한글 가능, 따옴표·콜론·백슬래시 차단)
- `search` 와 `unreadOnly` 는 **동시 사용 불가**(400 `search_filter_conflict`), 검색 모드는 mailbox 전체라 `folder` 무시
- 응답 `{ messages: { id, subject, from, receivedDateTime, bodyPreview, isRead, hasAttachments, importance, webLink }[], nextCursor: null }` — 본문 전체·첨부·읽음 처리는 **불가**(위젯 용도 의도적 제한). `webLink` 로 Outlook 웹 진입
- 위젯 폴링(보통 30초) 시 Bearer TTL 60초 → 매 호출 새 토큰을 받거나 서비스 자체 재서명 토큰 사용.

### 프레즌스 — 단건 GET / 배치 POST

- 단건 `GET /api/graph/presence/{email}` — **본인 조회는 scope 면제**(JWT `sub` == email). 응답 `{ presence: { id, availability, activity } }` (`availability`: Available/Busy/DoNotDisturb/Away/BeRightBack/Offline/PresenceUnknown, `activity`: InACall·InAMeeting·OutOfOffice 등). 대상 미존재는 404
- 배치 `POST /api/graph/presence` — body `{ "emails": ["a@x.com", …] }` (1~650, dedupe·lowercase 정규화, 본인 면제 없음) → 응답 `{ presences: Record<email, GraphPresence | null>, errors: [{ email, error: 'not_found' | 'transient' | 'graph_error' }] }` — 부분 실패도 200
- 여러 명이면 **배치 권장** (50명 기준 Graph 호출 100 → 51).

### POST /api/graph/mail/send — 본인 명의 발송 (민감)

- body: `subject`✱·`body`✱·`to`✱(string[]) + `contentType`("Text" 기본|"HTML")·`cc`·`fromName`·`replyTo`·`replyToName` 선택. `to+cc` 최대 50명. 응답 `{ ok: true }`
- **발신자는 JWT `sub` 강제** — `body.from` 을 보내도 무시된다(audit 에 `ignored_from` 기록). 표시 이름만 `fromName` 으로 변경 가능
- **발신·수신 도메인 모두 pable studio `mail_allowed_domains` 화이트리스트 통과 필수** — 미등록 도메인은 403(fail-closed, 차단 수신자는 응답 `blocked[]`). 신규 도메인은 pable studio 관리자에게 요청.

### POST /api/graph/mail/send-as — 시스템 계정 발송 (앱 스코프)

- `mail/send` 와 동일 body. 사용자 로그인 무관(앱 권한) — 알림·리마인더 등 자동 발송용
- **`from` 을 보내지 마라.** 발신 계정은 **회사(tenant)별로 pable studio 관리자가 등록**한 시스템 메일 계정으로 고정이고, 주소는 서비스에 공개되지 않는다. 어느 회사 계정이 쓰이는지는 **호출에 쓴 토큰의 `tenant_id` 클레임**이 정한다
- **에러 분기는 하나만 하라.** 기계로 식별 가능한 값은 `error === "system_mail_from_not_registered"` 뿐이고, 나머지 403 의 `error` 는 한국어 문구(`"허용되지 않은 발신 계정"`·`"허용되지 않은 발신 도메인"`·`"허용되지 않은 replyTo 도메인"`·`"허용되지 않은 수신 도메인"`)라 문자열 비교로 분기하면 문구가 바뀔 때 조용히 깨진다.
  - `system_mail_from_not_registered` → **회사 설정 미비**(코드 문제 아님, 재시도 금지). 응답 `message` 에 사용자에게 그대로 보여줄 한국어 문구가 담겨 오니 그걸 우선 노출하고, 없으면 `reason` 별로 안내하라:
    - `not_registered` → "pable studio 관리자에게 요청하세요: **관리자 화면 → 회사 관리 탭 → 회사 행의 ⋯ 메뉴 → '시스템 발신 메일 등록'**"
    - `domain_revoked` → 등록은 돼 있는데 그 주소의 도메인이 회사 허용 도메인에서 빠진 상태다(라벨도 '등록'이 아니라 '변경'). "**회사 관리 탭에서 허용 도메인을 확인한 뒤 ⋯ 메뉴 → '시스템 발신 메일 변경'** 으로 허용 도메인에 속한 주소를 다시 지정해 주세요" 라고 관리자에게 요청
  - 그 밖의 403 → **호출 설정 오류**(`from` 을 넣었거나, 발신·`replyTo`·수신 도메인이 화이트리스트 밖). 재시도해도 안 풀리니 자동 재시도하지 말고, 응답 `error`(있으면 `blocked[]`)는 **서버 로그에만** 남기고 사용자에겐 "메일 발송이 거부됐어요" 수준으로 끝내라
- 서비스별로 바꿀 수 있는 건 **표시 이름·회신 경로뿐**: `fromName: "가입 알림"` + `replyTo: "support@…"` → 수신자에겐 `"가입 알림" <등록된 발신 계정 주소>` 로 보이고 회신은 replyTo 로 간다. `replyTo` 도메인도 화이트리스트 검사 대상
- ⚠️ **`fromName` 에 최종 사용자 입력을 그대로 넣지 마라.** pable studio는 이 값을 검사 없이 표시 이름으로 쓰므로, 폼 이름란에 `보안팀 <security@회사도메인>` 같은 값이 들어오면 **정상 발신 계정에서 온 사칭 메일**이 만들어진다. 앱이 정한 상수를 쓰고, 굳이 사용자 값을 쓴다면 `<>` 를 제거하고 길이를 제한하라
- 수신 도메인 화이트리스트 동일 적용. 단 활동 로그에 남는 건 **발신 계정 미등록·도메인 회수·`from` 불일치**로 거부된 호출뿐이다(pable studio 활동 로그 → **시스템 메일** 필터) — 형식·수신 도메인 오류는 기록되지 않으니 관리자에게 "로그를 보라"고 안내하지 마라

## 스코프 신청

- 스코프 = "이 서비스가 pable studio를 통해 호출할 수 있는 리소스 범위". **"SSO 발급 신청"** 전에 SSO 키 영역에서 필요한 스코프만 체크 → 관리자 승인.
- **위임 스코프**(`graph.me.*`, 캘린더·메일·프레즌스 등)는 해당 사용자가 **pable studio에 최소 1회 로그인**했어야 한다(Microsoft refresh_token 저장). 미로그인 시 **403 `portal_login_required`** — 재시도로 안 풀리고 사용자가 pable studio에서 동의해야 함.
- **민감 스코프**(Mail.Read/Send 등)는 매 호출마다 서버가 DB로 재확인 → 관리자가 회수하면 토큰이 유효해도 즉시 차단.

## 아바타(프로필 사진)

SSO JWT에는 사진이 없다(용량). 두 가지:
1. **이니셜 아바타**(권장): `name`으로 이니셜 생성.
2. **실제 사진**: `GET /api/org/users/{email}` 응답의 `photo`(data URI). **본인 조회는 별도 scope 없이** 가능 → 로그인 사용자 아바타 표시엔 추가 권한 불필요.

## 에러 / 키 회전

- `401` = 인증 실패(서명·service 불일치·스코프 0). `403 scope_mismatch` = 서비스 `granted_scopes` 에 요구 스코프 없음(승인 필요). `403 portal_login_required` = 위임 스코프인데 사용자 pable studio 미로그인/동의 회수 — 재시도로 안 풀림. `400 invalid_request` = 쿼리·바디 검증 실패(code 필드로 세분). `502` = pable studio→Microsoft Graph 호출 실패. `503 transient` = 일시 오류, 잠시 후 재시도.
- **키 회전**: pable studio에서 회전하면 이전 키는 즉시 무효 → 서비스 `SSO_SECRET`을 새 값으로 교체해야 함(회전 후 401 지속 = 옛 평문 잔존).
