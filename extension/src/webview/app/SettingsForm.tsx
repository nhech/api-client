import { DEFAULT_SETTINGS, type Settings, type SettingsOverride } from '../../../../src/core/model';
import { Choice } from './components';
import { edit } from './store';

type BooleanKey = 'followRedirects' | 'allowPrivateRedirects' | 'rejectUnauthorized' | 'encodeUrl' | 'cookies';
type NumberKey = 'timeoutMs' | 'maxRedirects';

/** `warning` is shown when the setting has the value `warnWhen` (false unless said). */
const BOOLEANS: { key: BooleanKey; label: string; warning?: string; warnWhen?: boolean }[] = [
  { key: 'followRedirects', label: 'Follow redirects' },
  { key: 'allowPrivateRedirects', label: 'Follow a redirect from the internet to this machine or a private network', warning: 'A server could send the request to a service that only you can reach (a database, a router, the metadata service of a cloud machine).', warnWhen: true },
  { key: 'rejectUnauthorized', label: 'Verify the certificate of the server', warning: 'The certificate is not checked, so anyone on the network could pretend to be the server and read what is sent, passwords included.' },
  { key: 'encodeUrl', label: 'Encode the address and the query parameters' },
  { key: 'cookies', label: 'Send and keep cookies' }
];
const NUMBERS: { key: NumberKey; label: string; hint: string }[] = [
  { key: 'timeoutMs', label: 'Timeout (milliseconds)', hint: 'For the whole request, redirects included.' },
  { key: 'maxRedirects', label: 'Most redirects to follow', hint: '' }
];
const MEGABYTE = 1024 * 1024;

const OPTIONS = [{ value: 'inherit', label: 'Inherit' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] as const;
const describe = (value: boolean): string => (value ? 'Yes' : 'No');

/**
 * The settings of a request, a folder or a collection. A setting that is not filled in is inherited from the level above (the
 * workspace, the collection, the folder), down to the defaults, and its key is not in the file at all.
 */
export function SettingsForm(props: { settings: SettingsOverride; path: ('settings' | string)[]; what: string }) {
  const { settings } = props;
  const at = (key: keyof Settings): (string | number)[] => [...props.path, key];
  const setNumber = (key: keyof Settings, text: string, scale = 1): void => {
    if (text.trim() === '') { edit({ op: 'unset', path: at(key) }); return; }
    const number = Number(text);
    if (Number.isFinite(number) && number >= 0) edit({ op: 'set', path: at(key), value: Math.round(number * scale) });
  };
  return (
    <div class="form">
      <p class="hint">What is not filled in here is inherited from above this {props.what}, and from the defaults at the top.</p>
      {NUMBERS.map(field => (
        <label class="field">
          <span class="field-label">{field.label}</span>
          <input type="text" inputMode="numeric" placeholder={`Inherit (${DEFAULT_SETTINGS[field.key]})`} value={settings[field.key] === undefined ? '' : String(settings[field.key])} spellcheck={false} onChange={event => setNumber(field.key, (event.target as HTMLInputElement).value)} />
          {field.hint !== '' ? <span class="hint">{field.hint}</span> : null}
        </label>
      ))}
      <label class="field">
        <span class="field-label">Largest response to keep in memory (megabytes)</span>
        <input type="text" inputMode="decimal" placeholder={`Inherit (${DEFAULT_SETTINGS.responseLimitBytes / MEGABYTE})`} value={settings.responseLimitBytes === undefined ? '' : String(Math.round((settings.responseLimitBytes / MEGABYTE) * 100) / 100)} spellcheck={false} onChange={event => setNumber('responseLimitBytes', (event.target as HTMLInputElement).value, MEGABYTE)} />
        <span class="hint">A larger response is kept in a file, up to 256 MB.</span>
      </label>
      {BOOLEANS.map(field => (
        <>
          <Choice label={field.label} value={settings[field.key] === undefined ? 'inherit' : String(settings[field.key])} options={OPTIONS.map(option => (option.value === 'inherit' ? { value: option.value, label: `Inherit (${describe(DEFAULT_SETTINGS[field.key])})` } : option))}
            onChange={value => (value === 'inherit' ? edit({ op: 'unset', path: at(field.key) }) : edit({ op: 'set', path: at(field.key), value: value === 'true' }))} />
          {field.warning !== undefined && settings[field.key] === (field.warnWhen ?? false) ? <p class="hint warn" role="alert">{field.warning}</p> : null}
        </>
      ))}
    </div>
  );
}
