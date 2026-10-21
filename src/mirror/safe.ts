import { neutralizeExpressions } from '../convert/expressions';
import type { Clock } from '../core/clock';
import { dynamicValue } from '../core/vars';

/**
 * What a `.http` tool does with text between `{{` and `}}`. REST Client, httpYac and the JetBrains client are made to run in a place of trust,
 * and they read more into those braces than the client does: httpYac runs them as JavaScript, and `{{$processEnv NAME}}` (REST Client and httpYac)
 * puts an environment variable into the request. A request that arrives with a cloned repository can carry such text in its address, a header or a
 * body, so the mirror never writes it as it is: only a plain variable name (no dot, so no `process.env.X`) and the dynamic words that the client itself
 * understands, with arguments it accepts, are written as they are. Anything else has its braces separated (`{ {` and `} }`), which every tool reads
 * as ordinary text. A `{{` that is never closed is separated too, since httpYac starts a script at it.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Nothing here depends on the clock: it only decides whether the arguments of a dynamic word are valid. */
const NO_CLOCK: Clock = { now: () => 0, random: () => 0 };

const isWrittenAsIs = (inner: string): boolean => {
  const name = inner.trim();
  return NAME.test(name) || (name.startsWith('$') && dynamicValue(name, NO_CLOCK) !== undefined);
};

/** The text of a block of the mirror with every `{{ }}` that a tool might run made harmless. */
export const httpSafe = (text: string): string => neutralizeExpressions(text, isWrittenAsIs).text;
