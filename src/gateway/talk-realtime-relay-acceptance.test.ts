/**
 * End-to-end acceptance for Talk transcript persistence: the production relay
 * driving the real file-backed persistence boundary (no mock) through a fake
 * realtime provider bridge. Replaces the human WebUI speech acceptance step with
 * a deterministic assertion that finalized turns persist in order, that
 * identical text in separate exchanges survives under distinct turn ids, that
 * duplicate delivery deduplicates, and that no audio is ever stored.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  resolveSessionTranscriptReadTarget,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "../talk/provider-types.js";
import {
  clearTalkRealtimeRelaySessionsForTest,
  createTalkRealtimeRelaySession,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";

type AcceptanceMessage = {
  role?: string;
  content?: unknown;
  idempotencyKey?: string;
  openclawTalk?: { relaySessionId?: string; turnId?: string; provider?: string; source?: string };
};

function extractText(message: AcceptanceMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block) =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    return textBlock?.text ?? "";
  }
  return "";
}

describe("talk realtime relay transcript persistence acceptance", () => {
  let tempDir: string;
  let storePath: string;
  let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-acceptance-"));
    storePath = path.join(tempDir, "sessions.json");
    bridgeRequest = undefined;
  });

  afterEach(() => {
    clearTalkRealtimeRelaySessionsForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function config(): OpenClawConfig {
    return { session: { store: storePath } } satisfies OpenClawConfig;
  }

  async function seedAndCreateRelay() {
    const sessionKey = "agent:main:talk-acceptance";
    await upsertSessionEntry(
      { sessionKey, storePath },
      { sessionId: "session-acceptance", updatedAt: 10 },
    );
    const provider: RealtimeVoiceProviderPlugin = {
      id: "google",
      label: "Google",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      } as never,
      connId: "conn-1",
      cfg: config(),
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionKey,
    });
    return { session, sessionKey };
  }

  async function readMessages(sessionKey: string): Promise<AcceptanceMessage[]> {
    const readTarget = resolveSessionTranscriptReadTarget({
      sessionKey,
      storePath,
      sessionId: "session-acceptance",
    });
    const events = await loadTranscriptEvents({ sessionFile: readTarget.sessionFile });
    return events
      .filter((event) => event.type === "message")
      .map((event) => (event as { message?: AcceptanceMessage }).message)
      .filter((message): message is AcceptanceMessage => Boolean(message));
  }

  it("persists two exchanges in order, keeps identical user text distinct across exchanges, dedupes retries, and stores no audio", async () => {
    const { session, sessionKey } = await seedAndCreateRelay();

    // Exchange 1: user speaks, provider re-delivers the same final (retry), assistant replies.
    bridgeRequest?.onTranscript?.("user", "hello there", true);
    bridgeRequest?.onTranscript?.("user", "hello there", true);
    bridgeRequest?.onTranscript?.("assistant", "hi", true);
    // Exchange 2: user repeats the identical utterance after the reply, assistant replies again.
    bridgeRequest?.onTranscript?.("user", "hello there", true);
    bridgeRequest?.onTranscript?.("assistant", "welcome back", true);

    await stopTalkRealtimeRelaySession({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });

    const messages = await readMessages(sessionKey);

    // Spoken order preserved; the retry did not add a third user message.
    expect(messages.map((message) => [message.role, extractText(message)])).toEqual([
      ["user", "hello there"],
      ["assistant", "hi"],
      ["user", "hello there"],
      ["assistant", "welcome back"],
    ]);

    // Identical user text in separate exchanges persists under distinct turn ids.
    const userTurnIds = messages
      .filter((message) => message.role === "user")
      .map((message) => message.openclawTalk?.turnId);
    expect(userTurnIds).toHaveLength(2);
    expect(userTurnIds[0]).not.toBe(userTurnIds[1]);

    // Every persisted message carries Talk provenance.
    for (const message of messages) {
      expect(message.openclawTalk).toMatchObject({
        relaySessionId: session.relaySessionId,
        provider: "google",
        source: "realtime-talk",
      });
    }

    // Idempotency keys are unique (no duplicate persisted turn).
    const idempotencyKeys = messages.map((message) => message.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(idempotencyKeys.length);

    // No audio payload or path was introduced by the feature.
    const readTarget = resolveSessionTranscriptReadTarget({
      sessionKey,
      storePath,
      sessionId: "session-acceptance",
    });
    const transcriptJson = fs.readFileSync(readTarget.sessionFile, "utf8");
    expect(transcriptJson).not.toMatch(/audio|MediaPath|audioBase64/i);
  });
});
