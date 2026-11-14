import type { CodeSymbol } from '@codethread/code-model';
import type { Database } from './database.ts';

const pageSql = `SELECT symbol_json,count(*) OVER()::integer AS total
  FROM codethread.code_symbol
  WHERE snapshot_id=$1 AND (
    $2 = '' OR strpos(lower(symbol_json->>'name'),lower($2)) > 0 OR
    strpos(lower(symbol_json->>'filePath'),lower($2)) > 0
  )
  ORDER BY (symbol_json->>'filePath') COLLATE "C",
    (symbol_json #>> '{range,start,offset}')::integer,
    (symbol_json->>'key') COLLATE "C"
  LIMIT $3 OFFSET $4`;
const countSql = `SELECT count(*)::integer AS total
  FROM codethread.code_symbol
  WHERE snapshot_id=$1 AND (
    $2 = '' OR strpos(lower(symbol_json->>'name'),lower($2)) > 0 OR
    strpos(lower(symbol_json->>'filePath'),lower($2)) > 0
  )`;
// PostgreSQL lower() and JavaScript toLowerCase() do not share Unicode rules.
// Stream bounded names through the same predicate used by the result contract.
const candidateSql = `SELECT id, symbol_json->>'name' AS name,
    symbol_json->>'filePath' AS file_path
  FROM codethread.code_symbol WHERE snapshot_id=$1
  ORDER BY (symbol_json->>'filePath') COLLATE "C",
    (symbol_json #>> '{range,start,offset}')::integer,
    (symbol_json->>'key') COLLATE "C" LIMIT 20001`;

export interface SymbolSearchPage {
  items: CodeSymbol[];
  total: number;
}

export async function searchPublishedSymbols(
  db: Database,
  snapshotId: string,
  query: string,
  offset: number,
  limit: number,
): Promise<SymbolSearchPage> {
  if (query) {
    const selected: string[] = [];
    const filter = query.toLowerCase();
    let total = 0;
    let scanned = 0;
    for await (const batch of db
      .unsafe(candidateSql, [snapshotId])
      .cursor(256)) {
      for (const row of batch) {
        if (++scanned > 20_000)
          throw new Error('Stored snapshot exceeds the symbol limit');
        if (
          !String(row.name).toLowerCase().includes(filter) &&
          !String(row.file_path).toLowerCase().includes(filter)
        )
          continue;
        if (total >= offset && selected.length < limit)
          selected.push(String(row.id));
        total++;
      }
    }
    if (!selected.length) return { items: [], total };
    const rows = await db.unsafe(
      `SELECT symbol_json FROM codethread.code_symbol
       WHERE snapshot_id=$1 AND id=ANY($2::uuid[])
       ORDER BY (symbol_json->>'filePath') COLLATE "C",
         (symbol_json #>> '{range,start,offset}')::integer,
         (symbol_json->>'key') COLLATE "C"`,
      [snapshotId, selected],
    );
    return { items: rows.map((row) => row.symbol_json as CodeSymbol), total };
  }
  const rows = await db.unsafe(pageSql, [snapshotId, query, limit, offset]);
  const total = rows.length
    ? Number(rows[0]!.total)
    : Number((await db.unsafe(countSql, [snapshotId, query]))[0]!.total);
  return {
    items: rows.map((row) => row.symbol_json as CodeSymbol),
    total,
  };
}

export async function explainSymbolSearch(
  db: Database,
  snapshotId: string,
  query: string,
  offset: number,
  limit: number,
) {
  const rows = query
    ? await db.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidateSql}`,
        [snapshotId],
      )
    : await db.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${pageSql}`, [
        snapshotId,
        query,
        limit,
        offset,
      ]);
  return rows[0]?.['QUERY PLAN'];
}

export async function explainLegacySnapshotReads(
  db: Database,
  snapshotId: string,
) {
  const [facts, sources] = await Promise.all([
    db.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT facts_json FROM codethread.repository_snapshot WHERE id=$1`,
      [snapshotId],
    ),
    db.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT f.id,f.path,f.content_hash,f.byte_length,o.bytes
        FROM codethread.snapshot_file f LEFT JOIN codethread.source_object o
          ON o.sha256=f.content_hash WHERE f.snapshot_id=$1`,
      [snapshotId],
    ),
  ]);
  return {
    facts: facts[0]?.['QUERY PLAN'],
    sources: sources[0]?.['QUERY PLAN'],
  };
}
