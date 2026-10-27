# pable studio SSO v1 — 기존 앱 유지보수 전용

> ⛔ **새 앱에 쓰지 마라.** 새로 회사 계정 로그인을 붙이는 앱은 전부 v2 다(`sso-v2.md`) — pable studio 는 새 등록에 v1 을 발급하지 않는다.
>
> 이 문서는 아래를 **둘 다** 만족할 때만 읽는다.
> 1. `get_portal_registration` 의 `ssoProtocol` 이 `'v1'` 이다(이미 v1 키를 받은 기존 등록).
> 2. 앱에 v1 로그인 코드가 **이미 있다** — 토큰을 주소로 받는 `app/auth/sso/route.ts` 와 `SSO_SECRET` 을 쓰는 코드.
>
> 할 수 있는 일은 그 앱의 **유지보수**뿐이다 — 로그인 버그 수정, 사내 데이터 호출 추가, 서비스 ID 교정, 키 교체 배선.
> 앱에 아직 로그인 코드가 없는데 `ssoProtocol` 이 `'v1'` 이면 이 코드를 새로 만들지 말고 멈춘다(SKILL.md 규칙 -0.5 — "이 서비스에는 지금 pable studio 로그인을 붙일 수 없어요. pable studio 관리자에게 문의해 주세요" — 사용자에게 방식 이름을 말하지 않는다). 등록의 방식은 바뀌지 않으므로 v1 앱을 v2 로 옮기는 것도 이 문서 범위가 아니다.
> v1 코드에 v2 파일(`/auth/sso/callback`·`SSO_CLIENT_SECRET`)을 더하지도 마라 — 두 방식을 섞으면 로그인이 되지 않는다.

v1 프로토콜: pable studio 가 서비스별 키(`SSO_SECRET`, HS256)로 서명한 60초 JWT 를 앱의 `/auth/sso?token=` 으로 보내고,
앱은 같은 키로 검증한 뒤 자체 세션 JWT 로 재서명해 쿠키에 둔다. pable studio API(Bearer)는 그 세션 토큰을 그대로 보낸다.

## 1. 동작 개요 + 파일

```
[사용자] → pable studio 대시보드에서 서비스 카드 클릭
  → pable studio가 60초 JWT 발급 → 서비스의 /auth/sso?token=... 로 리디렉트
    → /auth/sso: 토큰 검증 → 자체 세션 JWT 재서명 → 쿠키 저장 → / 로 이동

[세션 없음·만료] → {PORTAL_URL}/dashboard?error=sso_required&service={SERVICE_ID}
  → (pable studio에 로그인돼 있지 않으면 로그인) → pable studio가 이 서비스로 자동 재진입 → 위 /auth/sso 흐름
```

| 파일 | 역할 |
|---|---|
| `app/auth/sso/route.ts` | SSO 진입점 — pable studio JWT 검증·재서명·쿠키 발급 |
| `app/page.tsx` (보호 페이지) | 세션 검증 + **역할 기반 기능 등급** |
| `app/login/page.tsx` | **공개** 로그인 안내 페이지 — 로그아웃 뒤 도착·`PORTAL_URL` 미설정 폴백·공유 링크로 들어온 사용자 안내 |
| `app/auth/logout/route.ts` | 세션 쿠키 삭제 후 `/login` |

## 2. 서비스 ID (`SSO_SERVICE_ID`)

pable studio에 등록된 식별자이고 **지어내는 값이 아니다.** JWT 의 `service`·`aud` 클레임에 실리는 값과 항상 같다.
`get_portal_registration` 의 `serviceClaimHint` 가 이 값이다(조회가 안 되면 pable studio "내 서비스" 카드의 **"서비스 ID" 칩**).

- **`serviceClaimPinned: false` = 잠정값** — 관리자가 승인할 때 다른 최종 ID 로 확정할 수 있다.
- **`serviceClaimPinned: true` 라도 래치가 아니다** — 승격 서비스 삭제·등록 재오픈 시 원래 값으로 되돌아온다. 어느 쪽이든 **배포 직전 재조회해 대조**하고, 달라졌으면 `SSO_SERVICE_ID` env 로 교체한다(코드의 `SERVICE_ID` 리터럴은 고치지 않는다).
- **비밀이 아니다** — `SSO_SECRET` 과 달리 채팅으로 다뤄도 된다.
- 자리표시자(`'my-service'`)인 채로 배포되면 pable studio가 이 앱을 찾지 못해 **세션이 만료돼도 자동 재진입이 안 되고(토스트만 뜬다) 에러 화면에 서비스 이름이 비어 보인다.**

## 3. 설정값 (v1)

- `SSO_SECRET` — `claim_portal_sso_key` 가 승인된 키를 수령해 저장한다(`SSO_SERVICE_ID` 도 함께). 사용자가 직접 복사해 주는 수동 폴백은 입력 카드로만
  받는다(웹 `manage_env` `request_input` · 로컬 `set_vercel_env`) — **채팅으로 키를 묻지 마라.** pable studio "키 확인"은 **누적 5회 한도**다.
- `PORTAL_URL` — `claim_portal_sso_key` 가 미설정이면 함께 배선한다. 코드 하드코딩 금지.
- (선택) `ALLOWED_TENANT_IDS` — 특정 회사만 허용할 때.
- 저장·변경 뒤에는 `request_vercel_deploy` 로 재배포해야 배포에 반영된다. "키가 안 맞아요"/`sso_failed` 는 코드보다 재배포를 먼저 해 본다.
- **로컬 실왕복**: `SSO_SECRET`·`SSO_SERVICE_ID`·`PORTAL_URL` 을 **PAX 웹 [코드] 탭의 `.env.local` 에서 복사**하는 것이 우선이다(확인 횟수를 쓰지 않는다).
- ⚠️ **(v1) 스코프만 바꿀 때는 키를 바꾸지 않는다**(2026-10-14~) — 사용자가 pable studio 대시보드 카드의 **"SSO 관리"**에서 권한 변경을 신청하면
  키는 그대로다(제거는 바로, 추가는 관리자 승인 뒤 다음 토큰부터) — 배선·재배포도 필요 없다.
  **키 재발급(회전)은 키가 새어 나갔거나 키 확인 한도를 다 썼을 때만** 쓴다 — 이전 키가 **즉시 무효화**돼 배포된 앱의 로그인이 그 자리에서 끊기므로,
  사용자가 pable studio에서 진행하고 승인 뒤 `claim_portal_sso_key` 를 `force: true` 로 호출해 새 키를 교체 배선 → 재배포한다. 도구가 회전을 먼저 제안하지 않는다.
- `SSO_SECRET` 은 세션 재서명에도 쓰이므로 보유자는 유효 세션을 위조할 수 있다 — 편집 권한자는 웹 [코드] 탭 `.env.local` 에서 값을 볼 수 있다.

## 4. 코어 코드 (v1)

**`SERVICE_ID` 는 pable studio가 준 값**이다 — 위 §2 "서비스 ID" 절차로 받아서 그대로 넣는다(지어내지 마라). **`COOKIE_NAME` 은 반대로 임의 고유값**이면 된다(다른 서비스와만 안 겹치면 됨, 예: `scheduler_sso`).

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

// 로컬(next dev)이면 &target=local — 생략하면 pable studio가 운영 배포로 재진입시킨다.
// sso_required 에만 의미가 있다(나머지 코드는 토스트라 target 무관).
const RELAUNCH_TARGET = process.env.NODE_ENV === 'development' ? '&target=local' : ''

// pable studio 복귀 헬퍼 — 코드는 이 세 가지뿐(표에 없는 코드는 pable studio가 조용히 무시).
// PORTAL_URL 이 없으면 죽은 절대주소 대신 자체 안내 페이지로 degrade.
type PortalCode = 'sso_required' | 'sso_failed' | 'borrowing_inactive'
const portalBack = (code: PortalCode, req: NextRequest) =>
  PORTAL_URL
    ? NextResponse.redirect(
        `${PORTAL_URL}/dashboard?error=${code}&service=${SERVICE_ID}${code === 'sso_required' ? RELAUNCH_TARGET : ''}`,
      )
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
  // 토큰 없이 진입 = pable studio 미경유 직접 접근 → sso_required (pable studio가 로그인 후 자동 재진입)
  if (!token) return portalBack('sso_required', req)

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

    // 규칙 3: borrowing 가드 + TTL 분기 — 공유 회수·공개 해제 직후 토큰은 전용 코드로
    // (sso_failed 로 보내면 pable studio 접속 기록에 "서비스 설정 오류"로 잘못 남는다)
    if (payload.via === 'grant' && payload.borrowing_active !== true) {
      return portalBack('borrowing_inactive', req)
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
const PORTAL_URL = process.env.PORTAL_URL  // 하드코딩 폴백 금지 (route.ts 주석과 같은 이유)
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
  // 규칙 7: 세션 없음·만료 → sso_required 로 pable studio에 보낸다. pable studio가 (필요하면 로그인 후)
  // 이 서비스로 자동 재진입시킨다. 로컬(next dev)은 &target=local — 생략하면 운영 배포로 간다.
  // PORTAL_URL 이 없으면 죽은 절대주소 대신 자체 안내 페이지로 degrade.
  if (!session) {
    redirect(PORTAL_URL
      ? `${PORTAL_URL}/dashboard?error=sso_required&service=${SERVICE_ID}${process.env.NODE_ENV === 'development' ? '&target=local' : ''}`
      : '/login')
  }

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
> ⚠️ **UI 분기만으론 부족(보안)** — 편집·관리·삭제 같은 보호 동작은 **서버 라우트에서도 role 을 재검증**해야 한다(클라이언트 분기는 URL 직접 호출을 못 막음). v1 서버 가드는 아래 §5.

### `app/login/page.tsx` — 공개 로그인 안내 (규칙 7)

세션이 필요 없는 **공개 페이지**여야 한다(아니면 무한 리다이렉트). 로그아웃 뒤 도착하는 곳이자, `PORTAL_URL` 이 없을 때의 폴백, 그리고 공유 링크로 들어온 사용자(pable studio 자동 재진입 대상이 아님)를 위한 안내 화면이다.

```tsx
const PORTAL_URL = process.env.PORTAL_URL  // 하드코딩 폴백 금지
const SERVICE_ID = process.env.SSO_SERVICE_ID ?? 'my-service'  // route.ts 와 같은 값
// sso_required 로 보내면 pable studio가 (필요하면 로그인 후) 이 서비스로 자동 재진입시킨다
const LOGIN_URL = PORTAL_URL
  ? `${PORTAL_URL}/dashboard?error=sso_required&service=${SERVICE_ID}${process.env.NODE_ENV === 'development' ? '&target=local' : ''}`
  : null

export default function LoginPage() {
  return (
    <main>
      <h1>pable studio 계정으로 로그인해 주세요</h1>
      <p>
        이 서비스는 pable studio 계정으로 로그인해요.
        아래 버튼을 누르면 pable studio에서 로그인한 뒤 이 서비스로 자동으로 돌아와요.
        (공유 링크로 들어왔다면 받은 링크로 다시 접속해 주세요.)
      </p>
      {/* 주소를 모르면 죽은 링크 대신 안내만 렌더한다 */}
      {LOGIN_URL
        ? <a href={LOGIN_URL}>pable studio로 로그인</a>
        : <p>pable studio 주소가 설정되지 않았어요. 관리자에게 <code>PORTAL_URL</code> 설정을 요청해 주세요.</p>}
    </main>
  )
}
```

### `app/auth/logout/route.ts`

```ts
import { NextResponse } from 'next/server'
const COOKIE_NAME = 'my_service_sso'
// 로그아웃은 반드시 자체 /login 으로 — sso_required 로 보내면 pable studio가 곧바로
// 다시 로그인시켜 로그아웃이 무의미해진다.
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/login', req.url))
  res.cookies.set(COOKIE_NAME, '', { path: '/', maxAge: 0 })
  return res
}
```

## 5. 서버 가드 (v1)

```ts
// app/api/admin/*/route.ts 등 운영 admin 전용 엔드포인트
import { cookies } from 'next/headers'
import { jwtVerify } from 'jose'

async function verifySession() {
  const token = (await cookies()).get('my_service_sso')?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.SSO_SECRET!), { algorithms: ['HS256'] })
    return payload as unknown as { role?: string; is_owner_tenant?: boolean; tenant_id?: string; sub?: string; oid?: string }
  } catch {
    return null
  }
}

export async function GET() {
  const s = await verifySession()
  if (!s || s.is_owner_tenant !== true || s.role !== 'owner') {
    return new Response('Not Found', { status: 404 }) // 존재 은닉
  }
  // ...
}
```

사용 회사 관리자 표(`service_tenant_admins` — `multitenant.md` §4)의 v1 매칭은 `user_oid` 칸에 Entra `oid` 를 넣는다.
`oid` 는 공유 링크로 들어온 토큰에는 없으므로 이메일 폴백이 남고, 맞으면 바로 `oid` 를 채운다:

```ts
// v1 — oid 우선, 없으면 이메일 폴백. oid 비교는 대소문자 무시(GUID 표기 차이 방어).
const rows = await db.from('service_tenant_admins')
  .select('user_email, user_oid')
  .eq('tenant_id', session.tenant_id)
const matched = rows.data?.some((r) =>
  (session.oid && r.user_oid && r.user_oid.toLowerCase() === session.oid.toLowerCase()) ||
  r.user_email === session.sub)

const isServiceAdmin =
  (session.is_owner_tenant === true && session.role === 'owner') ||  // A회사 운영자
  !!matched                                                          // B회사 자체 임명

// 점진 이관 백필 — 이메일로 매칭됐고 session.oid 가 있으면 그 행에 user_oid 를 채운다.
if (session.oid && matched) {
  await db.from('service_tenant_admins')
    .update({ user_oid: session.oid })
    .eq('tenant_id', session.tenant_id)
    .eq('user_email', session.sub)
    .is('user_oid', null)   // 기존 값 덮어쓰기 방지 + 부분 유니크 인덱스 충돌 회피
}
```

## 6. pable studio API 부르기 (v1 Bearer)

- 호출 인증 = **세션 쿠키에 담긴 재서명 JWT 를 그대로 `Authorization: Bearer`** 로 전달한다(`SSO_SECRET` 으로 HS256 서명된 토큰). `payload.service` 가 자기 서비스 ID 와 같아야 한다.
- **Bearer 호출 자격** = SSO 키 발급 + `granted_scopes` 1개 이상. 스코프 0개면 본인 조회도 401.
- **호출 대상 주소는 세션의 `portal_origin` 우선, env `PORTAL_URL` 폴백**(§4 `resolvePortalOrigin`). 쿠키를 직접 읽지 말고 반드시 `getSession()`(서명 검증 통과)을 거친다.
- 엔드포인트·스코프·에러 규칙은 `portal-api.md` 와 같다.

```ts
// 서버 라우트 안에서 — 검증된 세션의 토큰과 origin 을 함께 쓴다.
// getSession·resolvePortalOrigin 은 이 라우트 파일에도 그대로 복사 선언한다(page.tsx 에서 export 하면 Next 가 타입 에러로 막는다).
const session = await getSession()
if (!session?.token) return new Response(null, { status: 401 })
const origin = resolvePortalOrigin(session)   // portal_origin → env → null
if (!origin) return new Response(null, { status: 503 })
const res = await fetch(`${origin}/api/org/users/${encodeURIComponent(email)}`, {
  headers: { Authorization: `Bearer ${session.token}` },
})
```

## 7. 에러 프로토콜 (v1)

pable studio로 보내는 주소는 한 형식이다: `{PORTAL_URL}/dashboard?error={코드}&service={SERVICE_ID}`. 이 서비스가 보내는 코드는 `sso_required`·`sso_failed`·`borrowing_inactive` **세 가지뿐**이다 — 표에 없는 코드는 pable studio가 조용히 무시한다.

**규칙 7 — 세션 없음·만료는 `sso_required` 로 pable studio에 보낸다.** pable studio가 (로그인돼 있지 않으면 로그인을 받은 뒤) 이 서비스로 **자동 재진입**시킨다 — 사용자가 카드를 다시 찾을 필요가 없다. 자동 재진입 대상은 정식 서비스와 **등록자 본인의** 개발 등록이고, 그 밖(공유 링크로 들어온 다른 테스터 등)은 pable studio 대시보드에 안내 토스트가 뜬다. 같은 탭에서 60초 안에 자동 재진입이 반복되면 pable studio가 멈추고 안내를 띄운다.
- `&target=local` — 로컬(`next dev`)에서만 붙인다. 생략하면 운영 배포로 재진입한다. pable studio에 로컬 포트가 등록돼 있어야 하고, 없으면 토스트로 끝난다.
- 로그아웃은 예외 — 자체 `/login` 으로 보낸다(`sso_required` 면 곧바로 다시 로그인된다).
- 🚫 `{PORTAL_URL}/auth/redirect?serviceId=` 를 쓰지 마라 — pable studio 내부 경로다. 정식 승격 전 앱은 "서비스를 찾을 수 없음"이 되고, pable studio에 로그인돼 있지 않으면 로그인 화면으로 자동 연결되지 않는다.

| 코드 | 상황 | 처리 |
|---|---|---|
| `sso_required` | 세션 없음·만료, `/auth/sso` 에 토큰 없이 직접 접근 (정상) | pable studio가 로그인 후 자동 재진입 (대상이 아니면 토스트) |
| `sso_failed` | 실제 검증 실패 (키·tenant 불일치) | pable studio 토스트 + 관리자 로깅 — 자동 재시도 안 함 |
| `borrowing_inactive` | 공유받은 서비스인데 공유 회수·공개 해제 직후 토큰 (`via='grant'` + `borrowing_active` 아님) | pable studio 토스트 (공유 권한 회수 안내) |
| `sso_not_issued` | 키 미승인 (pable studio가 진입 전 차단·발급 — 이 서비스는 emit·handle 안 함) | 관리자 승인 대기 안내 (코드 수정 대상 아님) |

에러가 보이면 **코드를 다시 고치기 전에 pable studio부터 확인**하도록 안내:
`sso_failed` → `SSO_SECRET` 불일치 / "SSO 연동" 체크 누락(토큰 미수신) / **`SERVICE_ID` 불일치**.
`sso_not_issued` → 관리자 키 승인 대기.

### 증상 → 원인 찾기 (v1)

| 증상 | 1순위 원인 | 확인·조치 |
|---|---|---|
| pable studio로 간 뒤 이 서비스로 자동으로 돌아오지 않고 토스트만 뜬다, 또는 에러 화면에 서비스 이름이 비어 보인다 | `SERVICE_ID` 가 pable studio 값과 다름 (가장 흔함). 그 밖에 승격 전 앱을 등록자가 아닌 사용자가 쓰는 경우(정상), 로컬인데 pable studio에 로컬 포트 미등록 | **주소창의 `?service=` 값**이 pable studio "내 서비스" 카드의 **"서비스 ID" 칩**과 글자 그대로 같은지 대조 → 다르면 `SSO_SERVICE_ID` env 로 교정 후 재배포 |
| pable studio와 이 앱을 오가다 "방금 전에 이 서비스로 자동 접속을 시도했어요" 안내가 뜬다 | 세션 쿠키가 저장·전달되지 않는다 — `route.ts`·`page.tsx`·로그아웃의 `COOKIE_NAME` 불일치, 또는 http 주소에서 secure 쿠키 | 세 파일의 `COOKIE_NAME` 이 같은지, 배포 주소가 https 인지 확인 |
| 로그인은 되는데 pable studio 데이터가 401 | 스코프 미승인, 또는 DEV_BYPASS mock(`token: null`) | pable studio에서 스코프 승인 상태 확인. mock 은 원래 pable studio API 를 못 부른다 |
| pable studio로 갔는데 아무 안내도 없다 | 표에 없는 코드를 보냈다 | 이 서비스가 보내는 코드는 `sso_required`·`sso_failed`·`borrowing_inactive` 세 가지뿐이어야 한다. 임의 코드를 지어내지 마라 |

> 서버 로그에도 단서가 있다 — `SERVICE_ID` 불일치는 `[sso] SERVICE_ID 불일치` 경고로 남는다(배포 로그 확인 — 로컬 AI 는 `get_deploy_logs`).
