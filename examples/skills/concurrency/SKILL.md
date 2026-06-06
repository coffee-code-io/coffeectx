---
name: concurrency
description: Extract concurrency invariants, ordering constraints, and synchronisation relationships when the span touches shared state, locks, async code, transactions, or event ordering.
coffeecode:
  indexer: true
  types: ./types.yaml
allowed-tools: [upsert_entries, get_by_symbol_text, resolve_symbols, regex, raw_query, search, get_node_by_id]
---

# Concurrency-invariant extraction

You are extending the per-Span indexer. The base prompt already taught you the Span format and the built-in types. This skill adds three relationship types: `ConcurrencyInvariant`, `HappensBefore`, `SyncedWith`.

Invoke me only when the span touches mutexes/locks, SQLite transactions, async/await ordering constraints, event-emitter/pub-sub fan-out, or code annotated with words like "thread-safe", "race condition", "atomic", "before". Pure single-threaded edits don't need me.

# What to extract

## ConcurrencyInvariant — a must-hold condition on a shared resource
- `resource` — the shared resource name
- `invariant` — the must-hold condition
- `enforcement` — `"lock" | "atomic" | "queue" | "actor" | "transaction" | "none"`
- `symbol` — `{ "$id": "<uuid-of-the-owning-LspFunction/LspMethod/LspClass>" }`

```json
{ "$type": "ConcurrencyInvariant", "resource": "better-sqlite3 connection", "invariant": "all writes happen inside a single synchronous transaction", "enforcement": "transaction", "symbol": { "$id": "<uuid>" } }
```

## HappensBefore — an explicit ordering constraint
- `before` — the operation that must complete first
- `after` — the operation that may only start once `before` is done
- `reason` — why the ordering is required (data dependency, race, etc.)
- `symbolBefore` / `symbolAfter` — `{ "$id": "<uuid>" }` for the two LspFunction/LspMethod nodes

```json
{ "$type": "HappensBefore", "before": "collectEntryMeanings", "after": "buildEntryNode", "reason": "embedMap must be fully populated before the synchronous transaction begins", "symbolBefore": { "$id": "<uuid>" }, "symbolAfter": { "$id": "<uuid>" } }
```

## SyncedWith — two values that must stay consistent
- `a` / `b` — the two entities that must match
- `mechanism` — `"transaction" | "event" | "lock" | "observer" | "derived"`
- `description` — what breaks if they drift
- `symbol` — `{ "$id": "<uuid>" }` for the function that keeps them in sync

```json
{ "$type": "SyncedWith", "a": "named_types.type_id", "b": "types.id", "mechanism": "transaction", "description": "named_types always references a valid types row; orphans break type resolution", "symbol": { "$id": "<uuid>" } }
```

# Rules

- Extract only invariants that are actively enforced in the code visible in the span — not theoretical concerns.
- One entry per relationship; don't decompose a transaction-bracket into many `HappensBefore` entries when one `ConcurrencyInvariant` captures it cleanly.
- Skill output complements the base indexer's `LocalDecision`/`Decision`/`Assumption` extractions — still emit those when relevant.
