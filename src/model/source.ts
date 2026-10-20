/**
 * Thunder Client data as it is found on disk (spec section 3).
 * Everything is optional and loose on purpose: the importer never trusts a type, it checks every value.
 * Provenance tags of the spec: [FILE] real export, [CODE] extension 3.0.0 source, [FIXT] third-party fixture, [?] not verified.
 */

/** A text field that is a string in some files and an array of lines in others (N1). */
export type Text = string | string[] | undefined;

export interface TcKeyValue {
  name?: string;
  value?: string;
  isDisabled?: boolean;
  /** Path parameter (:name in the URL). */
  isPath?: boolean;
  /** Environment value stored encrypted; never decrypted. */
  encrypted?: boolean;
}

export interface TcAuth {
  /** Missing or "inherit" means: take it from the folder or collection (N16). */
  type?: string;
  bearer?: string;
  basic?: { username?: string; password?: string };
  oauth2?: Record<string, unknown>;
  // apikey, digest, aws, ntlm: field names [?]
}

export interface TcTest {
  type?: string;
  custom?: string;
  action?: string;
  value?: string | number;
}

export interface TcBody {
  type?: string;
  raw?: Text;
  form?: TcKeyValue[];
  files?: TcKeyValue[];
  graphql?: { query?: Text; variables?: Text };
}

export interface TcScripts {
  inlineScripts?: { script?: string[] }[];
  runFilters?: unknown[];
  runRequests?: unknown[];
  options?: { clearCookies?: boolean; skipRequest?: boolean };
}

/** Settings of a collection or a folder; inherited by the requests below (N15 to N19). */
export interface TcSettings {
  docs?: Text;
  envId?: string;
  runOptions?: unknown;
  options?: { baseUrl?: string };
  headers?: TcKeyValue[];
  auth?: TcAuth;
  tests?: TcTest[];
  preReq?: TcScripts;
  postReq?: TcScripts;
}

export interface TcRequest {
  _id?: string;
  /** "history" marks an activity entry, not a request of a collection. */
  colId?: string;
  /** "" is the top of the collection. */
  containerId?: string;
  name?: string;
  url?: string;
  method?: string;
  sortNum?: number;
  created?: string;
  modified?: string;
  headers?: TcKeyValue[];
  params?: TcKeyValue[];
  body?: TcBody;
  auth?: TcAuth;
  tests?: TcTest[];
  docs?: Text;
  /** http | ws | sse | grpc | graphql [?]; missing means http. */
  reqType?: string;
  preReq?: TcScripts;
  postReq?: TcScripts;
  cookies?: unknown;
  settings?: unknown;
}

export interface TcFolder {
  _id?: string;
  name?: string;
  containerId?: string;
  sortNum?: number;
  created?: string;
  settings?: TcSettings;
}

/** A v4 collection file (collections/tc_col_*.json) or one element of v3 thunderCollection.json (then without requests). */
export interface TcCollection {
  _id?: string;
  colName?: string;
  sortNum?: number;
  created?: string;
  folders?: TcFolder[];
  requests?: TcRequest[];
  settings?: TcSettings;
}

export interface TcEnvironment {
  _id?: string;
  name?: string;
  default?: boolean;
  /** global without local: shared by all; global with local: private to this machine (N14). */
  global?: boolean;
  local?: boolean;
  sortNum?: number;
  data?: TcKeyValue[];
  envFile?: string;
}

/** thunder-collection_*.json [FILE] */
export interface TcExportCollection {
  client?: string;
  collectionName?: string;
  dateExported?: string;
  version?: string;
  folders?: TcFolder[];
  requests?: TcRequest[];
}

/** thunder-environment_*.json [FILE] */
export interface TcExportEnvironment {
  client?: string;
  environmentName?: string;
  dateExported?: string;
  version?: string;
  variables?: { name?: string; value?: string }[];
}
