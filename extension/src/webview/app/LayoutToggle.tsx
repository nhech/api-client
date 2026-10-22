import { signal } from '@preact/signals';
import { layout, type HostPort } from './store';

/** Whether the editor is wide enough for the answer to be beside the request when the layout is `auto` (the same width as the style sheet uses). */
const query = typeof matchMedia === 'function' ? matchMedia('(min-width: 1000px)') : undefined;
const wide = signal(query?.matches ?? true);
query?.addEventListener('change', event => { wide.value = event.matches; });

/**
 * Two buttons that say where the answer is drawn: beside the request, or below it as in Postman. The one that is in effect is pressed; pressing the other
 * one chooses it, and pressing the chosen one again goes back to the width of the editor deciding.
 */
export function LayoutToggle(props: { port: HostPort }) {
  const chosen = layout.value;
  const effective = chosen === 'auto' ? (wide.value ? 'beside' : 'below') : chosen;
  const choose = (value: 'below' | 'beside'): void => props.port.post({ type: 'layout', layout: chosen === value ? 'auto' : value });
  return (
    <div class="segmented layout-toggle" role="group" aria-label="Where the answer is shown">
      <button type="button" aria-pressed={effective === 'below'} title="The answer below the request, as in Postman" onClick={() => choose('below')}>Below</button>
      <button type="button" aria-pressed={effective === 'beside'} title="The answer beside the request" onClick={() => choose('beside')}>Beside</button>
    </div>
  );
}
