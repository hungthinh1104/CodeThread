import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../../../server/http.ts';
import { getScanFiles } from '../../../../../server/scan-admin-bff.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    if (!trustedLocalRequest(request, false)) return forbiddenResponse();
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'offset') || keys.length > 1)
      return jsonResponse(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Only a single optional offset parameter is supported.',
          },
        },
        400,
      );
    const { id } = await context.params;
    return jsonResponse(await getScanFiles(id, url.searchParams.get('offset')));
  } catch (error) {
    return errorResponse(error);
  }
}
