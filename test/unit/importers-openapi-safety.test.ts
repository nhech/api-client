import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi } from '../../src/importers/openapi';
import type { Imported, ImportedFolder } from '../../src/importers/types';

/** What a description may carry that must not reach a file that Git tracks, or change the address a request goes to. */

const parse = (value: unknown): Imported => {
  const result = parseOpenApi(JSON.stringify(value));
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.imported;
};
const requestsOf = (imported: Imported): ImportedFolder['requests'] => {
  const all: ImportedFolder['requests'] = [];
  const visit = (folder: ImportedFolder): void => { all.push(...folder.requests); folder.folders.forEach(visit); };
  imported.collections.forEach(visit);
  return all;
};

test('Credentials that the description gives as examples are moved to secret variables of the collection, as for a Postman file', () => {
  const key = 'live-key-4eC39HqLyjWDarjtT1zdp7dc';
  const password = 'correct-horse-battery-staple';
  const imported = parse({
    openapi: '3.0.3', info: { title: 'Keys' }, servers: [{ url: 'https://api.example.test' }],
    paths: {
      '/pay': {
        post: {
          parameters: [{ name: 'api_key', in: 'query', example: key }, { name: 'X-Api-Key', in: 'header', example: key }],
          requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: { user: 'ann', password } } } },
          responses: {}
        }
      }
    }
  });
  const text = JSON.stringify(requestsOf(imported));
  assert.ok(!text.includes(key.slice(8)), 'the key is in no request');
  assert.ok(!text.includes(password), 'the password is in no request');
  const collection = imported.collections[0] as ImportedFolder;
  const secrets = collection.container.vars.filter(variable => variable.secret);
  assert.ok(secrets.some(variable => variable.value === key), 'the key is the value of a secret variable');
  assert.ok(secrets.some(variable => variable.value === password), 'so is the password');
  const request = requestsOf(imported)[0];
  assert.match(request?.query[0]?.value ?? '', /^\{\{[\w-]+\}\}$/);
  assert.ok(imported.notes.some(note => /moved to secret variables of the collection/.test(note.message)));
});

test('A server address with a user name or a password in it is a secret variable of its environment', () => {
  const imported = parse({ openapi: '3.0.3', info: { title: 'Userinfo' }, servers: [{ url: 'https://ann:s3cr3t-value@api.example.test/v1' }, { url: 'https://api.example.test/v2' }], paths: { '/a': { get: {} } } });
  const [first, second] = imported.environments;
  assert.equal(first?.vars[0]?.secret, true);
  assert.equal(first?.vars[0]?.value, 'https://ann:s3cr3t-value@api.example.test/v1');
  assert.equal(second?.vars[0]?.secret, false);
  assert.ok(imported.notes.some(note => /has a user name or a password in it/.test(note.message)));
  assert.ok(!JSON.stringify(imported.notes).includes('s3cr3t-value'), 'the notes never repeat it');
});

test('A path parameter whose example is a dot segment is not given that value: it would change the path', () => {
  const imported = parse({
    openapi: '3.0.3', info: { title: 'Dots' },
    paths: {
      '/projects/{project}/members/{member}/{keep}': {
        delete: {
          parameters: [
            { name: 'project', in: 'path', required: true, example: '..' },
            { name: 'member', in: 'path', required: true, example: '%2E%2e' },
            { name: 'keep', in: 'path', required: true, example: '.hidden' }
          ],
          responses: {}
        }
      }
    }
  });
  const rows = requestsOf(imported)[0]?.pathParams.map(item => `${item.name}=${item.value}`);
  assert.deepEqual(rows, ['project={{project}}', 'member={{member}}', 'keep=.hidden']);
});
