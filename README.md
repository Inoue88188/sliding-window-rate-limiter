# sliding-window-rate-limiter

A tiny, dependency-free sliding-window rate limiter for JavaScript (ESM). You give it a clock, a maximum number of events, and a window length in milliseconds; it tells you whether the next event is allowed and records it when it is.

```js
import { SlidingWindowRateLimiter } from 'sliding-window-rate-limiter';

const limiter = new SlidingWindowRateLimiter({
  maxEvents: 100,
  windowMs: 60_000,
  // clock defaults to Date.now; pass a fake in tests
});

const { allowed, count, remaining } = limiter.check();
if (!allowed) {
  // reject the request
}
```

`peek()` returns the same `{ allowed, count, remaining }` shape but does **not** record an event — use it when you need to report remaining budget without consuming it.

## Why this exists

The sliding-window counter is a common primitive, but most implementations either (a) bake in `Date.now`, making them untestable, or (b) try to support every shape of limit (token bucket, leaky bucket, fixed window, per-key, per-user) and end up with a sprawling API. This library picks one model — a true sliding window over event timestamps — and one cap per limiter. If you need different burst sizes for different call sites, construct multiple limiters; if you need per-key isolation, keep a `Map<key, SlidingWindowRateLimiter>` outside this library.

The one deliberate coupling: `check()` both decides **and** records. This is intentional. A `check()` that does not record invites the classic bug of checking, then forgetting to record, which silently disables the limiter. `peek()` is the escape hatch for read-only inspection.

## The awkward edge

The window is **inclusive** on the left edge: `[now - windowMs, now]`. An event that happened exactly `windowMs` ago is still counted as in-window. This matters at the boundary: if your window is 1000 ms and you admit one event at t=0, then at t=1000 the limiter is still full. At t=1001 the old event finally expires. If your downstream code assumes a half-open window, this is the spot where you will be surprised.

The clock must advance monotonically in normal use. The limiter stores timestamps in ascending order and evicts from the front. If the clock ever goes backwards (NTP step, manual override), eviction still terminates and does not throw, but the limiter may retain stale timestamps longer than expected until the clock catches back up. There is no internal compensation for clock skew between processes.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

