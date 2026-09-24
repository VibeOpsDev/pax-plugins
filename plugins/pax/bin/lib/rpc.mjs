/**
 * 원격 브리지(`/api/local-ai/mcp`) 호출 — 프록시(JSON-RPC 그대로 전달)와 스크립트(`callTool`)가 공유.
 * 서버는 `enableJsonResponse=true` 라 보통 JSON 이지만 SSE 형식이면 `data:` 라인에서 추출(방어적).
 * 배포 보호 우회(프리뷰 인스턴스, 2026-09-23): 인스턴스 폴더의 `deployment-bypass.json` 이 있으면 **그 origin·https 로 나가는 요청에만**
 * `x-vercel-protection-bypass` 를 붙인다(`deploymentBypassHeaders`). 없으면 헤더 없음 = 종전 동작. Vercel 엣지의 보호 401 은
 * `isDeploymentProtected` 로 알아보고 전용 안내(`DEPLOYMENT_PROTECTED_MESSAGE`)를 낸다 — 앱의 401(인증 만료)과 다른 원인이라서.
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

/** CallToolResult 의 텍스트를 한 줄로. */
export function resultText(result) {
  return (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}
