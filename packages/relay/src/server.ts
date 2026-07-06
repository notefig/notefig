#!/usr/bin/env node
/**
 * Metrists relay: a dumb encrypted pipe.
 *
 * The server understands only the envelope in PROTOCOL.md (schemas in
 * @metrists/shared/relay). Everything in `frame.payload` is opaque
 * ciphertext — the relay can be hosted by anyone without being trusted
 * with document content, prompts, or keys.
 *
 * Skeleton: room join + frame forwarding between exactly two peers.
 * TODO(phase 3): room TTL, max frame size enforcement, per-IP token bucket,
 * graceful peer-left on disconnect, optional bounded replay buffer.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { RelayFrameSchema, type RelayFrame } from "@metrists/shared";

const PORT = Number(process.env.PORT ?? 8787);
/** Exactly two peers per room; no fan-out, ever. */
const MAX_PEERS_PER_ROOM = 2;

type Room = { peers: Set<WebSocket> };
const rooms = new Map<string, Room>();

function send(socket: WebSocket, frame: RelayFrame): void {
  socket.send(JSON.stringify(frame));
}

const server = new WebSocketServer({ port: PORT });

server.on("connection", (socket) => {
  let joinedRoom: string | null = null;

  socket.on("message", (data) => {
    const parsed = RelayFrameSchema.safeParse(
      JSON.parse(data.toString("utf8")),
    );
    if (!parsed.success) {
      socket.close(1002, "invalid frame");
      return;
    }
    const frame = parsed.data;

    if (frame.t === "hello") {
      const room = rooms.get(frame.room) ?? { peers: new Set() };
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        send(socket, { v: 1, t: "error", room: frame.room, message: "room full" });
        socket.close(1013, "room full");
        return;
      }
      room.peers.add(socket);
      rooms.set(frame.room, room);
      joinedRoom = frame.room;
      send(socket, { v: 1, t: "joined", room: frame.room });
      for (const peer of room.peers) {
        if (peer !== socket) {
          send(peer, { v: 1, t: "peer-joined", room: frame.room });
          send(socket, { v: 1, t: "peer-joined", room: frame.room });
        }
      }
      return;
    }

    if (frame.t === "frame" && joinedRoom === frame.room) {
      const room = rooms.get(frame.room);
      for (const peer of room?.peers ?? []) {
        if (peer !== socket) send(peer, frame);
      }
    }
  });

  socket.on("close", () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.peers.delete(socket);
    for (const peer of room.peers) {
      send(peer, { v: 1, t: "peer-left", room: joinedRoom });
    }
    if (room.peers.size === 0) rooms.delete(joinedRoom);
  });
});

console.log(`metrists-relay listening on :${PORT}`);
