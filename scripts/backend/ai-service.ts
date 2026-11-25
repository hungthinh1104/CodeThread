import {
  aiStatusResponseSchema,
  aiSynthesizeApiRequestSchema,
} from '@codethread/contracts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  GetSourceEvidenceResponse,
  GraphNeighborsResponse,
} from '@codethread/contracts';
import {
  AI_PROMPT_VERSION,
  AiError,
  buildAiContextPacketFromProjection,
  createAiProviderFromConfig,
  createAiSynthesizer,
  hashAiContextPacket,
} from '../ai/index.ts';
import type { AiConfig, AiProvider, FetchLike } from '../ai/index.ts';
import { ServiceError } from './service.ts';

const DEFAULT_MAX_CONCURRENT_AI = 2;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 64;

export interface AiProjectionReader {
  aiProjection(
    jobId: string,
    projectId: string,
    neighborsInput: unknown,
  ): Promise<{
    graph: GraphNeighborsResponse;
    evidenceBatch: GetSourceEvidenceResponse;
  }>;
}

export interface BackendAiServiceOptions {
  readonly provider?: AiProvider;
  readonly fetchImpl?: FetchLike;
  readonly maxConcurrent?: number;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly response: AiSynthesisResponse;
}

function mapAiFailure(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  if (error instanceof AiError) {
    switch (error.code) {
      case 'AI_DISABLED':
      case 'AI_INVALID_CONFIG':
        throw new ServiceError(503, 'AI_DISABLED', error.message);
      case 'AI_INVALID_REQUEST':
        throw new ServiceError(400, 'INVALID_REQUEST', error.message);
      case 'AI_CAPACITY_EXCEEDED':
        throw new ServiceError(429, 'AI_CAPACITY_EXCEEDED', error.message);
      case 'AI_PROVIDER_TIMEOUT':
        throw new ServiceError(504, 'AI_PROVIDER_TIMEOUT', error.message);
      case 'AI_PROVIDER_ERROR':
      case 'AI_RESPONSE_TOO_LARGE':
      case 'AI_INVALID_MODEL_OUTPUT':
        throw new ServiceError(502, error.code, error.message);
    }
  }
  throw error;
}

/**
 * Orchestrates snapshot-grounded AI synthesis on top of BackendQueryService:
 * - Validates API request shape before checking feature enablement.
 * - Fails closed with 503 AI_DISABLED without touching DB or network when off.
 * - Releases DB heavy-query slots before invoking the AI provider.
 * - Bounds concurrent AI requests (default 2) and caches immutable results.
 */
export class BackendAiService {
  private readonly queries: AiProjectionReader;
  private readonly config: AiConfig;
  private readonly provider: AiProvider | null;
  private readonly synthesizer: ReturnType<typeof createAiSynthesizer>;
  private readonly maxConcurrent: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private active = 0;

  constructor(
    queries: AiProjectionReader,
    config: AiConfig,
    options: BackendAiServiceOptions = {},
  ) {
    this.queries = queries;
    this.config = config;
    this.provider = config.enabled
      ? (options.provider ??
        createAiProviderFromConfig(config, options.fetchImpl))
      : null;
    this.synthesizer = createAiSynthesizer(config, {
      ...(this.provider ? { provider: this.provider } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AI;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get activeSynthesisCount(): number {
    return this.active;
  }

  status(): AiStatusResponse {
    if (!this.config.enabled) {
      return aiStatusResponseSchema.parse({ enabled: false });
    }
    return aiStatusResponseSchema.parse({
      enabled: true,
      provider: this.config.provider,
      locality: this.config.locality,
      model: this.config.model,
    });
  }

  async synthesize(
    jobId: string,
    projectId: string,
    rawInput: unknown,
  ): Promise<AiSynthesisResponse> {
    const request = aiSynthesizeApiRequestSchema.parse(rawInput);
    if (!this.config.enabled || !this.provider) {
      throw new ServiceError(
        503,
        'AI_DISABLED',
        'Optional AI synthesis is disabled.',
      );
    }
    if (this.active >= this.maxConcurrent) {
      throw new ServiceError(
        429,
        'AI_CAPACITY_EXCEEDED',
        'Too many AI synthesis requests are active; retry shortly.',
      );
    }
    this.active++;
    try {
      // Step 1: Hydrate bounded graph + verified excerpts, then immediately
      // release the heavy-query DB slot inside aiProjection() before LLM I/O.
      const { graph, evidenceBatch } = await this.queries.aiProjection(
        jobId,
        projectId,
        request.neighbors,
      );
      const packet = buildAiContextPacketFromProjection(graph, evidenceBatch);
      const packetHash = hashAiContextPacket(packet);
      const cacheKey = [
        packetHash,
        request.task,
        this.provider.kind,
        this.provider.model,
        AI_PROMPT_VERSION,
        request.maxClaims,
        request.maxNextSteps,
      ].join(':');

      const cached = this.readCache(cacheKey);
      if (cached) return cached;

      const response = await this.synthesizer.synthesize({
        task: request.task,
        packet,
        maxClaims: request.maxClaims,
        maxNextSteps: request.maxNextSteps,
      });
      this.writeCache(cacheKey, response);
      return response;
    } catch (error) {
      mapAiFailure(error);
    } finally {
      this.active--;
    }
  }

  private readCache(key: string): AiSynthesisResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    // Refresh LRU order.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.response;
  }

  private writeCache(key: string, response: AiSynthesisResponse): void {
    const now = this.now();
    for (const [existingKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(existingKey);
    }
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, {
      expiresAt: now + this.cacheTtlMs,
      response,
    });
  }
}
