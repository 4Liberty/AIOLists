// src/utils/rateLimiter.js
// Simple token bucket rate limiter for up to N requests per second
class RateLimiter {
  constructor({ tokensPerInterval, interval }) {
    this.tokensPerInterval = tokensPerInterval;
    this.interval = interval;
    this.tokens = tokensPerInterval;
    this.queue = [];
    setInterval(() => {
      this.tokens = this.tokensPerInterval;
      this._processQueue();
    }, this.interval);
  }

  _processQueue() {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      const { resolve } = this.queue.shift();
      resolve();
    }
  }

  async removeToken() {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve });
    });
  }
}

module.exports = RateLimiter;
