import { convertTree } from './convert';
import { emitHttp, REPORT_FILE } from './emit';
import type { EmitOptions } from './emit';
import { REST_CLIENT_PRIVATE_SETTINGS_FILE } from './emit/env';
import { renderReport } from './emit/report';
import type { Finding } from './model/findings';
import type { ImportModel } from './model/ir';
import { buildTree } from './normalize/build';
import type { BuildTreeOptions } from './normalize/build';
import { DEFAULT_IMPORT_OPTIONS } from './pipeline';
import type { ImportOptions, ImportResult, ImportSummary, TcSource } from './pipeline';

export interface ImportPipelineOptions extends Partial<ImportOptions> {
  tree?: BuildTreeOptions;
  emit?: EmitOptions;
}

const countFolders = (model: ImportModel): number => {
  let total = 0;
  const stack = model.collections.map(collection => collection.root);
  for (let container = stack.pop(); container !== undefined; container = stack.pop()) {
    total += container.folders.length;
    for (const folder of container.folders) stack.push(folder);
  }
  return total;
};

/**
 * The whole conversion from what the reader found to the files to write, with no disk and no VS Code: reader output in,
 * `OutputFile[]` out. The findings are in the order of the stages (reader, tree, conversion, files) and the report is built
 * last, from all of them. Pure and deterministic.
 */
export function importSource(source: TcSource, options: ImportPipelineOptions = {}): ImportResult & { model: ImportModel } {
  const chosen: ImportOptions = {
    moveSecrets: options.moveSecrets ?? DEFAULT_IMPORT_OPTIONS.moveSecrets,
    targetDir: options.targetDir ?? DEFAULT_IMPORT_OPTIONS.targetDir,
    conflictPolicy: options.conflictPolicy ?? DEFAULT_IMPORT_OPTIONS.conflictPolicy,
    target: options.target ?? DEFAULT_IMPORT_OPTIONS.target
  };
  const tree = buildTree(source, options.tree);
  const model = convertTree(tree, { moveSecrets: chosen.moveSecrets, target: chosen.target });
  const emitted = emitHttp(model, { ...options.emit, target: chosen.target });

  const findings: Finding[] = [...source.findings, ...tree.findings, ...model.findings, ...emitted.findings];
  const reenter = model.environments.flatMap(environment => environment.variables.filter(variable => variable.needsReentry).map(variable => ({ environment: environment.name, variable: variable.name })));
  const summary: ImportSummary = {
    collections: model.collections.length,
    folders: countFolders(model),
    requests: emitted.requests,
    environments: emitted.environments.length,
    skippedRequests: model.skipped.length,
    secretsMoved: model.stats.secretsMoved,
    variablesToReenter: reenter.length
  };
  const report = renderReport({ summary, findings, collections: emitted.collections, environments: emitted.environments, skipped: model.skipped, reenter, options: chosen, truncated: emitted.truncated, restClientPrivate: emitted.files.some(file => file.path === REST_CLIENT_PRIVATE_SETTINGS_FILE) });
  return { files: [...emitted.files, { path: REPORT_FILE, content: report }], findings, summary, model };
}
