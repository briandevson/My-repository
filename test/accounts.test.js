import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Account rules. persistence.js reads its data directory once at import, so
 * these tests point it at a scratch directory before importing it.
 */
const dir = mkdtempSync(join(tmpdir(), 'aetheria-accounts-'));
process.env.AETHERIA_DATA = dir;
const { authenticate, nameAvailable, normaliseName } = await import('../server/persistence.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a name can only be registered once', () => {
  assert.equal(nameAvailable('gwyn'), true);
  const first = authenticate('gwyn', 'hunter2', true);
  assert.equal(first.ok, true);
  assert.equal(first.fresh, true);
  assert.equal(nameAvailable('gwyn'), false);

  const second = authenticate('gwyn', 'somethingelse', true);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already taken/i);
});

test('names are case- and space-insensitive, so lookalikes cannot be registered', () => {
  authenticate('rowan', 'hunter2', true);
  for (const variant of ['Rowan', 'ROWAN', '  rowan  ']) {
    const attempt = authenticate(variant, 'hunter2', true);
    assert.equal(attempt.ok, false, `${variant} should collide with rowan`);
    assert.match(attempt.reason, /already taken/i);
  }
  assert.equal(normaliseName('Robin Hood'), 'robin_hood');
});

test('logging in needs an existing name and the right password', () => {
  authenticate('finch', 'hunter2', true);

  const missing = authenticate('nobody', 'hunter2', false);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /No character/i);

  const wrong = authenticate('finch', 'wrongpass', false);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /Incorrect password/i);

  const right = authenticate('FINCH', 'hunter2', false);
  assert.equal(right.ok, true);
  assert.equal(right.name, 'finch', 'you get the canonical name back');
  assert.equal(right.fresh, false);
});

test('invalid names and short passwords are rejected before anything is stored', () => {
  for (const bad of ['', 'a', 'way_too_long_name', 'bad name!', '../etc/passwd']) {
    const attempt = authenticate(bad, 'hunter2', true);
    assert.equal(attempt.ok, false, `${bad} should be rejected`);
  }
  const short = authenticate('sparrow', 'abc', true);
  assert.equal(short.ok, false);
  assert.match(short.reason, /at least 4/i);
  assert.equal(nameAvailable('sparrow'), true, 'a rejected registration stores nothing');
});

test('passwords are never stored in the clear', () => {
  const result = authenticate('wren', 'correct horse', true);
  const stored = JSON.stringify(result.account);
  assert.ok(!stored.includes('correct horse'), 'the password does not appear in the record');
  assert.ok(result.account.salt && result.account.hash);
});
