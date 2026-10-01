import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from '../src/index.js';

// A fake clock: you set the time, the limiter reads it. Tests never touch the
// wall clock, so they are deterministic regardless of machine speed.
function makeFakeClock(start = 0) {
  let t = start;
  return {
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
    now: () => t,
  };
}

test('constructor rejects non-positive maxEvents', () => {
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 0, windowMs: 1000 }), RangeError);
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: -1, windowMs: 1000 }), RangeError);
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 1.5, windowMs: 1000 }), RangeError);
});

test('constructor rejects non-positive or non-finite windowMs', () => {
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 0 }), RangeError);
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: -5 }), RangeError);
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: Infinity }), RangeError);
  assert.throws(() => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: NaN }), RangeError);
});

test('constructor rejects non-function clock', () => {
  assert.throws(
    () => new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 1000, clock: 'nope' }),
    TypeError,
  );
});

test('admits up to maxEvents within a single window', () => {
  const clock = makeFakeClock(1000);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 3, windowMs: 1000, clock: clock.now });

  const a = limiter.check();
  const b = limiter.check();
  const c = limiter.check();
  const d = limiter.check();

  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, true);
  assert.equal(d.allowed, false);
  // After the rejected call, count is still the cap, not cap+1.
  assert.equal(d.count, 3);
  assert.equal(d.remaining, 0);
});

test('check records the new event timestamp when allowed', () => {
  // peek before vs. after a successful check proves the timestamp was stored.
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 2, windowMs: 1000, clock: clock.now });

  const before = limiter.peek();
  assert.equal(before.count, 0);

  const res = limiter.check();
  assert.equal(res.allowed, true);
  assert.equal(res.count, 1);

  const after = limiter.peek();
  assert.equal(after.count, 1);
});

test('peek does not mutate state', () => {
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 2, windowMs: 1000, clock: clock.now });

  const first = limiter.peek();
  const second = limiter.peek();

  assert.deepEqual(first, second);
  assert.equal(first.count, 0);
  assert.equal(first.remaining, 2);
  assert.equal(first.allowed, true);
});

test('events roll out of the window as time advances', () => {
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 2, windowMs: 1000, clock: clock.now });

  // Fill the window at t=0.
  assert.equal(limiter.check().allowed, true);
  assert.equal(limiter.check().allowed, true);
  assert.equal(limiter.check().allowed, false);

  // Advance past the window. The two earlier events should have expired.
  clock.advance(1001);
  assert.equal(limiter.peek().count, 0);
  assert.equal(limiter.check().allowed, true);
});

test('event at exactly windowMs ago is still counted (inclusive boundary)', () => {
  // Window is [now - windowMs, now]; an event at exactly the left edge is in.
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 1000, clock: clock.now });

  assert.equal(limiter.check().allowed, true);   // event at t=0, window now full
  clock.advance(1000);                          // now at t=1000, window is [0,1000]
  assert.equal(limiter.peek().count, 1);         // the t=0 event is still in
  assert.equal(limiter.check().allowed, false);  // still full
  clock.advance(1);                              // now at t=1001, window is [1,1001]
  assert.equal(limiter.peek().count, 0);         // the t=0 event has expired
  assert.equal(limiter.check().allowed, true);
});

test('reset clears recorded events', () => {
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 1000, clock: clock.now });

  assert.equal(limiter.check().allowed, true);
  assert.equal(limiter.check().allowed, false);
  limiter.reset();
  assert.equal(limiter.peek().count, 0);
  assert.equal(limiter.check().allowed, true);
});

test('out-of-order timestamps in the array do not break eviction', () => {
  // Eviction scans from the front assuming ascending order, which is the
  // invariant check() maintains (clock advances monotonically in normal use).
  // If the clock ever goes backwards, eviction must still terminate and not
  // throw. We verify explicitly that the loop halts.
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 5, windowMs: 1000, clock: clock.now });

  assert.equal(limiter.check().allowed, true); // record at 0
  clock.set(-500);                              // clock moves backwards
  // peek must not throw and must not corrupt state.
  const r = limiter.peek();
  assert.equal(r.count, 1);
  assert.equal(r.allowed, true);
});

test('default clock (Date.now) is used when clock omitted', () => {
  // We do not assert on the wall-clock value; we only confirm the limiter
  // constructs and behaves coherently when no clock is supplied.
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 60_000 });
  const r = limiter.peek();
  assert.equal(typeof r.count, 'number');
  assert.equal(r.count, 0);
  assert.equal(r.allowed, true);
});

test('repeated rejections while over the cap stay stable', () => {
  const clock = makeFakeClock(0);
  const limiter = new SlidingWindowRateLimiter({ maxEvents: 1, windowMs: 1000, clock: clock.now });

  assert.equal(limiter.check().allowed, true);
  for (let i = 0; i < 5; i++) {
    const r = limiter.check();
    assert.equal(r.allowed, false);
    assert.equal(r.count, 1);
    assert.equal(r.remaining, 0);
  }
});

test('importing the named export works', () => {
  // Guards against a renamed or dropped export. If the public name changes,
  // this test fails loudly instead of silently breaking callers' imports.
  assert.equal(typeof SlidingWindowRateLimiter, 'function');
});
