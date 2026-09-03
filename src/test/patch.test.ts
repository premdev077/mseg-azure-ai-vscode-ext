import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEdits, detectEol, parseEdits } from '../patch/apply';

const SRC = [
  'function greet(name) {',
  '  return "hello " + name;',
  '}',
  '',
  'function farewell(name) {',
  '  return "bye " + name;',
  '}',
  ''
].join('\n');

function expectOk(outcome: ReturnType<typeof applyEdits>) {
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
  return outcome as Extract<typeof outcome, { ok: true }>;
}

function expectFail(outcome: ReturnType<typeof applyEdits>) {
  assert.equal(outcome.ok, false, 'expected the patch to be refused');
  return outcome as Extract<typeof outcome, { ok: false }>;
}

test('a unique snippet is replaced and nothing else moves', () => {
  const out = expectOk(
    applyEdits(SRC, [
      { find: '  return "bye " + name;', replace: '  return "goodbye " + name;' }
    ])
  );
  assert.ok(out.text.includes('"goodbye " + name'));
  assert.ok(
    out.text.includes('"hello " + name'),
    'the other function must be untouched'
  );
  assert.equal(out.applied, 1);
});

test('edits apply in order, each against the previous result', () => {
  const out = expectOk(
    applyEdits(SRC, [
      { find: 'function greet(', replace: 'function hi(' },
      // Only matches because the first edit already ran.
      { find: 'function hi(name) {', replace: 'export function hi(name: string) {' }
    ])
  );
  assert.ok(out.text.includes('export function hi(name: string) {'));
  assert.equal(out.applied, 2);
});

test('an ambiguous find is refused rather than guessed', () => {
  const out = expectFail(
    applyEdits(SRC, [{ find: '  return "', replace: '  return u"' }])
  );
  assert.match(out.error, /ambiguous/i);
  assert.match(out.error, /occurs 2 times/);
  assert.match(out.error, /Nothing was changed/);
  assert.equal(out.failedAt, 0);
});

test('a find that matches nothing reports which edit failed', () => {
  const out = expectFail(
    applyEdits(SRC, [{ find: 'function nowhere() {}', replace: 'x' }])
  );
  assert.match(out.error, /did not match/i);
  assert.equal(out.failedAt, 0);
});

test('a later failure names the edits that already applied, so the retry can be aimed', () => {
  const out = expectFail(
    applyEdits(SRC, [
      { find: 'function greet(', replace: 'function hi(' },
      { find: 'function greet(', replace: 'function hey(' } // renamed by edit 1
    ])
  );
  assert.equal(out.failedAt, 1);
  assert.match(out.error, /edits 1-1 were applied first/);
});

test('a failing patch changes nothing at all', () => {
  const out = applyEdits(SRC, [
    { find: '  return "hello " + name;', replace: '  return `hello ${name}`;' },
    { find: 'does not exist', replace: 'x' }
  ]);
  // The caller only ever writes `outcome.text`, and a failure has none.
  assert.equal(out.ok, false);
  assert.equal('text' in out, false);
});

test('an empty find is rejected before anything is searched', () => {
  const out = expectFail(applyEdits(SRC, [{ find: '', replace: 'x' }]));
  assert.match(out.error, /empty "find"/);
});

test('no edits is an error, not a silent no-op', () => {
  assert.equal(applyEdits(SRC, []).ok, false);
});

test('an edit that changes nothing is reported instead of proposing an empty diff', () => {
  const out = expectFail(
    applyEdits(SRC, [{ find: 'function greet(', replace: 'function greet(' }])
  );
  assert.match(out.error, /byte-for-byte unchanged/);
});

test('an empty replace deletes the matched text', () => {
  const out = expectOk(
    applyEdits(SRC, [
      { find: 'function farewell(name) {\n  return "bye " + name;\n}\n', replace: '' }
    ])
  );
  assert.ok(!out.text.includes('farewell'));
  assert.ok(out.text.includes('greet'));
});

// --- line endings ----------------------------------------------------------

test('detectEol reads the dominant ending', () => {
  assert.equal(detectEol('a\r\nb\r\nc'), '\r\n');
  assert.equal(detectEol('a\nb\nc'), '\n');
  assert.equal(detectEol('no newlines here'), '\n');
  assert.equal(detectEol('a\r\nb\r\nc\nd'), '\r\n', 'mostly CRLF should read as CRLF');
});

test('an LF snippet still matches a CRLF file', () => {
  // This is the common case in this repo: the model reads a CRLF file and
  // sends the snippet back with LF.
  const crlf = SRC.replace(/\n/g, '\r\n');
  const out = expectOk(
    applyEdits(crlf, [
      {
        find: 'function greet(name) {\n  return "hello " + name;\n}',
        replace: 'const greet = (name) => "hello " + name;'
      }
    ])
  );
  assert.equal(out.normalisedEol, true);
  assert.ok(out.text.includes('const greet = (name) => "hello " + name;'));
});

test("a multi-line replacement adopts the file's line endings", () => {
  const crlf = SRC.replace(/\n/g, '\r\n');
  const out = expectOk(
    applyEdits(crlf, [
      {
        find: '  return "bye " + name;',
        replace: '  const msg = "bye";\n  return msg + " " + name;'
      }
    ])
  );
  assert.ok(
    out.text.includes('  const msg = "bye";\r\n  return msg + " " + name;'),
    'the inserted newline should be CRLF like the rest of the file'
  );
  assert.equal(
    out.text.includes('"bye";\n  return'),
    false,
    'no bare LF should be introduced'
  );
});

test('an LF file is left with LF endings', () => {
  const out = expectOk(
    applyEdits(SRC, [
      { find: '  return "bye " + name;', replace: '  const m = 1;\n  return m;' }
    ])
  );
  assert.equal(out.normalisedEol, false);
  assert.equal(out.text.includes('\r\n'), false);
});

// --- argument parsing ------------------------------------------------------

test('parseEdits accepts a well-formed array', () => {
  const parsed = parseEdits([{ find: 'a', replace: 'b' }]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.edits, [{ find: 'a', replace: 'b' }]);
});

test('parseEdits defaults a missing replace to deletion', () => {
  const parsed = parseEdits([{ find: 'a' }]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.edits[0].replace, '');
});

test('parseEdits names the offending edit', () => {
  for (const [input, pattern] of [
    [[{ replace: 'b' }], /Edit 1 is missing a string "find"/],
    [
      [{ find: 'a' }, { find: 'b', replace: 5 }],
      /Edit 2 has a "replace" that is not a string/
    ],
    [[{ find: 'a' }, null], /Edit 2 is not an object/]
  ] as Array<[unknown, RegExp]>) {
    const parsed = parseEdits(input);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.error, pattern);
  }
});

test('parseEdits rejects non-arrays and empty arrays', () => {
  for (const bad of [undefined, null, 'string', {}, 42, []]) {
    assert.equal(
      parseEdits(bad).ok,
      false,
      `${JSON.stringify(bad)} should be rejected`
    );
  }
});
