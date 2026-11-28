import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../../../server/http.ts';
import { cancelBackendScan } from '../../../../../server/backend-client.ts';

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
    return jsonResponse({ scan: await cancelBackendScan(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
