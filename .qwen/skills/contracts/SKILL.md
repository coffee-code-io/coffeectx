---
name: contracts
description: Index contracts, validators, entity mappings, and uniqueness constraints from agent session events
allowedTools: [upsert_entries, exact, regex, raw_query]
---

## Skill: Contracts

When event batches reveal validation logic, data contracts, entity relationships, or uniqueness rules being defined or enforced, extract them into the knowledge graph.

### TextContract — a prose invariant or behavioural contract

Fields:
- `description`: the contract in plain English (e.g. "upsert_entries must never be called with an empty entries array")
- `symbols`: `{ "$id": "<uuid>" }` list for the symbols this contract applies to

### ArgValidator — a runtime argument validation rule

Fields:
- `argument`: argument name
- `rule`: the validation rule (e.g. "must be a non-empty string", "must be a valid UUID")
- `symbols`: `{ "$id": "<uuid>" }` list

### SyncValidator — a synchronous cross-field or state validation

Fields:
- `description`: what invariant is checked
- `symbols`: `{ "$id": "<uuid>" }` list

### EntityMapping — a mapping between two entity types

Fields:
- `from`: source type name
- `to`: target type name
- `description`: nature of the mapping (e.g. "AgentLog.sessionId maps to AgentRun.id")

### Unique — a uniqueness constraint

Fields:
- `field`: field name (or comma-separated fields for composite)
- `scope`: type name this applies to
- `description`: why this constraint exists

### Examples

```json
{ "$type": "TextContract", "description": "Every node insertion must include $type; omitting it is a hard error", "symbols": [] }
{ "$type": "ArgValidator", "argument": "sessionId", "rule": "Must be a valid UUID v4", "symbols": [{ "$id": "uuid-of-validateSessionId" }] }
{ "$type": "Unique", "field": "uuid", "scope": "AgentRun", "description": "Each agent run has a unique session UUID" }
```
