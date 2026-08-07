/* ARCANE LEDGER — thin fetch wrapper for the backend (server/).
 *
 * The client (this file set) and the API server are two separate
 * processes/origins (in production, two separate Render services on two
 * different onrender.com subdomains -- see render.yaml).
 *
 * Auth transport (revised -- see server/src/lib/session.js's setSessionCookie
 * comment for the full history): this used to rely on an HttpOnly session
 * cookie round-tripping via `credentials: 'include'`. That broke in
 * practice on mobile Safari / iOS in-app-browsers: their Intelligent
 * Tracking Prevention (ITP) treats a cookie set by a cross-site fetch/XHR
 * *response* (exactly what neon-core-api.onrender.com responding to
 * neon-core-client.onrender.com is) as a third-party tracking cookie and
 * blocks/evicts it, regardless of correct `SameSite=None; Secure` -- so
 * login would succeed but the very next request would 401 with "session
 * expired." ITP's eviction targets are specifically the browser's ambient
 * cookie jar; it has no special knowledge of or interest in localStorage,
 * which is ordinary same-origin (first-party, from the CLIENT's own
 * origin's point of view) storage that the client's own JS reads and writes
 * explicitly -- there is no "cross-site" classification to apply to it the
 * way there is for a cookie set by a *different* site's response. That's
 * why moving the token here sidesteps the problem rather than just
 * reshuffling which cookie flag gets blamed next.
 *
 * So: login/signup responses now include `token` in the JSON body (in
 * addition to a Set-Cookie the server only actually sends in dev -- see
 * setToken/getToken below), which is stored in localStorage and attached as
 * `Authorization: Bearer <token>` on every subsequent request. `credentials:
 * 'include'` is kept (harmless -- in dev it still round-trips the cookie
 * server/scripts/*-smoke-test.js also rely on directly; in production
 * there's simply nothing for it to send since the server no longer sets a
 * cookie there).
 *
 * API_BASE_URL comes from js/config.js (loaded before this file, see
 * index.html) rather than being hardcoded here, so the same file set works
 * unmodified against local dev and the deployed Render API.
 */
const API_BASE_URL = CONFIG.API_BASE_URL;

const TOKEN_STORAGE_KEY = 'al_session_token';

// Wrapped in try/catch: localStorage can throw in rare environments (e.g.
// some in-app-browser private-mode configurations block it entirely) --
// degrading to "acts logged out" there is acceptable, throwing an uncaught
// exception on every API call is not.
function getToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch (e) { return null; }
}
function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (e) { /* see getToken -- degrade silently */ }
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function apiRequest(path, options) {
  options = options || {};
  const hasBody = options.body !== undefined;
  const token = getToken();
  const headers = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(API_BASE_URL + path, {
    method: options.method || 'GET',
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }

  if (!res.ok) {
    // A 401 means the token we sent (if any) is missing/invalid/expired --
    // proactively drop it so the app doesn't keep retrying a dead token on
    // every future load (App.checkSession in js/main.js would otherwise
    // just silently keep failing the same way forever instead of cleanly
    // dropping to the login screen with a clean slate).
    if (res.status === 401) setToken(null);
    const message = (data && data.error)
      || (data && data.fieldErrors && '입력값을 확인해주세요')
      || `요청을 처리하지 못했습니다 (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

const API = {
  ApiError,
  // Exposed so js/ws.js (which can't send an Authorization header -- browser
  // WebSocket connections can't set custom headers at handshake time) can
  // read the same stored token and pass it as a `?token=` query param
  // instead. Not exposed as setToken -- nothing outside this file should be
  // writing the token directly; it's only ever set as a side effect of a
  // successful login/signup below, and cleared via auth.logout() or a 401.
  getToken,
  auth: {
    // payload: { email, password, confirmPassword, displayName } -> { account: {id,email,displayName}, token }
    // 400 -> { fieldErrors: { email?, password?, confirmPassword?, displayName? } } (spec §4.1)
    signup: (payload) => apiRequest('/api/auth/signup', { method: 'POST', body: payload })
      .then((data) => { setToken(data && data.token); return data; }),
    // payload: { email, password } -> { account: {id,email,displayName}, token }
    // 401 -> { error: <unified message> } (spec §4.2, never field-specific)
    login: (payload) => apiRequest('/api/auth/login', { method: 'POST', body: payload })
      .then((data) => { setToken(data && data.token); return data; }),
    // -> null (204 No Content). Clears the stored token locally even if the
    // request itself fails (see js/main.js's handleLogout -- offline logout
    // should still drop the player to the login screen locally).
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }).finally(() => setToken(null)),
    // -> { account: {id,email,displayName} }; 401 (ApiError) if no valid session
    me: () => apiRequest('/api/auth/me'),
  },
  decks: {
    // -> { slots: [ {slot,name,cards,total,valid,updatedAt} | null, ... ] }, always length 3
    list: () => apiRequest('/api/decks'),
    // payload: { name, cards: {cardId: count} } -> upserted deck object
    save: (slot, payload) => apiRequest(`/api/decks/${slot}`, { method: 'PUT', body: payload }),
    remove: (slot) => apiRequest(`/api/decks/${slot}`, { method: 'DELETE' }),
  },
  matchHistory: {
    // -> { matches: [ {opponentDisplayName, result: 'win'|'loss'|'win_forfeit', playedAt: 'YYYY-MM-DD'}, ... ] }
    // Most recent first, capped at 100 server-side (spec §6.5).
    list: () => apiRequest('/api/match-history'),
  },
  rooms: {
    // -> { rooms: [ {id, hostDisplayName, createdAt: <ms epoch>}, ... ] }
    // Open (waiting-for-second-player) rooms, newest first -- spec §6.2.1-
    // §6.2.3. `id` is the relay's internal room identifier (never shown to
    // the player) -- js/match.js passes it straight back as room_join's
    // `code` when a row is clicked. Polled every 3s + manual refresh by
    // js/match.js, per spec §6.2.3's explicit "no realtime push" decision --
    // see server/src/routes/rooms.js for why this is REST, not a WS message.
    list: () => apiRequest('/api/rooms'),
  },
};
