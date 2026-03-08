/**
 * Query language for retrival-mcp.
 *
 * Grammar:
 *   Query       = Clause (',' Clause)*                          -- AND semantics
 *   Clause      = 'Symbol'  STRING                              -- exact symbol match
 *               | 'Regex'   STRING                              -- regex on symbol value
 *               | 'Meaning' STRING                              -- semantic search
 *               | 'Id'      STRING                              -- exact node ID lookup
 *               | TypeQuery                                     -- filter by named type
 *               | MapQuery                                      -- filter map nodes by fields
 *               | ListQuery                                     -- filter list nodes by items
 *               | '(' Query ')'                                 -- grouping
 *
 *   TypeQuery   = 'IsType' STRING (',' 'IsType' STRING)*        -- OR semantics
 *   MapQuery    = 'Field' STRING SubQuery (',' 'Field' STRING SubQuery)*  -- AND semantics
 *   ListQuery   = 'HasItem' SubQuery
 *   SubQuery    = '(' Query ')' | Clause                        -- arg to Field / HasItem
 *
 * Disambiguation: TypeQuery and MapQuery greedily consume commas when
 * the next token is their keyword (IsType / Field). All other commas
 * belong to the outer Query.
 *
 * Examples:
 *   Symbol "main"
 *   Meaning "authentication flow", IsType "Project"
 *   Field "title" Meaning "auth", Field "tags" Symbol "security"
 *   HasItem (Symbol "step1"), Symbol "pipeline"
 */

// ── AST ───────────────────────────────────────────────────────────────────────

export type Query = QueryClause[]; // comma-separated = AND

export type QueryClause =
  | { kind: 'Symbol'; value: string }
  | { kind: 'Regex'; pattern: string }
  | { kind: 'Meaning'; text: string }
  | { kind: 'IdQuery'; id: string }
  | { kind: 'TypeQuery'; types: string[] } // OR across IsType values
  | { kind: 'MapQuery'; fields: MapField[] } // AND across fields
  | { kind: 'ListQuery'; item: Query }
  | { kind: 'Group'; inner: QueryClause };

export interface MapField {
  key: string;
  query: Query;
}

// ── Lexer ─────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(['Symbol', 'Regex', 'Meaning', 'Id', 'IsType', 'Field', 'HasItem']);

type Token =
  | { type: 'KW'; value: string }
  | { type: 'STR'; value: string }
  | { type: 'LPAREN' }
  | { type: 'RPAREN' }
  | { type: 'COMMA' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    if (/\s/.test(input[i]!)) { i++; continue; }

    if (input[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (input[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (input[i] === ',') { tokens.push({ type: 'COMMA' }); i++; continue; }

    if (input[i] === '"' || input[i] === "'") {
      const q = input[i++]!;
      let s = '';
      while (i < input.length && input[i] !== q) {
        if (input[i] === '\\') { i++; s += input[i++]; }
        else s += input[i++];
      }
      if (input[i] !== q) throw new Error('Unterminated string literal');
      i++;
      tokens.push({ type: 'STR', value: s });
      continue;
    }

    if (/[A-Za-z_]/.test(input[i]!)) {
      let w = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i]!)) w += input[i++];
      if (KEYWORDS.has(w)) {
        tokens.push({ type: 'KW', value: w });
        continue;
      }
      throw new Error(`Unquoted string '${w}' at position ${i - w.length}; wrap strings in \"...\" or '...'.`);
      continue;
    }

    throw new Error(`Unexpected character '${input[i]}' at position ${i}`);
  }

  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private consume(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('Unexpected end of input');
    return t;
  }

  private expectKw(kw: string): void {
    const t = this.consume();
    if (t.type !== 'KW' || t.value !== kw)
      throw new Error(`Expected keyword '${kw}', got ${JSON.stringify(t)}`);
  }

  private expectStr(): string {
    const t = this.consume();
    if (t.type !== 'STR')
      throw new Error(`Expected string, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseQuery(): Query {
    const clauses: QueryClause[] = [this.parseClause()];

    while (this.peek()?.type === 'COMMA') {
      // Don't consume the comma yet — let parseClause decide if it belongs here.
      // (TypeQuery / MapQuery peek-ahead handles their own commas.)
      // If the comma is not theirs, it belongs to this Query level.
      this.consume();
      clauses.push(this.parseClause());
    }

    return clauses;
  }

  private parseClause(): QueryClause {
    const t = this.peek();
    if (!t) throw new Error('Expected clause, got end of input');

    if (t.type === 'LPAREN') {
      this.consume();
      const inner = this.parseClause();
      const closing = this.consume();
      if (closing.type !== 'RPAREN') throw new Error('Expected )');
      return { kind: 'Group', inner };
    }

    if (t.type !== 'KW')
      throw new Error(`Expected keyword or '(', got ${JSON.stringify(t)}`);

    switch (t.value) {
      case 'Symbol': {
        this.consume();
        return { kind: 'Symbol', value: this.expectStr() };
      }
      case 'Regex': {
        this.consume();
        return { kind: 'Regex', pattern: this.expectStr() };
      }
      case 'Meaning': {
        this.consume();
        return { kind: 'Meaning', text: this.expectStr() };
      }
      case 'Id': {
        this.consume();
        return { kind: 'IdQuery', id: this.expectStr() };
      }
      case 'IsType':
        return this.parseTypeQuery();
      case 'Field':
        return this.parseMapQuery();
      case 'HasItem': {
        this.consume();
        return { kind: 'ListQuery', item: this.parseSubQuery() };
      }
      default:
        throw new Error(`Unknown keyword '${t.value}'`);
    }
  }

  // TypeQuery greedily consumes commas followed by 'IsType'
  private parseTypeQuery(): QueryClause {
    const types: string[] = [];
    this.expectKw('IsType');
    types.push(this.expectStr());

    while (
      this.peek()?.type === 'COMMA' &&
      this.peek(1)?.type === 'KW' &&
      (this.peek(1) as { type: 'KW'; value: string }).value === 'IsType'
    ) {
      this.consume(); // comma
      this.expectKw('IsType');
      types.push(this.expectStr());
    }

    return { kind: 'TypeQuery', types };
  }

  // MapQuery greedily consumes commas followed by 'Field'
  private parseMapQuery(): QueryClause {
    const fields: MapField[] = [];
    this.expectKw('Field');
    fields.push({ key: this.expectStr(), query: this.parseSubQuery() });

    while (
      this.peek()?.type === 'COMMA' &&
      this.peek(1)?.type === 'KW' &&
      (this.peek(1) as { type: 'KW'; value: string }).value === 'Field'
    ) {
      this.consume(); // comma
      this.expectKw('Field');
      fields.push({ key: this.expectStr(), query: this.parseSubQuery() });
    }

    return { kind: 'MapQuery', fields };
  }

  // SubQuery: '(' Query ')' or a single Clause
  private parseSubQuery(): Query {
    if (this.peek()?.type === 'LPAREN') {
      this.consume();
      const q = this.parseQuery();
      const closing = this.consume();
      if (closing.type !== 'RPAREN') throw new Error('Expected )');
      return q;
    }
    return [this.parseClause()];
  }
}

export function parseQuery(input: string): Query {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const q = parser.parseQuery();
  return q;
}

// ── Executor ──────────────────────────────────────────────────────────────────

export interface QueryDb {
  querySymbolExact(value: string): string[];
  querySymbolRegex(pattern: string): string[];
  queryMeaning(text: string, limit: number): Promise<string[]>;
  queryById(id: string): string[];
  queryByNamedType(names: string[]): string[];
  queryMapsByField(key: string, valueIds: string[]): string[];
  queryListsByItem(itemIds: string[]): string[];
}

export async function executeQuery(query: Query, db: QueryDb): Promise<string[]> {
  if (query.length === 0) return [];

  let result: Set<string> | null = null;

  for (const clause of query) {
    const ids = await executeClause(clause, db);
    const set = new Set(ids);

    if (result === null) {
      result = set;
    } else {
      // AND: intersection
      for (const id of result) {
        if (!set.has(id)) result.delete(id);
      }
    }

    if (result.size === 0) return [];
  }

  return result ? [...result] : [];
}

async function executeClause(clause: QueryClause, db: QueryDb): Promise<string[]> {
  switch (clause.kind) {
    case 'Symbol':
      return db.querySymbolExact(clause.value);

    case 'Regex':
      return db.querySymbolRegex(clause.pattern);

    case 'Meaning':
      return db.queryMeaning(clause.text, 50);

    case 'IdQuery':
      return db.queryById(clause.id);

    case 'TypeQuery':
      return db.queryByNamedType(clause.types);

    case 'MapQuery': {
      let candidates: Set<string> | null = null;
      for (const field of clause.fields) {
        const valueIds = await executeQuery(field.query, db);
        const mapIds = db.queryMapsByField(field.key, valueIds);
        const mapSet = new Set(mapIds);
        if (candidates === null) {
          candidates = mapSet;
        } else {
          for (const id of candidates) {
            if (!mapSet.has(id)) candidates.delete(id);
          }
        }
        if (candidates.size === 0) return [];
      }
      return candidates ? [...candidates] : [];
    }

    case 'ListQuery': {
      const itemIds = await executeQuery(clause.item, db);
      return db.queryListsByItem(itemIds);
    }

    case 'Group':
      return executeClause(clause.inner, db);
  }
}
