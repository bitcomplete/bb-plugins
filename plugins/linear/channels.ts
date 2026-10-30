// Realtime channel names the server publishes on and the app listens to.
// Its own module so the app bundle can import the names without pulling
// server.ts, which needs node, into the browser.
export const CONNECTION_CHANGED = "connection-changed";
/** A watch came, went, or woke its thread, or the doorbell stream changed state. */
export const WATCHES_CHANGED = "watches-changed";
