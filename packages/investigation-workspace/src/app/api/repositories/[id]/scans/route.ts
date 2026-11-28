import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../../../server/http.ts';
import {
  listBackendRepositoryScans,
  submitBackendScan,
} from '../../../../../server/backend-client.ts';
import { parseRequestJson } from '../../../../../server/workspace-bff.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    if (!trustedLocalRequest(request, false)) return forbiddenResponse();
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
    const { id } = await context.params;
    return jsonResponse(await listBackendRepositoryScans(id));
  } catch (error) {
    return errorResponse(error);
  }
}

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
    const { id } = await context.params;
    const body = await parseRequestJson(request);
    return jsonResponse({ scan: await submitBackendScan(id, body) });
  } catch (error) {
    return errorResponse(error);
  }
}
