import { z } from 'zod';
import { codeRelationKindSchema, idSchema } from '@codethread/code-model';
import { scoped, queryMetaSchema } from './query-common.js';
import { graphFields, graphIntegrity } from './graph-integrity.js';

const relationKindsSchema = z
  .array(codeRelationKindSchema)
  .min(1)
  .max(3)
  .refine((kinds) => new Set(kinds).size === kinds.length)
  .default(['calls']);

export const graphNeighborsRequestSchema = z.strictObject({
  snapshotId: idSchema,
  symbolId: idSchema,
  direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  relationKinds: relationKindsSchema,
  depth: z.number().int().min(1).max(5).default(2),
  nodeLimit: z.number().int().min(1).max(200).default(200),
});

export const findSymbolPathsRequestSchema = z.strictObject({
  snapshotId: idSchema,
  fromSymbolId: idSchema,
  toSymbolId: idSchema,
  relationKinds: relationKindsSchema,
  depth: z.number().int().min(1).max(5).default(2),
  nodeLimit: z.number().int().min(1).max(200).default(200),
  pathLimit: z.number().int().min(1).max(20).default(20),
});

export const graphNeighborsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      rootSymbolId: idSchema,
      ...graphFields,
    })
    .superRefine((graph, context) => {
      graphIntegrity(graph, context);
      if (!graph.symbols.some((symbol) => symbol.id === graph.rootSymbolId))
        context.addIssue({ code: 'custom', message: 'Missing root symbol' });
    }),
);

export const findSymbolPathsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      fromSymbolId: idSchema,
      toSymbolId: idSchema,
      ...graphFields,
      paths: z
        .array(
          z.strictObject({
            symbolIds: z.array(idSchema).min(1).max(6),
            relationIds: z.array(idSchema).max(5),
          }),
        )
        .max(20),
    })
    .superRefine((graph, context) => {
      graphIntegrity(graph, context);
      const relations = new Map(
        graph.relations.map((relation) => [relation.id, relation]),
      );
      const symbols = new Set(graph.symbols.map((symbol) => symbol.id));
      if (!symbols.has(graph.fromSymbolId) || !symbols.has(graph.toSymbolId))
        context.addIssue({
          code: 'custom',
          path: ['paths'],
          message: 'Missing path root symbol',
        });
      for (const path of graph.paths) {
        if (
          path.symbolIds.length !== path.relationIds.length + 1 ||
          new Set(path.symbolIds).size !== path.symbolIds.length ||
          path.symbolIds.some((id) => !symbols.has(id)) ||
          path.symbolIds[0] !== graph.fromSymbolId ||
          path.symbolIds.at(-1) !== graph.toSymbolId
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid cycle-safe path',
          });
        }
        path.relationIds.forEach((id, index) => {
          const relation = relations.get(id);
          if (
            !relation ||
            relation.sourceSymbolId !== path.symbolIds[index] ||
            relation.resolution.status !== 'exact' ||
            relation.resolution.targetId !== path.symbolIds[index + 1]
          ) {
            context.addIssue({
              code: 'custom',
              message: 'Path relation does not connect its symbols',
            });
          }
        });
      }
    }),
);

export type GraphNeighborsRequest = z.infer<typeof graphNeighborsRequestSchema>;

export type GraphNeighborsResponse = z.infer<
  typeof graphNeighborsResponseSchema
>;

export type FindSymbolPathsRequest = z.infer<
  typeof findSymbolPathsRequestSchema
>;

export type FindSymbolPathsResponse = z.infer<
  typeof findSymbolPathsResponseSchema
>;
