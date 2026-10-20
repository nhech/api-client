/**
 * GraphQL request bodies (spec 5.4): the query and its variables become the JSON body a GraphQL server expects.
 *
 * The variables text of Thunder may hold `{{variables}}` where JSON allows a value, which makes it invalid JSON until the
 * variables are filled in. So there are four cases: none; valid JSON (nested as an object); an object that is only invalid
 * because of `{{...}}` (put in as it is, and valid once sent); anything else (kept as a string, and reported).
 */
export type VariablesKind = 'none' | 'json' | 'raw-object' | 'text';

export function classifyVariables(text: string): VariablesKind {
  const trimmed = text.trim();
  if (trimmed === '') return 'none';
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? 'json' : 'text';
  } catch {
    return trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('{{') ? 'raw-object' : 'text';
  }
}

/** The body text, in a fixed layout (two spaces, `query` first) so that the same query always gives the same file. */
export function graphqlBodyText(query: string, variables: string): string {
  const kind = classifyVariables(variables);
  const trimmed = variables.trim();
  if (kind === 'none') return JSON.stringify({ query }, null, 2);
  if (kind === 'json') return JSON.stringify({ query, variables: JSON.parse(trimmed) as unknown }, null, 2);
  if (kind === 'raw-object') return `{\n  "query": ${JSON.stringify(query)},\n  "variables": ${trimmed}\n}`;
  return JSON.stringify({ query, variables }, null, 2);
}
