const crypto = require('crypto');

/**
 * Simple token-based authentication.
 *
 * The shared secret token is read from config.json.
 * Both browser clients and the local agent must provide this token.
 */

function createAuthMiddleware(config) {
  const token = config.token;
  if (!token || token === 'your-shared-secret-token-here-change-me') {
    console.warn('⚠  WARNING: Using default token. Please change the token in config.json!');
  }

  return {
    /**
     * Verify a token against the configured secret.
     * Uses timing-safe comparison to prevent timing attacks.
     */
    verify(providedToken) {
      if (!providedToken || !token) return false;
      try {
        return crypto.timingSafeEqual(
          Buffer.from(providedToken),
          Buffer.from(token)
        );
      } catch {
        return false;
      }
    },

    /**
     * Generate a session token for an authenticated connection.
     */
    generateSessionId() {
      return crypto.randomUUID();
    }
  };
}

module.exports = { createAuthMiddleware };
