// src/utils/rateLimiter.js
// Simple token bucket rate limiter for up to N requests per second
class RateLimiter {
  constructor({ tokensPerInterval, interval }) {
    this.tokensPerInterval = tokensPerInterval;
    this.interval = interval;
    this.tokens = tokensPerInterval;
    this.queue = [];
    this._intervalId = setInterval(() => {
      this.tokens = this.tokensPerInterval;
      this._processQueue();
    }, this.interval);
    
    // Prevent the interval from keeping the process alive
    if (this._intervalId.unref) {
      this._intervalId.unref();
    }
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
  
  /**
   * Cleanup method to prevent memory leaks
   */
  destroy() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this.queue = [];
  }
}

module.exports = RateLimiter;
