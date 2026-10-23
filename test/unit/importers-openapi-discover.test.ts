import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi } from '../../src/importers/openapi';
import { DISCOVER_ATTEMPTS, DISCOVER_SCRIPTS, discoverDescription, embeddedDescription, guessAddresses, looksLikeHtml, referencesInPage } from '../../src/importers/openapi-discover';

/** From the address of a page of documentation to the description behind it. */

const PAGE = '<!-- HTML for static distribution bundle build -->\n<!DOCTYPE html>\n<html lang="en"><head><title>Swagger UI</title></head><body><div id="swagger-ui"></div>\n<script src="./admin/swagger-ui-bundle.js"> </script>\n<script src="./admin/swagger-ui-init.js"> </script></body></html>';
const SPEC = '{"openapi":"3.0.0","info":{"title":"Admin"},"paths":{"/a":{"get":{}}}}';

test('A web page is told from a description: by its first tag, with a comment or a byte order mark before it', () => {
  assert.equal(looksLikeHtml(PAGE), true);
  assert.equal(looksLikeHtml(`${String.fromCharCode(0xfeff)}<!doctype html><html></html>`), true);
  assert.equal(looksLikeHtml('<html>'), true);
  assert.equal(looksLikeHtml(SPEC), false);
  assert.equal(looksLikeHtml('openapi: 3.0.0\ninfo:\n  title: x <html> in a text\n'), false, 'a description that mentions a tag');
  assert.equal(looksLikeHtml('<?xml version="1.0"?><note/>'), false);
  assert.equal(looksLikeHtml(''), false);
});

test('swagger-ui-express writes the description into its start-up script: it is cut out by its braces, not by its text', () => {
  const doc = '{ "openapi": "3.0.0", "info": { "title": "A } brace, a [ bracket and a \\" quote" }, "paths": { "/a": { "get": {} } } }';
  const script = `window.onload = function() {\n  let options = {\n  "swaggerDoc": ${doc},\n  "customOptions": {}\n  };\n};`;
  assert.equal(embeddedDescription(script, 1_000_000), doc);
  assert.equal(embeddedDescription('window.onload = function() { let options = {}; };', 1_000_000), undefined);
  assert.equal(embeddedDescription('"swaggerDoc": { "openapi": "3.0.0", "paths": {', 1_000_000), undefined, 'a value that never ends');
  assert.equal(embeddedDescription(`"swaggerDoc": ${doc}`, 20), undefined, 'a value past the limit');
});

test('A page and its scripts say where the description is: Swagger UI, Redoc, Scalar and a link; other origins and the bundle are not followed', () => {
  const page = 'https://api.example.test/docs/admin';
  const refs = referencesInPage(PAGE, page);
  assert.deepEqual(refs.scripts, ['https://api.example.test/docs/admin/swagger-ui-init.js'], 'relative to the page, and not the bundle');
  const init = 'SwaggerUIBundle({ url: "/openapi.json", urls: [{ url: "https://elsewhere.test/x.json" }, { "url": "v2/swagger.yaml" }], license: { "url": "https://example.com/license" } })';
  assert.deepEqual(referencesInPage(init, page).specs, ['https://api.example.test/openapi.json', 'https://api.example.test/docs/v2/swagger.yaml']);
  assert.deepEqual(referencesInPage("<redoc spec-url='openapi.yaml'></redoc><a href=\"/other.html\">x</a><a href=\"spec/api.json#top\">spec</a>", page).specs, ['https://api.example.test/docs/openapi.yaml', 'https://api.example.test/docs/spec/api.json']);
  assert.deepEqual(referencesInPage('<script id="api-reference" data-url="/api/openapi.json"></script>', page).specs, ['https://api.example.test/api/openapi.json']);
  assert.deepEqual(referencesInPage('url: "javascript:alert(1).json"', page).specs, [], 'only http and https');
  assert.deepEqual(referencesInPage('url: "//elsewhere.test/openapi.json"', page).specs, [], 'a name without a scheme is still another origin');
  assert.deepEqual(referencesInPage('', page), { specs: [], scripts: [] });
  const many = Array.from({ length: 500 }, (_, index) => `url: "/s${index}.json"`).join(',');
  assert.equal(referencesInPage(many, page).specs.length, DISCOVER_ATTEMPTS, 'a page cannot name more than the limit');
});

test('The addresses to try: beside the page first (NestJS), then the root (Spring, FastAPI), YAML last, never the page itself', () => {
  const nest = guessAddresses('https://api.example.test/docs/admin');
  assert.equal(nest[0], 'https://api.example.test/docs/admin-json');
  assert.ok(nest.includes('https://api.example.test/v3/api-docs') && nest.includes('https://api.example.test/openapi.json'));
  assert.ok(nest.indexOf('https://api.example.test/docs/admin-yaml') > nest.indexOf('https://api.example.test/openapi.json'), 'the YAML after the JSON');
  assert.ok(!nest.includes('https://api.example.test/docs/admin'));
  assert.equal(new Set(nest).size, nest.length);
  assert.ok(nest.length <= DISCOVER_ATTEMPTS);
  const spring = guessAddresses('https://h.test:8443/swagger-ui/index.html?x=1#top');
  assert.ok(spring.includes('https://h.test:8443/swagger-ui/swagger.json') && spring.includes('https://h.test:8443/v3/api-docs'), spring.join('\n'));
  assert.ok(!spring.some(address => address.includes('index.html') || address.includes('?')));
  assert.equal(guessAddresses('https://h.test/')[0], 'https://h.test/v3/api-docs', 'a bare address has only the root ones');
  assert.deepEqual(guessAddresses('ftp://h.test/x'), []);
  assert.deepEqual(guessAddresses('not an address'), []);
});

/** A fetch that answers from a table and remembers what was asked. */
const server = (pages: Record<string, string>) => {
  const asked: string[] = [];
  const fetch = async (url: string): Promise<string> => {
    asked.push(url);
    const text = pages[url];
    if (text === undefined) throw new Error('the server answered 404 Not Found');
    return text;
  };
  return { asked, fetch };
};
const live = new AbortController().signal;
const HOST = 'https://api.example.test';

test('An address that is the description is used as it is, and nothing else is asked', async () => {
  const { asked, fetch } = server({});
  const result = await discoverDescription(`${HOST}/openapi.json`, SPEC, fetch, live);
  assert.deepEqual(result.found, { text: SPEC, from: `${HOST}/openapi.json` });
  assert.deepEqual(asked, []);
});

test('A Swagger UI page of swagger-ui-express: the description is in the start-up script', async () => {
  const init = `window.onload = function() {\n  let options = {\n  "swaggerDoc": ${SPEC}\n  };\n};`;
  const { asked, fetch } = server({ [`${HOST}/docs/admin/swagger-ui-init.js`]: init });
  const result = await discoverDescription(`${HOST}/docs/admin`, PAGE, fetch, live);
  assert.deepEqual(result.found, { text: SPEC, from: `${HOST}/docs/admin/swagger-ui-init.js` });
  assert.deepEqual(asked, [`${HOST}/docs/admin/swagger-ui-init.js`]);
  assert.equal(result.page, true);
});

test('A page that points at a description, and a page that does not but whose program serves it beside it', async () => {
  const pointing = await discoverDescription(`${HOST}/docs/`, '<html><body><script>SwaggerUIBundle({ url: "/api/v1/spec.json" })</script></body></html>', server({ [`${HOST}/api/v1/spec.json`]: SPEC }).fetch, live);
  assert.equal(pointing.found?.from, `${HOST}/api/v1/spec.json`);
  const beside = server({ [`${HOST}/docs/admin-json`]: SPEC });
  const result = await discoverDescription(`${HOST}/docs/admin`, '<html><body>nothing here</body></html>', beside.fetch, live);
  assert.deepEqual(result.found, { text: SPEC, from: `${HOST}/docs/admin-json` });
  assert.deepEqual(beside.asked, [`${HOST}/docs/admin-json`], 'the first guess answered');
  const spring = await discoverDescription(`${HOST}/swagger-ui/index.html`, '<html></html>', server({ [`${HOST}/v3/api-docs`]: SPEC }).fetch, live);
  assert.equal(spring.found?.from, `${HOST}/v3/api-docs`);
});

test('What a page says is not an instruction: another origin is not asked, and no more than the limit is', async () => {
  const hostile = `<html><body><script>SwaggerUIBundle({ url: "https://internal.test/openapi.json", urls: [${Array.from({ length: 300 }, (_, index) => `{ url: "/x${index}.json" }`).join(',')}] })</script><script src="https://evil.test/swagger-ui-init.js"></script></body></html>`;
  const { asked, fetch } = server({});
  const result = await discoverDescription(`${HOST}/docs`, hostile, fetch, live);
  assert.equal(result.found, undefined);
  assert.equal(result.page, true);
  assert.ok(asked.every(url => url.startsWith(`${HOST}/`)), asked.filter(url => !url.startsWith(`${HOST}/`)).join('\n'));
  assert.ok(asked.length <= DISCOVER_ATTEMPTS + DISCOVER_SCRIPTS, `${asked.length} addresses were asked`);
  assert.equal(result.tried[0], `${HOST}/docs`);
});

test('When nothing is found it says whether the address was a page, and what it asked; a cancelled search stops', async () => {
  const page = await discoverDescription(`${HOST}/docs`, PAGE, server({}).fetch, live);
  assert.deepEqual([page.found, page.page], [undefined, true]);
  assert.ok(page.tried.length > 3 && page.tried.includes(`${HOST}/docs-json`), page.tried.join('\n'));
  const text = await discoverDescription(`${HOST}/data`, '{"statusCode":404}', server({}).fetch, live);
  assert.deepEqual([text.found, text.page], [undefined, false], 'an answer that is not a page is left to the reader to explain');
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(discoverDescription(`${HOST}/docs`, PAGE, server({}).fetch, stop.signal), /abort/i);
  const reports: string[] = [];
  await discoverDescription(`${HOST}/docs`, '<html></html>', server({ [`${HOST}/docs-json`]: SPEC }).fetch, live, url => reports.push(url));
  assert.deepEqual(reports, [`${HOST}/docs-json`], 'each address is reported as it is asked');
});

test('A description that names no server gets the address it was fetched from, a relative server is put after it, and a file is as before', () => {
  const bare = (extra: Record<string, unknown> = {}) => JSON.stringify({ openapi: '3.0.0', info: { title: 'X' }, paths: { '/a': { get: {} } }, ...extra });
  const origin = 'https://api.example.test:8443';
  const fetched = parseOpenApi(bare(), { origin });
  assert.ok(fetched.ok);
  assert.deepEqual(fetched.imported.environments.map(item => [item.name, item.vars[0]?.value]), [['api.example.test:8443', origin]]);
  assert.ok(fetched.imported.notes.some(note => /baseUrl is the address that it was fetched from, https:\/\/api\.example\.test:8443/.test(note.message)));
  const relative = parseOpenApi(bare({ servers: [{ url: '/api/v1' }] }), { origin });
  assert.ok(relative.ok);
  assert.equal(relative.imported.environments[0]?.vars[0]?.value, `${origin}/api/v1`);
  assert.ok(relative.imported.notes.some(note => /put after the address of the description/.test(note.message)));
  const absolute = parseOpenApi(bare({ servers: [{ url: 'https://prod.example.test/v2' }] }), { origin });
  assert.ok(absolute.ok);
  assert.equal(absolute.imported.environments[0]?.vars[0]?.value, 'https://prod.example.test/v2', 'a server that the description gives is trusted over the address');
  const swagger2 = parseOpenApi(JSON.stringify({ swagger: '2.0', info: { title: 'X' }, basePath: '/v2', paths: { '/a': { get: {} } } }), { origin });
  assert.ok(swagger2.ok);
  assert.equal(swagger2.imported.environments[0]?.vars[0]?.value, `${origin}/v2`);
  const file = parseOpenApi(bare());
  assert.ok(file.ok);
  assert.deepEqual(file.imported.environments.map(item => [item.name, item.vars[0]?.value]), [['Local', 'http://localhost']]);
  for (const bad of ['javascript:alert(1)', 'https://h.test/path', 'https://user:pw@h.test', 'ftp://h.test', 'https://']) {
    const refused = parseOpenApi(bare(), { origin: bad });
    assert.ok(refused.ok && refused.imported.environments[0]?.vars[0]?.value === 'http://localhost', bad);
  }
});

test('A YAML description written with anchors is refused with a hint to use the JSON of the program', () => {
  const result = parseOpenApi('openapi: 3.0.0\ninfo:\n  title: &t X\npaths: {}\n');
  assert.ok(!result.ok);
  assert.match(result.error, /anchors/);
  assert.match(result.error, /served as JSON too/);
});
