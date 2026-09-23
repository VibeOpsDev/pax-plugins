/**
 * 원격 브리지(`/api/local-ai/mcp`) 호출 — 프록시(JSON-RPC 그대로 전달)와 스크립트(`callTool`)가 공유.
 * 서버는 `enableJsonResponse=true` 라 보통 JSON 이지만 SSE 형식이면 `data:` 라인에서 추출(방어적).
 */

export const PLUGIN_VERSION_HEADER = 'X-Pax-Plugin-Version';
/**
 * 인스턴스 접미사 헤더 — 서버가 "이 클라이언트는 어느 이름(`pax` / `pax-<id>`)으로 설치된 플러그인인가" 를 아는 유일한 신호(2.0.0).
 * 발행 시 아래 placeholder 가 접미사(예 `sp`) 또는 빈 문자열로 치환된다. 빈 값(원본 이름)·미치환 개발본은 보내지 않는다 —
 * 서버는 헤더 부재 = 원본 이름으로 읽고, 자기 접미사와 다르면 재설치 안내를 붙인다.
 */
export const PLUGIN_ID_HEADER = 'X-Pax-Plugin-Id';
const PLUGIN_ID_RAW = 'preview';
export const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(PLUGIN_ID_RAW) && PLUGIN_ID_RAW.length <= 12 ? PLUGIN_ID_RAW : '';

/** JSON-RPC 본문 POST → { status, data } (data 는 파싱된 JSON-RPC 응답 또는 null). 네트워크 예외는 throw. */
export async function postJsonRpc(mcpUrl, token, body, { pluginVersion, timeoutMs = 30_000 } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (pluginVersion) headers[PLUGIN_VERSION_HEADER] = String(pluginVersion).replace(/[^\x20-\x7E]/g, '').slice(0, 32);
  if (PLUGIN_ID) headers[PLUGIN_ID_HEADER] = PLUGIN_ID;
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
  if (status === 401) return { ok: false, status, message: 'PAX 인증이 만료/취소되었습니다. /pax-preview:connect 로 다시 연결하세요.' };
  if (data && data.result) return { ok: true, result: data.result };
  if (data && data.error && typeof data.error.message === 'string') return { ok: false, status, message: data.error.message };
  return { ok: false, status, message: `PAX 서버 오류 (HTTP ${status})` };
}

/** CallToolResult 의 텍스트를 한 줄로. */
export function resultText(result) {
  return (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}
