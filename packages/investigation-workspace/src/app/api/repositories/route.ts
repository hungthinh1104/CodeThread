import {
  errorResponse,
  forbiddenResponse,
  jsonResponse,
  trustedLocalRequest,
} from '../../../server/http.ts';
import {
  createRepository,
  listRepositories,
} from '../../../server/scan-admin-bff.ts';
import { parseRequestJson } from '../../../server/upstream.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rejectQuery(request: Request): Response | null {
  return new URL(request.url).search
    ? jsonResponse(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Query parameters are not supported.',
          },
        },
        400,
      )
    : null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!trustedLocalRequest(request, false)) return forbiddenResponse();
    const rejected = rejectQuery(request);
    if (rejected) return rejected;
    return jsonResponse(await listRepositories());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!trustedLocalRequest(request, true)) return forbiddenResponse();
    const rejected = rejectQuery(request);
    if (rejected) return rejected;
    const payload = await parseRequestJson(request);
    return jsonResponse(await createRepository(payload));
  } catch (error) {
    return errorResponse(error);
  }
}
