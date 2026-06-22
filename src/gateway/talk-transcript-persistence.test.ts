import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSessionTranscriptReadTarget,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import { readSessionMessages } from "./session-transcript-readers.js";
import { persistFinalTalkTranscript } from "./talk-transcript-persistence.js";

const RELAY_SESSION_ID = "relay-1";
const TURN_ID = "turn-1";
const PROVIDER = "google";

type PersistedTalkMessage = {
  role?: string;
  content?: unknown;
  idempotencyKey?: string;
  openclawTalk?: {
    relaySessionId?: string;
    turnId?: string;
    provider?: string;
    source?: string;
  };
};

function makeSessionKey(id: string): string {
  return `agent:main:talk-${id}`;
}

async function readPersistedMessages(scope: {
  sessionKey: string;
  storePath: string;
  sessionId: string;
}): Promise<PersistedTalkMessage[]> {
  return readSessionMessages({
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    sessionId: scope.sessionId,
  }) as PersistedTalkMessage[];
}

describe("persistFinalTalkTranscript", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function config(): OpenClawConfig {
    return { session: { store: storePath } } satisfies OpenClawConfig;
  }

  async function seedSession(sessionKey: string, sessionId: string) {
    await upsertSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 10 });
    return { sessionKey, storePath, sessionId };
  }

  it("appends a finalized user transcript with provenance and no audio artifacts", async () => {
    const sessionKey = makeSessionKey("user");
    const scope = await seedSession(sessionKey, "session-user");

    const result = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "user",
      text: "  Hallo ਜੀ नमस्ते hello  ",
      now: 1000,
      config: config(),
    });

    expect(result.status).toBe("appended");
    expect(result.messageId).toEqual(expect.any(String));

    const messages = await readPersistedMessages(scope);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "Hallo ਜੀ नमस्ते hello",
      openclawTalk: {
        relaySessionId: RELAY_SESSION_ID,
        turnId: TURN_ID,
        provider: PROVIDER,
        source: "realtime-talk",
      },
    });
    expect(JSON.stringify(messages.at(-1))).not.toMatch(/audio|MediaPath|audioBase64/i);
  });

  it("appends a finalized assistant transcript as a text content block", async () => {
    const sessionKey = makeSessionKey("assistant");
    const scope = await seedSession(sessionKey, "session-assistant");

    const result = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "assistant",
      text: "Sure, here is the answer.",
      now: 2000,
      config: config(),
    });

    expect(result.status).toBe("appended");
    const messages = await readPersistedMessages(scope);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Sure, here is the answer." }],
    });
    expect(messages.at(-1)?.openclawTalk).toMatchObject({
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      source: "realtime-talk",
    });
  });

  it("skips when the finalized text is empty after trimming", async () => {
    const sessionKey = makeSessionKey("empty");
    await seedSession(sessionKey, "session-empty");

    const result = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "user",
      text: "   ",
      now: 3000,
      config: config(),
    });

    expect(result.status).toBe("skipped");
    expect(result.messageId).toBeUndefined();
  });

  it("skips when no session key is bound to the relay session", async () => {
    const result = await persistFinalTalkTranscript({
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "user",
      text: "hello",
      now: 4000,
      config: config(),
    });

    expect(result.status).toBe("skipped");
  });

  it("deduplicates repeated final events for the same turn", async () => {
    const sessionKey = makeSessionKey("dup");
    const scope = await seedSession(sessionKey, "session-dup");

    const first = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "user",
      text: "repeat me",
      now: 5000,
      config: config(),
    });
    const second = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: TURN_ID,
      provider: PROVIDER,
      role: "user",
      text: "repeat me",
      now: 6000,
      config: config(),
    });

    expect(first.status).toBe("appended");
    expect(second.status).toBe("duplicate");
    const messages = await readPersistedMessages(scope);
    expect(messages.filter((message) => message.content === "repeat me")).toHaveLength(1);
  });

  it("appends identical text under different turn ids", async () => {
    const sessionKey = makeSessionKey("turns");
    const scope = await seedSession(sessionKey, "session-turns");

    const first = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: "turn-a",
      provider: PROVIDER,
      role: "user",
      text: "same words",
      now: 7000,
      config: config(),
    });
    const second = await persistFinalTalkTranscript({
      sessionKey,
      relaySessionId: RELAY_SESSION_ID,
      turnId: "turn-b",
      provider: PROVIDER,
      role: "user",
      text: "same words",
      now: 8000,
      config: config(),
    });

    expect(first.status).toBe("appended");
    expect(second.status).toBe("appended");
    const messages = await readPersistedMessages(scope);
    expect(messages.filter((message) => message.content === "same words")).toHaveLength(2);
  });
});
