## Skill: LSP Enrichment

When file operations in the event batch touch source files, find the corresponding Lsp* symbols and add comments to those that lack them.

### Process

1. For each `FileOperation` event in the batch, note the file path(s) touched.
2. Use `exact` or `raw_query` to find Lsp* symbols for those files (match on `location` containing the file path, or `containerName`/`name`).
3. For each symbol that has no `comment` field (or an empty one), infer a brief description from the event context.
4. Use `upsert_entries` with the existing node `$id` to patch in the comment.

### Example

```json
{ "$type": "LspFunction", "$id": "<uuid>", "comment": "Builds the flat symbol-to-event index used during LSP enrichment" }
{ "$type": "LspClass", "$id": "<uuid>", "comment": "Wraps the SQLite connection and exposes typed query methods" }
```

### Guidelines

- Only add comments you can confidently infer from the event data. Do not guess.
- Keep comments concise (one sentence). Describe *what* the symbol does, with *why* if evident.
- Do not overwrite non-empty comments unless the new one is clearly more accurate.
- If no file operations touch source files in this batch, output "nothing to extract" and stop.
