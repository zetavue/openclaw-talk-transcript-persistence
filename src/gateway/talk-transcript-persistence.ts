import { createHash } from "node:crypto";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export type PersistFinalTalkTranscriptRole = "user" | "assistant";

/**
 * Provenance attached to every finalized Talk transcript message so the normal
 * session JSONL records that the turn originated from realtime voice. Stored
 * alongside role/content; never carries raw audio.
 */
export type TalkTranscriptProvenance = {
  relaySessionId: string;
  turnId: string;
  provider: string;
  source: "realtime-talk";
};

export type PersistFinalTalkTranscriptParams = {
  sessionKey?: string;
  relaySessionId: string;
  turnId: string;
  provider: string;
  role: PersistFinalTalkTranscriptRole;
  text: string;
  now?: number;
  config?: OpenClawConfig;
};

export type PersistFinalTalkTranscriptResult = {
  status: "appended" | "duplicate" | "skipped";
  messageId?: string;
};

const TALK_TRANSCRIPT_SOURCE = "realtime-talk";
const GATEWAY_INJECTED_PROVIDER = "openclaw";
const GATEWAY_INJECTED_MODEL = "gateway-injected";

const ZERO_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function buildTalkIdempotencyKey(params: {
  relaySessionId: string;
  turnId: string;
  role: PersistFinalTalkTranscriptRole;
  text: string;
}): string {
  const textHash = createHash("sha256").update(params.text).digest("hex");
  // Role is part of the key so a user utterance and an assistant reply in the
  // same turn cannot collapse into one another.
  return `talk:${params.relaySessionId}:${params.turnId}:${params.role}:${textHash}`;
}

function buildTalkProvenance(params: {
  relaySessionId: string;
  turnId: string;
  provider: string;
}): TalkTranscriptProvenance {
  return {
    relaySessionId: params.relaySessionId,
    turnId: params.turnId,
    provider: params.provider,
    source: TALK_TRANSCRIPT_SOURCE,
  };
}

function buildTalkTranscriptMessage(params: {
  role: PersistFinalTalkTranscriptRole;
  text: string;
  now: number;
  idempotencyKey: string;
  provenance: TalkTranscriptProvenance;
}): unknown {
  const { idempotencyKey, provenance: openclawTalk } = params;
  if (params.role === "user") {
    return {
      role: "user",
      content: params.text,
      timestamp: params.now,
      idempotencyKey,
      openclawTalk,
    };
  }
  // Assistant replies are gateway-injected text: a standard text content block
  // with zero usage so the transcript mirrors a normal assistant turn.
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    provider: GATEWAY_INJECTED_PROVIDER,
    model: GATEWAY_INJECTED_MODEL,
    usage: ZERO_TOKEN_USAGE,
    stopReason: "stop",
    timestamp: params.now,
    idempotencyKey,
    openclawTalk,
  };
}

/**
 * Persists one finalized Talk transcript line into the normal OpenClaw session
 * JSONL for the bound agent session. Scan-based idempotency deduplicates
 * repeated final events for the same turn, so partial/duplicate provider
 * deliveries never create duplicate messages. Raw audio is never stored.
 */
export async function persistFinalTalkTranscript(
  params: PersistFinalTalkTranscriptParams,
): Promise<PersistFinalTalkTranscriptResult> {
  const sessionKey = params.sessionKey?.trim();
  const text = params.text.trim();
  if (!sessionKey || !text) {
    return { status: "skipped" };
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  // Resolve the store path from the supplied config so writes land in the same
  // store the runtime uses (and tests can isolate via config.session.store).
  const storePath = resolveStorePath(params.config?.session?.store, agentId ? { agentId } : {});
  const sessionId = loadSessionEntry({ sessionKey, storePath })?.sessionId;
  if (!sessionId) {
    // No bound agent session yet: persistence is opt-in per Talk session, so
    // skip silently instead of creating a transcript without an owning session.
    return { status: "skipped" };
  }

  const now = params.now ?? Date.now();
  const idempotencyKey = buildTalkIdempotencyKey({
    relaySessionId: params.relaySessionId,
    turnId: params.turnId,
    role: params.role,
    text,
  });
  const message = buildTalkTranscriptMessage({
    role: params.role,
    text,
    now,
    idempotencyKey,
    provenance: buildTalkProvenance({
      relaySessionId: params.relaySessionId,
      turnId: params.turnId,
      provider: params.provider,
    }),
  });

  const result = await persistSessionTranscriptTurn(
    {
      sessionKey,
      sessionId,
      storePath,
      ...(agentId ? { agentId } : {}),
      ...(params.config ? { config: params.config } : {}),
    },
    {
      updateMode: "inline",
      messages: [{ message, idempotencyLookup: "scan", now }],
    },
  );

  const appendResult = result.messages[0];
  if (!appendResult) {
    return { status: "skipped" };
  }
  return {
    status: appendResult.appended ? "appended" : "duplicate",
    messageId: appendResult.messageId,
  };
}
