import { importSource } from './import';
import type { ImportPipelineOptions } from './import';
import type { ImportResult } from './pipeline';
import type { ImportModel } from './model/ir';
import { readSource } from './reader/fs-reader';
import type { ReadSourceOptions } from './reader/fs-reader';

export interface RunOptions extends ImportPipelineOptions, ReadSourceOptions {}

/**
 * Reads a Thunder Client data folder or export files from disk and converts them. Rejects with a SourceError when the path
 * cannot be read. Nothing is written: the result holds the files, and the writer (write/writer.ts) puts them on disk.
 */
export async function importFromPath(input: string | readonly string[], options: RunOptions = {}): Promise<ImportResult & { model: ImportModel }> {
  const { signal, limits, ...pipeline } = options;
  const source = await readSource(input, { ...(signal === undefined ? {} : { signal }), ...(limits === undefined ? {} : { limits }) });
  return importSource(source, pipeline);
}
