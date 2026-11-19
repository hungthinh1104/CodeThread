import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  sessionCookie,
  sessionIdFromCookie,
  trustedLocalRequest,
} from '../../../../server/http.ts';
import {
  openWorkspace,
  parseRequestJson,
} from '../../../../server/workspace-bff.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    if (!trustedLocalRequest(request, true)) return forbiddenResponse();
    if (new URL(request.url).search)
      return jsonResponse(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Query parameters are not supported.',
          },
        },
        400,
      );
    const { sessionId, metadata } = await openWorkspace(
      await parseRequestJson(request),
      sessionIdFromCookie(request),
    );
    return jsonResponse({ workspace: metadata }, 200, {
      'set-cookie': sessionCookie(sessionId, metadata.expiresAt),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
