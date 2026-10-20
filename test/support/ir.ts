import type { ImpContainer, ImpEnvironment, ImpRequest, ImpVariable, ImportModel } from '../../src';

/** Builders for the intermediate model, so that emitter tests do not depend on the converter. */
export const imp = (name: string, extra: Partial<ImpRequest> = {}): ImpRequest => ({
  sourceId: `r-${name}`, name, method: 'GET', url: `https://api.example/${encodeURIComponent(name)}`,
  query: [], headers: [], assertions: [], captures: [], notes: [], skippedScripts: [], ...extra
});

export const container = (name: string, requests: ImpRequest[] = [], folders: ImpContainer[] = [], docs?: string): ImpContainer => ({
  name, ...(docs === undefined ? {} : { docs }), requests, folders
});

export const variable = (name: string, value: string, extra: Partial<ImpVariable> = {}): ImpVariable => ({ name, value, secret: false, needsReentry: false, ...extra });

export const env = (name: string, variables: ImpVariable[], extra: Partial<ImpEnvironment> = {}): ImpEnvironment => ({ name, kind: 'named', isDefault: false, variables, ...extra });

export const model = (collections: { name: string; root: ImpContainer }[], environments: ImpEnvironment[] = []): ImportModel => ({
  collections: collections.map(collection => ({ id: `c-${collection.name}`, name: collection.name, root: collection.root })),
  environments, skipped: [], stats: { secretsMoved: 0 }, findings: []
});
