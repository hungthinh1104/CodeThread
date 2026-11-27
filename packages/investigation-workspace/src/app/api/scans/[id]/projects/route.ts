import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../../../server/http.ts';
import { getScanProjects } from '../../../../../server/scan-admin-bff.ts';

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
    return jsonResponse(await getScanProjects(id));
  } catch (error) {
    return errorResponse(error);
  }
}
