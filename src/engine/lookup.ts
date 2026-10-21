import { lookup as resolveName } from 'node:dns';
import { isLocalHost } from './redirect';
import { EngineError } from './types';

/**
 * A name is not an address. A server that is allowed to redirect the person can send them to `http://anything.example/`, and a name that the
 * server controls can resolve to 127.0.0.1, so the check of the address text in `nextHop` is not enough: after a redirect from a public address the
 * address that the name RESOLVES to is looked at before the connection is made, and a loopback, unspecified or link-local one ends the exchange.
 * The lookup is the one that Node makes by itself; only its answer is checked.
 */
type Resolve = (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void) => void;

export function refuseLocalAddresses(resolve: Resolve = resolveName as unknown as Resolve) {
  return (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void): void => {
    resolve(hostname, options, (error, address, family) => {
      if (error !== null) { callback(error, address, family); return; }
      const found = Array.isArray(address) ? address.map(entry => String((entry as { address?: unknown }).address ?? '')) : [String(address)];
      const local = found.find(isLocalHost);
      if (local !== undefined) {
        callback(new EngineError('network', `The name ${hostname} leads to ${local}, an address on this machine or network, after a redirect from a public address, which is not followed.`, 'Send the request to that address yourself if you mean to reach it, or allow redirects to this machine and private networks in the settings of the request.') as unknown as NodeJS.ErrnoException, '', 0);
        return;
      }
      callback(null, address, family);
    });
  };
}
