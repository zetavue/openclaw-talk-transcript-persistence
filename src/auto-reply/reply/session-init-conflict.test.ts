// Regression coverage for transient reply-session initialization write conflicts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  commitReplySessionInitialization: vi.fn(),
  loadReplySessionInitializationSnapshot: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  commitReplySessionInitialization: sessionAccessorMocks.commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot:
    sessionAccessorMocks.loadReplySessionInitializationSnapshot,
}));

describe("initSessionState conflict recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionAccessorMocks.commitReplySessionInitialization.mockReset();
    sessionAccessorMocks.loadReplySessionInitializationSnapshot.mockReset();
  });

  it("keeps retrying long enough to recover from bursty session-store conflicts", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-init-conflict-"));
    try {
      const storePath = path.join(root, "sessions.json");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      let snapshotRevision = 0;
      let committedEntry: SessionEntry | undefined;

      sessionAccessorMocks.loadReplySessionInitializationSnapshot.mockImplementation(() => ({
        currentEntry: undefined,
        readEntry: () => undefined,
        revision: `rev-${++snapshotRevision}`,
      }));
      sessionAccessorMocks.commitReplySessionInitialization.mockImplementation(
        async ({
          sessionEntry,
          sessionKey,
        }: {
          sessionEntry: SessionEntry;
          sessionKey: string;
        }) => {
          if (sessionAccessorMocks.commitReplySessionInitialization.mock.calls.length <= 7) {
            return { ok: false, reason: "stale-snapshot" };
          }
          committedEntry = {
            ...sessionEntry,
            sessionFile: path.join(root, `${sessionEntry.sessionId}.jsonl`),
          };
          return {
            ok: true,
            sessionEntry: committedEntry,
            sessionStoreView: { [sessionKey]: committedEntry },
            previousSessionTranscript: {},
          };
        },
      );

      const resultPromise = initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: "ping",
          ChatType: "direct",
          Provider: "webchat",
          SessionKey: "agent:restaurant:dashboard:test",
        },
      });

      await vi.advanceTimersByTimeAsync(20_000);

      await expect(resultPromise).resolves.toMatchObject({
        sessionEntry: committedEntry,
        sessionKey: "agent:restaurant:dashboard:test",
      });
      expect(sessionAccessorMocks.commitReplySessionInitialization).toHaveBeenCalledTimes(8);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
