---
name: pax-infra-ops
description: "PAX(preview) · Supabase/Vercel/pable studio 등록 조회·생성·배포·환경변수·스토리지·배포로그·PR게이트는 PAX MCP로 서버 대행. \"테이블 추가\", \"스키마 확인\", \"RLS 확인\", \"배포해줘\", \"환경변수 등록/확인\", \"배포 왜 실패했어\", \"PR 게이트 상태\", \"스토리지 버킷\", \"service_role 키\", \"서비스 등록\", \"SSO 키 신청\" 등 인프라 작업에 사용."
---
# 인프라 작업은 PAX MCP로 (secretless)

로컬에는 인프라 자격증명이 없으므로 Supabase/Vercel 권한 작업은 **PAX MCP 도구가 서버 권한으로 대행**합니다. credential을 로컬에 요구하지 마세요.

## 조회 (read-only)
- 연결 상태: `status` / 공개 env: `get_public_env`
- 스키마: `get_supabase_schema` / RLS(로컬에서 데이터 안 보일 때 진단): `get_rls_status` / 마이그레이션: `get_migrations`
- 스토리지 버킷 목록: `list_storage_buckets`
- pable studio 서비스 등록 상태·서비스 ID: `get_portal_registration`
- Vercel 배포 상태: `get_vercel_status` / 배포 실패 로그: `get_deploy_logs`
- 환경변수 **키 이름** 목록: `list_vercel_env` (보안상 값은 못 봅니다 — 키 이름만. **배포(Vercel) 환경 쪽만 보여줍니다** — 설정값 저장소 목록은 PAX 웹 [코드] 탭의 `.env.local`에서 확인)
- PR 게이트 상태: `get_pr_gate_status`

## 생성·변경 (편집자/소유자 역할 + GitHub 쓰기 권한 필요)
- 테이블/컬럼 생성 + 접근 규칙(RLS) + 인덱스: `apply_supabase_change` — **테이블·컬럼 삭제와 타입 변경은 불가** (아래 '저장 공간 구조 바꾸기')
- 스토리지 버킷 생성: `create_storage_bucket` — `defaultPolicy:"public"` 은 **읽기만 공개**이고 쓰기·삭제는 로그인한 사용자만입니다(로그인 없는 업로드는 불가 — 꼭 필요하면 서버 라우트에서 처리)
- 환경변수(설정값) 설정: `set_vercel_env` / 삭제: `unset_vercel_env` — 설정값 저장소 + 배포 환경 **양쪽**(아래 '환경변수 변경 주의')
- production 재배포: `request_vercel_deploy`
- pable studio 서비스 등록: `register_portal_service` — **`confirmedNew` 필요**(사용자가 pable studio에서 직접 등록해 둔 경우 중복 등록이 되므로 먼저 확인)
- pable studio SSO 키 신청: `request_portal_sso_key` — 연동 켜기가 **비가역**이라 `enableConfirmed` 필요 / 승인 후 수령·배선: `claim_portal_sso_key` — **수령 누적 5회 한도**, 재시도 루프 금지
  - 자세한 순서·주의는 `pax-sso` 스킬을 따르세요(로그인 연동 전반).

파괴적 작업(테이블 삭제 등)은 도구로 제공되지 않으며 PAX 웹에서 승인이 필요합니다. 권한 거부(403)면 사용자의 역할/GitHub 권한을 확인하도록 안내하세요(거부 시 연결이 자동 취소될 수 있음 — `/pax-preview:connect` 로 재연결).

## 저장 공간 구조 바꾸기 (`apply_supabase_change`)

**새로 만드는 테이블은 접근 규칙이 필수**입니다. 규칙이 0개로 끝나면 거절돼요(`POLICY_REQUIRED`) — 행 보안이 항상 켜지므로 규칙이 없으면 로그인한 사용자도 0행만 봅니다. `policies: []` 도 거절입니다(규칙을 자동으로 받으려면 `policies` 를 **아예 생략**하세요). **이미 있는 테이블은 거절하지 않고** 지금 상태(서버 전용 / 누구나 볼 수 있음 / 아무도 못 읽음)를 보고만 합니다.

🔴 **이미 쓰고 있는 테이블에 접근 규칙을 명시하면 그 테이블의 행 보안이 켜집니다.** 그 규칙이 가리키는 항목(예: `user_id`)을 **같은 호출에서 새로 만들면** 기존 내용에는 그 값이 비어 있어 **앱에서 기존 내용이 하나도 보이지 않게 되고, 이 도구로는 되돌릴 수 없습니다.** 서버가 `RLS_WOULD_HIDE_EXISTING_ROWS` 로 거절하면 **그 테이블만 `policies` 에서 빼고** 다시 보내세요(항목 추가는 그대로 진행됩니다). 아래 "`policies` 를 하나라도 주면 전부 적어야 한다" 규칙 때문에 **"신규 1개 + 기존 테이블에 항목 추가" 혼합 호출이 이 상황으로 곧장 옵니다** — 기존 테이블은 빼고 보내는 것이 기본입니다.

⚠️ **`policies` 를 하나라도 주면 모든 테이블의 자동 생성이 꺼집니다** — 명시할 때는 그 호출의 모든 테이블에 적어야 합니다.

| 원하는 것 | 입력 |
|---|---|
| 본인 것만 (기본) | `user_id` 컬럼을 두면 규칙이 **자동 생성** — `policies` 생략 |
| 누구나 읽기 (공지·상품) | `policies: [{table, name, operation:"SELECT", roles:["anon","authenticated"]}]`(`check` 생략) **+ `confirmedPublic: true`** · 대상 테이블을 `tables` 에도 함께 적어야 함 |
| 로그인한 사람만 읽기 | 위와 같고 `roles: ["authenticated"]` (⚠️ 프로젝트에서 Supabase 익명 로그인을 켰다면 익명 사용자도 `authenticated` 입니다 — 그 경우 사실상 공개에 가깝습니다) |
| 로그인한 사람이 쓰고 자기 것만 고치기 | `operation:"INSERT"`/`"UPDATE"` + `roles:["authenticated"]` + `check:{column:"user_id", operator:"=", value:"auth.uid()"}` |
| 서버에서만 쓰는 저장 공간 | `tables[].serverOnly: true` (감사 기록·작업 큐 — 앱에서 조회 불가. **새 테이블만** 가능하고 같은 테이블에 `policies` 를 함께 주면 거절) |

- `check` 를 생략하면 "조건 없이 전체 허용" 이라 **읽기(SELECT)에만** 쓸 수 있고 `roles` 가 필수입니다(쓰기까지 열면 로그인한 아무나 남의 데이터를 고칩니다). `operator: "<>"` 도 같은 이유로 읽기 전용입니다.
- **`anon` 공개는 되돌릴 수 없습니다**(Supabase 화면에서 직접 지워야 함) → 먼저 사용자에게 "로그인하지 않은 사람도 볼 수 있게 됩니다. 계속할까요?" 를 묻고, 동의를 받은 뒤 `confirmedPublic: true` 를 붙이세요.
- 공개 읽기 규칙을 만들면 성공 메시지에 "누구나 볼 수 있어요" 가 붙습니다 — **사용자에게 그대로 전달**하세요. 단 `[AI 전용 — 사용자에게 전달하지 마세요]` ~ `[AI 전용 끝]` 구간은 당신(AI)에게 주는 안내이니 **전달하지 말고** 그 지시만 따르세요.
- 같은 이름의 규칙이 이미 있으면 내용이 **바뀌지 않습니다**(`unchangedPolicies` 로 보고). 좁히려면 Supabase 화면에서 지운 뒤 다시 만들어야 합니다.
- 팀·그룹 멤버십처럼 다른 테이블을 조회하는 규칙은 이 도구로 못 만듭니다 — 제약을 알리고 Supabase 화면을 안내하세요.

**인덱스**
- 검색이 느릴 때: `indexes: [{table, columns}]` · 중복 금지까지: `unique: true`
- **`tables` 를 생략하고 접근 규칙이나 인덱스만 보낼 수 있습니다** (기존 테이블에 규칙·인덱스만 추가/삭제. 단 `anon` 공개 규칙은 대상 테이블을 `tables` 에 함께 적어야 합니다)
- 컬럼의 `unique: true` 는 제약이 아니라 **UNIQUE 인덱스**로 만들어져 되돌릴 수 있습니다 — ⚠️ **단 다른 테이블이 그 항목을 연결(`references`)하면 그때부터 되돌릴 수 없습니다**(연결을 끊는 수단이 이 도구에 없습니다)
- 되돌리기: `dropIndexes: [{table, columns, unique}]` — 만들 때와 **같은 `unique` 값**을 주세요(다르면 이름이 달라 `not_found`)
- 기존 데이터에 중복이 있으면 유니크 인덱스 생성이 실패합니다. 그건 **재시도해도 같은 결과**이니 중복을 먼저 정리하도록 안내하세요
- ⚠️ 유니크 인덱스를 지운 뒤 중복이 들어오면 다시 만들 수 없습니다
- 못 지운 것은 `dropIndexResults` 의 `status:"blocked"` + `reason` 으로 옵니다 — `referenced_by_fk`(다른 저장 공간이 연결해 씀, 사실상 영구)·`backs_constraint`·`primary_key`·`extension_owned`·`replica_identity`·`expression_index`. 사용자에게 사유를 전달하고 같은 입력으로 재시도하지 마세요

**연결(외래키) 주의**: `references` 로 가리킬 수 있는 것은 자동으로 만들어지는 `id` 와, **같은 호출에서 새로 만드는(또는 기존 테이블에 새로 추가하는) `unique: true` 항목**입니다. 아래 세 경우는 `42830`("연결하려는 항목에 중복 금지가 걸려 있지 않아요")로 **호출 전체가 실패**하니, 그 항목을 **먼저 만드는 호출**을 보낸 뒤 다음 호출에서 연결하세요(같은 입력 재시도는 같은 결과입니다).
- 같은 테이블 안에서 **자기 자신의** `unique: true` 항목을 가리킬 때 (예: `parent_slug` → 같은 테이블의 `slug`) — 서버가 `SELF_FK_UNIQUE_SAME_CALL` 로 미리 거절합니다
- 중복 금지를 항목이 아니라 `indexes: [{…, unique: true}]` 로 선언하고 그것을 가리킬 때
- 참조하는 테이블을 `tables` 배열에서 **참조 대상보다 먼저** 적었을 때(대상 테이블을 앞에 적으세요)

**되지 않는 것**: 컬럼 삭제·타입 변경·이름 변경, CHECK 제약, 함수·트리거·뷰, 확장 설치. 요청받으면 제약을 먼저 알리세요.

## 민감 — 값 수령 (편집자/소유자 + GitHub 쓰기 권한)
- service_role 키 다운로드: `get_service_role_key` — 로컬 `.env.development.local` 전용 (skill: pax-local-setup 의 '환경변수' 단계). 값 채팅 출력·커밋 금지(secret-safety 규칙).

## 배포·게이트가 막혔을 때 (디버깅 순서)
1. `get_pr_gate_status` — develop push 후 빌드 + **AI 보안 게이트** 상태. 응답의 `state`가 `no_gate`(게이트 없음)·`no_pr`(PR 생성 대기)면 **기다려도 안 생기니 폴링하지 마세요**. `failed`면 `build.failLog`(빌드 실패) 또는 `aiReview.blockReason`(AI 보안 게이트 BLOCK)을 읽고 원인을 고치세요.
2. Vercel 자체 빌드가 실패했으면 `get_deploy_logs`(기본은 에러 요약, 더 필요하면 `includeFull: true`로 전체 빌드 로그).
3. 더 깊은 로그가 필요하면 사용자에게 `gh run view` / `gh pr checks` 조회를 안내하세요(github-local-auth 스킬 — gh **조회는 허용**, PR 생성·머지는 금지).
- ⚠️ **빌드/배포 로그를 채팅에 통째로 붙여넣지 마세요** — 마스킹이 모든 비밀을 잡지는 못합니다. 필요한 줄만 인용하세요.

## 환경변수 변경 주의 (set_vercel_env / unset_vercel_env)
- **기존 키를 덮어쓰기 전 반드시 사용자에게 확인**하세요. 잘못 덮으면 앱이 깨지고 되돌리기 어렵습니다.
- **배포 라우팅 키**(`VERCEL_PROJECT_ID`·`SUPABASE_PROJECT_REF`·DB 접속 좌표 등)는 서버가 차단합니다 — 정상 동작입니다.
- `set_vercel_env`는 값을 **두 곳에 함께** 저장합니다 — 이 프로젝트의 **설정값 저장소**(PAX 웹 [코드] 탭의 `.env.local`, 편집 권한자에게 보임)와 **배포(Vercel) 환경**. `unset_vercel_env`도 두 곳에서 **함께** 지웁니다.
- **사용자 PC 의 로컬 파일(`.env.development.local`)에는 들어가지 않습니다.** 로컬에서도 같은 값으로 테스트하려면 **PAX 웹 [코드] 탭의 `.env.local`에서 값을 복사해 `.env.development.local`에 직접 추가**해야 합니다(사용자에게 안내하거나, 사용자가 값을 주면 AI가 파일에 씁니다). 시크릿 취급은 secret-safety 규칙을 따르세요.
- env를 바꾼 뒤에는 **`request_vercel_deploy`로 재배포해야 배포된 앱에 실제로 적용**됩니다(저장은 즉시, 적용은 재배포 후).
- 잘못 넣은 키는 `unset_vercel_env`로 지웁니다. 단 **프로젝트 좌표·DB 자격증명·로그인 연동 키**(`SSO_SECRET`·`PORTAL_URL`·`SUPABASE_SERVICE_ROLE_KEY` 등)는 서버가 삭제를 거절합니다 — 설정값 저장소가 유일한 사본이어서 지우면 되돌릴 수 없기 때문입니다. 값을 바꾸려면 `set_vercel_env`로 덮어쓰세요.
- 민감한 값(API 키·`SERVICE_ROLE` 등)을 **채팅에 붙여넣는 것 자체가 노출**입니다. 꼭 필요할 때만 사용자가 직접 값을 제공하게 하고, 등록 뒤 그 값을 화면에 다시 출력하지 마세요. (등록은 `set_vercel_env`로 값을 *올리는* 정상 흐름이고, 값을 *보여주는* 것은 별개의 위험입니다.)

## 사용자에게 노출 가능한 정보 (중요)
사용자에게는 **GitHub 저장소 주소**와 **배포 주소(`*.vercel.app`)** 만 보여주세요. 다음 운영 인프라 식별자는 **절대 노출하거나 추측해서 만들지 마세요**:
- Vercel 대시보드/인스펙터 URL(`vercel.com/...`), org·team 이름, project id, deployment id(uid)
- Supabase project ref, 대시보드 URL, DB 호스트

배포 상태를 알릴 땐 `get_vercel_status`·`get_pr_gate_status`가 주는 `state`·`phase`·`deployUrl`(*.vercel.app)·커밋 SHA 정도만 사용하세요. "배포 보기" 같은 대시보드 링크를 만들지 마세요.
