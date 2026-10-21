/**
 * The values of the YAML subset the client's files use. Every scalar is a string (`true`, `10` and `null` are the strings
 * "true", "10" and "null": the schema layer decides what they mean), a mapping keeps its keys in file order, and a sequence is
 * an array.
 */
export type YValue = string | YValue[] | YMap;
export type YMap = Map<string, YValue>;

export interface YamlLimits {
  /** Size of the text in UTF-8 bytes. */
  maxBytes: number;
  /** Nesting of mappings and sequences. */
  maxDepth: number;
  /** Mapping entries, sequence items and scalars together. */
  maxNodes: number;
}

export const DEFAULT_YAML_LIMITS: YamlLimits = { maxBytes: 5 * 1024 * 1024, maxDepth: 64, maxNodes: 100_000 };

/** Where and why a text is not in the subset; the line and the column count from 1. */
export interface YamlError {
  line: number;
  column: number;
  message: string;
}

export type YamlResult = { ok: true; value: YValue } | { ok: false; error: YamlError };
