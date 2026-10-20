/**
 * Bounds for everything read from disk (spec section 8.1). Past a bound the part is skipped with TC-TOO-LARGE and the rest
 * of the import goes on. The numbers are a starting point to be tuned by measurement.
 */
const MiB = 1024 * 1024;

export const LIMITS = {
  /** One JSON file. */
  maxFileBytes: 20 * MiB,
  /** All files read in one import. */
  maxTotalBytes: 200 * MiB,
  maxFiles: 5000,
  maxRequests: 50_000,
  /** Nesting of the JSON value itself. */
  maxJsonDepth: 64,
  /** One string value. */
  maxStringBytes: 5 * MiB,
  /** A name before it is cut to a slug. */
  maxNameChars: 1000,
  /** Nesting of folders (N6). */
  maxFolderDepth: 32,
  /** Length of a file or folder name made from a name (spec 6.1). */
  maxSlugChars: 60,
  /** Everything the emitter produces, so that inheritance cannot multiply a small input into a huge output. */
  maxOutputBytes: 256 * MiB
} as const;

/** The limits the reader enforces, as plain numbers so that tests can lower them. */
export interface ReaderLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxRequests: number;
  maxJsonDepth: number;
  maxStringBytes: number;
}

export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxFileBytes: LIMITS.maxFileBytes,
  maxTotalBytes: LIMITS.maxTotalBytes,
  maxFiles: LIMITS.maxFiles,
  maxRequests: LIMITS.maxRequests,
  maxJsonDepth: LIMITS.maxJsonDepth,
  maxStringBytes: LIMITS.maxStringBytes
};
