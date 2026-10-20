#!/usr/bin/env node
import { REPORT_FILE } from './emit';
import { SourceError } from './reader/fs-reader';
import { importFromPath } from './run';
import type { ConflictPolicy } from './pipeline';
import { DEFAULT_TARGET, TARGETS, isTarget } from './model/target';
import type { Target } from './model/target';
import { WriteError, planWrite, writeFiles } from './write/writer';

/**
 * Command line: `thunder-import <source...> [--write]`. Without `--write` it is a dry run: it prints the report and the list of
 * files and changes nothing. It prints names and counts, never the content of a file, so its output is safe to paste.
 */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd(): string;
}

const USAGE = `Usage: thunder-import <source>... [options]

  <source>               a Thunder Client data folder, or one or more exported .json files

Options:
  --write                write the files (without it nothing is written: a dry run)
  --workspace <folder>   folder the files are written in (default: the current folder)
  --out <folder>         folder inside the workspace that receives the files (default: api)
  --policy <policy>      new-folder (default), skip-existing or overwrite
  --no-move-secrets      keep literal secrets in the shared files instead of moving them
  --target <tool>        the tool the files are written for: rest-client (default), httpyac or jetbrains.
                         Thunder's dynamic variables ({{#guid}}, {{#number, 1, 9}}) are spelled the way that tool reads them
  -h, --help             show this text
`;

interface Parsed {
  sources: string[];
  write: boolean;
  workspace: string | undefined;
  out: string;
  policy: ConflictPolicy;
  moveSecrets: boolean;
  target: Target;
  help: boolean;
}

const POLICIES: readonly ConflictPolicy[] = ['new-folder', 'skip-existing', 'overwrite'];

function parse(argv: readonly string[]): Parsed | string {
  const parsed: Parsed = { sources: [], write: false, workspace: undefined, out: 'api', policy: 'new-folder', moveSecrets: true, target: DEFAULT_TARGET, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = (): string | undefined => argv[++i];
    switch (arg) {
      case '--write': parsed.write = true; break;
      case '--no-move-secrets': parsed.moveSecrets = false; break;
      case '--target': {
        const v = value();
        if (!isTarget(v)) return `--target must be one of ${TARGETS.join(', ')}.`;
        parsed.target = v;
        break;
      }
      case '-h': case '--help': parsed.help = true; break;
      case '--workspace': { const v = value(); if (v === undefined) return 'Missing value for --workspace.'; parsed.workspace = v; break; }
      case '--out': { const v = value(); if (v === undefined) return 'Missing value for --out.'; parsed.out = v; break; }
      case '--policy': {
        const v = value();
        const policy = POLICIES.find(candidate => candidate === v);
        if (policy === undefined) return `--policy must be one of ${POLICIES.join(', ')}.`;
        parsed.policy = policy;
        break;
      }
      default:
        if (arg.startsWith('-')) return `Unknown option ${arg}.`;
        parsed.sources.push(arg);
    }
  }
  return parsed;
}

/** Runs the command and returns the exit code: 0 done, 1 the import failed, 2 the command line is wrong. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === 'string') { io.stderr(`${parsed}\n\n${USAGE}`); return 2; }
  if (parsed.help) { io.stdout(USAGE); return 0; }
  if (parsed.sources.length === 0) { io.stderr(`Give a Thunder Client folder or exported files.\n\n${USAGE}`); return 2; }

  try {
    const result = await importFromPath(parsed.sources.length === 1 ? parsed.sources[0] as string : parsed.sources, {
      moveSecrets: parsed.moveSecrets, targetDir: parsed.out, conflictPolicy: parsed.policy, target: parsed.target
    });
    io.stdout(result.files.find(file => file.path === REPORT_FILE)?.content ?? '');
    const request = { workspaceRoot: parsed.workspace ?? io.cwd(), targetDir: parsed.out, policy: parsed.policy, files: result.files } as const;
    if (!parsed.write) {
      const plan = await planWrite(request);
      io.stdout(`\nDry run. ${plan.files.filter(file => file.action !== 'skip').length} files would be written to ${plan.targetDir}/:\n`);
      for (const file of plan.files) io.stdout(`  ${file.action.padEnd(9)} ${file.path}\n`);
      io.stdout('\nRun again with --write to write them.\n');
      return 0;
    }
    const outcome = await writeFiles(request);
    io.stdout(`\nWrote ${outcome.written.length + outcome.overwritten.length} files to ${outcome.plan.targetDir}/ (${outcome.skipped.length} left as they were).\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof SourceError || error instanceof WriteError ? error.message : 'The import stopped because of an unexpected problem. Nothing was written.'}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2), {
    stdout: text => { process.stdout.write(text); },
    stderr: text => { process.stderr.write(text); },
    cwd: () => process.cwd()
  }).then(code => { process.exitCode = code; });
}
