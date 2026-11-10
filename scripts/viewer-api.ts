import { idSchema } from '@codethread/code-model';
import { z } from 'zod';
import type { ViewerDataset } from './viewer-dataset.ts';
import { querySnapshot } from './viewer-projection.ts';
import { ViewerFailure } from './viewer-errors.ts';

const projectId = z.string().min(1).max(64);
const envelope = z.strictObject({ projectId, request: z.unknown() });
const search = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(640000).default(0),
});
const followRequest = z.strictObject({
  snapshotId: idSchema,
  symbolId: idSchema,
});

export function queryViewer(
  dataset: ViewerDataset,
  pathname: string,
  body: unknown,
): unknown {
  if (pathname === '/api/projects') {
    z.strictObject({}).parse(body);
    return dataset.projects();
  }
  if (pathname === '/api/catalog') {
    const request = search.parse(body);
    return dataset.search(request.query, request.offset);
  }
  if (pathname === '/api/files') {
    const request = z
      .strictObject({ offset: z.number().int().min(0).max(2000).default(0) })
      .parse(body);
    return dataset.files(request.offset);
  }
  const scope = dataset.repository
    ? envelope.parse(body)
    : { projectId: 'selected', request: body };
  const { snapshot, investigation } = dataset.get(scope.projectId);
  if (pathname === '/api/follow-context') {
    const request = followRequest.parse(scope.request);
    return dataset.follow(
      scope.projectId,
      request.snapshotId,
      request.symbolId,
    );
  }
  if (pathname === '/api/symbols') {
    const request = search.parse(scope.request);
    if (
      request.offset >
      (snapshot.resourceProfile === 'repository' ? 20000 : 2000)
    )
      throw new ViewerFailure(
        'INVALID_REQUEST',
        'Symbol offset exceeds the selected resource profile.',
        400,
      );
  }
  const result = querySnapshot(
    snapshot,
    investigation,
    pathname,
    scope.request,
  );
  return dataset.repository ? { projectId: scope.projectId, result } : result;
}
