import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../server/http.ts';
import { systemHealth } from '../../../server/scan-admin-bff.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
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
    return jsonResponse(await systemHealth());
  } catch (error) {
    return errorResponse(error);
  }
}
