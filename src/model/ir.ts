/**
 * The intermediate model (spec section 4.1): what the reader and normaliser hand to an emitter.
 * Collections, folders, requests and environments arrive already ordered (N5), inheritance already applied (N15 to N19).
 */
import type { Finding } from './findings';

export interface ImportModel {
  collections: ImpCollection[];
  environments: ImpEnvironment[];
  /** Requests that could not be carried over (WebSocket, SSE, gRPC, unknown kinds), for the report. */
  skipped: ImpSkipped[];
  stats: { secretsMoved: number };
  findings: Finding[];
}

export interface ImpSkipped { collection: string; request: string; reason: string }

export interface ImpCollection {
  id: string;
  name: string;
  docs?: string;
  root: ImpContainer;
}

export interface ImpContainer {
  name: string;
  docs?: string;
  requests: ImpRequest[];
  folders: ImpContainer[];
}

export interface ImpQuery { name: string; value: string; enabled: boolean }
export interface ImpHeader { name: string; value: string; enabled: boolean; secret: boolean }

export interface ImpRequest {
  sourceId: string;
  name: string;
  docs?: string;
  method: string;
  /** After N2 (query once) and N3 (path parameters filled in) and N15 (base URL). */
  url: string;
  query: ImpQuery[];
  headers: ImpHeader[];
  body?: ImpBody;
  auth?: ImpAuth;
  assertions: ImpAssertion[];
  captures: ImpCapture[];
  /** Whole comment lines (`# @assert status == 200`) that go after the documentation, already clean and on one line each; for what the structured fields above cannot say. */
  directives?: string[];
  /** Comment lines for what was not carried over, such as "[auth oauth2 not imported]". One line each, already clean. */
  notes: string[];
  skippedScripts: { phase: 'pre' | 'post'; lines: string[]; from?: string }[];
}

export type ImpBody =
  | { kind: 'text'; contentType: string; text: string }
  | { kind: 'form'; fields: { name: string; value: string; enabled: boolean }[] }
  | { kind: 'multipart'; parts: { name: string; value?: string; filePath?: string; enabled: boolean }[] }
  | { kind: 'graphql'; query: string; variables?: string };

/** A value that may be a secret; the flag decides whether it goes to the private environment file (section 8.3). */
export interface Secretish { value: string; secret: boolean }

export type ImpAuth =
  | { kind: 'bearer'; token: Secretish }
  | { kind: 'basic'; username: Secretish; password: Secretish }
  | { kind: 'unsupported'; type: string };

export type AssertTarget = 'status' | 'time' | 'body' | 'header' | 'json';
export interface ImpAssertion { target: AssertTarget; name?: string; op: string; expected: string }

export type CaptureScope = 'active' | 'local' | 'global';
export interface ImpCapture {
  variable: string;
  scope: CaptureScope;
  /** json $.x | body | header x | cookie x | value literal | null | delete (the grammar of spec 6.2a). */
  source: string;
}

export type EnvironmentKind = 'shared' | 'named' | 'private';
export interface ImpVariable { name: string; value: string; secret: boolean; needsReentry: boolean }
export interface ImpEnvironment {
  name: string;
  kind: EnvironmentKind;
  isDefault: boolean;
  variables: ImpVariable[];
  envFile?: string;
  /** Made by the importer (the secrets it moved), not read from Thunder Client. */
  synthetic?: boolean;
}
