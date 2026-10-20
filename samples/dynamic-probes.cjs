'use strict';
/*
 * Hand-written requests that use each candidate spelling of a dynamic variable, so that a run in REST Client, httpYac and
 * JetBrains shows which spelling each tool resolves (the received URL has the value) and which it does not (no request, or the
 * braces still in the URL). Used by the three check runners; the importer's own output is checked apart.
 */
const CANDIDATES = [
  '$guid', '$uuid', '$random.uuid',
  '$randomInt 1 9', '$randomInt', '$random.integer(1, 9)', '$random.integer(1,9)',
  '$timestamp', '$isoTimestamp', '$datetime iso8601',
  '$random.email', '$random.alphabetic(6)', '$random.float(1, 9)', '$random.hexadecimal(8)', '$random.alphanumeric(6)',
  // Repeated, to see the range a tool really uses (the bounds, and whether the upper one is reached).
  ...Array.from({ length: 16 }, () => '$random.integer(1, 3)'), ...Array.from({ length: 16 }, () => '$randomInt 1 3'), ...Array.from({ length: 8 }, () => '$random.integer(100, 102)')
];

exports.CANDIDATES = CANDIDATES;
exports.dynamicProbeFile = () => `${CANDIDATES.map((expression, index) => `### dyn ${index}\nGET {{baseUrl}}/dyn/${index}/{{${expression}}}\n`).join('\n')}`;
