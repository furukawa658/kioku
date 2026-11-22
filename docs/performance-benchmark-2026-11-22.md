# kioku Local Search Performance Notes

- Date: 2026-11-22
- Host: Windows x64
- Runtime: Bun 1.4.4
- Embedding dimensions: 384
- Top-k: 10

## Scope

This benchmark answers three questions for the kioku 0.8.0 local search path:

1. Which optional SQLite PRAGMAs measurably improve kioku's write and FTS workloads.
2. Whether USearch HNSW is a better local vector index than the current `sqlite-vec` index.
3. Which SQLite connection settings should be consistent across the Bun worker and the optional Rust MCP core.

The benchmark uses synthetic, normalized float32 vectors and a 50,000-row SQLite fixture. It is a local engineering check, not a universal database ranking or a claim about PostgreSQL, production hardware, or every dataset distribution.

## Reproduce

```powershell
bun scripts/bench-sqlite-pragmas.ts 50000 10
bun scripts/bench-vector-index.ts 1000,10000,50000,100000 20
```

Both scripts write progress to stderr and the final JSON result to stdout. The SQLite benchmark alternates configuration order on each trial to reduce warm-state bias.

## SQLite PRAGMA Results

The comparison alternated `current` and `temp_store=MEMORY` for 10 trials over 50,000 records, 2,000 updates, and 100 indexed and FTS reads per trial.

| Configuration | Insert p50 | Update p50 | Indexed read p50 | Indexed read p95 | FTS read p50 | FTS read p95 | RSS p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current | 1331.855 ms | 8.567 ms | 0.0307 ms | 0.1303 ms | 0.1709 ms | 1.1785 ms | 71.21 MiB |
| `temp_store=MEMORY` | 1001.917 ms | 9.234 ms | 0.0344 ms | 0.0922 ms | 0.1528 ms | 0.8932 ms | 70.98 MiB |

Decision:

- Adopt `temp_store=MEMORY` for connection-local temporary sort and FTS/RRF work. It reduced insertion p50 by about 25% and FTS p50/p95 by about 11%/24% without increasing RSS.
- Do not adopt `mmap_size=268435456` in this release. An individual comparison showed slower insertion and reads in the current fixture.
- Do not adopt `cache_size=-32000` in this release. It increased RSS without a reproducible search improvement.
- Keep `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, and a 5,000 ms busy timeout.
- Revisit these settings when real database sizes, memory limits, or query distributions materially change.

## sqlite-vec vs USearch

The final 100,000-vector comparison used 384-dimensional float32 vectors, cosine distance, 10 nearest neighbors, 10 query vectors, and five searches per query. USearch used HNSW with 16 connectivity, expansion-add 128, expansion-search 64, and automatic build threads.

| Index | Build | Search p50 | Search p95 | recall@10 |
| --- | ---: | ---: | ---: | ---: |
| `sqlite-vec` | 1322.726 ms | 58.5362 ms | 81.4143 ms | 1.000 |
| USearch HNSW | 60122.102 ms | 1.7183 ms | 2.8538 ms | 0.340 |

Process RSS after the 100,000-vector comparison was 575.87 MiB.

Decision:

- Do not add USearch to the product index in 0.8.0.
- The faster USearch query path is not useful without meeting kioku's recall requirement. At 100,000 synthetic vectors, recall@10 fell to 0.340 while `sqlite-vec` returned the exact top 10.
- The USearch graph also took about 45 times longer to build and increased memory usage beyond the current local design.
- Keep USearch as a benchmark candidate. Re-evaluate only after a real-vector corpus, persistence strategy, update/delete workload, filtered search contract, and memory ceiling are fixed.

Earlier 1,000 to 100,000-vector runs showed the same direction: `sqlite-vec` retained recall 1.0, while USearch recall fell as the index grew. USearch's query time benefit alone is insufficient to change the index.

## Connection Consistency

0.8.0 applies the following per-connection settings in both the Bun worker and Rust MCP core:

- `busy_timeout=5000`
- `temp_store=MEMORY`

The Bun worker also configures its existing durable-database settings: WAL mode, `synchronous=NORMAL`, foreign keys, journal size limit, and incremental auto-vacuum where applicable. Rust search and Work State paths use read-only SQLite connections, while invalidation uses the shared read-write connection helper.

## Acceptance Checks

The release includes tests for:

- Explicit 5,000 ms busy timeouts on Rust read-only and read-write connections.
- `temp_store=MEMORY` on Bun and Rust connections.
- MCP invalidation while a concurrent WAL writer holds a short write transaction.
- Work State reads while a WAL writer has an uncommitted transaction.
