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

  it("serializes concurrent initialization for the same reply session key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-init-queue-"));
    let releaseFirstCommit: (() => void) | undefined;
    try {
      const storePath = path.join(root, "sessions.json");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const firstCommitStarted = new Promise<void>((resolve) => {
        sessionAccessorMocks.commitReplySessionInitialization.mockImplementation(
          async ({
            sessionEntry,
            sessionKey,
          }: {
            sessionEntry: SessionEntry;
            sessionKey: string;
          }) => {
            const callIndex =
              sessionAccessorMocks.commitReplySessionInitialization.mock.calls.length;
            if (callIndex === 1) {
              resolve();
              await new Promise<void>((release) => {
                releaseFirstCommit = release;
              });
            }
            const committedEntry = {
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
      });
      sessionAccessorMocks.loadReplySessionInitializationSnapshot.mockImplementation(() => ({
        currentEntry: undefined,
        readEntry: () => undefined,
        revision: "stable",
      }));

      const first = initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: "first",
          ChatType: "direct",
          Provider: "telegram",
          SessionKey: "agent:test:telegram:direct:1944659960",
        },
      });
      await firstCommitStarted;

      const second = initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: "second",
          ChatType: "direct",
          Provider: "telegram",
          SessionKey: "agent:test:telegram:direct:1944659960",
        },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(sessionAccessorMocks.commitReplySessionInitialization).toHaveBeenCalledTimes(1);
      releaseFirstCommit?.();

      await Promise.all([first, second]);
      expect(sessionAccessorMocks.commitReplySessionInitialization).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirstCommit?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
