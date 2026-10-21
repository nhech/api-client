/**
 * Time and randomness come in through this interface so that the pure code, which may not read the clock or call a random
 * generator, can still make an identifier, and a test can make the same one every time.
 */
export interface Clock {
  /** Milliseconds since 1970-01-01. */
  now(): number;
  /** In [0, 1). */
  random(): number;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: ten characters of time and sixteen of randomness, so that identifiers sort by creation and are practically unique. */
export function newId(clock: Clock): string {
  let time = Math.max(0, Math.floor(clock.now()));
  let head = '';
  for (let index = 0; index < 10; index++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = '';
  for (let index = 0; index < 16; index++) tail += CROCKFORD[Math.min(31, Math.floor(clock.random() * 32))];
  return head + tail;
}

export const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
