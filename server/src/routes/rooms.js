const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const rooms = require('../ws/rooms');

/* spec-online-pvp.md §6.2 (2026-08 revision): the room-list screen needs to
 * fetch "currently open rooms" on load and again every 3s (polling, §6.2.3)
 * -- crucially, BEFORE the client has created or joined any room, i.e.
 * before there is any WS room/session context to hang a request off of.
 *
 * REST vs. a new WS message type -- reasoning (per task brief, stating this
 * explicitly rather than picking silently):
 *
 * - A WS message type (e.g. `list_rooms`) is not ruled out by the relay's
 *   existing per-room-only messaging design the way protocol.js's other
 *   client->server messages are -- `list_rooms` wouldn't need a `ws.roomCode`
 *   to already be set, so it COULD be added as a room-agnostic message
 *   handled directly in ws/server.js's handleMessage() switch. So this
 *   isn't a hard technical blocker either way.
 * - The deciding factor is fit with the polling model spec §6.2.3 explicitly
 *   settled on: 3s auto-poll + a manual refresh button, i.e. a plain
 *   stateless "ask now, get an answer now" request/response, repeated on a
 *   timer -- there is no ongoing subscription or session tied to it. That is
 *   exactly the shape every other read this client already does (GET
 *   /api/decks, GET /api/match-history, js/api.js) -- reusing plain
 *   `fetch()` + the existing HttpOnly-cookie auth (requireAuth, same as
 *   those routes) means the room-list screen never needs to open a WS
 *   connection at all just to browse -- it only calls Net.connect() (js/
 *   ws.js) at the moment the player actually creates or joins a room. Doing
 *   this over WS instead would mean either (a) opening a socket purely to
 *   poll a list, before the player has committed to playing at all, or (b)
 *   somehow answering a `list_rooms` sent on a socket that doesn't have a
 *   room yet -- solvable, but it's solving a problem plain HTTP already
 *   solves for free, for a message that carries no realtime/push
 *   requirement (spec explicitly rejected push for this).
 * - Implementation cost: this route requires('../ws/rooms') directly and
 *   reads its in-memory `rooms` Map synchronously -- legal because the HTTP
 *   API and the WS relay are the exact same Node process (server/src/
 *   index.js attaches both to one httpServer). No IPC, no second data
 *   store, no risk of the REST view and the WS relay's bookkeeping
 *   disagreeing with each other.
 */
const router = express.Router();
router.use(requireAuth);

// GET /api/rooms -- open (waiting-for-second-player) rooms, newest first.
// See rooms.js's listOpenRooms() for exactly what counts as "open".
router.get('/', (req, res) => {
  res.json({ rooms: rooms.listOpenRooms() });
});

module.exports = router;
