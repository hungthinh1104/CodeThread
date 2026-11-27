import {
  aiStatusResponseSchema,
  backendApiResponseSchemas,
  type AiStatusResponse,
} from '@codethread/contracts';
import { z } from 'zod';
import {
  WorkspaceBffError,
  workspaceRepositoryIdSchema,
  workspaceScanIdSchema,
} from './bff-types.ts';
import { backendRequest } from './upstream.ts';

const createRepositoryBodySchema = z.strictObject({
  locator: z.string().trim().min(1).max(4096),
});

const startScanBodySchema = z.strictObject({
  revision: z.string().trim().min(1).max(1024),
  idempotencyKey: z.string().trim().min(1).max(128),
});

const emptyObjectSchema = z.strictObject({});
const filesOffsetSchema = z.number().int().min(0).max(1256);

export type BackendHealthStatus = z.infer<
  (typeof backendApiResponseSchemas)['GET /v1/health']
>;

export type SanitizedRepository = {
  id: string;
  label: string;
  activeScanId: string | null;
  generation: string;
};

export type ScanStatusRecord = {
  id: string;
  repositoryId: string;
  generation: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  revision: string;
  commitId: string | null;
  treeId: string | null;
  activationResult: 'activated' | 'stale' | 'not_eligible' | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export function sanitizeRepositoryLabel(locator: string): string {
  return (
    locator
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/[\p{Cc}\p{Cf}]/gu, '\uFFFD')
      .slice(0, 120) || 'Local repository'
  );
}

function mapRepositoryRow(
  row: z.infer<(typeof backendApiResponseSchemas)['GET /v1/repositories/:id']>,
): SanitizedRepository {
  return {
    id: row.id,
    label: sanitizeRepositoryLabel(row.locator),
    activeScanId: row.active_job_id,
    generation: row.desired_generation,
  };
}

function mapScanRow(
  scan: z.infer<(typeof backendApiResponseSchemas)['GET /v1/scans/:id']>,
): ScanStatusRecord {
  return {
    id: scan.id,
    repositoryId: scan.repository_id,
    generation: scan.generation,
    state: scan.state,
    attempt: scan.attempt,
    revision: scan.revision_selector,
    commitId: scan.git_commit_oid,
    treeId: scan.git_tree_oid,
    activationResult: scan.activation_result,
    errorCode: scan.error_code,
    errorMessage: scan.error_message,
    createdAt: scan.created_at,
    updatedAt: scan.updated_at,
  };
}

export async function systemHealth(): Promise<{
  health: BackendHealthStatus;
  ai: AiStatusResponse;
}> {
  const [rawHealth, rawAi] = await Promise.all([
    backendRequest('GET /v1/health', '/v1/health', 'GET', {
      allowStatuses: [503],
    }),
    backendRequest('GET /v1/ai/status', '/v1/ai/status', 'GET').catch(() => ({
      enabled: false,
    })),
  ]);
  return {
    health: backendApiResponseSchemas['GET /v1/health'].parse(rawHealth),
    ai: aiStatusResponseSchema.parse(rawAi),
  };
}

export async function listRepositories(): Promise<{
  items: SanitizedRepository[];
}> {
  const rows = (await backendRequest(
    'GET /v1/repositories',
    '/v1/repositories',
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/repositories']>;
  return { items: rows.map(mapRepositoryRow) };
}

export async function getRepository(
  rawRepositoryId: string,
): Promise<{ repository: SanitizedRepository }> {
  const parsed = workspaceRepositoryIdSchema.safeParse(rawRepositoryId);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'A valid repository identifier is required.',
    );
  const row = (await backendRequest(
    'GET /v1/repositories/:id',
    `/v1/repositories/${parsed.data}`,
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/repositories/:id']>;
  if (row.id !== parsed.data)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned a different repository.',
    );
  return { repository: mapRepositoryRow(row) };
}

export async function createRepository(
  value: unknown,
): Promise<{ repository: SanitizedRepository }> {
  const parsed = createRepositoryBodySchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Provide a local Git repository path beneath the configured root.',
    );
  const created = (await backendRequest(
    'POST /v1/repositories',
    '/v1/repositories',
    'POST',
    { body: { locator: parsed.data.locator } },
  )) as z.infer<(typeof backendApiResponseSchemas)['POST /v1/repositories']>;
  return {
    repository: {
      id: created.id,
      label: sanitizeRepositoryLabel(created.locator),
      activeScanId: null,
      generation: '0',
    },
  };
}

export async function startRepositoryScan(
  rawRepositoryId: string,
  value: unknown,
) {
  const repoId = workspaceRepositoryIdSchema.safeParse(rawRepositoryId);
  const body = startScanBodySchema.safeParse(value);
  if (!repoId.success || !body.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Provide a valid repository, revision selector, and idempotency key.',
    );
  const accepted = (await backendRequest(
    'POST /v1/repositories/:id/scans',
    `/v1/repositories/${repoId.data}/scans`,
    'POST',
    { body: body.data },
  )) as z.infer<
    (typeof backendApiResponseSchemas)['POST /v1/repositories/:id/scans']
  >;
  if (accepted.repositoryId !== repoId.data)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend queued a scan for a different repository.',
    );
  return { scan: accepted };
}

export async function getScanStatus(
  rawScanId: string,
): Promise<{ scan: ScanStatusRecord }> {
  const parsed = workspaceScanIdSchema.safeParse(rawScanId);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'A valid scan identifier is required.',
    );
  const scan = (await backendRequest(
    'GET /v1/scans/:id',
    `/v1/scans/${parsed.data}`,
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/scans/:id']>;
  if (scan.id !== parsed.data)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned a different scan.',
    );
  return { scan: mapScanRow(scan) };
}

export async function cancelScanJob(rawScanId: string, value: unknown) {
  const scanId = workspaceScanIdSchema.safeParse(rawScanId);
  if (!scanId.success || !emptyObjectSchema.safeParse(value).success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Cancelling a scan requires a valid scan ID and an empty JSON body.',
    );
  const cancelled = (await backendRequest(
    'POST /v1/scans/:id/cancel',
    `/v1/scans/${scanId.data}/cancel`,
    'POST',
  )) as z.infer<
    (typeof backendApiResponseSchemas)['POST /v1/scans/:id/cancel']
  >;
  if (cancelled.id !== scanId.data)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend cancelled a different scan.',
    );
  return { scan: cancelled };
}

export async function getScanProjects(rawScanId: string) {
  const scanId = workspaceScanIdSchema.safeParse(rawScanId);
  if (!scanId.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'A valid scan identifier is required.',
    );
  const items = (await backendRequest(
    'GET /v1/scans/:id/projects',
    `/v1/scans/${scanId.data}/projects`,
    'GET',
  )) as z.infer<
    (typeof backendApiResponseSchemas)['GET /v1/scans/:id/projects']
  >;
  return { scanId: scanId.data, items };
}

export async function getScanFiles(
  rawScanId: string,
  offsetRaw: string | null,
) {
  const scanId = workspaceScanIdSchema.safeParse(rawScanId);
  if (!scanId.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'A valid scan identifier is required.',
    );
  const raw = offsetRaw === null ? 0 : Number(offsetRaw);
  if (
    (offsetRaw !== null && !/^(0|[1-9][0-9]*)$/.test(offsetRaw)) ||
    !filesOffsetSchema.safeParse(raw).success
  )
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'File offset must be an integer between 0 and 1256.',
    );
  const page = (await backendRequest(
    'GET /v1/scans/:id/files',
    `/v1/scans/${scanId.data}/files?offset=${raw}`,
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/scans/:id/files']>;
  return { scanId: scanId.data, ...page };
}
