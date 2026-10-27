# pable studio SSO — 멀티테넌트 · 역할 등급 · 서버 가드 (상세)

SKILL.md 코어를 넘어서 **여러 회사가 쓰는 서비스**를 만들거나, 역할별 기능을 서버에서 강제할 때 참조한다. 세션·코드는 `sso-v2.md` 의 레시피(`lib/sso.ts` 의 `getSession()`)를 기준으로 한다.

## 1. 역할(role) 기반 기능 등급 — 상세

`role`은 `viewer` / `editor` / `owner` 3종. 표준 매핑:

| role | 할당 주체 | 예시 기능 |
|---|---|---|
| `viewer` | 전체 공개·팀 프리셋·borrowing 기본 | 읽기 전용 |
| `editor` | 팀 프리셋·개인 할당 | 수정 |
| `owner` | 서비스 소유자. pable studio admin/super_admin도 owner로 발급(2026-05 변경) | 멤버 권한 관리 |

```ts
const canEdit = ['editor', 'owner'].includes(session.role)
const canManageMembers = session.role === 'owner'
// 운영 admin(cross-tenant 관리 등)은 반드시 is_owner_tenant 사용 (role==='admin' 은 없음)
const isServiceAdmin = session.is_owner_tenant === true && session.role === 'owner'
```

> 등급 결정엔 `role`(+owner 게이트는 `is_owner_tenant`)만 쓴다. `via`/`tenant_name`은 감사·표시 전용이며 권한 게이트로 쓰면 안 된다.

## 2. 서버측 route guard (필수)

클라이언트 UI 분기만으로는 URL 직접 호출을 못 막는다. 보호 동작(편집·관리·삭제 API)은 서버에서 세션을 다시 열어 role을 재검증한다.

```ts
// app/api/admin/*/route.ts 등 운영 admin 전용 엔드포인트 — 세션은 sso-v2.md 의 lib/sso.ts 가 연다
import { getSession } from '@/lib/sso'

export async function GET() {
  const s = await getSession()
  if (!s || s.is_owner_tenant !== true || s.role !== 'owner') {
    return new Response('Not Found', { status: 404 }) // 존재 은닉
  }
  // ...
}
```

- 삭제·권한 변경·외부 발송처럼 되돌리기 어려운 동작은 `getSession()` 대신 `lib/portal-token.ts` 의 **`requireLiveSession()`** 으로 연다(`sso-v2.md` 규칙 12 — 앱 세션은 pable studio 로그아웃·권한 회수 뒤에도 `SESSION_TTL` 까지 남는다).
- 세션 필드: `role`·`is_owner_tenant`·`tenant_id`·`sub`(이메일)·`portal_sub`(이 서비스 전용 계정 키). `oid` 는 없다.
- (기존 v1 앱의 서버 가드는 `sso-v1.md` §5 — 새 앱에 쓰지 마라.)

## 3. 데이터 격리 (여러 회사 사용 시 필수)

모든 사용자 데이터 테이블에 `tenant_id` 컬럼을 두고 격리한다.

```ts
// 일반 조회 — 항상 세션의 tenant_id 로 필터
const rows = await db.from('items').select('*').eq('tenant_id', session.tenant_id)

// 운영 admin 이 다른 회사 데이터를 봐야 할 때만 (규칙 4 게이트 통과 후)
if (isServiceAdmin) {
  const target = req.nextUrl.searchParams.get('tenantId') ?? session.tenant_id
  rows = await db.from('items').select('*').eq('tenant_id', target)
}
```

**cross-tenant 진입**(`actor_tenant_id !== target_tenant_id`)은 반드시 감사 로그에 기록.

```ts
await db.from('audit_logs').insert({
  actor_email: session.sub,
  actor_tenant_id: session.tenant_id,
  target_tenant_id: targetTenantId,
  action: '...',
  via: session.via,          // 침해 분석용
  is_owner_tenant: session.is_owner_tenant,
})
```

> `is_owner_tenant: true` + `tenant_id !== service_owner_tenant_id` 조합은 `super_admin`만 도달 가능한 신호다. 이 조합으로 super_admin을 **권한 게이트에서** 식별하지 마라(추상화 누수). 권한 결정과 이상 탐지는 목적을 분리한다.

## 4. Borrowing(공유받은 회사) 처리

- 공유 서비스는 `is_public=true` 전제. 사용 회사 멤버 전원에게 `services.default_role`(viewer 또는 editor) 일괄 부여. 사용 회사 안에서 user 단위 차등은 **pable studio가 못 준다**.
- **잔존 윈도우**: pable studio 접근 토큰은 60초지만 앱 세션 쿠키는 `SESSION_TTL` 까지 산다. `borrowing_active === true`면 세션 TTL을 **600초**로 단축한다(`sso-v2.md` 의 `BORROWING_TTL`). 콜백에서 `via==='grant' && is_owner_tenant!==true && borrowing_active!==true` 면 세션을 만들지 않고 `/login?error=denied` 로 보낸다(공유 회수·공개 해제 직후 차단 — 레시피에 이미 있다).

### 사용 회사 내부 관리자 지정 — 다운스트림 자체 책임

B회사(사용 회사) 안의 특정 사용자만 관리자로 올려야 하면 pable studio는 그 분기를 못 준다. 자체 테이블 + UI로 구현:

```sql
CREATE TABLE service_tenant_admins (
  tenant_id  UUID NOT NULL,     -- B회사 tenant_id
  user_email TEXT NOT NULL,     -- 승격 대상 (PK 유지 — 아래 참조)
  user_oid   TEXT,              -- 계정 키 = portal_sub (nullable — 첫 로그인 때 채운다, 있으면 이걸로만 매칭)
  granted_by TEXT NOT NULL,     -- 임명자 (감사)
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_email)
);
CREATE UNIQUE INDEX ON service_tenant_admins (tenant_id, user_oid) WHERE user_oid IS NOT NULL;
```

**왜 `user_email` 이 PK 인가 (바꾸지 마라)** — 임명은 그 사람이 이 앱에 처음 로그인하기 **전에도** 한다. 그때 아는 것은 이메일뿐이고 계정 키(`portal_sub`)는 첫 로그인에서야 생긴다. 그래서 `user_oid` 는 **nullable 컬럼**이고, 첫 로그인 때 채운 뒤로는 계정 키로만 맞춘다(칸 이름은 옛 표와 호환하려고 그대로 둔다).

#### 매칭 — `user_oid` 칸에 `portal_sub` 를 넣는다

접근 토큰·세션에는 **`oid` 가 없다.** 대신 pable studio 가 이 서비스에만 주는 계정 키 **`portal_sub`**(가명 — 메일 주소가 바뀌어도 그대로)가
공유받은 회사 사용자를 포함해 **언제나** 있다. `user_oid` 칸에 `portal_sub` 를 저장하고 이 순서로 맞춘다 —
**계정 키 우선 → 계정 키가 아직 없는 행만 이메일 → 맞으면 바로 계정 키를 채운다(백필).** (기존 v1 앱의 Entra `oid` 매칭은 `sso-v1.md` §5.)

🚫 **이메일만으로 맞추지 마라.** 회사 메일 주소는 퇴사·이동 뒤 다른 사람에게 다시 배정된다 — 이메일만 보면 그 주소를 새로 받은 사람이
**관리자 권한을 그대로 물려받는다.** 그래서 계정 키가 채워진 행은 이메일이 같아도 맞추지 않는다(계정 키가 다르면 다른 사람이다).

```ts
// 계정 키(portal_sub) 우선. 이메일은 아직 계정 키가 없는 행(임명 직후·첫 로그인 전)에만 쓰고, 맞으면 바로 계정 키를 채운다.
// portal_sub 는 Entra GUID 가 아니다 — 대소문자까지 그대로 비교한다(toLowerCase 하지 마라). 서비스마다 다른 값이라 다른 서비스 표로 옮기지 않는다.
const { data: rows } = await db.from('service_tenant_admins')
  .select('user_email, user_oid')
  .eq('tenant_id', session.tenant_id)
const byKey = rows?.some((r) => r.user_oid === session.portal_sub) ?? false
const byEmail = !byKey && (rows?.some((r) => r.user_oid == null && r.user_email === session.sub) ?? false)

const isServiceAdmin =
  (session.is_owner_tenant === true && session.role === 'owner') ||  // A회사 운영자
  byKey || byEmail                                                   // B회사 자체 임명

// 백필 — 이메일로 맞은 그 순간 계정 키를 채운다. 그다음부터 이 행은 계정 키로만 맞는다(주소가 재배정돼도 넘어가지 않는다).
if (byEmail) {
  await db.from('service_tenant_admins')
    .update({ user_oid: session.portal_sub })
    .eq('tenant_id', session.tenant_id)
    .eq('user_email', session.sub)
    .is('user_oid', null)   // 기존 값 덮어쓰기 방지 + 부분 유니크 인덱스 충돌 회피
}
```

- 이메일 절이 남는 창은 **임명 뒤 첫 로그인 전**뿐이다. 임명할 때 그 사람이 이미 이 앱에 로그인한 적이 있으면(자체 사용자 표에 `portal_sub` 가 있으면)
  `user_oid` 를 함께 채워 둔다 — 그러면 그 창도 없다.

임명은 A회사 운영자만(권장), 또는 B회사 첫 사용자 self-claim 후 A 승인(bootstrap). 이메일 도메인만으로 자동 admin은 피한다. 임명/회수는 감사 로그에 기록.

> pable studio에 "B회사 사용자별 차등"을 추가해달라고 요청하지 마라 — `user_service_roles`는 본질적으로 운영 회사가 자기 사용자에게만 임명하는 테이블이며, cross-tenant 임명을 허용하면 borrowing 신뢰 경계가 무너진다. **B회사 사용자별 차등은 항상 다운스트림 자체 책임.**

## 5. DEV_BYPASS 5시나리오 (로컬 테스트)

`DEV_BYPASS_SSO=true` + `DEV_BYPASS_SCENARIO`로 전환(`sso-v2.md` 의 `lib/sso.ts` `buildDevMockSession`). 각 시나리오가 검증하는 것:

| `DEV_BYPASS_SCENARIO` | 의미 | 확인 포인트 |
|---|---|---|
| `owner_native` (기본) | 운영 회사 native owner | 전체 관리 기능 노출 |
| `super_admin_cross` | super_admin cross-tenant | isServiceAdmin=true (owner+is_owner_tenant) |
| `borrowed_owner` | 사용 회사 borrowed owner | is_owner_tenant=false → 운영 admin 미노출 |
| `borrowed_viewer` | 사용 회사 borrowed viewer | 읽기 전용, borrowing TTL(600초) |
| `global` | 글로벌 카탈로그 서비스 | service_owner_tenant_id=null |

> DEV_BYPASS 는 pable studio 왕복(코드 교환·토큰 검증)을 건너뛰므로 role/tenant 분기·등급·페이지 렌더는 검증하지만 **실제 로그인은 검증하지 못한다**. mock 세션에는 pable studio 접근 토큰도 없다(`getAccessToken()` 이 `dev_bypass`). 실제 왕복은 배포(또는 로컬 포트가 등록된 로컬 실행)에서 확인한다.
