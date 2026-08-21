/**
 * Abuse limits for a server open to the internet.
 *
 * None of this matters on a laptop with friends on it; all of it matters the
 * moment the port is public. Everything here is in-memory and per-process,
 * which is the right scope for a single game server.
 */

/**
 * Classic token bucket: `capacity` actions available, refilling at
 * `refillPerSecond`. Bursts are fine, sustained floods are not.
 */
export class TokenBucket {
  constructor(capacity, refillPerSecond, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.updated = now;
  }

  take(cost = 1, now = Date.now()) {
    const elapsed = Math.max(0, now - this.updated) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updated = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Per-connection message limits. Chat is metered separately and much more
 * tightly than movement, because it is the one thing that reaches other people.
 */
export class ConnectionLimiter {
  constructor(now = Date.now()) {
    this.messages = new TokenBucket(60, 25, now); // bursty clicking is normal
    this.chat = new TokenBucket(5, 0.7, now); // roughly one line every 1.5s
    this.strikes = 0;
  }

  /** @returns {'ok'|'slow'|'flood'} */
  check(op, now = Date.now()) {
    if (!this.messages.take(1, now)) {
      this.strikes++;
      return this.strikes > 20 ? 'flood' : 'slow';
    }
    if ((op === 'chat' || op === 'pm') && !this.chat.take(1, now)) return 'slow';
    return 'ok';
  }
}

/**
 * Failed-login throttle, keyed by client address. Passwords are scrypt-hashed,
 * but that only helps if an attacker cannot try a million of them.
 */
export class LoginThrottle {
  constructor({ maxAttempts = 8, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map(); // key -> { count, first }
  }

  allowed(key, now = Date.now()) {
    const entry = this.attempts.get(key);
    if (!entry) return true;
    if (now - entry.first > this.windowMs) {
      this.attempts.delete(key);
      return true;
    }
    return entry.count < this.maxAttempts;
  }

  fail(key, now = Date.now()) {
    const entry = this.attempts.get(key);
    if (!entry || now - entry.first > this.windowMs) {
      this.attempts.set(key, { count: 1, first: now });
      return;
    }
    entry.count++;
  }

  succeed(key) {
    this.attempts.delete(key);
  }

  /** Drop expired entries so a long-running server does not grow forever. */
  sweep(now = Date.now()) {
    for (const [key, entry] of this.attempts) {
      if (now - entry.first > this.windowMs) this.attempts.delete(key);
    }
  }
}

/**
 * The address to attribute a connection to. Behind a proxy the socket address
 * is the proxy's, so the forwarded header is used - but only when the operator
 * has said there is a proxy, since the header is trivially forged otherwise.
 */
export function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return request.socket.remoteAddress ?? 'unknown';
}
