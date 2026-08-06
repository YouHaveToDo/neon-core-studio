/* ARCANE LEDGER — runtime environment config for the static client (no build
 * step, per project convention: plain script tags, no bundler/framework).
 * Loaded before js/api.js (and therefore js/ws.js, which reads API_BASE_URL
 * from api.js) -- see index.html's script order.
 *
 * Deploy shape (render.yaml, repo root): the client and the API are two
 * SEPARATE Render services on two different onrender.com subdomains --
 * `neon-core-client.onrender.com` (Static Site) and
 * `neon-core-api.onrender.com` (Node Web Service). They are NOT same-origin
 * in production, so the API's URL can't be derived from window.location the
 * way it could if they shared an origin -- it has to be a known constant.
 *
 * Local dev keeps working exactly as before: the client is opened against
 * `localhost`/`127.0.0.1` (a plain static server, or even file://), and the
 * API runs on localhost:3001 (server/src/config.js's PORT default). That's a
 * reliable, zero-config signal for which branch to take -- Render's static
 * site never serves from a `localhost` hostname, so there's no ambiguity.
 *
 * If the production API's Render service is ever renamed, update
 * PRODUCTION_API_BASE_URL below (and render.yaml's CLIENT_ORIGIN to match
 * the client's own URL) -- this is intentionally a plain constant, not a
 * build-time env system, since that would be speculative infrastructure for
 * a project this size (two known deploy targets, not N of them).
 */
const CONFIG = (() => {
  const PRODUCTION_API_BASE_URL = 'https://neon-core-api.onrender.com';
  const LOCAL_API_BASE_URL = 'http://localhost:3001';

  const { hostname } = window.location;
  const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

  return {
    API_BASE_URL: isLocalDev ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL,
  };
})();
