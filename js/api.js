/* ARCANE LEDGER — thin fetch wrapper for the backend (server/).
 *
 * The client (this file set) and the API server are two separate
 * processes/origins (in production, two separate Render services on two
 * different onrender.com subdomains -- see render.yaml). Every request
 * sends `credentials: 'include'` so the HttpOnly session cookie
 * (server/src/lib/session.js) round-trips; the server's CORS config
 * (server/src/app.js) is what makes that legal cross-origin.
 *
 * API_BASE_URL comes from js/config.js (loaded before this file, see
 * index.html) rather than being hardcoded here, so the same file set works
 * unmodified against local dev and the deployed Render API.
 */
const API_BASE_URL = CONFIG.API_BASE_URL;

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
  const res = await fetch(API_BASE_URL + path, {
    method: options.method || 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = null; }
  }

  if (!res.ok) {
    const message = (data && data.error)
      || (data && data.fieldErrors && '입력값을 확인해주세요')
      || `요청을 처리하지 못했습니다 (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

const API = {
  ApiError,
  auth: {
    // payload: { email, password, confirmPassword, displayName } -> { account: {id,email,displayName} }
    // 400 -> { fieldErrors: { email?, password?, confirmPassword?, displayName? } } (spec §4.1)
    signup: (payload) => apiRequest('/api/auth/signup', { method: 'POST', body: payload }),
    // payload: { email, password } -> { account: {id,email,displayName} }
    // 401 -> { error: <unified message> } (spec §4.2, never field-specific)
    login: (payload) => apiRequest('/api/auth/login', { method: 'POST', body: payload }),
    // -> null (204 No Content)
    logout: () => apiRequest('/api/auth/logout', { method: 'POST' }),
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
};
