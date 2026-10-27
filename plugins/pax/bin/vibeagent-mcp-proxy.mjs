#!/usr/bin/env node
/**
 * vibeagent-mcp-proxy — stdio MCP 서버(로컬 프로세스).
 *
 * Claude Code 가 이 프로세스를 띄우면, initialize·tools/list 는 **로컬에서 즉시 응답**해
 * 도구가 네이티브로 뜨게 하고(인증 불필요), tools/call 만 **원격 /api/local-ai/mcp 로
 * 토큰을 붙여 전달**한다. 토큰은 /pax-preview:connect 가 저장한 로컬 파일에서 매 호출 읽는다 — 2.0.0 부터 **프로젝트별 파일**
 * (`lib/store.mjs selectToken`: GitHub remote 또는 폴더 바인딩으로 선택. Codex 는 호스트 threadId로 채팅별 별도 토큰을 선택. 구 파일은 첫 `status` 로 repoUrl 을
 * 학습해 폴더 remote 와 일치하면 프로젝트 파일로 승격, 불일치면 거부).
 *
 * 왜 이 방식인가: 원격 HTTP MCP + headersHelper 는 Claude Code 이슈 #41690 으로 토큰 주입이
 * silent no-op → 네이티브 도구가 안 뜬다. stdio 프록시는 그 한계를 우회한다(stdio 는 안정 지원).
 *
 * ⚠️ TOOLS 카탈로그는 src/lib/localAi/mcpServer.ts 와 **수동 동기화** 대상(도구 추가/변경 시 갱신).
 */
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionFromMeta, sessionDir, readSessionToken, deleteSessionToken, cancelSessionPending } from './lib/session.mjs';
import { acquirePendingLock } from './lib/pendingLock.mjs';
import { isUsable } from './lib/store.mjs';
import { dirname, resolve } from 'node:path';
import { selectToken, promoteLegacy, repoUrlToSlug } from './lib/store.mjs';
import { postJsonRpc, PLUGIN_ID, isDeploymentProtected, DEPLOYMENT_PROTECTED_MESSAGE } from './lib/rpc.mjs';
import { validateProjectDir } from './lib/projectDir.mjs';
import { isInsideDir } from './lib/gitRemote.mjs';

if (process.argv.includes('--print-proxy-path')) {
  process.stdout.write(`${fileURLToPath(import.meta.url)}\n`);
  process.exit(0);
}

// stdio 모드엔 CLAUDE_CODE_MCP_SERVER_URL 이 없으므로 빌드 시 치환된 URL 을 사용.
const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 플러그인 자체의 remote 를 프로젝트로 오인하지 않는다. Codex 채팅 모드는 이 폴백을 사용하지 않는다. */
const cwdForToken = () => (isInsideDir(process.cwd(), PLUGIN_ROOT) ? null : process.cwd());

const REQUIRE_SESSION = process.argv.includes('--require-session');
const runFile = promisify(execFile);
const REQUIRE_PROJECT_DIR = process.argv.includes('--require-project-dir');

const PROTOCOL_VERSION = '2025-06-18';
// version 은 마켓플레이스 배포 시 아래 placeholder 가 실제 버전으로 치환됨(단일 소스: src/lib/pluginVersion.ts).
const SERVER_INFO = { name: 'pax-local-ai-preview', version: '2.2.1' };
// 서버가 "이 사용자가 구버전인가"를 알 수 있는 유일한 신호. 서버는 **헤더 부재 = 기능 도입 이전 버전**으로
// 판정하므로 값이 이상해도 보내는 것 자체는 유지한다(baked 상수라 실패할 수 없다).
// 비-ASCII/제어문자가 섞이면 fetch 가 TypeError 를 던져 **전 도구 호출이 실패**하므로 필터는 필수.
const PLUGIN_VERSION_VALUE = String(SERVER_INFO.version).replace(/[^\x20-\x7E]/g, '').slice(0, 32);
// 인스턴스 접미사(`PAX_PLUGIN_ID` — 발행 시 rpc.mjs 에 치환)가 있으면 도구 설명 앞에 `PAX(<id>) · ` 를 붙여 여러 PAX 서버의
// 플러그인이 한 PC 에 있을 때 모델이 어느 서버 도구인지 구분하게 한다(설명은 서버와 수동 동기화 대상인 TOOLS 원문에 손대지 않고
// tools/list 응답에서만 붙인다). 원본 정체성은 빈 접두 = 오늘과 동일.
const TOOL_LABEL = PLUGIN_ID ? `PAX(${PLUGIN_ID}) · ` : '';

const NOARGS = { type: 'object', properties: {} };
const TOOLS = [
  { name: 'status', description: '현재 브리지 연결의 프로젝트·스코프·인프라 준비 상태를 반환합니다.', inputSchema: NOARGS },
  { name: 'get_public_env', description: '로컬 .env 에 쓸 공개값만 반환합니다 — publicKeys(앱 공개 설정값: NEXT_PUBLIC_*/VITE_*·PORTAL_URL·SSO_CLIENT_ID(기존 v1 앱은 SSO_SERVICE_ID), Supabase 연결 여부와 무관) + Supabase URL·anon key(ready 일 때). service_role·SSO_CLIENT_SECRET·SSO_SECRET 등 비밀 미포함. 미준비 시 notReadyReason(+ stalled:true = 연결 중단, 웹에서 재연동 필요)로 상태를 알립니다.', inputSchema: NOARGS },
  { name: 'get_service_role_key', description: '로컬 .env.development.local 용 SUPABASE_SERVICE_ROLE_KEY 를 반환합니다(편집자/소유자 + GitHub 쓰기 권한 필요). 받은 값은 파일에만 기록 — 채팅 출력·커밋 금지.', inputSchema: NOARGS },
  { name: 'get_project_manifest', description: 'clone/로컬 실행에 필요한 repo·브랜치·배포주소(*.vercel.app) 정보를 반환합니다.', inputSchema: NOARGS },
  { name: 'get_project_skills', description: '이 프로젝트 폴더에 놓을 회사·개인 스킬 번들을 반환합니다(read-only). 직접 호출하지 말고 bin/vibeagent-sync-skills.mjs 가 clone 폴더의 .claude/skills/pax-* 에 씁니다.', inputSchema: NOARGS },
  { name: 'get_supabase_schema', description: 'public 스키마의 테이블·컬럼 구조를 반환합니다(read-only).', inputSchema: NOARGS },
  { name: 'get_rls_status', description: '테이블별 RLS 활성 여부와 정책 목록을 반환합니다(read-only).', inputSchema: NOARGS },
  { name: 'get_migrations', description: '적용된 Supabase 마이그레이션 버전 목록을 반환합니다(read-only).', inputSchema: NOARGS },
  {
    name: 'apply_supabase_change',
    description: '테이블·컬럼을 만들거나 컬럼을 추가하고, 접근 규칙(RLS)·인덱스를 설정합니다. 만든 인덱스 되돌리기도 됩니다(dropIndexes). '
      + '테이블·컬럼 삭제와 타입 변경은 불가. 접근 규칙은 테이블마다 필요합니다 — user_id 컬럼이 있으면 본인 전용 규칙이 자동 생성되고, '
      + '모두가 봐야 하면 policies 에 {operation:"SELECT", roles:["anon","authenticated"]}, 서버 전용이면 tables[].serverOnly. '
      + '인덱스만 바꿀 때는 tables 생략 가능. 로그인 없이 읽히게 하는 공개 규칙은 사용자 동의 + confirmedPublic:true 필요. (편집자/소유자 + GitHub 쓰기 권한 필요)',
    inputSchema: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    primaryKey: { type: 'boolean' },
                    nullable: { type: 'boolean' },
                    unique: { type: 'boolean', description: '중복 금지. UNIQUE 인덱스로 만들어지고 되돌릴 수 있습니다' },
                    defaultValue: { type: 'string' },
                    references: { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' } } },
                  },
                  required: ['name', 'type'],
                },
              },
              serverOnly: { type: 'boolean', description: '서버에서만 쓰는 저장 공간(감사 기록·작업 큐). 앱에서 직접 조회 불가' },
            },
            required: ['name', 'columns'],
          },
        },
        policies: {
          type: 'array',
          description: '접근 규칙. 생략하면 user_id 컬럼이 있는 테이블에 본인 전용 규칙이 자동 생성됩니다',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              name: { type: 'string' },
              operation: { type: 'string', enum: ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
              check: {
                type: 'object',
                description: '생략하면 전체 허용 — operation 은 SELECT 만, roles 필수',
                properties: {
                  column: { type: 'string' },
                  operator: { type: 'string', enum: ['=', '<>'] },
                  value: { type: 'string', enum: ['auth.uid()'] },
                },
                required: ['column', 'operator', 'value'],
              },
              roles: {
                type: 'array',
                description: '누구에게 적용할지. anon=비로그인 포함',
                items: { type: 'string', enum: ['anon', 'authenticated'] },
              },
            },
            required: ['table', 'name', 'operation'],
          },
        },
        indexes: {
          type: 'array',
          description: '검색 속도용 인덱스. unique:true 면 중복 금지도 함께',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
            },
            required: ['table', 'columns'],
          },
        },
        confirmedPublic: {
          type: 'boolean',
          description: '로그인 없이 읽히게 하는 것을 사용자가 동의함(anon 공개 규칙에 필수)',
        },
        dropIndexes: {
          type: 'array',
          description: '만들었던 인덱스 되돌리기. unique 값을 실제와 똑같이 지정해야 합니다',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
            },
            required: ['table', 'columns'],
          },
        },
      },
    },
  },
  { name: 'get_vercel_status', description: '최근 배포 상태를 반환합니다(read-only). 배포주소는 *.vercel.app 만 노출.', inputSchema: NOARGS },
  { name: 'request_vercel_deploy', description: 'production 재배포를 요청합니다(편집자/소유자 + GitHub 쓰기 권한 필요).', inputSchema: NOARGS },
  {
    name: 'get_deploy_logs',
    description: 'Vercel 빌드/배포 실패 로그를 반환합니다(read-only). 기본은 에러 요약, includeFull=true 면 전체 빌드 로그.',
    inputSchema: { type: 'object', properties: { includeFull: { type: 'boolean' } } },
  },
  {
    name: 'get_pr_gate_status',
    description: 'develop push 후 GitHub Actions PR 게이트(빌드 + AI 보안 게이트)의 상태와 실패/BLOCK 사유를 반환합니다(read-only).',
    inputSchema: NOARGS,
  },
  {
    name: 'list_vercel_env',
    description: 'Vercel 에 등록된 환경변수의 키 이름만 반환합니다(값 미포함, read-only).',
    inputSchema: NOARGS,
  },
  {
    name: 'set_vercel_env',
    description:
      '환경변수(설정값)를 추가/수정합니다(편집자/소유자 + GitHub 쓰기 권한 필요). 값은 이 프로젝트의 설정값 저장소와 배포(Vercel) 환경에 함께 저장됩니다(사용자 PC 의 로컬 .env 에는 안 들어감). ⚠️ 기존 키 덮어쓰기 전 사용자 확인 필수. 적용하려면 request_vercel_deploy 재배포 필요.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    },
  },
  {
    name: 'unset_vercel_env',
    description:
      '환경변수(설정값)를 삭제합니다(잘못 설정한 키 회수용, 편집자/소유자 + GitHub 쓰기 권한 필요). 설정값 저장소와 배포(Vercel) 환경에서 함께 지워집니다 — 삭제 전 사용자 확인 필수. 프로젝트 좌표·DB 자격증명·로그인 연동 키는 서버가 거절합니다. 적용하려면 재배포 필요.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'list_storage_buckets',
    description: 'Supabase 스토리지 버킷 목록을 반환합니다(read-only).',
    inputSchema: NOARGS,
  },
  {
    name: 'create_storage_bucket',
    description: '스토리지 버킷을 생성합니다(파일 업로드 기능용, 편집자/소유자 + GitHub 쓰기 권한 필요).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        public: { type: 'boolean' },
        fileSizeLimit: { type: 'number' },
        allowedMimeTypes: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_design_components',
    description: '테넌트 디자인 시스템의 컴포넌트·리소스 목록을 조회합니다(read-only). UI 작업 전에 먼저 호출하세요.',
    inputSchema: NOARGS,
  },
  {
    name: 'get_design_component',
    description: '디자인 시스템 컴포넌트(또는 리소스 문서)의 완성 코드를 조회합니다(read-only). 반환 코드는 수정 없이 그대로 저장하세요.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '컴포넌트 또는 리소스 이름' },
        system: { type: 'string', description: '디자인 시스템 이름 (발행본이 여러 개일 때만 지정)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_design_foundation',
    description: '디자인 시스템의 색·타이포·간격 토큰을 CSS 변수 파일로 조회합니다(read-only). UI 작업 전에 한 번 저장하세요.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: '디자인 시스템 이름 (발행본이 여러 개일 때만 지정)' },
      },
    },
  },
  {
    name: 'get_portal_registration',
    description:
      '이 프로젝트의 pable studio 서비스 등록 상태와 서비스 ID(SSO 코드의 service/aud 클레임 값)를 조회합니다(read-only). 로그인 방식(ssoProtocol: v1·v2·아직 미정 null)과 v2 의 client_id 도 알려 줍니다 — pable studio SSO 연동 코드를 만들기 전, 서비스 ID 가 필요할 때 먼저 호출하세요.',
    inputSchema: NOARGS,
  },
  {
    name: 'register_portal_service',
    description:
      '이 프로젝트를 pable studio에 서비스로 등록합니다(SSO 연동은 꺼진 중립 상태로 생성, 멱등). get_portal_registration 이 registered:false 이고, 사용자가 pable studio에서 직접 등록한 적이 없음을 확인한 뒤 confirmedNew:true 로 호출하세요.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'pable studio에 표시할 서비스 한 줄 소개 (선택)' },
        confirmedNew: {
          type: 'boolean',
          description: '사용자에게 "pable studio에서 직접 등록한 적 없음"을 확인받았을 때만 true',
        },
      },
    },
  },
  {
    name: 'request_portal_sso_key',
    description:
      '이 프로젝트의 pable studio SSO 연동을 켜고(꺼져 있으면 — 한 번 켜면 끌 수 없음) 로그인 키(client_id·client secret) 발급을 신청합니다. 사용자 동의를 받은 뒤 enableConfirmed:true 로 호출하세요. 승인은 관리자(사람)가 합니다. 새 신청은 v2 로 정해지고, pable studio가 새 방식을 아직 지원하지 않으면 신청하지 않고 멈춥니다(v2_unavailable). 키 수령 뒤에는 다시 신청하지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: '이전 신청이 거절/회수된 뒤(NONE 복귀) 사용자가 재신청을 명시적으로 원할 때만 true',
        },
        enableConfirmed: { type: 'boolean', description: 'SSO 연동 켜기(비가역)에 사용자가 동의했을 때만 true' },
      },
    },
  },
  {
    name: 'claim_portal_sso_key',
    description:
      '승인된(APPROVED) SSO 키를 수령해 이 프로젝트의 설정값 저장소와 배포(Vercel) 환경에 저장합니다 — SSO_CLIENT_ID·SSO_CLIENT_SECRET(기존 v1 등록이면 SSO_SECRET·SSO_SERVICE_ID — 키 값은 반환되지 않고 로컬 .env 에도 들어가지 않습니다). 수령은 누적 5회 한도이니 재시도 루프 금지.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: '이미 SSO_CLIENT_SECRET(기존 v1 등록은 SSO_SECRET) 이 있어도 새 키로 교체 배선할 때만 true (재발급 완료를 사용자가 명시한 경우)',
        },
      },
    },
  },
  { name: 'disconnect', description: '이 프로젝트의 PAX 연결(현재 토큰)을 즉시 취소합니다. /pax-preview:disconnect 가 먼저 이 도구를 호출해 서버에서 취소한 뒤 로컬 토큰 파일을 지웁니다. 다시 쓰려면 /pax-preview:connect.', inputSchema: NOARGS },
];

const SESSION_TOOLS = [
  { name: 'connect', description: '현재 Codex 채팅을 PAX 서비스에 연결합니다. start로 시작해 주소·확인값을 사용자에게 전달하고, 브라우저 연결 후 wait로 완료를 확인하세요. restart는 이 채팅의 대기만 교체합니다. 채팅 ID는 Codex가 자동 전달합니다.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'wait', 'restart'] } }, required: ['action'], additionalProperties: false } },
  { name: 'sync_skills', description: '이 채팅의 서비스 스킬을 Git 폴더에 동기화합니다. projectDir는 파일 저장 위치이며 연결 선택에는 쓰지 않습니다. 폴더 remote가 연결 서비스와 같아야 합니다. 같은 폴더의 다른 채팅도 파일을 공유합니다.', inputSchema: { type: 'object', properties: { projectDir: { type: 'string' } }, required: ['projectDir'], additionalProperties: false } },
];
async function sessionTool(id, params) {
  let unlock;
  try {
    const sessionId = sessionFromMeta(params?._meta);
    const args = params?.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
    if (Object.hasOwn(args, 'sessionId') || Object.hasOwn(args, 'threadId')) throw new Error('채팅 ID는 인자로 지정하지 않습니다.');
    const name = params?.name;
    if (![...TOOLS, ...SESSION_TOOLS].some(t => t.name === name)) throw new Error('Unknown tool');
    if (name === 'connect') {
      if (!['start', 'wait', 'restart'].includes(args.action) || Object.keys(args).some(k => k !== 'action')) throw new Error('connect action: start | wait | restart');
      const cliArgs = [resolve(PLUGIN_ROOT, 'bin/vibeagent-connect.mjs'), '--session-id', sessionId];
      if (args.action === 'wait') cliArgs.push('--wait', '5');
      if (args.action === 'restart') cliArgs.push('--restart');
      const { stdout } = await runFile(process.execPath, cliArgs, { cwd: PLUGIN_ROOT, timeout: 45000, maxBuffer: 65536 });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: stdout }] } });
    }
    if (name === 'sync_skills') {
      const dir = validateProjectDir(args.projectDir, PLUGIN_ROOT);
      unlock = acquirePendingLock(sessionDir(MCP_URL, sessionId));
      if (!unlock) throw new Error('connection_busy: 이 채팅의 연결 작업이 진행 중입니다. 다시 시도하세요.');
      const { stdout } = await runFile(process.execPath, [resolve(PLUGIN_ROOT, 'bin/vibeagent-sync-skills.mjs'), '--session-id', sessionId, '--project-dir', dir], { timeout: 45000, maxBuffer: 65536 });
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: stdout }] } });
    }
    // Lock spans token selection and request: disconnect cannot delete a replacement token.
    unlock = acquirePendingLock(sessionDir(MCP_URL, sessionId));
    if (!unlock) throw new Error('connection_busy: 이 채팅의 요청이 진행 중입니다. 다시 시도하세요.');
    const entry = readSessionToken(MCP_URL, sessionId);
    if (name === 'disconnect') cancelSessionPending(MCP_URL, sessionId);
    if (!isUsable(entry)) {
      if (name !== 'disconnect') throw new Error('session_not_connected: 이 채팅은 연결되지 않았거나 만료됐어요. connect 도구로 이 채팅에서 연결하세요.');
      if (entry) deleteSessionToken(MCP_URL, sessionId);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '이 채팅의 연결 대기와 만료된 로컬 연결을 정리했어요. 유효한 토큰은 없습니다.' }] } });
    }
    const remoteArgs = { ...args };
    delete remoteArgs.projectDir;
    // Host metadata stays local: no thread IDs or session data sent to the PAX server.
    const { status, data } = await postJsonRpc(MCP_URL, entry.token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: remoteArgs } }, { pluginVersion: PLUGIN_VERSION_VALUE, timeoutMs: 120000 });
    if (isDeploymentProtected(status, data)) throw new Error(DEPLOYMENT_PROTECTED_MESSAGE);
    if (status === 401 && name === 'disconnect') {
      deleteSessionToken(MCP_URL, sessionId);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '이미 만료/취소된 이 채팅의 연결을 정리했어요.' }] } });
    }
    if (status !== 200 || !data?.result) throw new Error(status === 401 ? '이 채팅의 연결이 만료/취소됐어요. connect로 다시 연결하세요.' : `PAX 요청 실패 (HTTP ${status}). 연결 해제 실패 시 토큰은 유지됩니다.`);
    if (name === 'disconnect' && !data.result.isError) deleteSessionToken(MCP_URL, sessionId);
    return send({ jsonrpc: '2.0', id, result: data.result });
  } catch (e) { return errorResult(id, String(e.stderr || e.message).slice(0, 2000)); }
  finally { unlock?.(); }
}

/** 토큰 선택 — { token, sel } | { token:null, message }. 레거시 단일 파일은 폴더 remote 와 대조 후 승격. */
async function readToken(projectDir) {
  const sel = selectToken({ mcpUrl: MCP_URL, cwd: projectDir ?? cwdForToken(),
    projectDirHint: projectDir ? undefined : process.env.CLAUDE_PROJECT_DIR, fresh: !!projectDir });
  if (sel.kind === 'project' || sel.kind === 'folder' || sel.kind === 'recent') return { token: sel.entry.token, sel };
  if (sel.kind === 'legacy') {
    // 구 파일은 repoUrl 을 모른다 — 첫 호출 때 status 로 학습해 폴더 remote 와 대조(remote 없으면 최근 연결로 그대로 사용).
    if (!sel.remote) return { token: sel.entry.token, sel };
    const mismatch = `지금 폴더(${sel.remote})는 이전 연결과 다른 프로젝트예요. /pax-preview:connect 로 이 프로젝트를 연결하세요.`;
    try {
      const { status, data } = await postJsonRpc(MCP_URL, sel.entry.token, { jsonrpc: '2.0', id: 'legacy-status', method: 'tools/call', params: { name: 'status', arguments: {} } }, { pluginVersion: PLUGIN_VERSION_VALUE, timeoutMs: 15_000 });
      if (isDeploymentProtected(status, data)) return { token: null, message: DEPLOYMENT_PROTECTED_MESSAGE };
      if (status === 401) return { token: null, message: 'PAX 인증이 만료/취소되었습니다. /pax-preview:connect 를 실행해 다시 연결하세요.' };
      const repoUrl = status === 200 ? data?.result?.structuredContent?.repoUrl : null;
      if (typeof repoUrl === 'string') {
        if (repoUrlToSlug(repoUrl) === sel.remote) {
          promoteLegacy(MCP_URL, sel.entry, repoUrl);
          return { token: sel.entry.token, sel };
        }
        return { token: null, message: mismatch };
      }
    } catch { /* 아래 안내 — 잠그지 않는다 */ }
    return { token: null, message: '이전 연결(구 버전 토큰)이 어느 프로젝트 것인지 서버에서 확인하지 못했어요. 잠시 후 다시 시도하거나 /pax-preview:connect 로 이 프로젝트를 연결하세요.' };
  }
  // remote 없는 폴더는 이 폴더에서 연결한 프로젝트(폴더 바인딩)만 쓴다 — 다른 세션·폴더의 최근 연결로 새지 않는다.
  if (sel.reason === 'no_folder_binding') {
    return { token: null, message: '이 폴더는 아직 PAX 에 연결되지 않았어요. /pax-preview:connect 를 실행해 이 폴더에서 쓸 프로젝트를 고르세요(다른 폴더에서 한 연결은 여기에 쓰이지 않아요).' };
  }
  const where = sel.remote ? `이 프로젝트(${sel.remote})` : sel.slug ? `이 폴더에 연결된 프로젝트(${sel.slug})` : 'PAX';
  return { token: null, message: sel.reason === 'expired'
    ? `${where} 연결이 만료됐어요. /pax-preview:connect 를 실행해 다시 연결하세요.`
    : `${where}에 연결되어 있지 않아요. /pax-preview:connect 를 실행해 연결하세요.` };
}

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    /* stdout 닫힘(EPIPE) 등 — 무시 */
  }
}

function errorResult(id, text) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
}

async function forwardToolCall(id, params) {
  if (REQUIRE_SESSION) return sessionTool(id, params);
  let projectDir;
  const args = params?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return errorResult(id, 'arguments must be an object');
  try {
    if (REQUIRE_PROJECT_DIR || Object.hasOwn(args, 'projectDir')) projectDir = validateProjectDir(args.projectDir, PLUGIN_ROOT);
  } catch (e) { return errorResult(id, e.message); }
  const remoteArgs = { ...args };
  delete remoteArgs.projectDir;
  params = { ...params, arguments: remoteArgs };
  const { token, message } = await readToken(projectDir);
  if (!token) return errorResult(id, message);
  try {
    const { status, data } = await postJsonRpc(MCP_URL, token, { jsonrpc: '2.0', id, method: 'tools/call', params }, { pluginVersion: PLUGIN_VERSION_VALUE, timeoutMs: 120_000 });
    if (status === 401) {
      // 배포 보호(Vercel Authentication)의 엣지 401 은 앱의 인증 만료와 원인이 다르다 — 재연결로 우회 값을 받게 안내.
      return errorResult(id, isDeploymentProtected(status, data) ? DEPLOYMENT_PROTECTED_MESSAGE : 'PAX 인증이 만료/취소되었습니다. /pax-preview:connect 를 실행해 다시 연결하세요.');
    }
    if (data && data.result) return send({ jsonrpc: '2.0', id, result: data.result });
    // JSON-RPC error 는 {code:number, message} 형태일 때만 그대로 전달 — 비-JSON-RPC 본문(503/400 등)은 도구 에러로 (review #7)
    if (data && typeof data.error === 'object' && data.error && typeof data.error.code === 'number') {
      return send({ jsonrpc: '2.0', id, error: data.error });
    }
    return errorResult(
      id,
      `PAX 서버 오류 (HTTP ${status}).${status === 503 ? ' 서비스 일시 중지 — 잠시 후 다시 시도하세요.' : ''}`,
    );
  } catch (e) {
    return errorResult(id, `PAX 서버 호출 실패: ${e?.message ?? e}`);
  }
}

// 장수 프로세스 — 부모(Claude Code) 종료/끊김에 견디게: EPIPE·미처리 예외에 조용히 종료 (review #8)
process.stdout.on('error', () => {});
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => {});

const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  // 알림(id 없음) — 응답하지 않는다 (notifications/initialized 등).
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: (REQUIRE_SESSION ? [...TOOLS, ...SESSION_TOOLS] : TOOLS).map((t) => ({ ...t, description: TOOL_LABEL + t.description,
        inputSchema: REQUIRE_PROJECT_DIR ? { ...t.inputSchema, properties: { ...t.inputSchema.properties,
          projectDir: { type: 'string', description: '현재 대화의 프로젝트 폴더 절대 경로. 플러그인 폴더 사용 금지.' } },
          required: [...(t.inputSchema.required ?? []), 'projectDir'] } : t.inputSchema,
      })) } });
    case 'tools/call':
      return void forwardToolCall(id, params);
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
