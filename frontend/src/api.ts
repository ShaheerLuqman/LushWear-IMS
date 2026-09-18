// API base URL, auth token storage, and the fetch wrapper every component
// calls directly. Replaces config.js + the auth pieces of utils.js/app-core.js -
// as a plain module now (not a window.fetch monkey-patch), since there are no
// more classic scripts left that need to see a patched global fetch.

const LOCAL_API = 'http://127.0.0.1:8000/api';
const PROD_API = 'https://v1--lushwear-ims--44bb74tlkh9m.code.run/api';

const host = window.location.hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
export const API_BASE = isLocal ? LOCAL_API : PROD_API;

const AUTH_TOKEN_KEY = 'lushwear_auth_token';

export function getAuthToken(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function isAuthBootstrapUrl(path: string): boolean {
  // auth/login and auth/bootstrap are the login itself; their 401s are handled
  // locally (wrong password) rather than treated as an expired session.
  return path.startsWith('/auth/login') || path.startsWith('/auth/bootstrap');
}

/** Registered once by AuthProvider so this module can report a 401 without depending on React. */
let onAuthExpired: (() => void) | null = null;
export function setOnAuthExpired(handler: (() => void) | null): void {
  onAuthExpired = handler;
}

/** Pull a displayable message out of a FastAPI error body. */
export function apiErrorMessage(body: any, fallback: string): string {
  const detail = body && body.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d: any) => (typeof d === 'string' ? d : d.msg || JSON.stringify(d))).join(' ');
  }
  return fallback;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ApiRequestOptions extends RequestInit {
  fallback?: string;
}

/**
 * Fetch `path` (relative to API_BASE), attaching the auth token, and throw a
 * normalised ApiError on failure. Returns the raw Response - callers read
 * .json()/.blob()/.headers themselves.
 */
export async function apiRequest(path: string, { fallback = 'Request failed', ...options }: ApiRequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer ' + token);
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (response.status === 401 && !isAuthBootstrapUrl(path)) {
    onAuthExpired?.();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(apiErrorMessage(body, `${fallback} (${response.status})`), response.status);
  }
  return response;
}

export interface ApiJsonOptions extends Omit<ApiRequestOptions, 'body'> {
  body?: unknown;
}

/** JSON-in/JSON-out wrapper around apiRequest. Pass `body` to send it as JSON. */
export async function apiJson<T = any>(path: string, { body, ...options }: ApiJsonOptions = {}): Promise<T> {
  const opts: ApiRequestOptions = { ...options };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> || {}) };
    opts.body = JSON.stringify(body);
  }
  const response = await apiRequest(path, opts);
  if (response.status === 204) return null as T;
  return response.json();
}

/** POSTs `body` as JSON and yields each newline-delimited JSON object as it streams
 * in, rather than waiting for the whole body. Used by endpoints that report progress
 * incrementally (POST /orders/fulfill books parcels one at a time). */
export async function* apiJsonStream<T = any>(path: string, { body, fallback = 'Request failed', ...options }: ApiJsonOptions = {}): AsyncGenerator<T> {
  const response = await apiRequest(path, {
    method: 'POST',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> || {}) },
    body: JSON.stringify(body),
    fallback,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail);
}
