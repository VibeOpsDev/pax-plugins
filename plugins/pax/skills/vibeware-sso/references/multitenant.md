# pable studio SSO — 멀티테넌트 · 역할 등급 · 서버 가드 (상세)

SKILL.md 코어를 넘어서 **여러 회사가 쓰는 서비스**를 만들거나, 역할별 기능을 서버에서 강제할 때 참조한다. 출처: VibeWare `sso-integration-guide.md` §2.5·§9.

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
// app/api/admin/*/route.ts 등 운영 admin 전용 엔드포인트
import { cookies } from 'next/headers'
import { jwtVerify } from 'jose'

async function verifySession() {
  const token = (await cookies()).get('my_service_sso')?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.SSO_SECRET!), { algorithms: ['HS256'] })
    return payload as unknown as { role?: string; is_owner_tenant?: boolean; tenant_id?: string; sub?: string }
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
- **잔존 윈도우**: pable studio 토큰은 60초지만 재서명 쿠키는 서비스 TTL까지 산다. `borrowing_active === true`면 쿠키 TTL을 **600초**로 단축(코어 코드의 `BORROWING_TTL`). 재서명 시점에 `via==='grant' && borrowing_active!==true`면 쿠키 발급 안 하고 pable studio로 되돌린다(grant revoke / is_public OFF 직후 차단).

### 사용 회사 내부 관리자 지정 — 다운스트림 자체 책임

B회사(사용 회사) 안의 특정 사용자만 관리자로 올려야 하면 pable studio는 그 분기를 못 준다. 자체 테이블 + UI로 구현:

```sql
CREATE TABLE service_tenant_admins (
  tenant_id  UUID NOT NULL,     -- B회사 tenant_id
  user_email TEXT NOT NULL,     -- 승격 대상 (PK 유지 — 아래 참조)
  user_oid   TEXT,              -- Entra object id (nullable — 있으면 이걸 우선 매칭)
  granted_by TEXT NOT NULL,     -- 임명자 (감사)
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_email)
);
CREATE UNIQUE INDEX ON service_tenant_admins (tenant_id, user_oid) WHERE user_oid IS NOT NULL;
```

**왜 `user_email` 이 PK 인가 (바꾸지 마라)** — `oid` 는 이메일과 달리 변하지 않아 키로 더 낫지만, **공유 링크로 들어온 토큰에는 `oid` 가 없다.** PK 를 `oid` 로 바꾸면 그 경로 사용자가 전부 매칭 실패한다. 그래서 `user_oid` 는 **nullable 컬럼으로 추가**하고 조회는 `oid` 우선 → 이메일 폴백으로 간다. 지배적 실패모드는 권한 상승이 아니라 **이메일이 바뀌었을 때 권한 행을 잃는 것**이다.

```ts
// oid 우선, 없으면 이메일 폴백. oid 비교는 대소문자 무시(GUID 표기 차이 방어).
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
// 이걸 빼면 user_oid 는 영원히 NULL 이라 위 oid 절이 죽고 컬럼이 무의미해진다.
if (session.oid && matched) {
  await db.from('service_tenant_admins')
    .update({ user_oid: session.oid })
    .eq('tenant_id', session.tenant_id)
    .eq('user_email', session.sub)
    .is('user_oid', null)   // 기존 값 덮어쓰기 방지 + 부분 유니크 인덱스 충돌 회피
}
```

임명은 A회사 운영자만(권장), 또는 B회사 첫 사용자 self-claim 후 A 승인(bootstrap). 이메일 도메인만으로 자동 admin은 피한다. 임명/회수는 감사 로그에 기록.

> pable studio에 "B회사 사용자별 차등"을 추가해달라고 요청하지 마라 — `user_service_roles`는 본질적으로 운영 회사가 자기 사용자에게만 임명하는 테이블이며, cross-tenant 임명을 허용하면 borrowing 신뢰 경계가 무너진다. **B회사 사용자별 차등은 항상 다운스트림 자체 책임.**

## 5. DEV_BYPASS 5시나리오 (로컬 테스트)

`DEV_BYPASS_SSO=true` + `DEV_BYPASS_SCENARIO`로 전환(SKILL.md `buildDevMockSession` 참조). 각 시나리오가 검증하는 것:

| `DEV_BYPASS_SCENARIO` | 의미 | 확인 포인트 |
|---|---|---|
| `owner_native` (기본) | 운영 회사 native owner | 전체 관리 기능 노출 |
| `super_admin_cross` | super_admin cross-tenant | isServiceAdmin=true (owner+is_owner_tenant) |
| `borrowed_owner` | 사용 회사 borrowed owner | is_owner_tenant=false → 운영 admin 미노출 |
| `borrowed_viewer` | 사용 회사 borrowed viewer | 읽기 전용, borrowing TTL(600초) |
| `global` | 글로벌 카탈로그 서비스 | service_owner_tenant_id=null |

> DEV_BYPASS는 `jwtVerify`/`SSO_SECRET`을 우회하므로 role/tenant 분기·등급·쿠키·페이지 렌더는 검증하지만 **실제 pable studio-토큰 재서명은 검증하지 못한다**. 실제 왕복은 pable studio "배포 열기"로 확인(가이드 §11).
