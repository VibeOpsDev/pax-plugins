#!/usr/bin/env node
/**
 * 루프백 리스너 — `/pax-preview:connect` 가 띄우는 **이중 fork 분리 프로세스**(2.0.0).
 *
 * Claude Code 는 Esc 취소·TaskStop 시 ppid 트리 전체를 SIGKILL 하므로(`tree-kill`) `detached` 만으로는 못 살아남는다.
 * `--spawn` 이 `--serve` 를 detached 로 띄우고 즉시 exit(리스너 ppid → launchd/init 재부모화). `--serve` 는 중간 프로세스의
 * stdout/stderr(= connect 가 연 `listener-<nonce8>.log`)를 그대로 물려받아 import 오류·크래시가 로그에 남는다.
 *
 * `--serve`: 127.0.0.1 임의 포트에 `GET /connect?code&nonce` 하나만 받는다. Host 가 `127.0.0.1:<port>` 인지·nonce timingSafeEqual —
 * 불일치는 404 로 답하고 **계속 대기**, 유효 요청 1회만. 수신 → 교환 POST(코드만 — 신원 증명은 PAX 로그인 쪽) → 토큰 파일 저장 →
 * 상태 `done` → 그 뒤에 응답. 응답은 쿼리·헤더를 렌더하지 않는 정적 HTML(no-store·nosniff·외부 자원 없음).
 * 요청 처리 중 예외는 404(교환 전)·500(교환 후) 로 답하고 프로세스는 살려 둔다(비동기 핸들러 거부가 프로세스를 죽이지 않게).
 * 수명 600s(로그인·MFA 왕복 포함) → `failed(timeout)`, SIGTERM → `failed(superseded)`.
 * 상태 파일 `<instanceDir>/pending-<nonce8>.json` 을 전경(`--wait`)이 폴링한다. `--url` 로 받은 연결 주소 템플릿(`{port}` 슬롯)은
 * 포트를 채워 상태 파일 `url` 에 보관 — 전경이 **이어 붙을 때** 다시 보여 준다. 상태 파일에 연결 코드·토큰은 절대 넣지 않는다.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, writeProjectToken, writeFolderBinding } from './lib/store.mjs';
import { PLUGIN_VERSION_HEADER } from './lib/rpc.mjs';

const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';
const PLUGIN_VERSION = '2.0.0';
const LIFETIME_MS = 600_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const mode = process.argv.includes('--serve') ? 'serve' : process.argv.includes('--spawn') ? 'spawn' : null;
const nonce = arg('--nonce');
const statePath = arg('--state');
const previousJti = arg('--previous-jti') || null;
const urlTemplate = arg('--url') || null;
// remote 없는 폴더에서 시작한 연결 — 교환 성공 시 이 폴더 ↔ 고른 프로젝트를 묶는다(connect 스크립트가 done 을 10분 안에 소비하지 못해도 바인딩은 남는다).
const bindDir = arg('--bind-dir') || null;
const exp = Number(arg('--exp')) || Date.now() + LIFETIME_MS;

if (!mode || !nonce || !statePath) {
  process.stderr.write('usage: vibeagent-connect-listener.mjs --spawn|--serve --nonce <n> --state <file> [--exp ms] [--previous-jti jti] [--url template] [--bind-dir dir]\n');
  process.exit(2);
}

if (mode === 'spawn') {
  const self = fileURLToPath(import.meta.url);
  // stdout/stderr 는 중간 프로세스가 받은 로그 fd 를 그대로 물려준다(`ignore` 면 로그가 항상 0 바이트).
  const child = spawn(process.execPath, [self, '--serve', ...process.argv.slice(3)], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  process.exit(0);
}

// ─── serve ────────────────────────────────────────────────────────────────
const state = { status: 'starting', pid: process.pid, port: null, url: null, started: Date.now(), exp, message: null, result: null };
function saveState(patch) {
  Object.assign(state, patch);
  try { writeJsonAtomic(statePath, state); } catch { /* 상태 파일 실패는 치명 아님 */ }
}

/**
 * 응답 페이지 — 인자는 **상수 문자열만**(요청 데이터를 절대 넣지 않는다). 외부 자원 0(CSS 인라인·아이콘은 인라인 SVG).
 * 색·크기는 PAX design-rules §3~§5 토큰 값을 인라인 변수로 옮긴 것(별도 오리진 127.0.0.1 이라 globals.css 를 못 읽는다).
 * 다크는 PAX 의 `html[data-theme]` 스위치가 이 오리진에 없어 `prefers-color-scheme` 으로만 판정한다(규칙 §7 의 의도적 이탈).
 * tone: ok(성공) · error(교환 실패) · warn(대기 중 잘못된 요청 — 계속 기다린다).
 */
const ICONS = {
  ok: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  warn: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
};
// pable 워드마크 — src/components/brand/BrandLogo.tsx 의 사본(디자인 지침: 브랜드 컴포넌트는 수정 없이 사용). 연결 페이지 눈썹 줄과 같은 16px.
// 리스너 페이지는 오프라인에서도 떠야 하므로 외부 이미지 대신 인라인 SVG. 그라디언트 id 는 페이지에 한 번만 렌더돼 고정값. path 데이터는 selfcheck 가 원본과 대조한다.
const BRAND_SVG = '<svg role="img" aria-label="pable studio" height="16" viewBox="0 0 301 54" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;color:var(--label)" ><path d="M285.904 42.97C282.988 42.97 280.414 42.34 278.182 41.08C275.95 39.784 274.186 38.02 272.89 35.788C271.63 33.52 271 30.928 271 28.012C271 25.06 271.63 22.468 272.89 20.236C274.186 17.968 275.95 16.204 278.182 14.944C280.414 13.648 282.988 13 285.904 13C288.784 13 291.34 13.648 293.572 14.944C295.804 16.204 297.55 17.968 298.81 20.236C300.106 22.468 300.754 25.06 300.754 28.012C300.754 30.928 300.124 33.52 298.864 35.788C297.604 38.02 295.858 39.784 293.626 41.08C291.394 42.34 288.82 42.97 285.904 42.97ZM285.904 38.11C287.776 38.11 289.432 37.678 290.872 36.814C292.312 35.95 293.428 34.762 294.22 33.25C295.048 31.738 295.462 29.992 295.462 28.012C295.462 26.032 295.048 24.286 294.22 22.774C293.428 21.226 292.312 20.02 290.872 19.156C289.432 18.292 287.776 17.86 285.904 17.86C284.032 17.86 282.376 18.292 280.936 19.156C279.496 20.02 278.362 21.226 277.534 22.774C276.706 24.286 276.292 26.032 276.292 28.012C276.292 29.992 276.706 31.738 277.534 33.25C278.362 34.762 279.496 35.95 280.936 36.814C282.376 37.678 284.032 38.11 285.904 38.11Z" fill="currentColor"/><path d="M264.564 42.472C263.772 42.472 263.106 42.22 262.566 41.716C262.062 41.176 261.81 40.51 261.81 39.718V15.688C261.81 14.86 262.062 14.194 262.566 13.69C263.106 13.186 263.772 12.934 264.564 12.934C265.392 12.934 266.058 13.186 266.562 13.69C267.066 14.194 267.318 14.86 267.318 15.688V39.718C267.318 40.51 267.066 41.176 266.562 41.716C266.058 42.22 265.392 42.472 264.564 42.472ZM264.564 8.128C263.592 8.128 262.746 7.786 262.026 7.102C261.342 6.382 261 5.536 261 4.564C261 3.592 261.342 2.764 262.026 2.08C262.746 1.36 263.592 1 264.564 1C265.536 1 266.364 1.36 267.048 2.08C267.768 2.764 268.128 3.592 268.128 4.564C268.128 5.536 267.768 6.382 267.048 7.102C266.364 7.786 265.536 8.128 264.564 8.128Z" fill="currentColor"/><path d="M241.904 43.39C239.096 43.39 236.558 42.742 234.29 41.446C232.058 40.114 230.276 38.314 228.944 36.046C227.648 33.778 227 31.222 227 28.378C227 25.534 227.594 22.996 228.782 20.764C230.006 18.496 231.662 16.714 233.75 15.418C235.838 14.086 238.196 13.42 240.824 13.42C242.948 13.42 244.91 13.87 246.71 14.77C248.51 15.634 250.022 16.822 251.246 18.334V3.754C251.246 2.926 251.498 2.26 252.002 1.756C252.542 1.252 253.208 1 254 1C254.828 1 255.494 1.252 255.998 1.756C256.502 2.26 256.754 2.926 256.754 3.754V28.378C256.754 31.222 256.088 33.778 254.756 36.046C253.46 38.314 251.696 40.114 249.464 41.446C247.232 42.742 244.712 43.39 241.904 43.39ZM241.904 38.53C243.74 38.53 245.378 38.098 246.818 37.234C248.258 36.334 249.392 35.11 250.22 33.562C251.048 32.014 251.462 30.286 251.462 28.378C251.462 26.434 251.048 24.706 250.22 23.194C249.392 21.682 248.258 20.494 246.818 19.63C245.378 18.73 243.74 18.28 241.904 18.28C240.104 18.28 238.466 18.73 236.99 19.63C235.55 20.494 234.398 21.682 233.534 23.194C232.706 24.706 232.292 26.434 232.292 28.378C232.292 30.286 232.706 32.014 233.534 33.562C234.398 35.11 235.55 36.334 236.99 37.234C238.466 38.098 240.104 38.53 241.904 38.53Z" fill="currentColor"/><path d="M208.971 41.862C206.487 41.862 204.255 41.34 202.275 40.296C200.331 39.216 198.783 37.65 197.631 35.598C196.515 33.546 195.957 31.026 195.957 28.038V14.754C195.957 13.962 196.209 13.314 196.713 12.81C197.253 12.27 197.919 12 198.711 12C199.503 12 200.151 12.27 200.655 12.81C201.195 13.314 201.465 13.962 201.465 14.754V28.038C201.465 30.054 201.843 31.728 202.599 33.06C203.355 34.356 204.381 35.328 205.677 35.976C206.973 36.588 208.431 36.894 210.051 36.894C211.599 36.894 212.967 36.588 214.155 35.976C215.379 35.364 216.351 34.536 217.071 33.492C217.791 32.448 218.151 31.278 218.151 29.982H221.553C221.553 32.214 220.995 34.23 219.879 36.03C218.799 37.83 217.305 39.252 215.397 40.296C213.525 41.34 211.383 41.862 208.971 41.862ZM220.905 41.592C220.113 41.592 219.447 41.34 218.907 40.836C218.403 40.296 218.151 39.63 218.151 38.838V14.754C218.151 13.926 218.403 13.26 218.907 12.756C219.447 12.252 220.113 12 220.905 12C221.733 12 222.399 12.252 222.903 12.756C223.407 13.26 223.659 13.926 223.659 14.754V38.838C223.659 39.63 223.407 40.296 222.903 40.836C222.399 41.34 221.733 41.592 220.905 41.592Z" fill="currentColor"/><path d="M190.323 41.934C188.523 41.934 186.903 41.484 185.463 40.584C184.023 39.648 182.889 38.388 182.061 36.804C181.233 35.22 180.819 33.438 180.819 31.458V5.7C180.819 4.908 181.071 4.26 181.575 3.756C182.079 3.252 182.727 3 183.519 3C184.311 3 184.959 3.252 185.463 3.756C185.967 4.26 186.219 4.908 186.219 5.7V31.458C186.219 32.898 186.615 34.104 187.407 35.076C188.199 36.048 189.171 36.534 190.323 36.534H192.159C192.807 36.534 193.347 36.786 193.779 37.29C194.247 37.794 194.481 38.442 194.481 39.234C194.481 40.026 194.175 40.674 193.563 41.178C192.987 41.682 192.231 41.934 191.295 41.934H190.323ZM178.335 18.12C177.579 18.12 176.967 17.904 176.499 17.472C176.031 17.04 175.797 16.5 175.797 15.852C175.797 15.132 176.031 14.556 176.499 14.124C176.967 13.692 177.579 13.476 178.335 13.476H190.809C191.565 13.476 192.177 13.692 192.645 14.124C193.113 14.556 193.347 15.132 193.347 15.852C193.347 16.5 193.113 17.04 192.645 17.472C192.177 17.904 191.565 18.12 190.809 18.12H178.335Z" fill="currentColor"/><path d="M163.703 41.97C161.183 41.97 158.843 41.592 156.683 40.836C154.559 40.044 152.903 39.054 151.715 37.866C151.175 37.29 150.941 36.642 151.013 35.922C151.121 35.166 151.481 34.554 152.093 34.086C152.813 33.51 153.515 33.276 154.199 33.384C154.919 33.456 155.531 33.762 156.035 34.302C156.647 34.986 157.619 35.634 158.951 36.246C160.319 36.822 161.831 37.11 163.487 37.11C165.575 37.11 167.159 36.768 168.239 36.084C169.355 35.4 169.931 34.518 169.967 33.438C170.003 32.358 169.481 31.422 168.401 30.63C167.357 29.838 165.431 29.19 162.623 28.686C158.987 27.966 156.341 26.886 154.685 25.446C153.065 24.006 152.255 22.242 152.255 20.154C152.255 18.318 152.795 16.806 153.875 15.618C154.955 14.394 156.341 13.494 158.033 12.918C159.725 12.306 161.489 12 163.325 12C165.701 12 167.807 12.378 169.643 13.134C171.479 13.89 172.937 14.934 174.017 16.266C174.521 16.842 174.755 17.454 174.719 18.102C174.683 18.714 174.377 19.236 173.801 19.668C173.225 20.064 172.541 20.19 171.749 20.046C170.957 19.902 170.291 19.578 169.751 19.074C168.851 18.21 167.879 17.616 166.835 17.292C165.791 16.968 164.585 16.806 163.217 16.806C161.633 16.806 160.283 17.076 159.167 17.616C158.087 18.156 157.547 18.948 157.547 19.992C157.547 20.64 157.709 21.234 158.033 21.774C158.393 22.278 159.077 22.746 160.085 23.178C161.093 23.574 162.569 23.97 164.513 24.366C167.213 24.906 169.337 25.59 170.885 26.418C172.469 27.246 173.603 28.218 174.287 29.334C174.971 30.414 175.313 31.674 175.313 33.114C175.313 34.77 174.863 36.264 173.963 37.596C173.099 38.928 171.803 39.99 170.075 40.782C168.383 41.574 166.259 41.97 163.703 41.97Z" fill="currentColor"/><path d="M125.622 41.2195C122.736 41.9928 120 42.0738 117.414 41.4624C114.853 40.8068 112.64 39.5735 110.776 37.7623C108.937 35.907 107.64 33.571 106.885 30.7544C106.121 27.903 106.042 25.2409 106.646 22.7682C107.276 20.2513 108.489 18.1002 110.284 16.3148C112.07 14.4945 114.336 13.2164 117.083 12.4803C119.796 11.7536 122.288 11.7378 124.562 12.4331C126.826 13.0936 128.746 14.3494 130.323 16.2003C131.925 18.0072 133.095 20.2842 133.831 23.0313C134.008 23.692 133.931 24.3089 133.6 24.8821C133.26 25.4205 132.742 25.7829 132.046 25.9692L111.026 31.6016L109.908 27.4288L130.772 21.8384L129.024 23.8719C128.524 22.1425 127.761 20.6883 126.737 19.5091C125.704 18.2952 124.472 17.4515 123.04 16.9778C121.609 16.5041 120.024 16.5002 118.285 16.9661C116.303 17.4972 114.716 18.3884 113.523 19.6398C112.365 20.8818 111.626 22.3656 111.305 24.0913C110.976 25.7823 111.067 27.584 111.58 29.4965C112.092 31.4091 112.983 32.9965 114.253 34.2588C115.523 35.5211 117.04 36.382 118.803 36.8413C120.566 37.3007 122.438 37.2648 124.42 36.7337C125.498 36.4449 126.543 35.9601 127.553 35.2795C128.589 34.5547 129.384 33.8383 129.94 33.1304C130.359 32.6081 130.864 32.2678 131.455 32.1094C132.072 31.9069 132.657 31.9364 133.212 32.1977C133.943 32.5609 134.41 33.0508 134.612 33.6674C134.815 34.284 134.681 34.8976 134.211 35.508C133.28 36.7637 132.007 37.9247 130.392 38.991C128.812 40.0481 127.222 40.7909 125.622 41.2195Z" fill="currentColor"/><path d="M104.1 42.174C102.516 42.174 101.112 41.742 99.888 40.878C98.664 40.014 97.71 38.844 97.026 37.368C96.342 35.856 96 34.128 96 32.184V2.7C96 1.908 96.252 1.26 96.756 0.756C97.26 0.252 97.908 0 98.7 0C99.492 0 100.14 0.252 100.644 0.756C101.148 1.26 101.4 1.908 101.4 2.7V32.184C101.4 33.516 101.652 34.614 102.156 35.478C102.66 36.342 103.308 36.774 104.1 36.774H105.45C106.17 36.774 106.746 37.026 107.178 37.53C107.646 38.034 107.88 38.682 107.88 39.474C107.88 40.266 107.538 40.914 106.854 41.418C106.17 41.922 105.288 42.174 104.208 42.174H104.1Z" fill="currentColor"/><path d="M78.85 43.39C76.042 43.39 73.522 42.742 71.29 41.446C69.058 40.114 67.294 38.314 65.998 36.046C64.702 33.778 64.036 31.222 64 28.378V3.754C64 2.926 64.252 2.26 64.756 1.756C65.296 1.252 65.962 1 66.754 1C67.582 1 68.248 1.252 68.752 1.756C69.256 2.26 69.508 2.926 69.508 3.754V18.334C70.768 16.822 72.28 15.634 74.044 14.77C75.844 13.87 77.806 13.42 79.93 13.42C82.558 13.42 84.916 14.086 87.004 15.418C89.092 16.714 90.73 18.496 91.918 20.764C93.142 22.996 93.754 25.534 93.754 28.378C93.754 31.222 93.088 33.778 91.756 36.046C90.46 38.314 88.696 40.114 86.464 41.446C84.232 42.742 81.694 43.39 78.85 43.39ZM78.85 38.53C80.686 38.53 82.324 38.098 83.764 37.234C85.204 36.334 86.338 35.11 87.166 33.562C88.03 32.014 88.462 30.286 88.462 28.378C88.462 26.434 88.03 24.706 87.166 23.194C86.338 21.682 85.204 20.494 83.764 19.63C82.324 18.73 80.686 18.28 78.85 18.28C77.05 18.28 75.412 18.73 73.936 19.63C72.496 20.494 71.362 21.682 70.534 23.194C69.706 24.706 69.292 26.434 69.292 28.378C69.292 30.286 69.706 32.014 70.534 33.562C71.362 35.11 72.496 36.334 73.936 37.234C75.412 38.098 77.05 38.53 78.85 38.53Z" fill="currentColor"/><path d="M2.754 53.8099C1.962 53.8099 1.296 53.5399 0.756 52.9999C0.252 52.4959 0 51.8479 0 51.0559V26.4319C0.0360001 23.5879 0.702 21.0319 1.998 18.7639C3.294 16.4959 5.058 14.7139 7.29 13.4179C9.522 12.0859 12.042 11.4199 14.85 11.4199C17.694 11.4199 20.232 12.0859 22.464 13.4179C24.696 14.7139 26.46 16.4959 27.756 18.7639C29.088 21.0319 29.754 23.5879 29.754 26.4319C29.754 29.2759 29.142 31.8319 27.918 34.0999C26.73 36.3319 25.092 38.1139 23.004 39.4459C20.916 40.7419 18.558 41.3899 15.93 41.3899C13.806 41.3899 11.844 40.9579 10.044 40.0939C8.28 39.1939 6.768 37.9879 5.508 36.4759V51.0559C5.508 51.8479 5.256 52.4959 4.752 52.9999C4.248 53.5399 3.582 53.8099 2.754 53.8099ZM14.85 36.5299C16.686 36.5299 18.324 36.0979 19.764 35.2339C21.204 34.3339 22.338 33.1279 23.166 31.6159C24.03 30.0679 24.462 28.3399 24.462 26.4319C24.462 24.4879 24.03 22.7599 23.166 21.2479C22.338 19.6999 21.204 18.4939 19.764 17.6299C18.324 16.7299 16.686 16.2799 14.85 16.2799C13.05 16.2799 11.412 16.7299 9.936 17.6299C8.496 18.4939 7.362 19.6999 6.534 21.2479C5.706 22.7599 5.292 24.4879 5.292 26.4319C5.292 28.3399 5.706 30.0679 6.534 31.6159C7.362 33.1279 8.496 34.3339 9.936 35.2339C11.412 36.0979 13.05 36.5299 14.85 36.5299Z" fill="currentColor"/><path d="M39.8399 14.1957C42.4651 13.0293 45.3734 12.6547 48.2084 13.1178L48.2038 13.1439C50.1621 13.5631 51.5688 15.4152 51.4313 17.5348C51.2805 19.8577 49.3325 21.6222 47.0802 21.4763C46.8222 21.4596 46.5713 21.4174 46.3297 21.3543C45.2794 21.2713 44.2219 21.45 43.2541 21.88C42.1252 22.3815 41.1672 23.2026 40.4979 24.2408C39.8287 25.2788 39.4771 26.4896 39.4861 27.7246C39.4952 28.9598 39.8644 30.166 40.549 31.1942C41.2336 32.2224 42.2042 33.0286 43.3403 33.5135C44.4763 33.9981 45.7295 34.1405 46.9454 33.9234C48.1613 33.7062 49.2876 33.1388 50.1857 32.2908C51.0838 31.4427 51.7148 30.3503 52.0013 29.1488L60.1812 31.0992C59.5151 33.8934 58.0479 36.4326 55.9594 38.4048C53.8707 40.377 51.2514 41.6975 48.4235 42.2024C45.5955 42.7074 42.6811 42.3752 40.0389 41.2477C37.3969 40.1201 35.1412 38.2456 33.5492 35.8545C31.9572 33.4634 31.098 30.6595 31.0768 27.787C31.0556 24.9144 31.8738 22.0984 33.4303 19.684C34.9869 17.2696 37.2146 15.3621 39.8399 14.1957Z" fill="url(#pable-logo-a-ring)"/><path d="M55.9118 40.8157C49.6346 36.0636 50.8231 25.0739 52.2093 19.4988C52.7934 17.1499 53.7687 14.9784 56.0716 14.2258C58.7298 13.357 63.6219 14.9867 62.0489 19.4574C59.1133 27.8013 61.9585 34.9103 62.9708 37.1683C63.9493 41.4905 59.3714 43.4349 55.9118 40.8157Z" fill="url(#pable-logo-a-blob)"/><defs><linearGradient id="pable-logo-a-ring" x1="27.9997" y1="16.1102" x2="47.4384" y2="35.5571" gradientUnits="userSpaceOnUse"><stop stop-color="#2BC2F4"/><stop offset="0.55" stop-color="#587CFA"/><stop offset="1" stop-color="#7E91FF"/></linearGradient><linearGradient id="pable-logo-a-blob" x1="48.5754" y1="18.8579" x2="64.8654" y2="27.7567" gradientUnits="userSpaceOnUse"><stop stop-color="#5E6BF3"/><stop offset="1" stop-color="#5CC3F7"/></linearGradient></defs></svg>';
const PAGE_CSS =
  ':root{--bg:#fff;--surface:#fff;--label:#26282b;--neutral:#454c53;--assistive:#9ea4aa;--line:#e8ebed;--fill:#f7f8f9;--shadow:0 4px 16px rgba(0,0,0,.05);' +
  '--ok:#2e7d32;--ok-bg:#eef7f0;--ok-border:#c2e5c8;--err:#f95c5c;--err-bg:#fef2f2;--err-border:#fecaca;--warn:#b47a09;--warn-bg:#fef3c7;--warn-border:#fcd34d}' +
  '@media(prefers-color-scheme:dark){:root{--bg:#232323;--surface:#282828;--label:#d8d8d8;--neutral:#9e9e9e;--assistive:#6b6b6b;--line:#3b3b3b;--fill:#2d2d2d;--shadow:0 4px 12px rgba(0,0,0,.4);' +
  '--ok:#4ade80;--ok-bg:rgba(74,222,128,.12);--ok-border:rgba(74,222,128,.32);--err:#f95c5c;--err-bg:rgba(248,113,113,.12);--err-border:rgba(248,113,113,.32);--warn:#fbbf24;--warn-bg:rgba(251,191,36,.12);--warn-border:rgba(251,191,36,.32)}}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:var(--bg);color:var(--label);-webkit-font-smoothing:antialiased}' +
  '.wrap{width:100%;max-width:480px}' +
  '.eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 12px 4px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--assistive)}' +
  '.eyebrow svg{height:16px;width:auto;flex-shrink:0}.eyebrow i{width:1px;height:12px;background:var(--line)}' +
  '.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:32px 24px;text-align:center}' +
  '.icon{width:48px;height:48px;margin:0 auto 16px;border-radius:999px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--fill);color:var(--neutral)}' +
  '.ok .icon{background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok)}.error .icon{background:var(--err-bg);border-color:var(--err-border);color:var(--err)}.warn .icon{background:var(--warn-bg);border-color:var(--warn-border);color:var(--warn)}' +
  'h1{margin:0 0 8px;font-size:24px;font-weight:600;line-height:1.3;letter-spacing:-.01em}' +
  'p{margin:0;font-size:14px;line-height:1.6;color:var(--neutral)}' +
  '.hint{margin-top:16px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--assistive)}' +
  '@media(max-width:768px){h1{font-size:20px}.card{padding:24px 16px;border-radius:12px}}';
const PAGE = (title, body, tone = 'warn', hint = '') =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} — PAX</title>` +
  `<style>${PAGE_CSS}</style></head>` +
  `<body><div class="wrap"><div class="eyebrow">${BRAND_SVG}<i></i><span>로컬 AI 연결</span></div>` +
  `<main class="card ${tone}"><div class="icon">${ICONS[tone] ?? ICONS.warn}</div><h1>${title}</h1><p>${body}</p>${hint ? `<p class="hint">${hint}</p>` : ''}</main>` +
  `</div></body></html>`;
const HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
// 도구 중립 문구 — 연결 페이지(ConnectClient)·모달과 같은 규칙: '로컬 AI' 통칭 + Claude/Codex 명령 병기(Codex 는 스킬 지목 `/pax-preview:pax-connect` — `/pax-preview:` 토큰이 발행 시 접미사 치환).
const RETRY_HINT = '로컬 AI 에서 연결을 다시 시작하세요 (Claude Code 는 /pax-preview:connect, Codex 는 /pax-preview:pax-connect).';
const nonceBuf = Buffer.from(nonce, 'utf8');

function deny(res, body = RETRY_HINT) {
  res.writeHead(404, HEADERS);
  res.end(PAGE('연결할 수 없음', body));
}
function finish() {
  setTimeout(() => { server.close(); process.exit(0); }, 300);
}

let handled = false;
async function handle(req, res) {
  let url;
  try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return deny(res); }
  const expectedHost = `127.0.0.1:${state.port}`;
  // 바이트 길이로 먼저 대조 — UTF-16 길이가 같아도 UTF-8 바이트 수가 다르면 timingSafeEqual 이 throw 한다.
  const nonceIn = Buffer.from(url.searchParams.get('nonce') ?? '', 'utf8');
  const nonceOk = nonceIn.length === nonceBuf.length && timingSafeEqual(nonceIn, nonceBuf);
  if (req.method !== 'GET' || url.pathname !== '/connect' || req.headers.host !== expectedHost || !nonceOk || handled) return deny(res);
  const code = url.searchParams.get('code') ?? '';
  if (!code || code.length > 256) return deny(res, RETRY_HINT);
  handled = true;
  saveState({ status: 'exchanging' });
  const outcome = await exchange(code);
  if (outcome.ok) {
    saveState({ status: 'done', result: outcome.result, message: null });
    res.writeHead(200, HEADERS);
    res.end(PAGE('연결됐어요', '로컬 AI 화면으로 돌아가면 준비가 이어져요.', 'ok', '이 탭은 닫아도 돼요.'));
  } else {
    saveState({ status: 'failed', message: outcome.message });
    res.writeHead(200, HEADERS);
    res.end(PAGE('연결하지 못했어요', '로컬 AI 화면으로 돌아가 안내를 확인하세요.', 'error'));
  }
  finish();
}
const server = http.createServer((req, res) => {
  const wasHandled = handled;
  handle(req, res).catch((e) => {
    try {
      if (res.headersSent) { res.end(); return; }
      if (handled && !wasHandled) {
        // 이 요청이 교환 단계까지 갔다가 터짐 — 코드는 이미 썼을 수 있으니 실패로 마감한다.
        saveState({ status: 'failed', message: `internal: ${e?.message ?? e}` });
        res.writeHead(500, HEADERS);
        res.end(PAGE('연결하지 못했어요', '로컬 AI 화면으로 돌아가 안내를 확인하세요.', 'error'));
        finish();
      } else {
        deny(res); // 교환 전 예외 — 계속 대기
      }
    } catch { /* 응답 실패는 무시 */ }
  });
});

const backoff = (attempt) => new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
async function exchange(code) {
  const exchangeUrl = MCP_URL.replace(/\/api\/local-ai\/mcp\/?$/, '/api/local-ai/token/exchange');
  let lastMessage = '연결 서버 응답이 없어요.';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res, data;
    try {
      res = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PLUGIN_VERSION_HEADER]: PLUGIN_VERSION.replace(/[^\x20-\x7E]/g, '').slice(0, 32) },
        body: JSON.stringify({ connectCode: code, ...(previousJti ? { previousJti } : {}) }),
        redirect: 'error', // 코드를 리다이렉트 대상에 다시 POST 하지 않는다
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      lastMessage = `network: ${e?.message ?? e}`;
      if (attempt < 2) await backoff(attempt);
      continue;
    }
    if (res.ok && typeof data.token === 'string' && typeof data.repoUrl === 'string') {
      try {
        const slug = writeProjectToken(MCP_URL, { token: data.token, expiresAt: data.expiresAt ?? null, scopes: data.scopes ?? [], jti: data.jti ?? null, repoUrl: data.repoUrl });
        if (bindDir) { try { writeFolderBinding(MCP_URL, bindDir, { slug, repoUrl: data.repoUrl }); } catch { /* connect 스크립트의 done 소비가 보조로 재기록 */ } }
        return { ok: true, result: { repoUrl: data.repoUrl, slug, jti: data.jti ?? null, scopes: data.scopes ?? [], expiresAt: data.expiresAt ?? null } };
      } catch (e) {
        // 토큰은 서버에서 이미 발급됐다 — 재시도하면 code_invalid 가 진짜 원인(로컬 저장 실패)을 가린다.
        return { ok: false, message: `store: 토큰 파일을 저장하지 못했어요(${e?.code ?? e?.message ?? e}). 설정 폴더(~/.config/vibeagent)의 권한을 확인한 뒤 /pax-preview:connect 를 다시 실행하세요.` };
      }
    }
    const codeName = typeof data.code === 'string' ? data.code : `http_${res.status}`;
    lastMessage = `${codeName}: ${typeof data.error === 'string' ? data.error : `연결 실패 (HTTP ${res.status})`}`;
    // 401/400/429 는 재시도 무의미(코드 소비·만료 등). 503 중 mint_failed 는 코드가 이미 소비돼 재시도가 code_invalid 로 진단을 덮는다.
    if (res.status !== 503 || codeName === 'mint_failed') return { ok: false, message: lastMessage };
    if (attempt < 2) await backoff(attempt);
  }
  return { ok: false, message: lastMessage };
}

server.on('error', (e) => {
  const sandbox = e?.code === 'EADDRNOTAVAIL' || e?.code === 'EPERM' || e?.code === 'EACCES';
  saveState({ status: 'failed', message: sandbox ? 'sandbox: 샌드박스 제한으로 보여요 — 터미널에서 직접 실행하세요.' : `listen: ${e?.message ?? e}` });
  process.exit(1);
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = urlTemplate ? urlTemplate.replace('{port}', String(port)) : null;
  saveState({ status: 'waiting', port, url });
});
setTimeout(() => {
  if (state.status === 'waiting' || state.status === 'starting') saveState({ status: 'failed', message: 'timeout: 시간이 지났어요. /pax-preview:connect 를 다시 실행하세요.' });
  server.close();
  process.exit(0);
}, Math.max(1000, exp - Date.now())).unref();
process.on('SIGTERM', () => {
  if (state.status === 'waiting') saveState({ status: 'failed', message: 'superseded: 새 연결이 시작돼 이전 대기를 정리했어요.' });
  server.close();
  process.exit(0);
});
