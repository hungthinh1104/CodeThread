import { describe, expect, it } from 'vitest';
import { viewerApiResponseSchemas } from '../scripts/viewer-api.ts';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const symbol = {
  snapshotId: id,
  id,
  key: 'symbol:fixture',
  fileId: id,
  filePath: 'src/fixture.ts',
  name: 'fixture',
  kind: 'function',
  range: {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 1, line: 1, column: 2 },
  },
  declarationEvidenceId: id,
  evidenceIds: [id],
};
const catalogItem = {
  projectId: 'selected',
  projectLabel: 'Selected files',
  snapshotId: id,
  symbol,
};

describe('viewer response schema negative controls', () => {
  it('rejects unexpected fields and inconsistent page/source projections', () => {
    expect(
      viewerApiResponseSchemas['/api/projects'].safeParse({
        mode: 'repository',
        initialProjectId: null,
        repositoryId: id,
        commitId: null,
        source: null,
        items: [],
        rawDatabaseRow: true,
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/catalog'].safeParse({
        query: '',
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: 1,
        items: [catalogItem],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/catalog'].safeParse({
        query: '',
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [{ ...catalogItem, symbol: { ...symbol, snapshotId: otherId } }],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/catalog'].safeParse({
        query: '',
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [catalogItem, catalogItem],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/symbols'].safeParse({
        snapshotId: id,
        query: '',
        offset: 0,
        limit: 50,
        total: 100,
        nextOffset: 999,
        items: Array.from({ length: 50 }, () => symbol),
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/symbols'].safeParse({
        snapshotId: id,
        query: '',
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [{ ...symbol, snapshotId: otherId }],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/symbols'].safeParse({
        snapshotId: id,
        query: '',
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [symbol, symbol],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/files'].safeParse({
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [
          {
            path: 'vendor/linked.ts',
            sha256: 'a'.repeat(64),
            blobId: 'b'.repeat(40),
            byteLength: 1,
            status: 'excluded',
            analysisReason: 'Not a regular source blob.',
            projectIds: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/files'].safeParse({
        offset: 0,
        limit: 50,
        total: 1,
        nextOffset: null,
        items: [
          {
            path: 'src/first.ts',
            sha256: 'a'.repeat(64),
            byteLength: 1,
            status: 'analyzed',
            projectIds: ['selected'],
          },
          {
            path: 'src/second.ts',
            sha256: 'b'.repeat(64),
            byteLength: 1,
            status: 'analyzed',
            projectIds: ['selected'],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      viewerApiResponseSchemas['/api/files'].safeParse({
        offset: 0,
        limit: 50,
        total: 2,
        nextOffset: null,
        items: [
          {
            path: 'src/first.ts',
            sha256: 'a'.repeat(64),
            byteLength: 1,
            status: 'analyzed',
            projectIds: ['selected'],
          },
        ],
      }).success,
    ).toBe(false);
    for (const status of ['analyzed', 'not_analyzed'] as const)
      expect(
        viewerApiResponseSchemas['/api/files'].safeParse({
          offset: 0,
          limit: 50,
          total: 1,
          nextOffset: null,
          items: [
            {
              path: 'src/missing-provenance.ts',
              sha256: null,
              byteLength: null,
              status,
              projectIds: ['selected'],
            },
          ],
        }).success,
      ).toBe(false);
  });

  it('requires follow choice status to match its exact candidate count', () => {
    const candidate = {
        projectId: 'selected',
        projectLabel: 'Selected files',
        snapshotId: id,
        symbolId: id,
      },
      schema = viewerApiResponseSchemas['/api/follow-context'];
    expect(
      schema.safeParse({
        projectId: 'selected',
        snapshotId: id,
        symbolId: id,
        requiresChoice: false,
        candidates: [candidate, candidate],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        projectId: 'selected',
        snapshotId: id,
        symbolId: id,
        requiresChoice: false,
        candidates: [],
      }).success,
    ).toBe(false);
  });
});
