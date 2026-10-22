/** Whether an address has a user name or a password in it (`https://user:password@host/`). */
export const hasUserinfo = (address: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(address.trim());

/** An address as it can be shown in a message or a log: the user name and the password in it are not. */
export const withoutUserinfo = (address: string): string => address.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@');
