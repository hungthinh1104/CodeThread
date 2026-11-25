import { z } from 'zod';
import { responseContextFor } from './ai-packet.js';
import {
  aiSynthesisResponseSchema,
  aiSynthesizeRequestSchema,
} from './ai-queries.js';
import type { AiSynthesisResponse, AiSynthesizeRequest } from './ai-queries.js';

function assertSubset(
  cited: readonly string[],
  allowed: ReadonlySet<string>,
  path: (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  for (const id of cited) {
    if (!allowed.has(id)) {
      context.addIssue({
        code: 'custom',
        path,
        message: `${label} ${id} is not present in the request packet`,
      });
      return;
    }
  }
}

/** Validates an AI synthesis response against its originating snapshot packet. */
export function parseAiSynthesisResult(
  request: AiSynthesizeRequest,
  response: unknown,
): AiSynthesisResponse {
  const checkedRequest = aiSynthesizeRequestSchema.parse(request);
  const { packet } = checkedRequest;
  const excerptIds = new Set(packet.excerpts.map((item) => item.evidenceId));
  const symbolIds = new Set(packet.symbols.map((item) => item.id));
  const relationIds = new Set(packet.relations.map((item) => item.id));
  const diagnosticIds = new Set(packet.diagnostics.map((item) => item.id));

  return aiSynthesisResponseSchema
    .superRefine((value, context) => {
      if (value.snapshotId !== packet.snapshotId) {
        context.addIssue({
          code: 'custom',
          path: ['snapshotId'],
          message: 'AI synthesis snapshot does not match request packet',
        });
      }
      if (value.rootSymbolId !== packet.rootSymbolId) {
        context.addIssue({
          code: 'custom',
          path: ['rootSymbolId'],
          message: 'AI synthesis root symbol does not match request packet',
        });
      }
      const expectedContext = responseContextFor(packet);
      if (JSON.stringify(value.context) !== JSON.stringify(expectedContext)) {
        context.addIssue({
          code: 'custom',
          path: ['context'],
          message:
            'AI synthesis context limits do not match the request packet',
        });
      }
      if (value.task !== checkedRequest.task) {
        context.addIssue({
          code: 'custom',
          path: ['task'],
          message: 'AI synthesis task does not match request',
        });
      }
      if (value.claims.length > checkedRequest.maxClaims) {
        context.addIssue({
          code: 'custom',
          path: ['claims'],
          message: 'AI synthesis claims exceed requested maxClaims',
        });
      }
      if (value.nextSteps.length > checkedRequest.maxNextSteps) {
        context.addIssue({
          code: 'custom',
          path: ['nextSteps'],
          message: 'AI synthesis nextSteps exceed requested maxNextSteps',
        });
      }
      value.claims.forEach((claim, index) => {
        assertSubset(
          claim.evidenceIds,
          excerptIds,
          ['claims', index, 'evidenceIds'],
          'Evidence ID',
          context,
        );
        assertSubset(
          claim.symbolIds,
          symbolIds,
          ['claims', index, 'symbolIds'],
          'Symbol ID',
          context,
        );
        assertSubset(
          claim.relationIds,
          relationIds,
          ['claims', index, 'relationIds'],
          'Relation ID',
          context,
        );
        assertSubset(
          claim.diagnosticIds,
          diagnosticIds,
          ['claims', index, 'diagnosticIds'],
          'Diagnostic ID',
          context,
        );
      });
      value.nextSteps.forEach((step, index) => {
        if (!symbolIds.has(step.symbolId)) {
          context.addIssue({
            code: 'custom',
            path: ['nextSteps', index, 'symbolId'],
            message: `Next-step symbol ${step.symbolId} is not in the request packet`,
          });
        }
        assertSubset(
          step.supportingEvidenceIds,
          excerptIds,
          ['nextSteps', index, 'supportingEvidenceIds'],
          'Evidence ID',
          context,
        );
      });
    })
    .parse(response);
}
