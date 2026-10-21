import type { Request } from '../core/model';

/** The tab of the request editor a request opens on: the body when it has one, else the first of the query and the headers that has a row in use, else the query. */
export function defaultRequestTab(request: Request): 'query' | 'headers' | 'body' {
  if (request.body.kind !== 'none') return 'body';
  const used = (rows: readonly { enabled: boolean; name: string }[]): boolean => rows.some(row => row.enabled && row.name !== '');
  if (used(request.query)) return 'query';
  if (used(request.headers)) return 'headers';
  return 'query';
}
