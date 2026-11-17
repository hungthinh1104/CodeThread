import { z } from 'zod';
import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  sessionIdFromCookie,
  trustedLocalRequest,
} from '../../../../server/http.ts';
import {
  forwardViewerOperation,
  parseRequestJson,
  workspaceMetadata,
} from '../../../../server/workspace-bff.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
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
    const { path } = await context.params;
    if (path.length !== 1)
      return jsonResponse(
        {
          error: {
            code: 'WORKSPACE_OPERATION_NOT_FOUND',
            message: 'The requested operation is not available.',
          },
        },
        404,
      );
    const payload = await parseRequestJson(request);
    const sessionId = sessionIdFromCookie(request);
    if (path[0] === 'meta') {
      z.strictObject({}).parse(payload);
      return jsonResponse({ workspace: await workspaceMetadata(sessionId) });
    }
    return jsonResponse(
      await forwardViewerOperation(sessionId, path[0]!, payload),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
