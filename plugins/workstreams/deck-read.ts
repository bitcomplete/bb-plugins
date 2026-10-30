import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { DeckView } from "./deck";
import { DECK_CHANGED } from "./deck-shared";
import { message } from "./deck-flow";
let cachedDeck: DeckView | null = null;
export function useDeck(seenAt: () => Record<string, number>, drawn: () => string[], beforeUpdate: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<DeckView | null>(cachedDeck);
  /** Reads landed on this visit, so a link can wait for one after it: the cached deck can predate a card just made. */
  const [reads, setReads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const again = useRef(false);
  const before = useRef(beforeUpdate);
  before.current = beforeUpdate;
  const seen = useRef(seenAt);
  seen.current = seenAt;
  const asked = useRef(drawn);
  asked.current = drawn;
  const load = useCallback(function read(): void {
    if (reading.current) { again.current = true; return; }
    reading.current = true;
    rpc.call("deck_get", { seen: seen.current(), ghosts: asked.current() }).then((next) => { before.current(); cachedDeck = next; setView(next); setReads((count) => count + 1); setError(null); },
      (cause: unknown) => setError(message(cause))).finally(() => {
      reading.current = false;
      if (again.current) { again.current = false; read(); }
    });
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(DECK_CHANGED, () => load());
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  /** A read is running now, so the next one to land may predate a change made during it. */
  const busy = useCallback(() => reading.current, []);
  return { rpc, view, reads, error, load, busy };
}

