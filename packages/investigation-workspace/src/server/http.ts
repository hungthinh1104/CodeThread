import { WorkspaceBffError } from './workspace-bff.ts';

const COOKIE_NAME = 'ct_workspace_session';

export function workspaceOrigin(): string {
  const rawPort = process.env.CODETHREAD_WORKSPACE_PORT ?? '3000';
  if (!/^\d{1,5}$/.test(rawPort))
    throw new Error('CODETHREAD_WORKSPACE_PORT must be a numeric port.');
  const port = Number(rawPort);
  if (port < 1 || port > 65535)
    throw new Error('CODETHREAD_WORKSPACE_PORT is outside the valid range.');
  return new URL(`http://127.0.0.1:${port}`).origin;
}

export function trustedLocalRequest(
  request: Request,
  requireOrigin: boolean,
): boolean {
  const origin = workspaceOrigin();
  if (request.headers.get('host') !== new URL(origin).host) return false;
  const requestOrigin = request.headers.get('origin');
  if (requireOrigin && requestOrigin !== origin) return false;
  if (requestOrigin && requestOrigin !== origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none'
  );
}

export function sessionIdFromCookie(
  request: Request,
  scanId: string,
): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === `${COOKIE_NAME}_${scanId}`) return valueParts.join('=');
  }
  return undefined;
}

export function sessionCookie(
  scanId: string,
  sessionId: string,
  expiresAt: string,
): string {
  const age = Math.max(
    0,
    Math.min(1800, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
  );
  return `${COOKIE_NAME}_${scanId}=${sessionId}; Path=/api/workspace; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof WorkspaceBffError)
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  return jsonResponse(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The local Investigation Workspace request failed.',
      },
    },
    500,
  );
}

export function forbiddenResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 'INVALID_ORIGIN',
        message: 'Local same-origin access is required.',
      },
    },
    403,
  );
}
