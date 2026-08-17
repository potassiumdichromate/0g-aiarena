import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ERC8021_MARKER,
  ERC8021_REFERENCE_VECTOR,
  appendDataSuffix,
  decodeBuilderCodeSuffix,
  encodeBuilderCodeSuffix,
  configuredBuilderCodeSuffix,
  resetBuilderCodeCache,
} from '../src';

test('reproduces the documented reference vector exactly', () => {
  // If Base clarifies the ordering and this fails, that is the signal to flip
  // the layout in builderCode.ts — not to weaken the test.
  assert.equal(
    encodeBuilderCodeSuffix([...ERC8021_REFERENCE_VECTOR.codes]),
    ERC8021_REFERENCE_VECTOR.suffix,
  );
});

test('the reference vector round-trips', () => {
  const decoded = decodeBuilderCodeSuffix(ERC8021_REFERENCE_VECTOR.suffix);
  assert.deepEqual(decoded?.codes, ['baseapp']);
  assert.equal(decoded?.schemaId, 0);
});

test('suffix ends with the 16-byte ERC marker', () => {
  const suffix = encodeBuilderCodeSuffix(['kult']);
  assert.ok(suffix.toLowerCase().endsWith(ERC8021_MARKER.slice(2).toLowerCase()));
});

test('round-trips arbitrary codes', () => {
  for (const codes of [['kult'], ['kult', 'arena'], ['a'], ['x'.repeat(200)]]) {
    const decoded = decodeBuilderCodeSuffix(encodeBuilderCodeSuffix(codes));
    assert.deepEqual(decoded?.codes, codes);
  }
});

test('an empty code list produces no suffix, so calldata is untouched', () => {
  assert.equal(encodeBuilderCodeSuffix([]), '0x');
  assert.equal(encodeBuilderCodeSuffix(['', '  ']), '0x');
  assert.equal(appendDataSuffix('0xdeadbeef', '0x'), '0xdeadbeef');
});

test('appending leaves the original calldata as a prefix', () => {
  const calldata = '0xa9059cbb' + '00'.repeat(64);
  const appended = appendDataSuffix(calldata, encodeBuilderCodeSuffix(['kult']));

  assert.ok(appended.startsWith(calldata));
  assert.deepEqual(decodeBuilderCodeSuffix(appended)?.codes, ['kult']);
});

test('ordinary calldata decodes to null rather than throwing', () => {
  for (const data of ['0x', '0xa9059cbb', '0x' + 'ab'.repeat(200), 'not hex']) {
    assert.equal(decodeBuilderCodeSuffix(data), null);
  }
});

test('trailing data that merely ends in the marker is rejected', () => {
  // Marker present, but the length byte points back past the start of the data.
  const bogus = '0x' + 'ff' + 'ff' + '00' + ERC8021_MARKER.slice(2);
  assert.equal(decodeBuilderCodeSuffix(bogus), null);
});

test('a code containing the separator is refused', () => {
  assert.throws(() => encodeBuilderCodeSuffix(['ku,lt']), /separator/);
});

test('codes longer than the length field allows are refused', () => {
  assert.throws(() => encodeBuilderCodeSuffix(['x'.repeat(256)]), /at most 255/);
});

test('gas cost is bounded and small', () => {
  // 16 gas per non-zero byte; the suffix is a couple of dozen bytes.
  const suffix = encodeBuilderCodeSuffix(['kult']);
  const bytes = (suffix.length - 2) / 2;
  assert.ok(bytes <= 40, `suffix is ${bytes} bytes`);
});

// ── Environment configuration ───────────────────────────────────────────────
// The failure mode that matters: a bad code must degrade to "no attribution",
// never to a thrown error on the transaction path.

test('an unset builder code yields no suffix', () => {
  delete process.env.BASE_BUILDER_CODE;
  resetBuilderCodeCache();
  assert.equal(configuredBuilderCodeSuffix(), '0x');
});

test('a configured builder code yields a decodable suffix', () => {
  process.env.BASE_BUILDER_CODE = 'kult';
  resetBuilderCodeCache();

  const suffix = configuredBuilderCodeSuffix();
  assert.notEqual(suffix, '0x');
  assert.deepEqual(decodeBuilderCodeSuffix(suffix)?.codes, ['kult']);
});

test('a malformed builder code degrades to no attribution instead of throwing', () => {
  process.env.BASE_BUILDER_CODE = 'has,comma';
  resetBuilderCodeCache();

  // Must not throw — settlement cannot be held hostage to a marketing tag.
  assert.equal(configuredBuilderCodeSuffix(), '0x');
});

test('whitespace-only builder code is treated as unset', () => {
  process.env.BASE_BUILDER_CODE = '   ';
  resetBuilderCodeCache();
  assert.equal(configuredBuilderCodeSuffix(), '0x');
  delete process.env.BASE_BUILDER_CODE;
  resetBuilderCodeCache();
});
