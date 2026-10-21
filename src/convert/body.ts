import type { FindingCode } from '../model/findings';
import type { ImpBody } from '../model/ir';
import type { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import { readText } from '../normalize/text';
import { classifyVariables } from './graphql';

/**
 * The body of a request (spec 5.4). `contentType` is what Thunder sends on its own for this kind of body, so the file has
 * to say it: REST Client adds no Content-Type header.
 */
export interface Issue {
  code: FindingCode;
  message?: string;
}

export interface BodyResult {
  body: ImpBody | undefined;
  contentType: string | undefined;
  /** Comment lines for what could not be carried over. */
  notes: string[];
  issues: Issue[];
}

export const MULTIPART_BOUNDARY = '----ApiClientImport';

const TEXT_TYPES: Readonly<Record<string, string>> = { json: 'application/json', text: 'text/plain', xml: 'application/xml' };

/** A short word from the data that is safe to show (the comparison symbols of Thunder's tests included), or a placeholder. */
export const token = (value: unknown): string => (typeof value === 'string' && /^(?:[A-Za-z0-9_.-]{1,24}|<=?|>=?)$/.test(value) ? value : '<other>');

const nothing = (): BodyResult => ({ body: undefined, contentType: undefined, notes: [], issues: [] });

function text(value: unknown, coerce: Coercions): string {
  const result = readText(value);
  if (result.coerced) coerce.count++;
  return result.text;
}

/**
 * A file name that is not relative to the folder of the file: absolute, a drive, "~", or going up. The path is looked at the way the things that use it
 * look at it: the files that name it are written with the spaces and the line breaks around it taken off (a path that starts with a space is not a way
 * to hide a `..`), a name is the same with or without the dots and spaces that Windows drops at its end, and `\` is a separator as well as `/`.
 */
export function leavesFolder(path: string): boolean {
  const clean = path.replace(/[\r\n\t]/g, ' ').trim();
  if (/^(?:[A-Za-z]:|[\\/]|~)/.test(clean)) return true;
  return clean.split(/[\\/]/).some(segment => {
    const name = segment.trim();
    return /^[. ]+$/.test(name) && (name.match(/\./g)?.length ?? 0) >= 2;
  });
}

export function convertBody(value: unknown, coerce: Coercions): BodyResult {
  if (!isRecord(value)) return nothing();
  const type = value['type'] === undefined ? '' : coerce.string(value['type']);
  if (type === '' || type === 'none') return nothing();

  const textType = TEXT_TYPES[type];
  if (textType !== undefined) {
    const raw = text(value['raw'], coerce);
    return raw.trim() === '' ? nothing() : { body: { kind: 'text', contentType: textType, text: raw }, contentType: textType, notes: [], issues: [] };
  }

  if (type === 'formencoded') {
    const fields = readFields(value['form'], coerce).map(({ name, value: fieldValue, enabled }) => ({ name, value: fieldValue, enabled }));
    return fields.length === 0 ? nothing() : { body: { kind: 'form', fields }, contentType: 'application/x-www-form-urlencoded', notes: [], issues: [] };
  }

  if (type === 'formdata') {
    const parts: Extract<ImpBody, { kind: 'multipart' }>['parts'] = [];
    const issues: Issue[] = [];
    for (const field of readFields(value['form'], coerce)) {
      if (field.isFile) parts.push({ name: field.name, filePath: field.value, enabled: field.enabled });
      else parts.push({ name: field.name, value: field.value, enabled: field.enabled });
    }
    for (const field of readFields(value['files'], coerce)) parts.push({ name: field.name, filePath: field.value, enabled: field.enabled });
    for (const part of parts) {
      if (part.filePath !== undefined && part.enabled && leavesFolder(part.filePath)) issues.push({ code: 'TC-FILE-PATH' });
    }
    return parts.length === 0 ? nothing() : { body: { kind: 'multipart', parts }, contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`, notes: [], issues };
  }

  if (type === 'graphql') {
    const graphql = isRecord(value['graphql']) ? value['graphql'] : {};
    const query = text(graphql['query'], coerce);
    const variables = text(graphql['variables'], coerce);
    if (query.trim() === '') return nothing();
    const issues: Issue[] = classifyVariables(variables) === 'text' ? [{ code: 'TC-GRAPHQL-VARS' }] : [];
    return { body: { kind: 'graphql', query, ...(variables.trim() === '' ? {} : { variables }) }, contentType: 'application/json', notes: [], issues };
  }

  return { body: undefined, contentType: undefined, notes: [`[body not imported: ${token(type)}]`], issues: [{ code: 'TC-BODY-UNSUPPORTED', message: `A ${token(type)} body cannot be converted.` }] };
}

interface Field { name: string; value: string; enabled: boolean; isFile: boolean }

function readFields(list: unknown, coerce: Coercions): Field[] {
  const fields: Field[] = [];
  if (!Array.isArray(list)) return fields;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const name = coerce.string(item['name']);
    if (name === '') continue;
    fields.push({ name, value: coerce.string(item['value']), enabled: !coerce.flag(item['isDisabled']), isFile: coerce.flag(item['isFile']) });
  }
  return fields;
}
