/**
 * Findings: what the importer tells the user about everything it could not carry over as is (spec section 7).
 * The codes are the contract with the conversion report; a test keeps this catalog equal to the spec.
 */
export type Severity = 'info' | 'warn' | 'error';

export const FINDING_CATALOG = {
  'TC-LAYOUT-BOTH': { severity: 'warn', summary: 'Both v3 and v4 files exist; v4 is used.' },
  'TC-PARSE-ERROR': { severity: 'warn', summary: 'A file could not be read or was not recognised and was skipped.' },
  'TC-TOO-LARGE': { severity: 'error', summary: 'A limit was exceeded and that part was skipped.' },
  'TC-VERSION-UNKNOWN': { severity: 'info', summary: 'Unknown export version; read by shape.' },
  'TC-HISTORY-SKIPPED': { severity: 'info', summary: 'History entries were skipped.' },
  'TC-ORPHAN-FOLDER': { severity: 'warn', summary: 'A folder pointed to a missing parent and moved to the top.' },
  'TC-ORPHAN-REQUEST': { severity: 'warn', summary: 'A request belonged to no known collection or folder.' },
  'TC-CYCLE': { severity: 'warn', summary: 'A folder cycle was cut.' },
  'TC-DEPTH': { severity: 'warn', summary: 'Folders deeper than the limit were merged upwards.' },
  'TC-METHOD-INVALID': { severity: 'warn', summary: 'Invalid method replaced by GET.' },
  'TC-REQTYPE-UNSUPPORTED': { severity: 'warn', summary: 'WebSocket, SSE or gRPC request skipped.' },
  'TC-PARAM-NOT-IN-URL': { severity: 'warn', summary: 'An enabled query parameter was missing from the URL and was appended.' },
  'TC-PATHPARAM-EMPTY': { severity: 'warn', summary: 'A path parameter has no value; the placeholder was kept.' },
  'TC-HEADER-DEFAULT-DROPPED': { severity: 'info', summary: "Thunder's default headers were dropped." },
  'TC-INHERIT-HEADERS': { severity: 'info', summary: 'Headers inherited from a folder or collection were added to the request.' },
  'TC-INHERIT-AUTH': { severity: 'info', summary: 'Authentication inherited from a folder or collection.' },
  'TC-INHERIT-BASEURL': { severity: 'info', summary: 'A base URL inherited from a folder or collection was prefixed to the URL.' },
  'TC-INHERIT-TESTS': { severity: 'info', summary: 'Tests inherited from a folder or collection were added to the request.' },
  'TC-HEADER-DUP': { severity: 'warn', summary: 'Two headers differ only in letter case; the later one was kept.' },
  'TC-PREREQ-RUN': { severity: 'warn', summary: 'A "run other requests first" setting cannot be carried over.' },
  'TC-JSONPATH-GUESS': { severity: 'info', summary: 'A JSON path had no json. prefix; it was guessed.' },
  'TC-BODY-UNSUPPORTED': { severity: 'warn', summary: 'This body type cannot be converted.' },
  'TC-GRAPHQL-VARS': { severity: 'warn', summary: 'GraphQL variables are not valid JSON and were kept as a string.' },
  'TC-FILE-PATH': { severity: 'warn', summary: 'An attached file is outside the repository or has an absolute path.' },
  'TC-AUTH-OAUTH2': { severity: 'warn', summary: 'OAuth 2.0 settings were not converted.' },
  'TC-AUTH-UNSUPPORTED': { severity: 'warn', summary: 'This authentication type cannot be converted.' },
  'TC-AUTH-HEADER-CONFLICT': { severity: 'warn', summary: 'An Authorization header already exists; the explicit header wins.' },
  'TC-TEST-UNSUPPORTED': { severity: 'warn', summary: 'This assertion has no equivalent.' },
  'TC-SYSVAR-UNMAPPED': { severity: 'info', summary: 'A dynamic variable was left as it is.' },
  'TC-SCRIPT-SKIPPED': { severity: 'warn', summary: 'A script was not imported; it is kept as a comment.' },
  'TC-SETTINGS-DROPPED': { severity: 'info', summary: 'Request or collection settings with no equivalent were dropped.' },
  'TC-ENV-ENCRYPTED': { severity: 'warn', summary: 'An encrypted variable must be entered again.' },
  'TC-ENV-FILE': { severity: 'info', summary: 'An environment refers to a dotenv file; it is not read.' },
  'TC-ENV-DUP': { severity: 'warn', summary: 'A variable name is repeated in one environment.' },
  'TC-SECRET-MOVED': { severity: 'info', summary: 'A secret was moved to the private environment file.' },
  'TC-SECRET-LITERAL': { severity: 'warn', summary: 'A literal secret remains in a shared file.' },
  'TC-NAME-SANITIZED': { severity: 'info', summary: 'A name was changed to be a valid file name.' },
  'TC-NAME-COLLISION': { severity: 'info', summary: 'A name was changed to be unique.' },
  'TC-VALUE-COERCED': { severity: 'info', summary: 'A value of the wrong type was converted.' },
  'TC-LINEBREAK-REPLACED': { severity: 'info', summary: 'A line break inside a one-line value was replaced.' },
  'TC-EXPRESSION-NEUTRALIZED': { severity: 'warn', summary: 'Text between {{ }} that looked like code was made harmless.' },
  'TC-BODY-EXTERNAL': { severity: 'info', summary: 'A body was saved to a separate file because one of its lines starts with # or //.' }
} as const satisfies Record<string, { severity: Severity; summary: string }>;

export type FindingCode = keyof typeof FINDING_CATALOG;

export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  /** Where it happened, as "Collection / Folder / Request" or a path relative to the source. Names are fine; values read from the data never are. */
  readonly where: string;
  readonly message: string;
}

/** A finding with the catalog's severity and summary unless the caller gives its own. */
export function finding(code: FindingCode, where: string, message?: string, severity?: Severity): Finding {
  const entry = FINDING_CATALOG[code];
  return { code, severity: severity ?? entry.severity, where, message: message ?? entry.summary };
}

export const FINDING_CODES = Object.keys(FINDING_CATALOG) as FindingCode[];
