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
  WorkspaceBffError,
  workspaceMetadata,
  workspaceScanIdSchema,
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
    const scan = workspaceScanIdSchema.safeParse(
      request.headers.get('x-codethread-scan-id'),
    );
    if (!scan.success)
      throw new WorkspaceBffError(
        400,
        'INVALID_REQUEST',
        'A valid workspace scan identity is required.',
      );
    const payload = await parseRequestJson(request);
    const sessionId = sessionIdFromCookie(request, scan.data);
    if (path[0] === 'meta') {
      if (!z.strictObject({}).safeParse(payload).success)
        throw new WorkspaceBffError(
          400,
          'INVALID_REQUEST',
          'Workspace metadata requires an empty request object.',
        );
      return jsonResponse({
        workspace: await workspaceMetadata(sessionId, scan.data),
      });
    }
    return jsonResponse(
      await forwardViewerOperation(sessionId, scan.data, path[0]!, payload),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
