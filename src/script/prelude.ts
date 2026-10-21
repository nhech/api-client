/**
 * The code of the API that scripts see (`pm`, `postman`, `console`, `require`, `setTimeout`, `btoa`, `atob`), as text for the engine. It is plain JavaScript
 * of the old kind (no modules, no syntax the engine lacks) because it runs inside QuickJS, not here: it reads its data from `__input`, runs the scripts one
 * after the other, and ends by defining `__result`, which the worker calls once everything has settled. The scripts it runs are data, never part of this
 * text. It is a template so that its backslashes stay as they are; it must hold no backtick and no dollar-brace.
 */
export const PRELUDE_SOURCE = String.raw`(function () {
  'use strict';
  var root = globalThis;
  var input = JSON.parse(root.__input);
  var hostCall = root.__host;
  var hashSync = root.__hash;
  var hmacSync = root.__hmac;
  var randomSync = root.__random;
  delete root.__input;
  delete root.__host;
  delete root.__hash;
  delete root.__hmac;
  delete root.__random;

  var LOG_LIMIT_ENTRIES = 500;
  var LOG_LIMIT_CHARS = 256 * 1024;
  var NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  var hasOwn = Object.prototype.hasOwnProperty;

  // ---- small helpers ----

  function text(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') { try { return JSON.stringify(value); } catch (e) { return String(value); } }
    return String(value);
  }

  function inspect(value, depth) {
    depth = depth || 0;
    if (typeof value === 'string') return JSON.stringify(value.length > 200 ? value.slice(0, 197) + '...' : value);
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
    if (typeof value === 'bigint') return String(value) + 'n';
    if (typeof value !== 'object') return String(value);
    if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';
    try {
      if (Array.isArray(value)) {
        var items = [];
        for (var i = 0; i < value.length && i < 10; i++) items.push(inspect(value[i], depth + 1));
        return '[ ' + items.join(', ') + (value.length > 10 ? ', ... ' + (value.length - 10) + ' more' : '') + ' ]';
      }
      var keys = Object.keys(value);
      var parts = [];
      for (var k = 0; k < keys.length && k < 10; k++) parts.push(keys[k] + ': ' + inspect(value[keys[k]], depth + 1));
      return '{ ' + parts.join(', ') + (keys.length > 10 ? ', ... ' + (keys.length - 10) + ' more' : '') + ' }';
    } catch (e) { return '[Object]'; }
  }

  function same(a, b) {
    return a === b || (a !== a && b !== b);
  }

  function deepEqual(a, b, seen) {
    if (same(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    seen = seen || [];
    for (var s = 0; s < seen.length; s++) if (seen[s][0] === a && seen[s][1] === b) return true;
    seen.push([a, b]);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], seen)) return false;
      return true;
    }
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) if (!hasOwn.call(b, ka[j]) || !deepEqual(a[ka[j]], b[ka[j]], seen)) return false;
    return true;
  }

  // ---- bytes: UTF-8, hex and base64 by hand (the engine has neither TextEncoder nor atob) ----

  function utf8Bytes(string) {
    var bytes = [];
    for (var i = 0; i < string.length; i++) {
      var c = string.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < string.length) {
        var d = string.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return bytes;
  }

  function utf8String(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i++];
      var c;
      if (b < 0x80) c = b;
      else if (b >= 0xc0 && b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b >= 0xe0 && b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); }
      else if (b >= 0xf0) { c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); }
      else c = 0xfffd;
      out += String.fromCodePoint(c > 0x10ffff ? 0xfffd : c);
    }
    return out;
  }

  var HEX = '0123456789abcdef';
  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += HEX[(bytes[i] >> 4) & 15] + HEX[bytes[i] & 15];
    return out;
  }
  function fromHex(hex) {
    var bytes = [];
    for (var i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function fromBase64(string) {
    var clean = String(string).replace(/[^A-Za-z0-9+/]/g, '');
    var bytes = [];
    for (var i = 0; i < clean.length; i += 4) {
      var n = 0;
      var count = 0;
      for (var j = 0; j < 4 && i + j < clean.length; j++) { n = (n << 6) | B64.indexOf(clean[i + j]); count++; }
      n <<= 6 * (4 - count);
      bytes.push((n >> 16) & 255);
      if (count > 2) bytes.push((n >> 8) & 255);
      if (count > 3) bytes.push(n & 255);
    }
    return bytes;
  }

  root.btoa = function (string) {
    var s = String(string);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 255) throw new Error('The string to be encoded contains characters outside of the Latin1 range.');
      bytes.push(s.charCodeAt(i));
    }
    return toBase64(bytes);
  };
  root.atob = function (string) {
    var bytes = fromBase64(string);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };

  // ---- console ----

  var logs = [];
  var logChars = 0;
  var logsCut = false;
  function log(level, args) {
    if (logs.length >= LOG_LIMIT_ENTRIES || logChars >= LOG_LIMIT_CHARS) { logsCut = true; return; }
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(typeof args[i] === 'string' ? args[i] : inspect(args[i]));
    var line = parts.join(' ');
    if (line.length > 4000) line = line.slice(0, 3997) + '...';
    logChars += line.length;
    logs.push({ level: level, text: line });
  }
  root.console = {
    log: function () { log('log', arguments); },
    info: function () { log('info', arguments); },
    warn: function () { log('warn', arguments); },
    error: function () { log('error', arguments); },
    debug: function () { log('debug', arguments); }
  };

  // ---- the assertion error and expect (a subset of Chai's BDD style) ----

  function AssertionError(message, actual, expected) {
    var error = new Error(message);
    error.name = 'AssertionError';
    error.actual = actual;
    error.expected = expected;
    return error;
  }

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof RegExp) return 'regexp';
    if (value instanceof Date) return 'date';
    if (value instanceof Error) return 'error';
    return typeof value;
  }

  function Assertion(object, flags, message) {
    this.__object = object;
    this.__flags = flags || {};
    this.__message = message;
  }

  function flagged(assertion, name) {
    var flags = {};
    for (var key in assertion.__flags) flags[key] = assertion.__flags[key];
    flags[name] = true;
    return new Assertion(assertion.__object, flags, assertion.__message);
  }

  function assertThat(assertion, passed, message, negated, actual, expected) {
    var negate = !!assertion.__flags.not;
    if (passed === negate) {
      var prefix = assertion.__message ? assertion.__message + ': ' : '';
      throw AssertionError(prefix + (negate ? negated : message), actual, expected);
    }
  }

  var CHAIN = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also'];
  CHAIN.forEach(function (name) {
    Object.defineProperty(Assertion.prototype, name, { get: function () { return this; } });
  });
  ['not', 'deep', 'any', 'all', 'own', 'nested'].forEach(function (name) {
    Object.defineProperty(Assertion.prototype, name, { get: function () { return flagged(this, name); } });
  });

  function defineCheck(name, test, expectation, negation) {
    Object.defineProperty(Assertion.prototype, name, {
      get: function () {
        var object = this.__object;
        assertThat(this, test(object), 'expected ' + inspect(object) + ' to ' + expectation, 'expected ' + inspect(object) + ' not to ' + negation, object);
        return this;
      }
    });
  }
  defineCheck('ok', function (v) { return !!v; }, 'be truthy', 'be truthy');
  defineCheck('true', function (v) { return v === true; }, 'be true', 'be true');
  defineCheck('false', function (v) { return v === false; }, 'be false', 'be false');
  defineCheck('null', function (v) { return v === null; }, 'be null', 'be null');
  defineCheck('undefined', function (v) { return v === undefined; }, 'be undefined', 'be undefined');
  defineCheck('NaN', function (v) { return v !== v; }, 'be NaN', 'be NaN');
  defineCheck('exist', function (v) { return v !== null && v !== undefined; }, 'exist', 'exist');
  defineCheck('empty', function (v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (v && typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }, 'be empty', 'be empty');
  defineCheck('json', function (v) { try { JSON.parse(String(v)); return true; } catch (e) { return false; } }, 'be JSON', 'be JSON');

  function defineMethod(names, run) {
    names.forEach(function (name) {
      Assertion.prototype[name] = function () {
        var result = run.apply(this, arguments);
        return result === undefined ? this : result;
      };
    });
  }

  defineMethod(['equal', 'equals', 'eq'], function (expected) {
    var object = this.__object;
    var passed = this.__flags.deep ? deepEqual(object, expected) : same(object, expected);
    assertThat(this, passed, 'expected ' + inspect(object) + ' to ' + (this.__flags.deep ? 'deeply ' : '') + 'equal ' + inspect(expected), 'expected ' + inspect(object) + ' not to ' + (this.__flags.deep ? 'deeply ' : '') + 'equal ' + inspect(expected), object, expected);
  });
  defineMethod(['eql', 'eqls'], function (expected) {
    var object = this.__object;
    assertThat(this, deepEqual(object, expected), 'expected ' + inspect(object) + ' to deeply equal ' + inspect(expected), 'expected ' + inspect(object) + ' not to deeply equal ' + inspect(expected), object, expected);
  });
  function compare(name, symbol, test) {
    return function (limit) {
      var object = this.__object;
      assertThat(this, typeof object === 'number' && test(object, limit), 'expected ' + inspect(object) + ' to be ' + name + ' ' + inspect(limit), 'expected ' + inspect(object) + ' not to be ' + name + ' ' + inspect(limit), object, limit);
    };
  }
  defineMethod(['above', 'gt', 'greaterThan'], compare('above', '>', function (a, b) { return a > b; }));
  defineMethod(['least', 'gte'], compare('at least', '>=', function (a, b) { return a >= b; }));
  defineMethod(['below', 'lt', 'lessThan'], compare('below', '<', function (a, b) { return a < b; }));
  defineMethod(['most', 'lte'], compare('at most', '<=', function (a, b) { return a <= b; }));
  defineMethod(['within'], function (low, high) {
    var object = this.__object;
    assertThat(this, typeof object === 'number' && object >= low && object <= high, 'expected ' + inspect(object) + ' to be within ' + low + '..' + high, 'expected ' + inspect(object) + ' not to be within ' + low + '..' + high, object);
  });
  defineMethod(['closeTo', 'approximately'], function (value, delta) {
    var object = this.__object;
    assertThat(this, typeof object === 'number' && Math.abs(object - value) <= delta, 'expected ' + inspect(object) + ' to be close to ' + value + ' +/- ' + delta, 'expected ' + inspect(object) + ' not to be close to ' + value + ' +/- ' + delta, object);
  });
  defineMethod(['a', 'an'], function (type) {
    var object = this.__object;
    var actual = typeOf(object);
    assertThat(this, String(type).toLowerCase() === actual, 'expected ' + inspect(object) + ' to be ' + type, 'expected ' + inspect(object) + ' not to be ' + type, object, type);
  });
  defineMethod(['instanceof', 'instanceOf'], function (constructor) {
    var object = this.__object;
    assertThat(this, object instanceof constructor, 'expected ' + inspect(object) + ' to be an instance of ' + (constructor && constructor.name), 'expected ' + inspect(object) + ' not to be an instance of ' + (constructor && constructor.name), object);
  });
  defineMethod(['property'], function (name, value) {
    var object = this.__object;
    var target = object === null || object === undefined ? undefined : Object(object);
    var has = target !== undefined && (this.__flags.own ? hasOwn.call(target, name) : name in target);
    var passed = has && (arguments.length < 2 || (this.__flags.deep ? deepEqual(target[name], value) : same(target[name], value)));
    assertThat(this, passed, 'expected ' + inspect(object) + ' to have property ' + inspect(name) + (arguments.length > 1 ? ' of ' + inspect(value) + (has ? ', but got ' + inspect(target[name]) : '') : ''), 'expected ' + inspect(object) + ' not to have property ' + inspect(name) + (arguments.length > 1 ? ' of ' + inspect(value) : ''), object, value);
    return new Assertion(has ? target[name] : undefined, {}, this.__message);
  });
  defineMethod(['ownProperty', 'haveOwnProperty'], function (name, value) {
    return Assertion.prototype.property.apply(flagged(this, 'own'), arguments);
  });
  defineMethod(['keys', 'key'], function () {
    var object = this.__object;
    var expected = Array.prototype.slice.call(arguments);
    if (expected.length === 1 && Array.isArray(expected[0])) expected = expected[0];
    var actual = object && typeof object === 'object' ? Object.keys(object) : [];
    var has = expected.every(function (key) { return actual.indexOf(key) >= 0; });
    var passed = this.__flags.any ? expected.some(function (key) { return actual.indexOf(key) >= 0; }) : has && (this.__flags.contain || this.__flags.include ? true : actual.length === expected.length);
    assertThat(this, passed, 'expected ' + inspect(object) + ' to have keys ' + inspect(expected), 'expected ' + inspect(object) + ' not to have keys ' + inspect(expected), object);
  });
  function includeCheck(value) {
    var object = this.__object;
    var found = false;
    if (typeof object === 'string') found = object.indexOf(String(value)) >= 0;
    else if (Array.isArray(object)) found = object.some(function (item) { return this.__flags.deep ? deepEqual(item, value) : same(item, value); }, this);
    else if (object && typeof object === 'object' && value && typeof value === 'object') {
      found = Object.keys(value).every(function (key) { return hasOwn.call(object, key) && (this.__flags.deep ? deepEqual(object[key], value[key]) : same(object[key], value[key])); }, this);
    }
    assertThat(this, found, 'expected ' + inspect(object) + ' to include ' + inspect(value), 'expected ' + inspect(object) + ' not to include ' + inspect(value), object, value);
  }
  ['include', 'includes', 'contain', 'contains'].forEach(function (name) {
    Object.defineProperty(Assertion.prototype, name, {
      get: function () {
        var chained = flagged(this, 'include');
        var call = function (value) { includeCheck.call(chained, value); return chained; };
        Object.setPrototypeOf(call, chained);
        return call;
      }
    });
  });
  defineMethod(['length', 'lengthOf'], function (expected) {
    var object = this.__object;
    var actual = object === null || object === undefined ? undefined : object.length;
    assertThat(this, actual === expected, 'expected ' + inspect(object) + ' to have length ' + expected + ' but got ' + inspect(actual), 'expected ' + inspect(object) + ' not to have length ' + expected, actual, expected);
  });
  defineMethod(['match', 'matches'], function (pattern) {
    var object = this.__object;
    assertThat(this, typeof object === 'string' && pattern.test(object), 'expected ' + inspect(object) + ' to match ' + String(pattern), 'expected ' + inspect(object) + ' not to match ' + String(pattern), object);
  });
  defineMethod(['string'], function (value) {
    var object = this.__object;
    assertThat(this, typeof object === 'string' && object.indexOf(value) >= 0, 'expected ' + inspect(object) + ' to contain ' + inspect(value), 'expected ' + inspect(object) + ' not to contain ' + inspect(value), object);
  });
  defineMethod(['oneOf'], function (list) {
    var object = this.__object;
    assertThat(this, Array.isArray(list) && list.some(function (item) { return same(item, object); }), 'expected ' + inspect(object) + ' to be one of ' + inspect(list), 'expected ' + inspect(object) + ' not to be one of ' + inspect(list), object);
  });
  defineMethod(['members'], function (list) {
    var object = this.__object;
    var passed = Array.isArray(object) && Array.isArray(list) && object.length === list.length && list.every(function (item) { return object.some(function (other) { return deepEqual(other, item); }); });
    assertThat(this, passed, 'expected ' + inspect(object) + ' to have members ' + inspect(list), 'expected ' + inspect(object) + ' not to have members ' + inspect(list), object);
  });
  defineMethod(['satisfy', 'satisfies'], function (predicate) {
    var object = this.__object;
    assertThat(this, !!predicate(object), 'expected ' + inspect(object) + ' to satisfy the function', 'expected ' + inspect(object) + ' not to satisfy the function', object);
  });
  defineMethod(['throw', 'throws', 'Throw'], function (expected) {
    var thrown;
    var did = false;
    try { this.__object(); } catch (e) { did = true; thrown = e; }
    var passed = did;
    if (did && expected !== undefined) {
      if (typeof expected === 'string') passed = String(thrown && thrown.message).indexOf(expected) >= 0;
      else if (expected instanceof RegExp) passed = expected.test(String(thrown && thrown.message));
      else if (typeof expected === 'function') passed = thrown instanceof expected;
    }
    assertThat(this, passed, 'expected the function to throw' + (expected !== undefined ? ' ' + inspect(expected) : ''), 'expected the function not to throw' + (expected !== undefined ? ' ' + inspect(expected) : ''));
  });

  function expect(value, message) {
    return new Assertion(value, {}, message);
  }

  // ---- variables ----

  var SCOPES = { active: { set: Object.create(null), unset: Object.create(null) }, local: { set: Object.create(null), unset: Object.create(null) }, global: { set: Object.create(null), unset: Object.create(null) } };

  function put(object, key, value) {
    Object.defineProperty(object, key, { value: value, enumerable: true, writable: true, configurable: true });
    return object;
  }

  function copy(object) {
    var out = Object.create(null);
    if (object) for (var key in object) if (hasOwn.call(object, key)) out[key] = String(object[key]);
    return out;
  }

  /** A scope of variables: reads the values given at the start with what this run has set on top; changes are noted for the extension. */
  function makeScope(base, kind, mirror, live) {
    var values = live ? base : copy(base);
    var changes = SCOPES[kind];
    function checkName(name) {
      name = String(name);
      if (!NAME_PATTERN.test(name)) throw new Error('"' + name.slice(0, 40) + '" is not a name a variable can have (letters, digits, _ . -, not starting with a digit)');
      return name;
    }
    var scope = {
      get: function (name) { name = String(name); return hasOwn.call(values, name) ? values[name] : undefined; },
      has: function (name) { return hasOwn.call(values, String(name)); },
      set: function (name, value) {
        name = checkName(name);
        var stored = text(value);
        values[name] = stored;
        if (mirror) mirror[name] = stored;
        if (changes) { changes.set[name] = stored; delete changes.unset[name]; }
      },
      unset: function (name) {
        name = String(name);
        if (mirror && hasOwn.call(values, name) && hasOwn.call(mirror, name) && mirror[name] === values[name]) delete mirror[name];
        if (hasOwn.call(values, name)) delete values[name];
        if (changes) { delete changes.set[name]; changes.unset[name] = true; }
      },
      clear: function () {
        for (var key in values) {
          if (mirror && hasOwn.call(mirror, key) && mirror[key] === values[key]) delete mirror[key];
          if (changes) { delete changes.set[key]; changes.unset[key] = true; }
        }
        if (live) { for (var gone in values) delete values[gone]; } else values = Object.create(null);
      },
      toObject: function () { var out = {}; for (var key in values) put(out, key, values[key]); return out; },
      replaceIn: function (string) {
        return String(string).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, function (whole, name) { return hasOwn.call(values, name) ? values[name] : whole; });
      }
    };
    return scope;
  }

  var variableInput = input.variables || {};
  var mergedValues = copy(variableInput.merged);
  var environmentScope = makeScope(variableInput.environment, 'active', mergedValues);
  var collectionScope = makeScope(variableInput.collection, 'local', mergedValues);
  var globalsScope = makeScope(variableInput.globals, 'global', mergedValues);
  /** pm.variables: everything, as a request would see it, with what this run has set on top. Its own writes are the local ones. */
  var localScope = makeScope(mergedValues, 'local', undefined, true);

  // ---- request and response ----

  function lower(value) { return String(value).toLowerCase(); }

  function makeHeaders(pairs, mutable, onChange) {
    var list = [];
    (pairs || []).forEach(function (pair) { list.push({ key: String(pair[0]), value: String(pair[1]) }); });
    function find(key) { var k = lower(key); for (var i = 0; i < list.length; i++) if (lower(list[i].key) === k) return i; return -1; }
    function refuse() { throw new Error('The headers cannot be changed after the request was sent.'); }
    var headers = {
      get: function (key) { var i = find(key); return i < 0 ? undefined : list[i].value; },
      has: function (key) { return find(key) >= 0; },
      toObject: function () { var out = {}; list.forEach(function (h) { put(out, h.key, h.value); }); return out; },
      each: function (fn) { list.forEach(function (h) { fn({ key: h.key, value: h.value }); }); },
      all: function () { return list.map(function (h) { return { key: h.key, value: h.value }; }); },
      count: function () { return list.length; },
      add: function (header) { if (!mutable) refuse(); list.push({ key: String(header.key), value: String(header.value) }); onChange(); },
      upsert: function (header) {
        if (!mutable) refuse();
        var i = find(header.key);
        if (i < 0) list.push({ key: String(header.key), value: String(header.value) }); else list[i].value = String(header.value);
        onChange();
      },
      remove: function (key) { if (!mutable) refuse(); var i; while ((i = find(key)) >= 0) list.splice(i, 1); onChange(); },
      clear: function () { if (!mutable) refuse(); list.length = 0; onChange(); }
    };
    headers.__pairs = function () { return list.map(function (h) { return [h.key, h.value]; }); };
    return headers;
  }

  var phase = input.phase;
  var requestInput = input.request || { method: 'GET', url: '', headers: [], body: null };
  var requestState = { method: requestInput.method, url: requestInput.url, bodyRaw: requestInput.body && typeof requestInput.body.raw === 'string' ? requestInput.body.raw : undefined, headersChanged: false };
  var mutableRequest = phase === 'prerequest';

  function parseUrlParts(url) {
    var match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
    var authority = match && match[2] ? match[2] : '';
    var at = authority.lastIndexOf('@');
    var hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    var colon = hostPort.lastIndexOf(':');
    var hasPort = colon > hostPort.lastIndexOf(']');
    return {
      protocol: match && match[1] ? match[1] : '',
      host: hasPort ? hostPort.slice(0, colon) : hostPort,
      port: hasPort ? hostPort.slice(colon + 1) : '',
      path: match && match[3] ? match[3] : '',
      query: match && match[4] ? match[4] : '',
      hash: match && match[5] ? match[5] : ''
    };
  }

  function makeUrl() {
    function queryPairs() {
      var q = parseUrlParts(requestState.url).query;
      return q === '' ? [] : q.split('&').map(function (piece) { var i = piece.indexOf('='); return i < 0 ? [piece, ''] : [piece.slice(0, i), piece.slice(i + 1)]; });
    }
    function writeQuery(pairs) {
      if (!mutableRequest) throw new Error('The address cannot be changed after the request was sent.');
      var url = requestState.url;
      var hash = '';
      var hashAt = url.indexOf('#');
      if (hashAt >= 0) { hash = url.slice(hashAt); url = url.slice(0, hashAt); }
      var queryAt = url.indexOf('?');
      var base = queryAt >= 0 ? url.slice(0, queryAt) : url;
      requestState.url = base + (pairs.length > 0 ? '?' + pairs.map(function (p) { return p[0] + '=' + p[1]; }).join('&') : '') + hash;
    }
    var query = {
      get: function (name) { var pairs = queryPairs(); for (var i = 0; i < pairs.length; i++) if (pairs[i][0] === name) return pairs[i][1]; return undefined; },
      has: function (name) { return query.get(name) !== undefined; },
      toObject: function () { var out = {}; queryPairs().forEach(function (p) { put(out, p[0], p[1]); }); return out; },
      add: function (param) { var pairs = queryPairs(); pairs.push([String(param.key), String(param.value)]); writeQuery(pairs); },
      remove: function (name) { writeQuery(queryPairs().filter(function (p) { return p[0] !== name; })); },
      upsert: function (param) { var pairs = queryPairs().filter(function (p) { return p[0] !== param.key; }); pairs.push([String(param.key), String(param.value)]); writeQuery(pairs); }
    };
    return {
      toString: function () { return requestState.url; },
      getHost: function () { return parseUrlParts(requestState.url).host; },
      getPath: function () { return parseUrlParts(requestState.url).path; },
      getQueryString: function () { return parseUrlParts(requestState.url).query; },
      getProtocol: function () { return parseUrlParts(requestState.url).protocol; },
      getPort: function () { return parseUrlParts(requestState.url).port; },
      addQueryParams: function (params) { var pairs = queryPairs(); String(params).split('&').forEach(function (piece) { if (piece !== '') { var i = piece.indexOf('='); pairs.push(i < 0 ? [piece, ''] : [piece.slice(0, i), piece.slice(i + 1)]); } }); writeQuery(pairs); },
      removeQueryParams: function (name) { query.remove(name); },
      query: query,
      host: parseUrlParts(requestState.url).host.split('.'),
      path: parseUrlParts(requestState.url).path.split('/').filter(function (s) { return s !== ''; })
    };
  }

  var requestHeaders = makeHeaders(requestInput.headers, mutableRequest, function () { requestState.headersChanged = true; });
  var requestBody = {
    get mode() { return requestInput.body ? requestInput.body.mode || 'raw' : undefined; },
    get raw() { return requestState.bodyRaw; },
    set raw(value) { if (!mutableRequest) throw new Error('The body cannot be changed after the request was sent.'); requestState.bodyRaw = text(value); },
    update: function (value) { if (!mutableRequest) throw new Error('The body cannot be changed after the request was sent.'); requestState.bodyRaw = typeof value === 'string' ? value : text(value && value.raw !== undefined ? value.raw : value); },
    toString: function () { return requestState.bodyRaw === undefined ? '' : requestState.bodyRaw; }
  };
  var requestObject = {
    get method() { return requestState.method; },
    set method(value) { if (!mutableRequest) throw new Error('The method cannot be changed after the request was sent.'); requestState.method = String(value).toUpperCase(); },
    get url() { return makeUrl(); },
    set url(value) { if (!mutableRequest) throw new Error('The address cannot be changed after the request was sent.'); requestState.url = text(value && typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : value); },
    headers: requestHeaders,
    body: requestInput.body ? requestBody : undefined,
    name: input.info ? input.info.requestName : ''
  };

  function makeResponse(data) {
    var headers = makeHeaders(data.headers, false, function () {});
    var cookieList = data.cookies || [];
    var response = {
      code: data.code,
      status: data.status,
      headers: headers,
      responseTime: data.responseTime,
      responseSize: data.size,
      json: function () {
        if (data.body === undefined || data.body === null) throw new Error(data.bodyNote || 'The response has no body to read.');
        return JSON.parse(data.body);
      },
      text: function () {
        if (data.body === undefined || data.body === null) throw new Error(data.bodyNote || 'The response has no body to read.');
        return data.body;
      },
      size: function () { return { body: data.size, header: 0, total: data.size }; },
      cookies: {
        get: function (name) { for (var i = 0; i < cookieList.length; i++) if (cookieList[i].name === name) return cookieList[i].value; return undefined; },
        has: function (name) { return response.cookies.get(name) !== undefined; },
        toObject: function () { var out = {}; cookieList.forEach(function (c) { put(out, c.name, c.value); }); return out; }
      }
    };
    response.to = {
      have: {
        status: function (expected) {
          var passed = typeof expected === 'number' ? data.code === expected : String(data.status).toLowerCase() === String(expected).toLowerCase();
          if (!passed) throw AssertionError('expected response to have status ' + (typeof expected === 'number' ? 'code ' : 'reason ') + inspect(expected) + ' but got ' + data.code + ' ' + data.status, data.code, expected);
        },
        header: function (name, value) {
          var actual = headers.get(name);
          if (actual === undefined) throw AssertionError('expected response to have header ' + inspect(name), undefined, name);
          if (value !== undefined && actual !== String(value)) throw AssertionError('expected response header ' + inspect(name) + ' to be ' + inspect(value) + ' but got ' + inspect(actual), actual, value);
        },
        body: function (expected) {
          var body = data.body;
          var passed = expected instanceof RegExp ? expected.test(String(body)) : expected === undefined ? body !== undefined && body !== '' : body === String(expected);
          if (!passed) throw AssertionError('expected response body to ' + (expected instanceof RegExp ? 'match ' + String(expected) : 'be ' + inspect(expected)), body, expected);
        },
        jsonBody: function (path, value) {
          var parsed;
          try { parsed = response.json(); } catch (e) { throw AssertionError('expected the response body to be JSON'); }
          if (path === undefined) return;
          var node = parsed;
          var steps = String(path).split('.');
          for (var i = 0; i < steps.length; i++) {
            if (node === null || node === undefined || !(steps[i] in Object(node))) throw AssertionError('expected the JSON body to have ' + inspect(path));
            node = node[steps[i]];
          }
          if (value !== undefined && !deepEqual(node, value)) throw AssertionError('expected the JSON body ' + inspect(path) + ' to be ' + inspect(value) + ' but got ' + inspect(node), node, value);
        }
      },
      be: {}
    };
    function state(name, test, description) {
      Object.defineProperty(response.to.be, name, { get: function () { if (!test(data.code)) throw AssertionError('expected response to be ' + description + ' but got ' + data.code + ' ' + data.status, data.code); return true; } });
    }
    state('ok', function (c) { return c === 200; }, 'ok (200)');
    state('success', function (c) { return c >= 200 && c < 300; }, 'a success (2xx)');
    state('accepted', function (c) { return c === 202; }, 'accepted (202)');
    state('badRequest', function (c) { return c === 400; }, 'a bad request (400)');
    state('unauthorized', function (c) { return c === 401; }, 'unauthorized (401)');
    state('forbidden', function (c) { return c === 403; }, 'forbidden (403)');
    state('notFound', function (c) { return c === 404; }, 'not found (404)');
    state('clientError', function (c) { return c >= 400 && c < 500; }, 'a client error (4xx)');
    state('serverError', function (c) { return c >= 500 && c < 600; }, 'a server error (5xx)');
    state('error', function (c) { return c >= 400 && c < 600; }, 'an error (4xx or 5xx)');
    state('redirection', function (c) { return c >= 300 && c < 400; }, 'a redirection (3xx)');
    Object.defineProperty(response.to.be, 'json', { get: function () { try { response.json(); } catch (e) { throw AssertionError('expected the response body to be JSON'); } return true; } });
    return response;
  }

  // ---- tests ----

  var tests = [];
  function recordTest(name, fn) {
    var entry = { name: String(name).slice(0, 300), passed: false, message: '', state: 'running' };
    tests.push(entry);
    function fail(error) { entry.state = 'done'; entry.passed = false; entry.message = String(error && error.message !== undefined ? error.name + ': ' + error.message : error).slice(0, 1000); }
    function pass() { entry.state = 'done'; entry.passed = true; }
    if (typeof fn !== 'function') { entry.state = 'done'; entry.passed = false; entry.message = 'skipped'; entry.skipped = true; return; }
    try {
      var returned = fn();
      if (returned && typeof returned.then === 'function') returned.then(pass, fail); else pass();
    } catch (error) { fail(error); }
  }
  recordTest.skip = function (name) { recordTest(name, undefined); };

  // ---- cookies of the request, data of an iteration ----

  function makeReadOnlyMap(object) {
    var data = copy(object);
    return {
      get: function (name) { name = String(name); return hasOwn.call(data, name) ? data[name] : undefined; },
      has: function (name) { return hasOwn.call(data, String(name)); },
      toObject: function () { var out = {}; for (var key in data) put(out, key, data[key]); return out; }
    };
  }
  var cookieValues = {};
  (input.cookies || []).forEach(function (cookie) { cookieValues[cookie.name] = cookie.value; });

  // ---- sending a request from a script ----

  var HOST_CALLS_FOR_REQUESTS = 0;
  function normalizeRequest(options) {
    if (typeof options === 'string') return { url: options, method: 'GET', headers: [], body: undefined };
    var headers = [];
    var given = options.header || options.headers;
    if (Array.isArray(given)) given.forEach(function (h) { headers.push([String(h.key), String(h.value)]); });
    else if (given && typeof given === 'object') for (var key in given) if (hasOwn.call(given, key)) headers.push([key, String(given[key])]);
    var body;
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body === 'string') body = options.body;
      else if (options.body.mode === 'raw') body = text(options.body.raw);
      else if (options.body.mode === 'urlencoded' && Array.isArray(options.body.urlencoded)) body = options.body.urlencoded.map(function (p) { return encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value); }).join('&');
    }
    return { url: text(options.url && typeof options.url === 'object' ? options.url.toString() : options.url), method: String(options.method || 'GET').toUpperCase(), headers: headers, body: body };
  }
  function sendRequest(options, callback) {
    var promise;
    try {
      var prepared = normalizeRequest(options);
      promise = hostCall('http', JSON.stringify(prepared)).then(function (answer) { return makeResponse(JSON.parse(answer)); });
    } catch (error) { promise = Promise.reject(error); }
    if (typeof callback === 'function') {
      promise.then(function (response) { try { callback(null, response); } catch (error) { failures.push(error); } }, function (error) { try { callback(error instanceof Error ? error : new Error(String(error)), null); } catch (inner) { failures.push(inner); } });
    }
    return promise;
  }

  // ---- what happens next ----

  var control = { skip: false, nextRequest: undefined };
  var failures = [];

  // ---- the API ----

  var pm = {
    info: { eventName: phase === 'prerequest' ? 'prerequest' : 'test', requestName: input.info ? input.info.requestName : '', requestId: input.info ? input.info.requestId : '', iteration: input.info ? input.info.iteration : 0, iterationCount: input.info ? input.info.iterationCount : 1 },
    variables: localScope,
    environment: Object.assign(environmentScope, { name: input.environmentName || '' }),
    collectionVariables: collectionScope,
    globals: globalsScope,
    iterationData: makeReadOnlyMap(input.iterationData),
    request: requestObject,
    response: input.response ? makeResponse(input.response) : undefined,
    cookies: makeReadOnlyMap(cookieValues),
    test: recordTest,
    expect: expect,
    sendRequest: sendRequest,
    setNextRequest: function (name) { control.nextRequest = name === null || name === undefined ? null : String(name); },
    execution: {
      skipRequest: function () { if (phase !== 'prerequest') throw new Error('skipRequest can only be called before the request is sent.'); control.skip = true; },
      setNextRequest: function (name) { control.nextRequest = name === null || name === undefined ? null : String(name); }
    }
  };
  root.pm = pm;
  root.postman = {
    setEnvironmentVariable: function (name, value) { environmentScope.set(name, value); },
    getEnvironmentVariable: function (name) { return environmentScope.get(name); },
    setGlobalVariable: function (name, value) { globalsScope.set(name, value); },
    getGlobalVariable: function (name) { return globalsScope.get(name); },
    clearEnvironmentVariable: function (name) { environmentScope.unset(name); },
    setNextRequest: pm.setNextRequest
  };

  // ---- timers (the engine has none): a wait is an operation of the extension, so it is counted and limited like the others ----

  var cancelled = Object.create(null);
  var timerId = 0;
  root.setTimeout = function (fn, ms) {
    var id = ++timerId;
    var delay = Math.min(Math.max(Number(ms) || 0, 0), 5000);
    var args = Array.prototype.slice.call(arguments, 2);
    hostCall('sleep', String(delay)).then(function () { if (!cancelled[id]) { try { fn.apply(undefined, args); } catch (error) { failures.push(error); } } });
    return id;
  };
  root.clearTimeout = function (id) { cancelled[id] = true; };

  // ---- require: only what the API has and a clear message for the rest ----

  function wordArray(bytes) {
    var array = {
      bytes: bytes,
      sigBytes: bytes.length,
      toString: function (encoder) { return (encoder || Hex).stringify(array); }
    };
    return array;
  }
  var Hex = { stringify: function (wa) { return toHex(wa.bytes); }, parse: function (s) { return wordArray(fromHex(String(s))); } };
  var Base64 = { stringify: function (wa) { return toBase64(wa.bytes); }, parse: function (s) { return wordArray(fromBase64(String(s))); } };
  var Utf8 = { stringify: function (wa) { return utf8String(wa.bytes); }, parse: function (s) { return wordArray(utf8Bytes(String(s))); } };
  function bytesOf(message) {
    if (message && typeof message === 'object' && message.bytes) return message.bytes;
    return utf8Bytes(text(message));
  }
  function hasher(algorithm) { return function (message) { return wordArray(fromHex(hashSync(algorithm, toHex(bytesOf(message))))); }; }
  function hmacer(algorithm) { return function (message, key) { return wordArray(fromHex(hmacSync(algorithm, toHex(bytesOf(key)), toHex(bytesOf(message))))); }; }
  var cryptoJs = {
    MD5: hasher('md5'), SHA1: hasher('sha1'), SHA256: hasher('sha256'), SHA512: hasher('sha512'),
    HmacMD5: hmacer('md5'), HmacSHA1: hmacer('sha1'), HmacSHA256: hmacer('sha256'), HmacSHA512: hmacer('sha512'),
    enc: { Hex: Hex, Base64: Base64, Utf8: Utf8 }
  };
  var uuid = {
    v4: function () {
      var b = fromHex(randomSync(16));
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      var h = toHex(b);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
  };
  var AVAILABLE = { 'crypto-js': cryptoJs, 'uuid': uuid, 'chai': { expect: expect } };
  root.require = function (name) {
    name = String(name);
    if (hasOwn.call(AVAILABLE, name)) return AVAILABLE[name];
    throw new Error('Cannot find module "' + name.slice(0, 60) + '". This client provides: crypto-js, uuid, chai.');
  };

  // ---- running the scripts, one after the other, in the global scope ----

  var runError = null;
  var scripts = input.scripts || [];
  var evaluate = root.eval;
  for (var s = 0; s < scripts.length; s++) {
    try {
      evaluate(scripts[s].code);
    } catch (error) {
      runError = { from: String(scripts[s].from), name: String(error && error.name ? error.name : 'Error'), message: String(error && error.message !== undefined ? error.message : error).slice(0, 1000) };
      break;
    }
  }

  root.__result = function () {
    var finalTests = tests.map(function (t) {
      if (t.state === 'running') return { name: t.name, passed: false, message: 'did not finish' };
      var out = { name: t.name, passed: t.passed, message: t.message };
      if (t.skipped) out.skipped = true;
      return out;
    });
    var out = { logs: logs, logsCut: logsCut, tests: finalTests, variables: {}, skip: control.skip, error: runError, asyncErrors: failures.slice(0, 5).map(function (e) { return String(e && e.message !== undefined ? e.message : e).slice(0, 500); }) };
    if (control.nextRequest !== undefined) out.nextRequest = control.nextRequest;
    ['active', 'local', 'global'].forEach(function (kind) {
      var set = [];
      var unset = [];
      for (var key in SCOPES[kind].set) set.push([key, SCOPES[kind].set[key]]);
      for (var gone in SCOPES[kind].unset) unset.push(gone);
      if (set.length > 0 || unset.length > 0) put(out.variables, kind, { set: set, unset: unset });
    });
    if (mutableRequest) {
      var changes = {};
      var any = false;
      if (requestState.method !== requestInput.method) { changes.method = requestState.method; any = true; }
      if (requestState.url !== requestInput.url) { changes.url = requestState.url; any = true; }
      if (requestState.headersChanged) { changes.headers = requestHeaders.__pairs(); any = true; }
      if (requestState.bodyRaw !== (requestInput.body && typeof requestInput.body.raw === 'string' ? requestInput.body.raw : undefined)) { changes.bodyRaw = requestState.bodyRaw; any = true; }
      if (any) out.request = changes;
    }
    return JSON.stringify(out);
  };
})();`;
