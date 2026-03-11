## Skill: Local Decisions

For each event batch, identify and index deliberate implementation choices and concrete local changes.

### LocalDecision — a deliberate choice within a function or module

Fields:
- `title`: short imperative phrase (e.g. "Use early return to reduce nesting")
- `rationale`: why this was the right approach
- `symbols`: list of `{ "$id": "<uuid>" }` for LSP symbol nodes this concerns
  — find IDs via `exact` search on function/class name before inserting
  — use `[]` if no matching symbols are indexed yet

### Choice — one option explicitly rejected in favour of another

Fields:
- `chosen`: what was selected (e.g. "better-sqlite3")
- `option`: what was rejected (e.g. "sql.js")
- `reason`: why the option was not chosen
- `symbols`: list of `{ "$id": "<uuid>" }` for related LSP nodes

### LocalChangeEvent — a concrete local shift in understanding, assumption, interface contract, or implementation

Extract when you see something being corrected, reversed, redefined, or updated at a local level.

Fields:
- `name`: short label (e.g. "parseQuery now returns null on empty input instead of throwing")
- `description`: what changed, why, and what the new behaviour or contract is
- `scope`: one of `"file"` | `"function"` | `"interface"` | `"assumption"` | `"implementation"`
- `symbols`: list of `{ "$id": "<uuid>" }` for LSP nodes whose behaviour or contract changed

### Examples

```json
{ "$type": "LocalDecision", "title": "Use Map instead of object for accumulator", "rationale": "Map preserves insertion order and has O(1) keyed lookups", "symbols": [{ "$id": "uuid-of-buildIndex" }] }
{ "$type": "Choice", "chosen": "early return", "option": "nested else", "reason": "Reduces nesting and keeps the happy path at the top level", "symbols": [] }
{ "$type": "LocalChangeEvent", "name": "buildEntryNode now validates $id node existence", "description": "Previously $id references were passed through without checking; now the node must exist in the DB or an error is thrown", "scope": "function", "symbols": [{ "$id": "uuid-of-buildEntryNode" }] }
```

### Auxiliary skills

If you see patterns in the batch matching other indexing tasks, invoke them:
- API endpoints, service methods, query params → `skill("api-indexing")`
- Contracts, validators, entity mappings → `skill("contracts")`
