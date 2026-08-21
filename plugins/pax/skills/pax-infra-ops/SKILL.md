---
name: pax-infra-ops
description: Supabase/Vercel 조회·생성·배포·환경변수·스토리지·배포로그·PR게이트는 PAX MCP로 서버 대행. "테이블 추가", "스키마 확인", "RLS 확인", "배포해줘", "환경변수 등록/확인", "배포 왜 실패했어", "PR 게이트 상태", "스토리지 버킷", "service_role 키" 등 인프라 작업에 사용.
---
# 인프라 작업은 PAX MCP로 (secretless)

로컬에는 인프라 자격증명이 없으므로 Supabase/Vercel 권한 작업은 **PAX MCP 도구가 서버 권한으로 대행**합니다. credential을 로컬에 요구하지 마세요.

## 조회 (read-only)
- 연결 상태: `status` / 공개 env: `get_public_env`
- 스키마: `get_supabase_schema` / RLS(로컬에서 데이터 안 보일 때 진단): `get_rls_status` / 마이그레이션: `get_migrations`
- 스토리지 버킷 목록: `list_storage_buckets`
- Vercel 배포 상태: `get_vercel_status` / 배포 실패 로그: `get_deploy_logs`
- Vercel 환경변수 **키 이름** 목록: `list_vercel_env` (보안상 값은 못 봅니다 — 키 이름만)
- PR 게이트 상태: `get_pr_gate_status`

## 생성·변경 (편집자/소유자 역할 + GitHub 쓰기 권한 필요)
- 테이블/컬럼 생성: `apply_supabase_change` — **생성만(DROP/DELETE 불가)**
- 스토리지 버킷 생성: `create_storage_bucket`
- Vercel 환경변수 설정: `set_vercel_env` / 삭제: `unset_vercel_env`
- production 재배포: `request_vercel_deploy`

파괴적 작업(테이블 삭제 등)은 도구로 제공되지 않으며 PAX 웹에서 승인이 필요합니다. 권한 거부(403)면 사용자의 역할/GitHub 권한을 확인하도록 안내하세요(거부 시 연결이 자동 취소될 수 있음 — 연결 코드로 재연결).

## 민감 — 값 수령 (편집자/소유자 + GitHub 쓰기 권한)
- service_role 키 다운로드: `get_service_role_key` — 로컬 `.env.development.local` 전용 (skill: pax-local-setup 의 '환경변수' 단계). 값 채팅 출력·커밋 금지(secret-safety 규칙).

## 배포·게이트가 막혔을 때 (디버깅 순서)
1. `get_pr_gate_status` — develop push 후 빌드 + **AI 보안 게이트** 상태. 응답의 `state`가 `no_gate`(게이트 없음)·`no_pr`(PR 생성 대기)면 **기다려도 안 생기니 폴링하지 마세요**. `failed`면 `build.failLog`(빌드 실패) 또는 `aiReview.blockReason`(AI 보안 게이트 BLOCK)을 읽고 원인을 고치세요.
2. Vercel 자체 빌드가 실패했으면 `get_deploy_logs`(기본은 에러 요약, 더 필요하면 `includeFull: true`로 전체 빌드 로그).
3. 더 깊은 로그가 필요하면 사용자에게 `gh run view` / `gh pr checks` 조회를 안내하세요(github-local-auth 스킬 — gh **조회는 허용**, PR 생성·머지는 금지).
- ⚠️ **빌드/배포 로그를 채팅에 통째로 붙여넣지 마세요** — 마스킹이 모든 비밀을 잡지는 못합니다. 필요한 줄만 인용하세요.

## 환경변수 변경 주의 (set_vercel_env / unset_vercel_env)
- **기존 키를 덮어쓰기 전 반드시 사용자에게 확인**하세요. 잘못 덮으면 앱이 깨지고 되돌리기 어렵습니다.
- **배포 라우팅 키**(`VERCEL_PROJECT_ID`·`SUPABASE_PROJECT_REF` 등)는 서버가 차단합니다 — 정상 동작입니다.
- `set_vercel_env`는 **Vercel 런타임에만** 반영됩니다. 소스 `.env`(=`get_public_env`가 보는 원본)에는 들어가지 않습니다.
- 로컬에서도 그 값으로 테스트하려면 `.env.development.local`에 **직접 추가**해야 합니다(set_vercel_env는 배포된 앱에만 반영 — 로컬엔 안 들어감). 시크릿 취급은 secret-safety 규칙을 따르세요.
- env를 바꾼 뒤에는 **`request_vercel_deploy`로 재배포해야 실제로 적용**됩니다.
- 잘못 넣은 키는 `unset_vercel_env`로 지웁니다.
- 민감한 값(API 키·`SERVICE_ROLE` 등)을 **채팅에 붙여넣는 것 자체가 노출**입니다. 꼭 필요할 때만 사용자가 직접 값을 제공하게 하고, 등록 뒤 그 값을 화면에 다시 출력하지 마세요. (등록은 `set_vercel_env`로 값을 *올리는* 정상 흐름이고, 값을 *보여주는* 것은 별개의 위험입니다.)

## 사용자에게 노출 가능한 정보 (중요)
사용자에게는 **GitHub 저장소 주소**와 **배포 주소(`*.vercel.app`)** 만 보여주세요. 다음 운영 인프라 식별자는 **절대 노출하거나 추측해서 만들지 마세요**:
- Vercel 대시보드/인스펙터 URL(`vercel.com/...`), org·team 이름, project id, deployment id(uid)
- Supabase project ref, 대시보드 URL, DB 호스트

배포 상태를 알릴 땐 `get_vercel_status`·`get_pr_gate_status`가 주는 `state`·`phase`·`deployUrl`(*.vercel.app)·커밋 SHA 정도만 사용하세요. "배포 보기" 같은 대시보드 링크를 만들지 마세요.
