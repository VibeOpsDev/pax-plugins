/**
 * 원격 브리지(`/api/local-ai/mcp`) 호출 — 프록시(JSON-RPC 그대로 전달)와 스크립트(`callTool`)가 공유.
 * 서버는 `enableJsonResponse=true` 라 보통 JSON 이지만 SSE 형식이면 `data:` 라인에서 추출(방어적).
 * 배포 보호 우회(프리뷰 인스턴스, 2026-09-23): 인스턴스 폴더의 `deployment-bypass.json` 이 있으면 **그 origin·https 로 나가는 요청에만**
 * `x-vercel-protection-bypass` 를 붙인다(`deploymentBypassHeaders`). 없으면 헤더 없음 = 종전 동작. Vercel 엣지의 보호 401 은
 * `isDeploymentProtected` 로 알아보고 전용 안내(`DEPLOYMENT_PROTECTED_MESSAGE`)를 낸다 — 앱의 401(인증 만료)과 다른 원인이라서.
 * 연결 전 확인(`connectPreflight`, 2.0.1)도 여기 둔다 — 같은 버전·접미사·우회 헤더 규칙을 공유해야 해서.
 */
import { readDeploymentBypass } from './store.mjs';

export const PLUGIN_VERSION_HEADER = 'X-Pax-Plugin-Version';
/**
 * 인스턴스 접미사 헤더 — 서버가 "이 클라이언트는 어느 이름(`pax` / `pax-<id>`)으로 설치된 플러그인인가" 를 아는 유일한 신호(2.0.0).
 * 발행 시 아래 placeholder 가 접미사(예 `sp`) 또는 빈 문자열로 치환된다. 빈 값(원본 이름)·미치환 개발본은 보내지 않는다 —
 * 서버는 헤더 부재 = 원본 이름으로 읽고, 자기 접미사와 다르면 재설치 안내를 붙인다.
 */
export const PLUGIN_ID_HEADER = 'X-Pax-Plugin-Id';
const PLUGIN_ID_RAW = 'preview';
export const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(PLUGIN_ID_RAW) && PLUGIN_ID_RAW.length <= 12 ? PLUGIN_ID_RAW : '';

/** Vercel 이 검사하는 배포 보호 우회 헤더 — 서버 `src/lib/localAi/deploymentBypass.ts` 와 같은 값. */
export const DEPLOYMENT_BYPASS_HEADER = 'x-vercel-protection-bypass';
/**
 * 우회 헤더 — 대상 주소가 **https 이고 이 MCP 주소와 origin 이 같을 때만**. 값은 `secret`(리스너가 방금 받은 값) 또는 인스턴스 파일.
 * 다른 호스트·http 로는 절대 나가지 않는다(리다이렉트 대상 포함 — 호출처는 redirect 를 따라가지 않는다).
 */
export function deploymentBypassHeaders({ mcpUrl, targetUrl = mcpUrl, secret = null } = {}) {
  let mcp, target;
  try { mcp = new URL(mcpUrl); target = new URL(targetUrl); } catch { return {}; }
  if (target.protocol !== 'https:' || target.origin !== mcp.origin) return {};
  const value = secret ?? readDeploymentBypass(mcpUrl)?.secret ?? null;
  return value ? { [DEPLOYMENT_BYPASS_HEADER]: value } : {};
}
/** Vercel 배포 보호의 엣지 401 — 앱에 닿지 못한 응답(`{ error:{ message:'Protected deployment' }, protection:{ vercel_auth_enabled } }`). */
export function isDeploymentProtected(status, data) {
  if (status !== 401 || !data || typeof data !== 'object') return false;
  return data.protection?.vercel_auth_enabled === true || data.error?.message === 'Protected deployment';
}
export const DEPLOYMENT_PROTECTED_MESSAGE =
  '배포 보호(Vercel Authentication)가 요청을 막았어요 — 이 서버는 브라우저 로그인 없이는 닿을 수 없어요. 관리자가 서버 env LOCAL_AI_DEPLOYMENT_BYPASS_SECRET 을 등록해 두면 다시 연결할 때 우회 값이 전달돼요 (Claude Code 는 /pax-preview:connect, Codex 는 /pax-preview:pax-connect).';

/** JSON-RPC 본문 POST → { status, data } (data 는 파싱된 JSON-RPC 응답 또는 null). 네트워크 예외는 throw. */
export async function postJsonRpc(mcpUrl, token, body, { pluginVersion, timeoutMs = 30_000 } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (pluginVersion) headers[PLUGIN_VERSION_HEADER] = String(pluginVersion).replace(/[^\x20-\x7E]/g, '').slice(0, 32);
  if (PLUGIN_ID) headers[PLUGIN_ID_HEADER] = PLUGIN_ID;
  Object.assign(headers, deploymentBypassHeaders({ mcpUrl }));
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/data:\s*(\{[\s\S]*\})\s*$/m);
    try { data = m ? JSON.parse(m[1]) : null; } catch { data = null; }
  }
  return { status: res.status, data };
}

/**
 * 도구 1회 호출 → { ok:true, result } | { ok:false, status, message }.
 * result = MCP CallToolResult({ content, structuredContent?, isError? }).
 */
export async function callTool(mcpUrl, token, name, args = {}, opts = {}) {
  const { status, data } = await postJsonRpc(mcpUrl, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts);
  if (isDeploymentProtected(status, data)) return { ok: false, status, message: DEPLOYMENT_PROTECTED_MESSAGE };
  if (status === 401) return { ok: false, status, message: 'PAX 인증이 만료/취소되었습니다. /pax-preview:connect 로 다시 연결하세요.' };
  if (data && data.result) return { ok: true, result: data.result };
  if (data && data.error && typeof data.error.message === 'string') return { ok: false, status, message: data.error.message };
  return { ok: false, status, message: `PAX 서버 오류 (HTTP ${status})` };
}

/**
 * 연결 전 확인(2.0.1) — 리스너를 띄우기 전에 서버에 "이 설치본으로 연결을 시작해도 되는가" 를 묻는다(`GET /api/local-ai/connect-preflight`).
 * 판정은 서버가 한다(플러그인 안에 기준을 박으면 다음 전환 때 바꿀 수 없다 — 1.x 가 연결 코드 인자에 묶여 막힌 선례, 2026-09-28).
 * **fail-open**: 개발본(미치환 버전)·주소 도출 실패·네트워크·타임아웃(5s — 서버가 마커 조회 2s 를 끝까지 기다린다)·비 200·형식 이상은 전부
 *   `{ stop:false }` — 확인 때문에 연결이 막히지 않는다.
 * 안내 본문은 서버 문구 그대로 출력하되 길이 상한·제어문자 제거만 한다(도구 응답 안내와 같은 신뢰 수준 — 같은 origin 의 https 응답).
 */
export async function connectPreflight(mcpUrl, pluginVersion, { timeoutMs = 5000 } = {}) {
  const PROCEED = { stop: false, guidance: null };
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(pluginVersion))) return PROCEED; // 미치환 개발본 — 서버에 묻지 않는다
  const url = String(mcpUrl).replace(/\/api\/local-ai\/mcp\/?$/, '/api/local-ai/connect-preflight');
  if (url === String(mcpUrl)) return PROCEED;
  try {
    const headers = { Accept: 'application/json', [PLUGIN_VERSION_HEADER]: String(pluginVersion) };
    if (PLUGIN_ID) headers[PLUGIN_ID_HEADER] = PLUGIN_ID;
    Object.assign(headers, deploymentBypassHeaders({ mcpUrl, targetUrl: url }));
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (res.status !== 200) return PROCEED;
    const data = await res.json().catch(() => null);
    if (!data || data.action !== 'stop' || typeof data.guidance !== 'string' || !data.guidance.trim()) return PROCEED;
    const guidance = data.guidance.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').slice(0, 8192);
    return { stop: true, guidance };
  } catch {
    return PROCEED;
  }
}

/** CallToolResult 의 텍스트를 한 줄로. */
export function resultText(result) {
  return (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}
