import { describe, expect, it } from "vitest";
import { defaultMessageTarget, orderMessageTargets, sendRowMessage, type MessageSdk } from "./threadmessage.js";

const pr = {
  repo: "inkwell/quill",
  number: 42,
  title: "Show gift card balance",
  url: "https://github.com/inkwell/quill/pull/42",
  checkout: "/p/quill-abc-101",
};
const links = [{ id: "thr_author", tier: "environment" as const }];

function sdk(archivedAt: number | null = null, delivery: "sent" | "queued" = "sent") {
  const calls: unknown[] = [];
  const client: MessageSdk = {
    get: async (args) => {
      calls.push(["get", args]);
      return { archivedAt };
    },
    send: async (args) => {
      calls.push(["send", args]);
      return { ok: true, delivery };
    },
  };
  return { client, calls };
}

describe("sendRowMessage", () => {
  it("ranks a workstream-started thread above checkout activity while keeping recent order within each tier", () => {
    const options = [
      { id: "thr_path_recent", tier: "paths" as const },
      { id: "thr_ticket", tier: "ticket" as const },
      { id: "thr_started", tier: "started" as const },
      { id: "thr_environment", tier: "environment" as const },
      { id: "thr_path_old", tier: "paths" as const },
    ];
    expect(orderMessageTargets(options).map((thread) => thread.id)).toEqual([
      "thr_started", "thr_environment", "thr_ticket", "thr_path_recent", "thr_path_old",
    ]);
    expect(options[0]?.id).toBe("thr_path_recent");
  });

  it("requires an explicit target whenever more than one thread is associated", () => {
    expect(defaultMessageTarget(links)).toBe("thr_author");
    expect(defaultMessageTarget([...links, { id: "thr_possible", tier: "paths" }])).toBe("");
    expect(defaultMessageTarget([])).toBe("");
  });

  it("sends one instruction to the selected linked thread with PR context", async () => {
    const { client, calls } = sdk();
    expect(await sendRowMessage(client, { threadId: "thr_author", message: " Rebase and post PTAL. ", links, pr })).toEqual({ ok: true, delivery: "sent" });
    expect(calls).toEqual([
      ["get", { threadId: "thr_author" }],
      ["send", {
        threadId: "thr_author", mode: "auto", input: [{ type: "text", mentions: [],
          text: "Workstreams row: inkwell/quill #42 — Show gift card balance\nPR: https://github.com/inkwell/quill/pull/42\nCheckout: /p/quill-abc-101\n\nUser request:\nRebase and post PTAL.",
        }],
      }],
    ]);
  });

  it("refuses a stale or unrelated target before reading or sending", async () => {
    const { client, calls } = sdk();
    expect(await sendRowMessage(client, { threadId: "thr_elsewhere", message: "PTAL", links, pr })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("refuses blank instructions and archived threads", async () => {
    const blank = sdk();
    expect(await sendRowMessage(blank.client, { threadId: "thr_author", message: "  ", links, pr })).toMatchObject({ ok: false });
    expect(blank.calls).toEqual([]);
    const archived = sdk(123);
    expect(await sendRowMessage(archived.client, { threadId: "thr_author", message: "PTAL", links, pr })).toMatchObject({ ok: false });
    expect(archived.calls).toEqual([["get", { threadId: "thr_author" }]]);
  });

  it("reports queued delivery instead of claiming the agent saw the message", async () => {
    const { client } = sdk(null, "queued");
    expect(await sendRowMessage(client, { threadId: "thr_author", message: "PTAL", links, pr })).toEqual({ ok: true, delivery: "queued" });
  });
});
