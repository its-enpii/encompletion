"use client";

import { io, Socket } from "socket.io-client";
import { getToken } from "./auth";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (typeof window === "undefined") {
    throw new Error("getSocket() must be called on the client");
  }
  if (!socket) {
    const token = getToken();
    // Connect same-origin via nginx (/socket.io/). NEXT_PUBLIC_API_URL is the
    // *internal* Docker hostname (http://backend:4000) used only by REST/authFetch
    // — for sockets we must use the public origin so nginx can reverse-proxy.
    socket = io("/", {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: token ? { token } : undefined,
    });
  }
  return socket;
}

export function refreshSocketAuth() {
  if (socket) {
    socket.auth = { token: getToken() || undefined };
    socket.disconnect().connect();
  }
}
