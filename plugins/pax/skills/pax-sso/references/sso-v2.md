# pable studio SSO v2 레시피 (`ssoProtocol: 'v2'` 등록 전용)

새로 회사 계정 로그인을 붙이는 앱은 **전부 이 레시피로** 만든다(`get_portal_registration` 의 `ssoProtocol` 이 `'v2'` 이거나 아직 `null`).
기존 v1 앱 유지보수 문서(`sso-v1.md`)의 코드는 쓰지 않는다 — 섞으면 로그인이 되지 않는다. 사용자에게 v1/v2 를 설명할 필요는 없다.
규칙 -1(스코프 가드)·규칙 0(선행조건)은 SKILL.md, 역할 등급·DEV_BYPASS·멀티테넌트 규칙은 멀티테넌트 참조 문서 그대로다.

프로토콜: 인가 코드 + PKCE S256 + client secret(client_secret_post) → 접근 토큰(ES256 JWT, 60초)을 pable studio JWKS 로 검증 →
자체 세션 쿠키. pable studio API(Bearer)는 접근 토큰으로 부르고, 60초가 지나면 로그인 유지(refresh token)로 새로 받는다.
이 레시피는 **검증된 코드**다(Next.js 16 App Router · `jose` 만 — 다른 라이브러리를 더하지 마라). 고칠 곳은 `COOKIE_NAME` 하나뿐이다.

## 동작 개요 + 만들 파일

```
[사용자] → pable studio 카드 클릭 → {앱}/auth/sso?iss={pable studio}&login_hint={계정}
  → /auth/sso: state·PKCE·service_session_id 를 암호화 쿠키(10분)에 두고 {PORTAL_URL}/auth/service-account 로 이동
    → (pable studio 에 로그인돼 있으면 화면 없이) {앱}/auth/sso/callback?code=…&state=…
      → callback: state 비교 → 서버에서 code 교환(client secret) → 접근 토큰 ES256 검증 → 앱 세션 쿠키 → /

[세션 없음·만료] → 페이지가 /auth/sso 로 보낸다 → 위 흐름(대개 화면 없이 다시 로그인)
[pable studio API] → 서버 라우트에서 getAccessToken() → Authorization: Bearer {접근 토큰}
```

| 파일 | 역할 |
|---|---|
| `lib/sso.ts` | 설정·키 유도·세션 읽기·토큰 쿠키(암호화)·JWKS 검증 — 아래 파일들이 import 한다 |
| `lib/portal-token.ts` | `getAccessToken()` — pable studio API 용 접근 토큰(60초, refresh 로 갱신) · `requireLiveSession()` — 민감한 서버 동작의 세션 확인 |
| `app/auth/sso/route.ts` | 로그인 시작 — **카드가 여는 주소**(`iss`·`login_hint`) |
| `app/auth/sso/callback/route.ts` | 콜백 — code 교환·토큰 검증·앱 세션 발급 |
| `app/page.tsx` (보호 페이지) | 세션 가드 + 역할 기반 기능 등급 |
| `app/login/page.tsx` | **공개** 안내 페이지 — 로그아웃 뒤 도착·로그인 실패 문구·설정 미비 폴백 |
| `app/auth/logout/route.ts` | refresh 폐기 + 쿠키 삭제 후 `/login` |

`src/` 를 쓰는 프로젝트(PAX 기본)는 `src/lib/…`·`src/app/…` 에 둔다. import 는 `@/lib/sso`(PAX 기본 tsconfig `@/* → ./src/*`) —
별칭이 없는 프로젝트면 상대 경로로 바꾼다.

## 규칙 (v2)

1. **경로를 바꾸지 마라** — pable studio 가 등록의 주소(로컬 포트 `http://localhost:{포트}`·개발 URL·배포 URL)마다
   `{origin}/auth/sso`(카드 시작)와 `{origin}/auth/sso/callback`(돌아갈 주소)을 **자동으로 등록**해 둔다. 다른 경로·다른 주소면
   pable studio 화면이 "로그인 연동이 등록되지 않은 서비스" 로 멈춘다.
   🚫 **앱을 경로 아래(`https://host/app`·Next `basePath`)에 두지 마라 — 이 레시피는 도메인 루트 전용이다.** pable studio 는 경로 아래 앱의
   돌아갈 주소를 그 경로 아래(`https://host/app/auth/sso/callback`)로 등록하는데, 이 코드는 루트(`{origin}/auth/sso/callback`)로 만든다.
2. **설정값 3종** — `PORTAL_URL`(pable studio 정본 주소 = 토큰의 iss) · `SSO_CLIENT_ID`(`dev-{번호}`) · `SSO_CLIENT_SECRET`(서버 전용).
   `claim_portal_sso_key` 가 배선한다. v1 의 `SSO_SECRET`·`SSO_SERVICE_ID` 는 쓰지 않는다. **새 환경변수를 만들지 마라** —
   세션 서명 키·토큰 암호화 키는 `SSO_CLIENT_SECRET` 에서 유도한다.
3. 🚫 **쿼리의 `iss` 로 주소를 만들지 마라.** 카드 주소는 누구나 흉내 낼 수 있다 — `iss` 가 설정값과 정확히 같을 때만 `login_hint` 를 쓰고,
   인가·토큰·JWKS 주소는 언제나 `PORTAL_URL`.
4. 🚫 **client secret·refresh token·접근 토큰을 응답 본문·로그·주소·클라이언트 컴포넌트·`NEXT_PUBLIC_*` 에 싣지 마라.**
   토큰은 암호화 쿠키(브라우저는 풀 수 없다)와 서버 메모리에만 둔다. `lib/sso.ts`·`lib/portal-token.ts` 는 `'use client'` 파일·middleware 에서 import 하지 않는다.
5. **세션 모양** — `sub` = 이메일(멀티테넌트 참조 문서의 역할 등급·서버 가드·데이터 격리 코드가 이 값으로 돈다), `role`·`tenant_id`·`is_owner_tenant`… 는 pable studio 토큰 그대로.
   pable studio 의 계정 키(이 서비스 전용 가명)는 `portal_sub` 다 — 이메일과 달리 바뀌지 않으니 새로 만드는 사용자 테이블의 키로 권한다.
   v2 토큰에는 **`oid` 가 없다** — 멀티테넌트 참조 문서의 관리자 표(`service_tenant_admins.user_oid`)에는 `portal_sub` 를 넣고 그 문서의 **v2 매칭**
   (계정 키 우선 · 이메일은 계정 키가 없는 행만 · 맞으면 바로 백필)을 쓴다. 🚫 **권한을 이메일만으로 맞추지 마라** — 메일 주소가 다른 사람에게
   다시 배정되면 그 사람이 관리자 권한을 물려받는다.
6. **세션에 Bearer 토큰이 없다** — pable studio API 는 언제나 `getAccessToken()` 으로 부른다(아래 Bearer 절).
   앱 세션 JWT(자체 서명)를 Bearer 로 보내면 401 이다.
7. 오류는 pable studio 로 되돌려 보내지 않는다 — 자체 `/login?error={고정 코드}` 로 안내한다.
   pable studio 가 준 `error`·`error_description` 원문을 화면에 출력하지 않는다.
8. **로그아웃** — refresh 를 pable studio 에서 폐기하고 쿠키를 지운 뒤 `/login`. pable studio 자체 로그아웃은 아니다(다시 [로그인]을 누르면 화면 없이 들어온다).
   pable studio 의 로그아웃 알림(백채널)은 이 레시피에 없다 — 쿠키 세션이라 끝낼 서버 상태가 없고, 세션 수명(1시간·공유 10분)이 상한이다.
9. `SSO_CLIENT_SECRET` 을 재발급해 바꾸면 기존 세션·토큰 쿠키가 전부 무효가 된다 — 사용자는 다음 접속 때 다시 로그인한다(대개 화면 없이). 정상이다.
   재발급은 등록마다 24시간에 3번까지다(넘으면 pable studio가 `429 rotate_limit` 으로 거절한다).
10. **PAX 미리보기는 실제 로그인을 하지 않는다** — 미리보기는 `DEV_BYPASS_SSO` 로 mock 세션을 띄운다(`getSession` 이 mock 을 돌려준다).
    실제 왕복은 배포(또는 로컬 포트가 등록된 로컬 실행)에서 확인한다. 로컬에서 실제 왕복을 하려면 `.env.development.local` 의 `DEV_BYPASS_SSO` 줄을
    **지우거나 `false` 로** 둔다 — 켜져 있으면 `/auth/sso` 가 pable studio 로 가지 않고 mock 세션을 만든다(production 빌드에선 무시된다).
11. 🚫 **세션의 `network_zone` 으로 행위를 허용·거부하지 마라(판정은 60초 안의 토큰 클레임으로만).** 앱 세션은 1시간 살고 그 안의 값은 로그인할 때의
    판정이다(refresh 로도 새로 판정되지 않는다). 세션 값은 화면 안내에만 쓴다. **기능 단위 사내망 제한(사내에서만 출퇴근 기록 등)은 이 레시피에 없다** —
    요청받으면 만들지 말고 "pable studio 로그인으로는 아직 지원되지 않아요"라고 안내한다(PAX 가 만드는 개발 등록은 사내망 설정이 '판정 결과만 전달'로 고정이라
    '사내망 전용' 서비스 설정도 쓸 수 없다).
12. **민감한 서버 동작은 `getAccessToken()` 실패를 로그인 안 됨으로 다룬다** — 삭제·권한 변경·외부 발송처럼 되돌리기 어려운 server action·쓰기 라우트는
    `getSession()` 만 보지 말고 `getAccessToken()` 도 본다(`requireLiveSession()`): `login_required` 면 로그인 안 된 것(401·다시 로그인 안내),
    `unavailable` 이면 진행하지 않는다(503·잠시 뒤). 앱 세션 쿠키는 pable studio 로그아웃·권한 회수 뒤에도 `SESSION_TTL` 까지 남는다. 예시는 아래 "민감한 서버 동작" 절.

### `lib/sso.ts` — 공용 모듈

```ts
/**
 * pable studio 로그인(SSO v2) 공용 모듈 — 설정·쿠키·세션. 서버 전용(Node 런타임).
 * 라우트(app/auth/sso/*)·페이지·lib/portal-token.ts 가 이 파일을 import 한다.
 * 🚫 middleware·'use client' 파일에서 import 하지 마라(node:crypto·비밀값을 쓴다).
 */
import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT, type JWTPayload } from 'jose'

// 🚫 하드코딩 폴백(`?? 'https://…'`) 금지 — 값이 없으면 /login 안내로 degrade 한다.
// PORTAL_URL 은 pable studio 정본 주소(토큰의 iss 와 같은 값)여야 한다. https 만, 로컬 pable studio 만 http.
export const PORTAL_ORIGIN = toPortalOrigin(process.env.PORTAL_URL)
// ← pable studio 가 준 client_id(`dev-{등록 번호}`) — claim_portal_sso_key 가 SSO_CLIENT_ID 로 배선한다. 지어내지 마라.
export const CLIENT_ID = process.env.SSO_CLIENT_ID ?? ''
export const COOKIE_NAME = 'my_service_sso' // ← 서비스별 고유 (임의 값)
export const TOKEN_COOKIE = `${COOKIE_NAME}_tk` // 접근·refresh 토큰 — 암호화해 둔다(서버만 푼다)
export const TX_COOKIE = `${COOKIE_NAME}_tx` // 로그인 진행 중 state·PKCE (10분)
export const TX_PATH = '/auth/sso' // /auth/sso 와 /auth/sso/callback 에만 실린다
// 로그인 유지가 끝난 뒤 다시 로그인할 때 같은 계정으로 — pable studio 계정 키(가명). 비밀은 아니다
export const HINT_COOKIE = `${COOKIE_NAME}_hint`
const LOGIN_HINT_RE = /^[A-Za-z0-9_-]{16,128}$/
// 카드가 준 컬러 모드(light·dark·system) — 앱에 다크 모드가 있을 때 첫 화면을 그 모드로 그리는 데만 쓴다(비밀 아님, 화면 스크립트가 읽는다)
export const THEME_COOKIE = `${COOKIE_NAME}_theme`
export const SESSION_TTL = 3600 // 앱 세션(초) — 1시간 이내 권장. 길수록 pable studio 로그아웃·권한 회수가 이 세션에 늦게 닿는다(민감 동작은 규칙 12)
export const BORROWING_TTL = 600 // 공유받은(borrowing) 세션 — 잔존 윈도우 단축

export function cookieOptions(maxAge: number, path = '/') {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path, maxAge }
}

/** 카드의 `theme` 쿼리 — 아는 값만(모르는 값·없음은 null → 쿠키를 건드리지 않는다) */
export function cardTheme(v: string | null): 'light' | 'dark' | 'system' | null {
  return v === 'light' || v === 'dark' || v === 'system' ? v : null
}

/**
 * 첫 화면 전에 카드의 컬러 모드를 `<html data-theme>` 로 — app/layout.tsx 의 <head> 인라인 스크립트("컬러 모드" 절, 다크 모드가 있는 앱만).
 * system 은 지금 OS 설정으로 접는다. 쿠키가 없으면 아무것도 하지 않는다(앱의 기본 모드 그대로).
 */
export function themeBootScript(): string {
  return `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)(?:;|$)/);if(!m)return;var t=m[1]==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m[1];document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`
}

/** 로그인 설정 3종이 다 있는가 — 없으면 라우트가 /login?error=config 로 degrade 한다 */
export function isConfigured(): boolean {
  return Boolean(PORTAL_ORIGIN && CLIENT_ID && process.env.SSO_CLIENT_SECRET)
}

export function isDevBypass(): boolean {
  return process.env.DEV_BYPASS_SSO === 'true' && process.env.NODE_ENV !== 'production'
}

function toPortalOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLocal) ? u.origin : null
  } catch {
    return null
  }
}

function clientSecret(): string {
  const s = process.env.SSO_CLIENT_SECRET
  if (!s) throw new Error('SSO_CLIENT_SECRET 미설정')
  return s
}

// 세션 서명 키·토큰 암호화 키 — 새 환경변수 없이 SSO_CLIENT_SECRET 에서 HKDF 로 유도한다(용도마다 다른 키).
// 비밀값을 재발급해 바꾸면 기존 세션·토큰 쿠키가 전부 무효가 된다 → 사용자는 다음 접속 때 다시 로그인(대개 화면 없이).
let derived: { secret: string; session: Uint8Array; token: Uint8Array } | null = null
function keys() {
  const secret = clientSecret()
  if (derived?.secret !== secret) {
    const derive = (info: string) => new Uint8Array(hkdfSync('sha256', secret, 'pable-sso-v2', info, 32))
    derived = { secret, session: derive('app-session'), token: derive('app-token') }
  }
  return derived
}

// ─── 세션 ──────────────────────────────────────────────────────────────

/** 앱 세션(자체 서명 JWT) 페이로드 — 역할 등급·서버 가드·데이터 격리 코드가 이 필드를 쓴다. */
export interface SSOPayload {
  sub: string // 이메일
  email?: string
  portal_sub: string // pable studio 가 이 서비스에 준 계정 키(가명) — 다시 로그인할 때 login_hint 로 쓴다
  name: string
  service: string // = SSO_CLIENT_ID
  role: 'viewer' | 'editor' | 'owner'
  tenant_id?: string
  tenant_name?: string | null // 표시 전용 (권한 결정 금지)
  service_owner_tenant_id?: string | null
  is_owner_tenant?: boolean
  borrowing_active?: boolean
  via?: 'owner' | 'global' | 'grant' // 감사 전용 (권한 게이트 금지)
  scopes?: string[]
  portal_origin?: string // = PORTAL_ORIGIN
  network_zone?: string // 로그인할 때의 사내망 판정 — 화면 안내 전용. 행위 허용·거부에 쓰지 마라(규칙 11)
  auth_time?: number
  // oid 는 없다 — v2 토큰에 Entra oid 가 없다. 사람을 가리키는 키는 portal_sub(멀티테넌트 참조 문서의 v2 매칭)
}
// 세션에 Bearer 토큰이 없다 — pable studio API 는 lib/portal-token.ts 의 getAccessToken() 으로 부른다.
export type Session = SSOPayload

export async function getSession(): Promise<Session | null> {
  // DEV_BYPASS: pable studio 없이 로컬에서 로그인·등급을 즉시 테스트 (production 에선 무시)
  if (isDevBypass()) return buildDevMockSession()
  try {
    const token = (await cookies()).get(COOKIE_NAME)?.value
    if (!token) return null
    const { payload } = await jwtVerify(token, keys().session, { algorithms: ['HS256'] })
    return payload as unknown as Session
  } catch {
    return null
  }
}

export async function signSession(claims: Record<string, unknown>, ttl: number): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${ttl}s`).sign(keys().session)
}

// ─── pable studio 토큰 ──────────────────────────────────────────────────

// JWKS 는 모듈에 한 번 만든다(jose 가 캐시하고, 모르는 kid 가 오면 다시 받는다). 주소는 언제나 설정값으로.
const jwks = PORTAL_ORIGIN ? createRemoteJWKSet(new URL('/api/sso/jwks', PORTAL_ORIGIN)) : null

/** 접근 토큰 검증 — iss·aud·alg 는 언제나 설정값으로(ES256, 60초). */
export async function verifyAccessToken(token: unknown): Promise<JWTPayload> {
  if (!jwks || !PORTAL_ORIGIN || !CLIENT_ID || typeof token !== 'string') throw new Error('sso_not_configured')
  const { payload } = await jwtVerify(token, jwks, {
    issuer: PORTAL_ORIGIN,
    audience: CLIENT_ID,
    algorithms: ['ES256'],
    typ: 'JWT', // 로그아웃 알림 토큰(logout+jwt)을 접근 토큰으로 받지 않는다
    requiredClaims: ['sub', 'exp', 'iat', 'jti'],
    clockTolerance: 5,
  })
  return payload
}

/** pable studio 토큰 끝점 호출 — 클라이언트 인증은 본문의 client_id·client_secret(client_secret_post). */
export async function portalPost(
  path: '/api/sso/token' | '/api/sso/revoke',
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!PORTAL_ORIGIN || !CLIENT_ID) throw new Error('sso_not_configured')
  let res: Response
  try {
    res = await fetch(new URL(path, PORTAL_ORIGIN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // 비밀값은 이 서버에서 pable studio 로만 간다 — 브라우저·주소·로그에 싣지 않는다
      body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: clientSecret() }),
      cache: 'no-store',
      redirect: 'error', // 다른 주소로 넘어가며 비밀값이 따라가지 않게(PORTAL_URL 이 옛 주소면 여기서 실패한다)
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    console.warn('[sso] pable studio 호출 실패 — 네트워크·시간 초과이거나, PORTAL_URL 이 다른 주소로 넘어가는 옛 주소다(설정값 확인)')
    throw e
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

/** refresh 폐기(RFC 7009) — 실패해도 로그아웃은 진행한다. 503·네트워크 오류면 1초 뒤 한 번 더. 토큰 값은 로그에 남기지 않는다. */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { status } = await portalPost('/api/sso/revoke', { token: refreshToken, token_type_hint: 'refresh_token' })
      if (status === 200) return
      if (status !== 503) {
        console.warn('[sso] refresh 폐기 응답', status)
        return
      }
    } catch {
      // 네트워크 — 아래에서 한 번 더
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1000))
  }
  console.warn('[sso] refresh 폐기 요청 실패')
}

// ─── 암호화 쿠키 (토큰·로그인 진행 상태) ───────────────────────────────────

export async function seal(data: Record<string, unknown>, maxAge: number): Promise<string> {
  return new EncryptJWT(data)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${maxAge}s`)
    .encrypt(keys().token)
}

export async function unseal(raw: string | undefined): Promise<JWTPayload | null> {
  if (!raw) return null
  try {
    const { payload } = await jwtDecrypt(raw, keys().token, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    return payload
  } catch {
    return null
  }
}

/** 토큰 쿠키 — sub = pable studio 계정 키, sid = service_session_id, at = 접근 토큰(60초), rt = refresh(있을 때만). */
export interface PortalTokens {
  sub: string
  sid: string
  at: string
  atExp: number
  rt?: string
}

export async function readTokens(): Promise<PortalTokens | null> {
  const p = await unseal((await cookies()).get(TOKEN_COOKIE)?.value)
  if (!p || typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.at !== 'string' || typeof p.atExp !== 'number') return null
  return { sub: p.sub, sid: p.sid, at: p.at, atExp: p.atExp, ...(typeof p.rt === 'string' ? { rt: p.rt } : {}) }
}

/**
 * 세션·토큰 쿠키 삭제 — 서버 컴포넌트에서는 쿠키를 지울 수 없어 조용히 넘어간다(다음 라우트 호출이 지운다).
 * hintSub 를 주면 그 계정 키를 힌트 쿠키로 남긴다 — 다시 로그인할 때 같은 계정으로 돌아오게(빼면 지금 활성 계정으로 조용히 바뀔 수 있다).
 */
export async function clearLoginCookies(hintSub?: string): Promise<void> {
  try {
    const jar = await cookies()
    jar.set(COOKIE_NAME, '', cookieOptions(0))
    jar.set(TOKEN_COOKIE, '', cookieOptions(0))
    if (hintSub && LOGIN_HINT_RE.test(hintSub)) jar.set(HINT_COOKIE, hintSub, cookieOptions(86400, TX_PATH))
  } catch {
    /* 서버 컴포넌트 — 무시 */
  }
}

/** 남겨 둔 계정 힌트 — 모양이 맞을 때만. */
export function readHintCookie(raw: string | undefined): string | null {
  return raw && LOGIN_HINT_RE.test(raw) ? raw : null
}

// ─── 작은 도구 ────────────────────────────────────────────────────────

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 상수 시간 비교 — 바이트 길이가 다르면 timingSafeEqual 이 던지므로 먼저 본다. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// 로컬 DEV_BYPASS mock — DEV_BYPASS_SCENARIO 로 5가지 전환 (기본 owner_native). 시나리오는 멀티테넌트 참조 문서 §5.
function buildDevMockSession(): Session {
  const s = process.env.DEV_BYPASS_SCENARIO ?? 'owner_native'
  const T_OWNER = '00000000-0000-0000-0000-000000000001'
  const T_USER = '00000000-0000-0000-0000-000000000002'
  const base = {
    sub: 'dev@local', email: 'dev@local', portal_sub: 'dev-local', name: '개발자', service: CLIENT_ID || 'my-service',
    scopes: [] as string[], auth_time: Math.floor(Date.now() / 1000), // oid 없음 — 실제 v2 토큰과 같게(관리자 매칭이 portal_sub 경로로 시험된다)
  }
  switch (s) {
    case 'super_admin_cross': return { ...base, role: 'owner', tenant_id: T_USER, tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: true, borrowing_active: true, via: 'grant' }
    case 'borrowed_owner': return { ...base, role: 'owner', tenant_id: T_USER, tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: false, borrowing_active: true, via: 'grant' }
    case 'borrowed_viewer': return { ...base, role: 'viewer', tenant_id: T_USER, tenant_name: 'B회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: false, borrowing_active: true, via: 'grant' }
    case 'global': return { ...base, role: 'viewer', tenant_id: T_USER, tenant_name: 'B회사', service_owner_tenant_id: null, is_owner_tenant: false, borrowing_active: false, via: 'global' }
    default: return { ...base, role: 'owner', tenant_id: T_OWNER, tenant_name: 'A회사', service_owner_tenant_id: T_OWNER, is_owner_tenant: true, borrowing_active: false, via: 'owner' }
  }
}
```

### `app/auth/sso/route.ts` — 로그인 시작 (카드 진입점)

```ts
import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { cardTheme, CLIENT_ID, cookieOptions, HINT_COOKIE, isConfigured, PORTAL_ORIGIN, pkceChallenge, readHintCookie, readTokens, seal, THEME_COOKIE, TX_COOKIE, TX_PATH } from '@/lib/sso'

/**
 * 로그인 시작 — pable studio 카드가 `/auth/sso?iss={pable studio}&login_hint={계정}&theme={컬러 모드}` 로 연다.
 * 세션이 없을 때 페이지도 여기로 보낸다. state·PKCE verifier·service_session_id 를 만들어 암호화 쿠키(10분)에 두고
 * 브라우저를 pable studio 인가 화면으로 보낸다(로그인돼 있으면 화면 없이 돌아온다).
 */
export async function GET(req: NextRequest) {
  // 설정이 없으면 죽은 주소 대신 자체 안내 페이지로 degrade
  if (!isConfigured() || !PORTAL_ORIGIN) return NextResponse.redirect(new URL('/login?error=config', req.url))

  // 로컬에서 127.0.0.1·[::1] 로 열었을 때 — Next 는 이 요청의 주소를 localhost 로 바꿔 쓴다. 그대로 진행하면 아래 진행 쿠키는
  // 127.0.0.1 에, 돌아갈 주소는 localhost 로 갈라져 콜백이 쿠키를 못 받는다. 먼저 같은 앱의 localhost 주소로 옮긴다(배포 주소는 해당 없음)
  if (isLoopbackIp(req.headers.get('host')) && req.nextUrl.hostname === 'localhost') return NextResponse.redirect(req.nextUrl)

  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const sid = randomBytes(24).toString('base64url') // service_session_id — 16~200자, 이메일·DB id 를 넣지 않는다
  const redirectUri = `${req.nextUrl.origin}/auth/sso/callback` // pable studio 가 등록 주소마다 자동 등록해 둔 경로

  // login_hint — 카드에서 왔으면(iss 가 설정값과 정확히 같을 때만) 그 값, 아니면 지금 이 브라우저의 계정.
  // 🚫 쿼리의 iss 로 주소를 만들지 마라 — 누구나 링크를 만들 수 있다. 인가·토큰·JWKS 주소는 언제나 PORTAL_ORIGIN.
  const q = req.nextUrl.searchParams
  const fromCard = q.get('iss') === PORTAL_ORIGIN ? q.get('login_hint') : null
  const hint = fromCard || (await readTokens())?.sub || readHintCookie(req.cookies.get(HINT_COOKIE)?.value) || null

  const url = new URL('/auth/service-account', PORTAL_ORIGIN)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    mode: 'login',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    ...(hint ? { login_hint: hint } : {}),
  }).toString()

  const res = NextResponse.redirect(url)
  res.cookies.set(TX_COOKIE, await seal({ state, verifier, sid, redirectUri }, 600), cookieOptions(600, TX_PATH))
  // 카드의 컬러 모드 — 인가에는 넘기지 않고 앱 화면에만("컬러 모드" 절). 비밀이 아니라 화면 스크립트가 읽는다(httpOnly 아님)
  const theme = cardTheme(q.get('theme'))
  if (theme) res.cookies.set(THEME_COOKIE, theme, { ...cookieOptions(60 * 60 * 24 * 365), httpOnly: false })
  return res
}

/** Host 헤더가 루프백 IP(127.x.x.x · [::1])인가 — 포트는 무시한다. 형식이 이상하면 false(옮기지 않는다) */
function isLoopbackIp(host: string | null): boolean {
  if (!host) return false
  try {
    return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
```

### `app/auth/sso/callback/route.ts` — 콜백 (code 교환·검증·세션)

```ts
import { NextRequest, NextResponse } from 'next/server'
import {
  BORROWING_TTL, CLIENT_ID, COOKIE_NAME, cookieOptions, HINT_COOKIE, isConfigured, PORTAL_ORIGIN, portalPost, readTokens, revokeRefreshToken,
  sameValue, seal, SESSION_TTL, signSession, TOKEN_COOKIE, TX_COOKIE, TX_PATH, unseal, verifyAccessToken,
} from '@/lib/sso'

/**
 * 로그인 콜백 — pable studio 가 `?code=&state=`(또는 `?error=&error_description=&state=`)로 돌아온다.
 * ① state 비교 ② error 처리(교환 없음) ③ 서버에서 code 교환 → 접근 토큰(ES256) 검증 → 앱 세션 발급.
 * 실패는 전부 자체 /login?error={고정 코드} 로 보낸다 — pable studio 의 error 원문을 화면·로그에 싣지 않는다.
 */

// (선택) 특정 회사만 허용. 비우면 null → pable studio 권한 판정에 위임. 절대 throw 금지.
function getAllowedTenantIds(): Set<string> | null {
  const raw = process.env.ALLOWED_TENANT_IDS ?? process.env.EXPECTED_TENANT_ID
  if (!raw) return null
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return ids.length ? new Set(ids) : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

// 화이트리스트 외 값은 fail-closed 로 viewer 강등 — 절대 승격 금지.
const ROLE_WHITELIST = ['viewer', 'editor', 'owner'] as const
function normalizeRole(raw: unknown): 'viewer' | 'editor' | 'owner' {
  return typeof raw === 'string' && (ROLE_WHITELIST as readonly string[]).includes(raw)
    ? (raw as 'viewer' | 'editor' | 'owner')
    : 'viewer'
}

// 표준 claim·pable studio 계정 키(sub)는 승계하지 않는다 — 나머지(tenant_id·scopes·is_owner_tenant…)는 spread 로 승계.
const STANDARD_JWT_CLAIMS = ['iat', 'exp', 'nbf', 'iss', 'aud', 'jti', 'sub']

/** /login 이 보여 줄 고정 코드 — app/login/page.tsx 의 MESSAGES 와 같은 집합 */
type LoginError = 'cancelled' | 'denied' | 'network' | 'unavailable' | 'expired' | 'config' | 'failed'

function authorizeError(error: string, description: string | null): LoginError {
  // 위치를 확인하지 못한 경우(network_unverified·network_check_unavailable)는 '사외'가 아니라 '잠시 후 다시'로 안내한다
  if (description === 'network_check_unavailable' || description === 'network_unverified' || error === 'temporarily_unavailable') return 'unavailable'
  if (description === 'network_restricted') return 'network'
  if (error === 'access_denied') {
    if (description === 'user_cancelled') return 'cancelled'
    if (description === 'login_failed') return 'failed' // pable studio 로그인 자체가 실패했다(권한 문제가 아니다)
    return 'denied' // account_not_allowed 등
  }
  return 'failed'
}

function tokenError(status: number, body: Record<string, unknown>): LoginError {
  const description = body.error_description
  if (description === 'network_restricted') return 'network'
  if (description === 'network_unverified' || status === 503) return 'unavailable'
  if (status === 401) {
    console.warn('[sso] 클라이언트 인증 실패 — SSO_CLIENT_ID·SSO_CLIENT_SECRET 설정을 확인하세요') // 값은 남기지 않는다
    return 'config'
  }
  if (body.error === 'access_denied') return 'denied'
  if (body.error === 'invalid_grant') return 'expired' // 같은 code 로 다시 교환하지 않는다 — 처음부터 다시 로그인
  return 'failed'
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const fail = (code: LoginError) => {
    const res = NextResponse.redirect(new URL(`/login?error=${code}`, req.url))
    res.cookies.set(TX_COOKIE, '', cookieOptions(0, TX_PATH))
    return res
  }

  // ① state — 시작 때 둔 값과 상수 시간 비교. 다르면 아무것도 처리하지 않는다
  const tx = await unseal(req.cookies.get(TX_COOKIE)?.value)
  if (!tx || !sameValue(tx.state, q.get('state'))) {
    return NextResponse.redirect(new URL('/login?error=expired', req.url))
  }
  if (typeof tx.verifier !== 'string' || typeof tx.sid !== 'string' || typeof tx.redirectUri !== 'string') return fail('failed')

  // ② 오류 콜백 — 취소·권한 없음·사내망 등. 교환하지 않는다
  const error = q.get('error')
  if (error) {
    const res = fail(authorizeError(error, q.get('error_description')))
    // 계정 고르기를 취소했으면 그 계정 힌트를 버린다 — 다음엔 사용자가 고르게
    if (q.get('error_description') === 'user_cancelled') res.cookies.set(HINT_COOKIE, '', cookieOptions(0, TX_PATH))
    return res
  }
  const code = q.get('code')
  if (!code) return fail('failed')
  if (!isConfigured() || !PORTAL_ORIGIN) return fail('config')

  // ③ code 교환 (서버 → pable studio). service_session_id 를 보내야 로그인 유지(refresh)를 받는다
  let exchanged: Awaited<ReturnType<typeof portalPost>>
  try {
    exchanged = await portalPost('/api/sso/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: tx.redirectUri,
      code_verifier: tx.verifier,
      service_session_id: tx.sid,
    })
  } catch {
    return fail('unavailable')
  }
  if (exchanged.status !== 200) return fail(tokenError(exchanged.status, exchanged.body))
  const { access_token: accessToken, refresh_token: refreshToken, refresh_token_expires_in: refreshTtl } = exchanged.body

  let payload: Awaited<ReturnType<typeof verifyAccessToken>>
  try {
    payload = await verifyAccessToken(accessToken) // ES256 · iss = PORTAL_ORIGIN · aud = SSO_CLIENT_ID
  } catch {
    return fail('failed')
  }

  // pable studio 계정 키(sub — 이 서비스 전용 가명)와 이메일이 둘 다 있어야 한다
  const email = typeof payload.email === 'string' && payload.email ? payload.email : null
  if (typeof payload.sub !== 'string' || !payload.sub || !email || typeof payload.exp !== 'number') return fail('failed')

  // 유효한 tenant_id(UUID) 필수 + (선택) 회사 화이트리스트
  const tenantId = payload.tenant_id
  if (!isUuid(tenantId)) return fail('failed')
  const allowed = getAllowedTenantIds()
  if (allowed && !allowed.has(tenantId)) return fail('denied')

  // 공유받은 회사(via=grant, 운영자 아님)는 borrowing_active 여야 한다 + TTL 분기
  if (payload.via === 'grant' && payload.is_owner_tenant !== true && payload.borrowing_active !== true) return fail('denied')
  const ttl = payload.borrowing_active === true ? BORROWING_TTL : SESSION_TTL

  // 앱 세션 — 표준 claim 만 제거, 나머지 승계, 신뢰 claim 은 뒤에서 재명시(변조 방어).
  // sub 는 이메일로 두고(앱 코드가 쓰는 사용자 키), pable studio 계정 키(이 서비스 전용 가명)는 portal_sub 로 둔다.
  const userClaims = Object.fromEntries(Object.entries(payload).filter(([k]) => !STANDARD_JWT_CLAIMS.includes(k)))
  const session = await signSession(
    {
      ...userClaims,
      sub: email,
      email,
      portal_sub: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : '',
      service: CLIENT_ID,
      role: normalizeRole(payload.role), // 화이트리스트 외 값은 viewer 강등(fail-closed)
      portal_origin: PORTAL_ORIGIN,
    },
    ttl,
  )

  // 토큰 쿠키 — 접근 토큰(60초)과 refresh(조건이 맞을 때만 온다 · 최대 24시간)를 암호화해 둔다. 브라우저는 풀 수 없다
  const rt = typeof refreshToken === 'string' && refreshToken ? refreshToken : undefined
  const tokenTtl = rt ? Math.min(Math.max(Number(refreshTtl) || 86400, 60), 86400) : 60
  const tokens = await seal(
    { sub: payload.sub, sid: tx.sid, at: accessToken as string, atExp: payload.exp, ...(rt ? { rt } : {}) },
    tokenTtl,
  )

  // 이 브라우저에 남아 있던 이전 로그인의 refresh 는 끝낸다(한 브라우저 = 앱 세션 하나)
  const previous = await readTokens()
  if (previous?.rt && previous.rt !== rt) await revokeRefreshToken(previous.rt)

  const res = NextResponse.redirect(new URL('/', req.url))
  res.cookies.set(COOKIE_NAME, session, cookieOptions(ttl))
  res.cookies.set(TOKEN_COOKIE, tokens, cookieOptions(tokenTtl))
  res.cookies.set(TX_COOKIE, '', cookieOptions(0, TX_PATH))
  res.cookies.set(HINT_COOKIE, '', cookieOptions(0, TX_PATH)) // 계정 키는 이제 토큰 쿠키에 있다
  return res
}
```
> 🚫 인증 판단에 `Referer`/`Origin` 헤더를 쓰지 마라 — state(쿠키와 상수 시간 비교) + PKCE + 서명 검증으로 충분하다(브라우저가 Referer 를 비우면 정상 사용자가 막힌다).

### `lib/portal-token.ts` — pable studio API 용 접근 토큰

```ts
/**
 * pable studio API 호출용 접근 토큰 — 서버 전용. `Authorization: Bearer ${token}` 으로 쓴다.
 * 접근 토큰은 60초다. 끝나기 10초 전까지는 받아 둔 것을 쓰고, 그 뒤엔 refresh(로그인 유지)로 새로 받는다.
 */
import { createHash } from 'node:crypto'
import { clearLoginCookies, getSession, isDevBypass, PORTAL_ORIGIN, portalPost, readTokens, verifyAccessToken, type Session } from '@/lib/sso'

export type AccessToken =
  | { ok: true; token: string; portalOrigin: string }
  // login_required: 다시 로그인해야 한다(세션 없음·로그아웃·만료·권한 회수·로그인 유지 미발급) — 화면은 /auth/sso 링크로 안내
  // unavailable: pable studio 가 잠시 확인하지 못했다 — refresh 는 그대로 두고 잠시 뒤 다시
  // dev_bypass: DEV_BYPASS mock 세션 — pable studio 토큰이 없다(예시 데이터·빈 상태로 대신한다)
  | { ok: false; reason: 'login_required' | 'unavailable' | 'dev_bypass' }

// 새로 받은 접근 토큰 — 인스턴스 메모리에만 둔다(refresh 해시로 찾는다). 쿠키는 다시 쓰지 않는다
// (서버 컴포넌트에서는 쿠키를 쓸 수 없다). refresh 는 회전하지 않아 같은 값을 계속 쓴다.
const refreshed = new Map<string, { token: string; expMs: number }>()
// 끝난·쓸 수 없는 refresh 표시(invalid_grant · unauthorized_client) — 서버 컴포넌트에서는 쿠키를 지울 수 없어(clearLoginCookies 가 조용히 넘어간다)
// 표시가 없으면 같은 죽은 refresh 를 렌더마다 pable studio 로 다시 보낸다. refresh 는 회전하지 않아 한 번 끝나면 다시 살지 않는다.
const dead = new Set<string>()
const EARLY_MS = 10_000

export async function getAccessToken(): Promise<AccessToken> {
  if (isDevBypass()) return { ok: false, reason: 'dev_bypass' }
  if (!PORTAL_ORIGIN) return { ok: false, reason: 'unavailable' }
  const [session, tokens] = await Promise.all([getSession(), readTokens()])
  // 토큰 쿠키는 지금 세션의 계정 것이어야 한다
  if (!session || !tokens || tokens.sub !== session.portal_sub) return { ok: false, reason: 'login_required' }

  const now = Date.now()
  if (tokens.atExp * 1000 - now > EARLY_MS) return { ok: true, token: tokens.at, portalOrigin: PORTAL_ORIGIN }
  if (!tokens.rt) return { ok: false, reason: 'login_required' } // 로그인 유지가 발급되지 않은 세션

  const key = createHash('sha256').update(tokens.rt).digest('base64url')
  if (dead.has(key)) return { ok: false, reason: 'login_required' } // 이미 끝난 refresh — 다시 보내지 않는다
  const cached = refreshed.get(key)
  if (cached && cached.expMs - now > EARLY_MS) return { ok: true, token: cached.token, portalOrigin: PORTAL_ORIGIN }

  let result: Awaited<ReturnType<typeof portalPost>>
  try {
    result = await portalPost('/api/sso/token', { grant_type: 'refresh_token', refresh_token: tokens.rt })
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
  if (result.status === 400 && result.body.error === 'invalid_grant') {
    // 끝났다(pable studio 로그아웃·만료·권한 회수 등) — refresh 를 버리고 다시 로그인
    refreshed.delete(key)
    if (dead.size > 1000) dead.clear()
    dead.add(key)
    await clearLoginCookies(tokens.sub) // 다시 로그인할 때 같은 계정으로(힌트) — 서버 컴포넌트면 조용히 넘어간다(그래서 위 dead 표시가 필요하다)
    return { ok: false, reason: 'login_required' }
  }
  if (result.status === 400 && result.body.error === 'unauthorized_client') {
    // 이 클라이언트는 로그인 유지를 쓸 수 없다(pable studio 설정이 바뀜) — 같은 refresh 를 다시 보내지 않는다.
    // 로그인이 끝난 것은 아니라 쿠키는 그대로 두고, 다음 로그인부터는 refresh 없이 들어온다
    console.warn('[sso] refresh: 이 클라이언트는 로그인 유지를 쓸 수 없어요 — pable studio 로그인 연동 설정을 확인하세요')
    refreshed.delete(key)
    if (dead.size > 1000) dead.clear()
    dead.add(key)
    return { ok: false, reason: 'login_required' }
  }
  if (result.status !== 200) {
    // 503 = 잠시 뒤 다시, 401 = 비밀값 설정 문제 — 어느 쪽도 refresh 를 버리지 않는다
    if (result.status === 401) console.warn('[sso] refresh: 클라이언트 인증 실패 — SSO_CLIENT_ID·SSO_CLIENT_SECRET 설정을 확인하세요')
    return { ok: false, reason: 'unavailable' }
  }
  try {
    const payload = await verifyAccessToken(result.body.access_token)
    if (payload.sub !== tokens.sub || typeof payload.exp !== 'number') return { ok: false, reason: 'login_required' }
    if (refreshed.size > 500) refreshed.clear()
    refreshed.set(key, { token: result.body.access_token as string, expMs: payload.exp * 1000 })
    return { ok: true, token: result.body.access_token as string, portalOrigin: PORTAL_ORIGIN }
  } catch {
    return { ok: false, reason: 'login_required' } // 서명 키 긴급 교체 등 — 검증 실패는 다시 로그인으로
  }
}

/**
 * 민감한 server action·쓰기 라우트 앞에서 부른다(규칙 12) — 앱 세션만 보지 않고 pable studio 로그인이 아직 살아 있는지 본다.
 * sso_required = 로그인 안 됨(다시 로그인 안내) · unavailable = 확인하지 못함(잠시 뒤 다시). 둘 다 진행하지 않는다.
 */
export async function requireLiveSession(): Promise<
  { ok: true; session: Session } | { ok: false; error: 'sso_required' | 'unavailable' }
> {
  const session = await getSession()
  if (!session) return { ok: false, error: 'sso_required' }
  const access = await getAccessToken()
  if (!access.ok && access.reason !== 'dev_bypass') {
    return { ok: false, error: access.reason === 'login_required' ? 'sso_required' : 'unavailable' }
  }
  return { ok: true, session }
}
```

### `app/page.tsx` — 세션 가드 + 역할 기반 기능 등급

```tsx
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/sso'

export default async function Page() {
  const session = await getSession()
  // 세션 없음·만료 → 로그인 시작(/auth/sso). pable studio 에 로그인돼 있으면 화면 없이 돌아온다
  if (!session) redirect('/auth/sso')

  // 역할 기반 기능 등급 (role 만 사용; via/tenant_name 은 권한 게이트 금지)
  const canEdit = ['editor', 'owner'].includes(session.role)          // editor·owner
  const canManageMembers = session.role === 'owner'                    // owner
  // 운영 admin 게이트 (cross-tenant 관리 등) — is_owner_tenant 필수
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
```
> ⚠️ **UI 분기만으론 부족(보안)** — 보호 동작은 서버 라우트에서도 `getSession()` 으로 role 을 재검증한다(멀티테넌트 참조 문서의 서버 가드).
> 다른 보호 페이지도 같은 두 줄(`getSession` → 없으면 `/auth/sso`)이다.

### `app/login/page.tsx` — 공개 안내 (세션 불필요)

```tsx
// 공개 로그인 안내 페이지 — 로그아웃 뒤 도착·로그인 실패·설정 미비 폴백. 세션이 필요 없어야 한다(아니면 무한 리다이렉트).
const MESSAGES: Record<string, string> = {
  cancelled: '로그인을 취소했어요.',
  denied: '이 서비스를 쓸 권한이 없어요. pable studio 관리자에게 문의해 주세요.',
  network: '회사 네트워크(사내망)에서만 쓸 수 있어요. 사내망에 연결한 뒤 다시 시도해 주세요.',
  unavailable: 'pable studio가 잠시 응답하지 않아요. 잠시 후 다시 시도해 주세요.',
  expired: '로그인 요청이 만료됐어요. 다시 시도해 주세요.',
  config: '로그인 설정이 아직 끝나지 않았어요. 관리자에게 문의해 주세요.',
  failed: '로그인하지 못했어요. 다시 시도해 주세요.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  // 고정 문구만 — 쿼리 원문을 화면에 그대로 출력하지 않는다. hasOwn: ?error=constructor 같은 값이 Object 의 상속 속성(함수)을 꺼내지 않게
  const message = error ? (Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : MESSAGES.failed) : null
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>pable studio 계정으로 로그인해 주세요</h1>
      <p>이 서비스는 pable studio 계정으로 로그인해요. 아래 버튼을 누르면 pable studio에서 로그인한 뒤 이 서비스로 돌아와요.</p>
      {message && <p role="alert">{message}</p>}
      <a href="/auth/sso">pable studio로 로그인</a>
    </main>
  )
}
```

### `app/auth/logout/route.ts`

```ts
import { NextResponse } from 'next/server'
import { COOKIE_NAME, cookieOptions, HINT_COOKIE, readTokens, revokeRefreshToken, TOKEN_COOKIE, TX_PATH } from '@/lib/sso'

// 로그아웃 — refresh 를 pable studio 에서 폐기하고(RFC 7009) 쿠키를 지운 뒤 자체 /login 으로.
// /auth/sso 로 보내면 pable studio 가 곧바로 다시 로그인시켜 로그아웃이 무의미해진다.
// pable studio 자체 로그아웃은 아니다 — pable studio 에 로그인돼 있으면 [로그인] 한 번에 화면 없이 다시 들어온다.
export async function GET(req: Request) {
  const tokens = await readTokens()
  if (tokens?.rt) await revokeRefreshToken(tokens.rt)
  const res = NextResponse.redirect(new URL('/login', req.url))
  res.cookies.set(COOKIE_NAME, '', cookieOptions(0))
  res.cookies.set(TOKEN_COOKIE, '', cookieOptions(0))
  res.cookies.set(HINT_COOKIE, '', cookieOptions(0, TX_PATH)) // 로그아웃 뒤엔 사용자가 계정을 고르게
  return res
}
```
> 로그아웃 링크는 일반 `<a href="/auth/logout">` 로 둔다(Next `<Link>` 는 미리 불러오기로 로그아웃이 일어날 수 있다).

## 컬러 모드 (선택 — 앱에 다크 모드가 있을 때만)

pable studio 카드는 사용자의 컬러 모드(`theme` = `light`·`dark`·`system`)를 함께 보낸다. `/auth/sso` 가 그 값을 `THEME_COOKIE` 에 두므로,
앱에 `[data-theme="dark"]` 다크 모드가 있으면 `app/layout.tsx` 에서 첫 화면 전에 적용한다. **다크 모드가 없는 앱은 이 절을 건너뛴다**(쿠키가 남아도 아무 일도 하지 않는다).

```tsx
// app/layout.tsx — <html> 에 suppressHydrationWarning: 스크립트가 서버 HTML 에 없던 data-theme 을 붙인다
import { themeBootScript } from '@/lib/sso'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

- 앱 안에 컬러 모드 토글을 만들면 고른 값을 **같은 쿠키**(`THEME_COOKIE`, `path=/; max-age=31536000; samesite=lax`)에 쓴다 — 저장 위치를 둘로 나누지 않는다.
  다음 카드 진입 때는 pable studio 의 값으로 다시 맞춰진다.
- 이 값으로 권한·동작을 정하지 않는다(누구나 주소에 붙일 수 있다). 화면 모양에만 쓴다.

## pable studio API 부르기 (Bearer — v2)

`references/portal-api.md` 의 엔드포인트·스코프 규칙은 같다. 토큰만 다르다 — **서버 라우트에서 `getAccessToken()`** 으로 받는다.

```ts
// app/api/me/route.ts (예) — 토큰은 응답에 싣지 않는다
import { getSession } from '@/lib/sso'
import { getAccessToken } from '@/lib/portal-token'

export async function GET() {
  const session = await getSession()
  if (!session) return Response.json({ code: 'sso_required' }, { status: 401 })
  const access = await getAccessToken()
  if (!access.ok) {
    if (access.reason === 'dev_bypass') return Response.json({ user: null }) // mock — 예시 데이터·빈 상태로 대신한다
    return access.reason === 'login_required'
      ? Response.json({ code: 'sso_required' }, { status: 401 }) // 화면은 /auth/sso 링크로 안내(자동 반복 이동 금지)
      : Response.json({ code: 'unavailable' }, { status: 503 })
  }
  const res = await fetch(`${access.portalOrigin}/api/org/users/${encodeURIComponent(session.sub)}`, {
    headers: { Authorization: `Bearer ${access.token}` },
    cache: 'no-store',
  })
  if (!res.ok) return Response.json({ code: 'portal_error', status: res.status }, { status: 502 })
  return Response.json(await res.json())
}
```

- 호출 주소는 `access.portalOrigin`(= `PORTAL_URL`) — 토큰 발급자와 같은 주소여야 한다.
- **승인된 스코프가 하나도 없으면 본인 조회도 401** 이다. 스코프는 사용자가 pable studio "SSO 키 · 스코프" 창에서 골라 신청 → 관리자 승인.
  v2 는 스코프를 바꿔도 **키가 바뀌지 않는다**(재배선·재배포 불필요, 다음 로그인부터 반영).
- 토큰 `tenant_id` 가 **등록 회사**여야 Bearer 가 통과한다 — 다른 회사 계정(운영자 직권 진입 포함)으로 로그인한 세션은 사내 데이터를 부르지 못한다.
- `getAccessToken()` 이 로그인 직후에는 되다가 1분쯤 뒤부터 `login_required` 면 **로그인 유지(refresh)가 발급되지 않은 것**이다 —
  **먼저 사용자에게 pable studio 에서 로그아웃했다가 다시 로그인해 보게 한다**(오래전에 로그인한 pable studio 세션·Teams 안에서 시작한 로그인은
  로그인 유지를 받지 못한다). 그래도 같으면 pable studio 쪽 설정(운영자 스위치)이 꺼져 있거나 '사내망 전용' 서비스다 — 코드 문제가 아니니 pable studio 관리자에게 확인을 요청한다.
- 클라이언트 화면이 401 을 받을 때마다 자동으로 `/auth/sso` 로 보내지 마라(반복 이동이 된다) — "다시 로그인" 링크를 보여 준다.

## 민감한 서버 동작 (규칙 12)

앱 세션 쿠키는 pable studio 로그아웃·권한 회수 뒤에도 `SESSION_TTL` 까지 남는다. 삭제·권한 변경·외부 발송처럼 되돌리기 어려운 동작은
`getSession()` 대신 `lib/portal-token.ts` 의 **`requireLiveSession()`** 으로 연다 — pable studio 로그인이 아직 살아 있는지 한 번 더 본다
(접근 토큰이 60초 안이면 pable studio 를 부르지 않고, 지났으면 refresh 가 확인한다). 읽기 페이지는 지금처럼 `getSession()` 이면 된다.

```ts
// app/items/actions.ts (예) — 삭제처럼 되돌리기 어려운 server action
'use server'
import { requireLiveSession } from '@/lib/portal-token'

export async function deleteItem(id: string) {
  const live = await requireLiveSession()
  if (!live.ok) return { error: live.error } // 화면: sso_required 면 "다시 로그인" 링크(/auth/sso), unavailable 이면 잠시 뒤 다시
  if (!['editor', 'owner'].includes(live.session.role)) return { error: 'forbidden' as const }
  // ← 앱의 DB 클라이언트로 — 언제나 세션의 tenant_id 로 격리(멀티테넌트 참조 문서)
  await db.from('items').delete().eq('id', id).eq('tenant_id', live.session.tenant_id)
  return { ok: true as const }
}
```

> 로그인 유지(refresh)가 발급되지 않는 환경이면 로그인 1분쯤 뒤부터 이 검사가 `sso_required` 를 낸다 — 아래 체크리스트의 로그인 유지 스위치를 먼저 확인한다.

## 출시 전 체크리스트 (v2)

- [ ] `claim_portal_sso_key` 가 `SSO_CLIENT_ID`·`SSO_CLIENT_SECRET`(+`PORTAL_URL`)를 배선했고, 그 뒤 `request_vercel_deploy` 로 재배포했다
- [ ] `PORTAL_URL` 이 수령 결과의 발급자(issuer)와 같다 — 코드·저장소 파일에 주소를 적지 않았다(`?? '…'` 폴백 · `next.config` 의 `env` · `vercel.json` 금지)
- [ ] **로그인 유지(refresh) 스위치** — pable studio 운영자 설정의 SSO v2 **'로그인 유지' 전역 스위치가 켜져 있다.**
      꺼져 있으면 로그인 1분쯤 뒤부터 `getAccessToken()` 이 `login_required` 다 — ① pable studio API(Bearer) 호출이 멈추고(데이터 API `sso_required`)
      ② `requireLiveSession()` 으로 연 민감한 동작(삭제·권한 변경·외부 발송 — 규칙 12)이 누를 때마다 다시 로그인을 요구한다. 둘 다 없는 앱(읽기 화면만)은 영향이 없다.
      '사내망 전용' 서비스는 스위치와 무관하게 로그인 유지가 없다. 코드로 고칠 수 없다 — 사용자에게 pable studio 관리자 확인을 요청한다
- [ ] 사내 데이터를 부르면 필요한 스코프가 승인됐다(승인 스코프 0개면 본인 조회도 401)
- [ ] 로컬에서 실제 로그인을 시험하면 등록의 로컬 포트가 띄운 포트와 같고, `DEV_BYPASS_SSO` 가 꺼져 있다
- [ ] `/login` 이 세션 없이 열린다(공개 페이지) · 로그아웃 링크가 `<a href="/auth/logout">` 이다

## 오류 안내 (`/login?error=`)

| 코드 | 상황 | 처리 |
|---|---|---|
| `cancelled` | pable studio 계정 고르기에서 취소 | 다시 로그인 버튼 |
| `denied` | 이 서비스를 쓸 권한 없음 · 허용 회사 밖(`ALLOWED_TENANT_IDS`) · 공유 회수 | pable studio 관리자 문의 안내 |
| `network` | 사내망 전용 서비스를 사내망 밖에서 | 사내망 연결 뒤 다시 |
| `unavailable` | pable studio 일시 오류(503 · 사내망 확인 실패) | 잠시 뒤 다시 |
| `expired` | state 불일치(10분 지남·다른 탭에서 새로 시작) · code 가 이미 쓰였거나 만료 | 다시 로그인(같은 code 로 다시 교환하지 않는다) |
| `config` | `PORTAL_URL`·`SSO_CLIENT_ID`·`SSO_CLIENT_SECRET` 누락, 또는 client 인증 실패(401) | 설정값·재배포 확인 — 서버 로그 `[sso] 클라이언트 인증 실패` |
| `failed` | 그 밖(토큰 검증 실패 등) | 아래 증상 표 |

### 증상 → 원인 찾기 (v2)

| 증상 | 1순위 원인 | 확인·조치 |
|---|---|---|
| pable studio 화면에 "로그인 연동이 등록되지 않은 서비스예요" | 지금 연 주소(origin)가 등록의 배포 URL·개발 URL·로컬 포트와 다르다, 또는 경로가 `/auth/sso/callback` 이 아니다 | 배포 URL 로 열었는지 확인. 로컬은 pable studio 등록에 **로컬 포트**가 같은 번호로 있어야 한다(PAX 가 비어 있으면 3000 으로 채운다 — 다른 포트면 pable studio 등록 수정에서 바꾼다) |
| 로컬에서 로그인하면 `/login?error=expired` | 시작 주소와 돌아온 주소의 호스트가 달라 진행 쿠키가 콜백에 실리지 않았다(`127.0.0.1` ↔ `localhost` — 레시피 시작 라우트가 루프백 IP 를 localhost 로 먼저 옮긴다) | `http://localhost:{포트}` 로 연다. 시작 라우트의 `isLoopbackIp` 분기를 지우지 않았는지 확인 |
| 로그인 직후 `/login?error=failed` | 토큰 검증 실패 — `PORTAL_URL` 이 pable studio 정본 주소(발급자)와 다르다 | `claim_portal_sso_key` 결과가 알려 준 발급자 주소, 또는 pable studio "SSO 키 · 스코프" 창의 "pable studio 주소" 값과 글자 그대로 대조 → 고친 뒤 재배포 |
| 로컬에서 [로그인]을 누르면 pable studio 를 거치지 않고 테스트 사용자로 바로 들어온다 | `DEV_BYPASS_SSO=true` 가 켜져 있다(mock 세션) | 실제 왕복을 시험하려면 `.env.development.local` 의 `DEV_BYPASS_SSO` 줄을 지우거나 `false` 로 두고 개발 서버를 다시 띄운다 |
| `/login?error=config` | 설정값 누락 또는 비밀값 불일치(재발급 뒤 옛 값) | 설정값 키 이름 확인 → 재배포. 비밀값 재발급 뒤엔 `claim_portal_sso_key`(force) 로 교체 |
| 데이터 API 가 `portal_error` 401 | 승인 스코프 0개 · 다른 회사 계정 · DEV_BYPASS | 스코프 승인 상태 확인. mock 은 원래 pable studio API 를 못 부른다 |
| 로그인 1분 뒤부터 데이터가 `sso_required` · 삭제 같은 동작마다 다시 로그인 | 로그인 유지(refresh) 미발급 | ① pable studio 에서 로그아웃했다가 다시 로그인(오래된 pable studio 로그인·Teams 안에서 시작한 로그인은 로그인 유지를 받지 못한다) ② 그래도 같으면 위 Bearer 절·출시 전 체크리스트 — pable studio 관리자에게 로그인 유지 설정 확인 |
| 로그인·데이터 호출이 계속 `unavailable`(잠시 후 다시) | `PORTAL_URL` 이 다른 주소로 넘어가는 옛 주소다(비밀값이 따라가지 않게 `redirect: 'error'` 로 끊는다) 또는 pable studio 장애 | 서버 로그 `[sso] pable studio 호출 실패` 확인 → `PORTAL_URL` 을 수령 결과의 발급자 주소로 바꾸고 재배포 |
| pable studio 화면이 "로그인 연동이 등록되지 않은 서비스예요" 인데 주소·포트는 맞다 | 등록된 배포 URL 에 경로가 있다(`https://host/app`) — pable studio 가 돌아갈 주소를 그 경로 아래로 등록했다 | 이 레시피는 도메인 루트 전용(규칙 1) — 앱을 도메인 루트에 배포하고 pable studio 등록의 배포 URL 에서 경로를 뺀다 |
