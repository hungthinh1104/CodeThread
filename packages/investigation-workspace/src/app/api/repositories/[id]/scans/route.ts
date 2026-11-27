import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../../../server/http.ts';
import { startRepositoryScan } from '../../../../../server/scan-admin-bff.ts';
import { parseRequestJson } from '../../../../../server/upstream.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

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
    const payload = await parseRequestJson(request);
    return jsonResponse(await startRepositoryScan(id, payload));
  } catch (error) {
    return errorResponse(error);
  }
}
