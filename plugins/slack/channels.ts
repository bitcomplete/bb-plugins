// Realtime channel names the server publishes on and the app listens to.
// Its own module so the app bundle can import the name without pulling
// server.ts, which needs node, into the browser.
export const CONNECTION_CHANGED = "connection-changed";
