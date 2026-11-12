import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRealworldStudyCommand } from '../scripts/realworld-study.ts';

const repositoryRoot = resolve('.');
const temporaryDirectories: string[] = [];

async function makeStudyDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ct-realworld-study-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const temporaryName = basename(directory);
      if (
        !temporaryName.startsWith('ct-realworld-study-') ||
        resolve(tmpdir(), temporaryName) !== resolve(directory)
      ) {
        throw new Error(
          'Refusing to remove an unexpected study test directory',
        );
      }
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('CT-REALWORLD-001 study CLI', () => {
  it('validates the frozen task packet without using prediction outputs', async () => {
    const result = await runRealworldStudyCommand(['validate'], {
      repositoryRoot,
    });

    expect(result).toMatchObject({
      valid: true,
      taskCount: 15,
      labelCounts: {
        exact: 22,
        non_exact: 4,
        no_exact_relation: 2,
      },
      repositories: ['hono', 'pinia', 'zod'],
    });
  });

  it('rejects a changed task packet before interpreting its contents', async () => {
    const temporaryRoot = await makeStudyDataRoot();
    const packetRoot = join(temporaryRoot, 'docs/evaluation/ct-realworld-001');
    await mkdir(packetRoot, { recursive: true });
    await copyFile(
      join(
        repositoryRoot,
        'docs/evaluation/ct-realworld-001/repositories.json',
      ),
      join(packetRoot, 'repositories.json'),
    );
    await writeFile(join(packetRoot, 'tasks.json'), '{"changed":true}', 'utf8');

    await expect(
      runRealworldStudyCommand(['validate'], { repositoryRoot: temporaryRoot }),
    ).rejects.toMatchObject({ code: 'FROZEN_PACKET_DIGEST_MISMATCH' });
  });

  it('rejects score input outside the local ignored study-data root', async () => {
    const studyDataRoot = await makeStudyDataRoot();

    await expect(
      runRealworldStudyCommand(['score', '../participant-results.json'], {
        repositoryRoot,
        studyDataRoot,
      }),
    ).rejects.toMatchObject({
      code: 'RESULT_FILE_OUTSIDE_LOCAL_STUDY_DATA',
    });
  });

  it('requires matching blind-review provenance before reading score input', async () => {
    const studyDataRoot = await makeStudyDataRoot();
    const resultPath = join(studyDataRoot, 'results.json');
    await writeFile(
      resultPath,
      '{ invalid JSON that must not be opened',
      'utf8',
    );

    await expect(
      runRealworldStudyCommand(['score', resultPath], {
        repositoryRoot,
        studyDataRoot,
      }),
    ).rejects.toMatchObject({
      code: 'REVIEW_PROVENANCE_MISSING',
    });
  });

  it('rejects review provenance that does not match the frozen task bank', async () => {
    const studyDataRoot = await makeStudyDataRoot();
    await mkdir(studyDataRoot, { recursive: true });
    const tasks = JSON.parse(
      await readFile(
        join(repositoryRoot, 'docs/evaluation/ct-realworld-001/tasks.json'),
        'utf8',
      ),
    ) as { tasks: Array<{ id: string }> };
    await writeFile(
      join(studyDataRoot, 'independent-review.json'),
      JSON.stringify({
        format: 'codethread-ct-realworld-001-independent-review-v1',
        taskBankSha256: '0'.repeat(64),
        repositorySetSha256:
          'de14e354a9d2151f74736ab827cb746a534967b8f241f6dc427928aa59828de9',
        scorerRevision: '1'.repeat(40),
        scoringPolicySha256: '2'.repeat(64),
        reviewCompletedAt: '2026-11-12T00:00:00.000Z',
        reviewerDidNotAuthorLabels: true,
        predictionsNotSeenBeforeAnswers: true,
        reviewedTaskIds: tasks.tasks.map((task) => task.id),
        independentAnswersSha256: '3'.repeat(64),
        adjudicationSha256: '4'.repeat(64),
      }),
      'utf8',
    );
    const resultPath = join(studyDataRoot, 'results.json');
    await writeFile(
      resultPath,
      '{ invalid JSON that must not be opened',
      'utf8',
    );

    await expect(
      runRealworldStudyCommand(['score', resultPath], {
        repositoryRoot,
        studyDataRoot,
      }),
    ).rejects.toMatchObject({
      code: 'REVIEW_PROVENANCE_INVALID',
    });
  });
});
