import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHttp } from '../../src/format/http/parse';
import { parseHttp as reference } from '../support/http-parser';

/** The reader of .http files that the program uses, and the reference reader that the tests of the emitters use, which was written apart from it: they must agree. */

const SAMPLES = [
  '',
  '### One\nGET https://a.test/\n',
  '# preamble\n\n### Two\n# @name two\n# a comment\n// another\n# @assert status == 200\n# @capture id = json $.id\n# @other thing\nPOST https://a.test/p?q=1\nContent-Type: application/json\nX-A: 1\nX-A: 2\nNoColon\n\n{"a":1}\n\n',
  '### No request line\n# only comments\n\n### Three\nDELETE /x\n',
  '### Body from a file\nPOST /f\n\n< ./data.json\n',
  '### Many blank\nPUT /m\nH: v\n\n\nline 1\n\nline 3\n\n\n',
  '### Windows\r\n# @name win\r\nGET /w\r\nH: v\r\n\r\nbody\r\n',
  '### Only method\nGET\n',
  '### Header with colon in value\nGET /c\nAuthorization: Bearer a:b:c\n',
  '###\nGET /empty-title\n',
  '### Comment between headers\nGET /h\nA: 1\n# not a header\nB: 2\n'
];

test('Both readers see the same thing in every sample', () => {
  for (const sample of SAMPLES) {
    // The reference reader does not know carriage returns: the program reads a file that a checkout turned into Windows line ends as well.
    assert.deepEqual(parseHttp(sample), reference(sample.replace(/\r\n?/g, '\n')), JSON.stringify(sample));
  }
});

test('The reader takes a Windows file as it takes the same file with line feeds', () => {
  const unix = '### T\n# @name n\nGET /a?x=1\nH: v\n\nbody line\n';
  assert.deepEqual(parseHttp(unix.replace(/\n/g, '\r\n')), parseHttp(unix));
  assert.deepEqual(parseHttp('### T\rGET /a\r').requests.map(request => request.url), ['/a']);
});

test('A request is what is between two lines that start with three hashes, and what follows the request line is headers up to a blank line and then the body', () => {
  const parsed = parseHttp('# top\n### A\nGET /a\nH: 1\n\nbody\n### B\nPOST /b\n');
  assert.deepEqual(parsed.preamble, ['# top']);
  assert.deepEqual(parsed.requests.map(request => [request.title, request.method, request.url, request.headers, request.body]), [['A', 'GET', '/a', [['H', '1']], 'body'], ['B', 'POST', '/b', [], undefined]]);
  assert.equal(parsed.empty, 0);
  assert.equal(parseHttp('### A\n# comment only\n').empty, 1);
  assert.equal(parseHttp('### A\nGET /a\n\n< ./f.txt\n').requests[0]?.bodyFile, './f.txt');
  assert.equal(parseHttp('### A\nGET /a\n\nline\n< ./not-alone.txt\n').requests[0]?.bodyFile, undefined);
  assert.equal(parseHttp('### A\nGET /a\n\n< ./first.txt\nand more text\n').requests[0]?.bodyFile, undefined, 'a body that starts with a path and goes on is text');
});

test('Hostile text is read in time proportional to its size', () => {
  const big = `### A\nGET /a\n${'H: v\n'.repeat(50_000)}\n${'x'.repeat(2_000_000)}\n${'### B\nGET /b\n'.repeat(20_000)}`;
  const started = Date.now();
  const parsed = parseHttp(big);
  assert.equal(parsed.requests.length, 20_001);
  assert.ok(Date.now() - started < 3000, 'under three seconds');
});
