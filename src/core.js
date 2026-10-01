/**
 * SlidingWindowRateLimiter — tracks event timestamps in a rolling window
 * and reports whether a new event would exceed a configured rate limit.
 *
 * Design decisions (stated plainly, per project policy):
 *
 * 1. Fixed cap, not per-call N. The constructor takes `maxEvents` and
 *    `windowMs`. check() takes only the current time and answers a single
 *    question: "is the (count + 1)th event within this window allowed?"
 *    It does NOT accept a burst-size argument. If you need different burst
 *    sizes for different call sites, construct multiple limiters.
 *
 * 2. check() is pure w.r.t. state mutation: it reports whether the event is
 *    allowed AND records it when allowed. This couples decision and recording
 *    on purpose — it prevents the classic "check, then forget to record" bug
 *    that silently disables a limiter. If you must check without recording
 *    (e.g., to display remaining budget in a UI), use `peek()`.
 *
 * 3. The clock is injected. Tests pass a fake clock and never touch the
 *    wall clock; production passes `Date.now`. No `setTimeout`, no sleeping,
 *    no drift between CI and a developer's laptop.
 *
 * 4. Timestamps are stored as a plain sorted array (decreasing by insertion
 *    order). Eviction keeps the array tiny by trimming entries whose window
 *    has fully closed. We do not measure time gaps in floats.
 */
export class SlidingWindowRateLimiter {
  #maxEvents;
  #windowMs;
  #now;
  /** @type {number[]} timestamps of admitted events, ascending */
  #timestamps = [];

  /**
   * @param {object} opts
   * @param {number} opts.maxEvents  Maximum events permitted within the window.
   * @param {number} opts.windowMs   Window length in milliseconds.
   * @param {() => number} [opts.clock]  Returns current time in ms epoch.
   *     Defaults to Date.now. Inject a fake in tests.
   */
  constructor({ maxEvents, windowMs, clock = () => Date.now() }) {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new RangeError('maxEvents must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be a positive finite number');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }
    this.#maxEvents = maxEvents;
    this.#windowMs = windowMs;
    this.#now = clock;
  }

  /**
   * Drop timestamps that fall before the current window's start.
   * Called only after we have a current time, so the window is well-defined.
   * @param {number} now  Current time (ms epoch).
   * @returns {void}
   */
  #evict(now) {
    const cutoff = now - this.#windowMs;
    // Strictly less than: an event at exactly `cutoff` is still in window.
    // The window is [now - windowMs, now].
    let firstValid = 0;
    while (firstValid < this.#timestamps.length && this.#timestamps[firstValid] < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.#timestamps = this.#timestamps.slice(firstValid);
    }
  }

  /**
   * Report whether a new event at the current time would be admitted, WITHOUT
   * recording it. Use this for observability (e.g., X-RateLimit-Remaining).
   *
   * @returns {{allowed: boolean, count: number, remaining: number}}
   *   - allowed:    whether check() at this instant would admit a new event.
   *   - count:      number of events currently within the window.
   *   - remaining:  maxEvents - count, clamped at 0.
   */
  peek() {
    const now = this.#now();
    this.#evict(now);
    const count = this.#timestamps.length;
    const remaining = Math.max(0, this.#maxEvents - count);
    return { allowed: count < this.#maxEvents, count, remaining };
  }

  /**
   * Decide whether a new event may proceed at the current time. If it is
   * allowed, record its timestamp. Returns the same shape as peek() so callers
   * can switch between them without reshaping.
   *
   * @returns {{allowed: boolean, count: number, remaining: number}}
   *   count and remaining reflect state AFTER this call (i.e., if allowed,
   *   the new event is included).
   */
  check() {
    const now = this.#now();
    this.#evict(now);
    const count = this.#timestamps.length;
    if (count < this.#maxEvents) {
      this.#timestamps.push(now);
      const after = count + 1;
      return { allowed: true, count: after, remaining: Math.max(0, this.#maxEvents - after) };
    }
    return { allowed: false, count, remaining: 0 };
  }

  /**
   * Forget all recorded events. Useful in tests to reset between scenarios
   * without constructing a new limiter (and losing the same clock).
   * @returns {void}
   */
  reset() {
    this.#timestamps = [];
  }
}
