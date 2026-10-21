import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSummary, renderNotes } from '../../src/importers/report';
import { emptyImported, type Imported } from '../../src/importers/types';

/** The words an import uses to say what it did. */

test('The summary counts what was found, with the right plural, and says nothing when there is nothing', () => {
  assert.equal(importSummary({ collections: 1, folders: 2, requests: 4, environments: 1 }), '1 collection, 2 folders, 4 requests, 1 environment');
  assert.equal(importSummary({ collections: 2, folders: 0, requests: 1, environments: 0 }), '2 collections, 1 request');
  assert.equal(importSummary({ collections: 0, folders: 0, requests: 0, environments: 3 }), '3 environments');
  assert.equal(importSummary({ collections: 0, folders: 0, requests: 0, environments: 0 }), 'nothing');
});

test('The document lists the notes, one line each, and says when everything came across', () => {
  const clean: Imported = emptyImported();
  assert.equal(renderNotes('Postman', clean), '# Import from Postman\n\nFound: nothing.\n\nEverything was carried over.\n');
  const imported: Imported = {
    collections: [{ container: { id: '', name: 'Shop', docs: '', baseUrl: '', headers: [], auth: { kind: 'inherit' }, vars: [], scripts: { pre: '', post: '' }, tests: [], settings: {}, order: [] }, requests: [], folders: [] }],
    environments: [], skipped: 2,
    notes: [{ where: 'Shop / Digest', message: 'The digest authentication is not supported.' }, { where: '', message: '3 more notes are not listed.' }, { where: 'Shop\n# not a heading', message: 'A\u202eB\nsecond line' }]
  };
  assert.equal(renderNotes('Thunder Client', imported), [
    '# Import from Thunder Client', '', 'Found: 1 collection.', '2 requests were left out because they cannot be sent from here (WebSocket, server-sent events, gRPC).', '',
    '## What was not carried over, or was changed (3)', '',
    '- **Shop / Digest**: The digest authentication is not supported.', '- 3 more notes are not listed.', '- **Shop # not a heading**: A?B second line', ''
  ].join('\n'));
  assert.match(renderNotes('x', { ...clean, skipped: 1 }), /1 request was left out because it cannot be sent from here/);
});
