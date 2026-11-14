// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the Eloverblik token the user
// created in the portal (a JWT, the "refresh token" of the API). Nothing here
// talks to the network; nothing here is ever written out (the token stays in
// memory).
// -----------------------------------------------------------------------------

/** Control characters (CR, LF, tab included): never in a token. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A JWT: three base64url parts (the API says the token is a JWT). */
const JWT = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;
const MAX_TOKEN = 8192;

/**
 * `{ token, problem }`: `problem` names what keeps the integration from
 * reading (nothing is sent then).
 */
export function normalizeConfig(raw = {}) {
  const config = { token: '', problem: undefined };
  const token = raw?.refresh_token;
  if (token !== undefined && token !== null && typeof token !== 'string') {
    config.problem = 'malformed';
    return config;
  }
  // A copy from the portal may carry spaces or line breaks around it.
  const text = (token ?? '').trim();
  if (text.length > MAX_TOKEN || CONTROL.test(text)) {
    config.problem = 'malformed';
    return config;
  }
  if (!text) config.problem = 'missing';
  else if (!JWT.test(text)) config.problem = 'badToken';
  else config.token = text;
  return config;
}

/**
 * The expiry of the token (the `exp` of its payload, seconds), read without
 * any check of the signature: shown in the status only, never a decision.
 * Undefined when unreadable.
 */
export function tokenExpiry(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!part || part.length > 6000) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const exp = payload?.exp;
    return Number.isInteger(exp) && exp > 1_500_000_000 && exp < 4_102_444_800
      ? exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
