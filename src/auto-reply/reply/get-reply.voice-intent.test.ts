import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.js";
import { buildGetReplyCtx } from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { analyzeVoiceCommandIntent } from "./voice-command-intent.js";
import "./get-reply.test-runtime-mocks.js";

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

function buildFastReplyConfig(): OpenClawConfig {
  return markCompleteReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-4o-mini",
        workspace: "/tmp/openclaw-voice-intent-test",
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
      },
    },
  } as OpenClawConfig);
}

function requirePreparedReplyParams() {
  const preparedReplyParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
  if (!preparedReplyParams) {
    throw new Error("expected prepared reply params");
  }
  return preparedReplyParams;
}

function buildExpectedGuardedBody(text: string, agentId = "restaurant"): string {
  const result = analyzeVoiceCommandIntent({
    text,
    channel: "telegram",
    agentId,
  });
  const guard = [
    "VOICE_COMMAND_GUARD:",
    `intent: ${result.intent}`,
    `risk: ${result.risk}`,
    `confidence: ${result.confidence}`,
    `requires_confirmation: ${result.requiresConfirmation ? "yes" : "no"}`,
    `grounding_required: ${result.groundingRequired ? "yes" : "no"}`,
    result.evidenceTerms.length
      ? `evidence_terms: ${result.evidenceTerms.join(", ")}`
      : "evidence_terms: none",
    result.missingFields.length
      ? `missing_fields: ${result.missingFields.join(", ")}`
      : "missing_fields: none",
    `instruction: ${result.confirmationHint}`,
  ].join("\n");
  return `${guard}\n\nTRANSCRIBED_VOICE_TEXT:\n${text}`;
}

describe("getReplyFromConfig voice intent guard", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(resolveDefaultModelMock).mockReset();
    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
    });
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("short-circuits telegram audio send intents with a confirmation reply", async () => {
    const text = "Schick die Antwort an Emily raus";
    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: text,
        BodyForAgent: text,
        RawBody: text,
        CommandBody: text,
        MediaType: "audio/ogg",
        AudioTranscriptText: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    expect(reply).toEqual({ text: "Meinst du Mail senden fuer Emily?" });
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("short-circuits telegram audio delete-draft intents with a confirmation reply", async () => {
    const text = "Loesch den Entwurf fuer Emily";
    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: text,
        BodyForAgent: text,
        RawBody: text,
        MediaType: "audio/ogg",
        AudioTranscriptText: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    expect(reply).toEqual({ text: "Meinst du Entwurf loeschen fuer Emily?" });
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("guards lookup voice transcripts before command parsing and still reaches the agent path", async () => {
    const text = "Such die Mail von Emily";
    await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: text,
        BodyForAgent: text,
        BodyForCommands: text,
        RawBody: text,
        CommandBody: text,
        CommandSource: "native",
        CommandAuthorized: true,
        MediaType: "audio/ogg",
        AudioTranscriptText: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    const preparedReplyParams = requirePreparedReplyParams();
    const expectedGuardedBody = buildExpectedGuardedBody(text);
    expect(preparedReplyParams.ctx.Body).toBe(expectedGuardedBody);
    expect(preparedReplyParams.ctx.BodyForCommands).toBe(expectedGuardedBody);
    expect(preparedReplyParams.ctx.CommandBody).toBe(expectedGuardedBody);
    expect(preparedReplyParams.commandSource).not.toBe(text);
    expect(preparedReplyParams.commandSource).toContain("VOICE_COMMAND_GUARD:");
  });

  it("guards draft voice transcripts and still reaches the agent path", async () => {
    const text = "Mach einen Entwurf fuer Emily";
    await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: text,
        BodyForAgent: text,
        RawBody: text,
        CommandBody: text,
        MediaType: "audio/ogg",
        AudioTranscriptText: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.ctx.RawBody).toBe(text);
    expect(preparedReplyParams.ctx.Body).toBe(buildExpectedGuardedBody(text));
    expect(preparedReplyParams.ctx.BodyForCommands).toBe(buildExpectedGuardedBody(text));
    expect(preparedReplyParams.ctx.CommandBody).toBe(buildExpectedGuardedBody(text));
  });

  it("leaves ordinary telegram text commands unchanged", async () => {
    const text = "Bitte antworte Emily spaeter";
    await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: text,
        BodyForAgent: text,
        BodyForCommands: text,
        RawBody: text,
        CommandBody: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.ctx.Body).toBe(text);
    expect(preparedReplyParams.ctx.BodyForCommands).toBe(text);
    expect(preparedReplyParams.ctx.CommandBody).toBe(text);
    expect(preparedReplyParams.ctx.RawBody).toBe(text);
  });

  it("reuses an existing voice guard without duplicating it", async () => {
    const text = "Such die Mail von Emily";
    const guardedBody = buildExpectedGuardedBody(text);
    await getReplyFromConfig(
      buildGetReplyCtx({
        AgentId: "restaurant",
        Body: guardedBody,
        BodyForAgent: guardedBody,
        BodyForCommands: text,
        RawBody: text,
        CommandBody: text,
        MediaType: "audio/ogg",
        AudioTranscriptText: text,
      }),
      undefined,
      buildFastReplyConfig(),
    );

    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.ctx.Body).toBe(guardedBody);
    expect(preparedReplyParams.ctx.BodyForCommands).toBe(guardedBody);
    expect(preparedReplyParams.ctx.CommandBody).toBe(guardedBody);
    expect(preparedReplyParams.ctx.Body.match(/VOICE_COMMAND_GUARD:/g)?.length ?? 0).toBe(1);
  });
});
