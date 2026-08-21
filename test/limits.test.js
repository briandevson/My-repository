import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionLimiter, LoginThrottle, TokenBucket, clientAddress } from '../server/limits.js';

test('a token bucket allows a burst then throttles, and refills over time', () => {
  const bucket = new TokenBucket(5, 1, 0);
  for (let i = 0; i < 5; i++) assert.equal(bucket.take(1, 0), true, `burst ${i}`);
  assert.equal(bucket.take(1, 0), false, 'the burst is spent');

  assert.equal(bucket.take(1, 2000), true, 'two seconds buys two more');
  assert.equal(bucket.take(1, 2000), true);
  assert.equal(bucket.take(1, 2000), false);

  // It never refills past its capacity.
  assert.equal(bucket.take(5, 1_000_000), true);
  assert.equal(bucket.take(1, 1_000_000), false);
});

test('normal play is never throttled but a flood is disconnected', () => {
  const limiter = new ConnectionLimiter(0);
  // Ten actions a second for ten seconds is heavy clicking, and must pass.
  let now = 0;
  for (let i = 0; i < 100; i++) {
    now += 100;
    assert.equal(limiter.check('walk', now), 'ok', `action ${i} at ${now}ms`);
  }

  // A flood in a single instant is dropped, then cut off.
  const flood = new ConnectionLimiter(0);
  const verdicts = [];
  for (let i = 0; i < 200; i++) verdicts.push(flood.check('walk', 0));
  assert.ok(verdicts.includes('slow'), 'excess messages are dropped');
  assert.equal(verdicts.at(-1), 'flood', 'a persistent flood ends the connection');
});

test('chat is metered separately from movement', () => {
  const limiter = new ConnectionLimiter(0);
  const said = [];
  for (let i = 0; i < 10; i++) said.push(limiter.check('chat', 0));
  assert.ok(said.slice(0, 5).every((verdict) => verdict === 'ok'), 'a few lines at once are fine');
  assert.ok(said.includes('slow'), 'spamming is not');

  // Movement still works while chat is on cooldown.
  assert.equal(limiter.check('walk', 0), 'ok');
});

test('failed logins are throttled per address and forgiven over time', () => {
  const throttle = new LoginThrottle({ maxAttempts: 3, windowMs: 1000 });
  assert.equal(throttle.allowed('1.2.3.4', 0), true);
  for (let i = 0; i < 3; i++) throttle.fail('1.2.3.4', 0);
  assert.equal(throttle.allowed('1.2.3.4', 0), false, 'locked out after three misses');
  assert.equal(throttle.allowed('5.6.7.8', 0), true, 'other people are unaffected');

  assert.equal(throttle.allowed('1.2.3.4', 2000), true, 'the window expires');

  // A success clears the record immediately.
  throttle.fail('9.9.9.9', 0);
  throttle.fail('9.9.9.9', 0);
  throttle.succeed('9.9.9.9');
  assert.equal(throttle.allowed('9.9.9.9', 0), true);
});

test('forwarded addresses are only trusted when the operator says so', () => {
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18' },
    socket: { remoteAddress: '10.0.0.2' },
  };
  assert.equal(clientAddress(request, false), '10.0.0.2', 'the header is forgeable, so ignore it by default');
  assert.equal(clientAddress(request, true), '203.0.113.9', 'behind a proxy, take the first hop');
  assert.equal(clientAddress({ headers: {}, socket: {} }, true), 'unknown');
});
