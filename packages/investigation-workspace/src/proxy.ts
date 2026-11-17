import { NextResponse, type NextRequest } from 'next/server';
import { workspaceOrigin } from './server/http.ts';

function securityHeaders(response: NextResponse, policy: string): NextResponse {
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.delete('X-Powered-By');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  const development = process.env.NODE_ENV === 'development';
  const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-inline'" : ''}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "worker-src 'self'",
  ].join('; ');
  const expectedOrigin = workspaceOrigin();
  const expectedHost = new URL(expectedOrigin).host;
  const method = request.method.toUpperCase();
  const origin = request.headers.get('origin');
  const stateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (
    request.headers.get('host') !== expectedHost ||
    (origin !== null && origin !== expectedOrigin) ||
    (stateChanging && origin !== expectedOrigin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return securityHeaders(
      NextResponse.json(
        {
          error: {
            code: 'INVALID_ORIGIN',
            message: 'Local same-origin access is required.',
          },
        },
        { status: 403 },
      ),
      "default-src 'none'; frame-ancestors 'none'",
    );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return securityHeaders(response, policy);
}

export const config = { matcher: ['/:path*'] };
