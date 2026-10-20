/**
 * The tool the .http files are written for. The three read the same requests, but spell Thunder's dynamic variables
 * differently (spec 5.7; tried for real in each of them), so the files are written for one of them.
 */
export const TARGETS = ['rest-client', 'httpyac', 'jetbrains'] as const;
export type Target = (typeof TARGETS)[number];

/** REST Client is the one most people use in VS Code. */
export const DEFAULT_TARGET: Target = 'rest-client';

export const TARGET_LABEL: Readonly<Record<Target, string>> = {
  'rest-client': 'REST Client',
  httpyac: 'httpYac',
  jetbrains: 'JetBrains HTTP Client'
};

export const isTarget = (value: unknown): value is Target => typeof value === 'string' && (TARGETS as readonly string[]).includes(value);
