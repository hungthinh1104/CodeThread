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
  parseOpenWorkspaceScan,
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
    const scanId = parseOpenWorkspaceScan(await parseRequestJson(request));
    const { sessionId, metadata } = await openWorkspace(
      scanId,
      sessionIdFromCookie(request, scanId),
    );
    return jsonResponse({ workspace: metadata }, 200, {
      'set-cookie': sessionCookie(scanId, sessionId, metadata.expiresAt),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
