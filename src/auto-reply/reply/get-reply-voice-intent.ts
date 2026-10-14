import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../reply-payload.js";
import type { RuntimeMsgContext } from "../templating.js";
import {
  analyzeVoiceCommandIntent,
  type VoiceCommandIntentResult,
} from "./voice-command-intent.js";

export const VOICE_COMMAND_GUARD_MARKER = "openclaw-local-voice-command-guard-v1";
const VOICE_COMMAND_GUARD_PREFIX = "VOICE_COMMAND_GUARD:";

function isVoiceCommandGuardText(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith(VOICE_COMMAND_GUARD_PREFIX);
}

function applyVoiceCommandGuardToContext(
  target: RuntimeMsgContext,
  guardedBody: string,
  voiceText?: string,
): void {
  target.Body = guardedBody;
  target.BodyForAgent = guardedBody;
  target.BodyForCommands = guardedBody;
  target.CommandBody = guardedBody;
  target.commandText = guardedBody;
  if (!normalizeOptionalString(target.RawBody) && voiceText) {
    target.RawBody = voiceText;
  }
}

export function maybeApplyVoiceCommandGuard(
  sourceCtx: RuntimeMsgContext,
  finalizedCtx: RuntimeMsgContext,
  agentId?: string,
): VoiceCommandIntentResult | undefined {
  const provider = normalizeOptionalString(finalizedCtx.Provider ?? sourceCtx.Provider);
  if (provider?.toLowerCase() !== "telegram") {
    return undefined;
  }

  const sourceRecord = sourceCtx as Record<string, unknown>;
  const finalizedRecord = finalizedCtx as Record<string, unknown>;
  const transcript = normalizeOptionalString(
    finalizedRecord.AudioTranscriptText ?? sourceRecord.AudioTranscriptText,
  );
  const mediaType = normalizeOptionalString(finalizedRecord.MediaType ?? sourceRecord.MediaType);
  const body = normalizeOptionalString(finalizedCtx.Body ?? sourceCtx.Body);
  const voiceText = transcript ?? body;
  const isAudioTurn = Boolean(transcript) || /^audio\//i.test(mediaType ?? "");

  if (!isAudioTurn || !voiceText) {
    return undefined;
  }

  const intentResult = analyzeVoiceCommandIntent({
    text: voiceText,
    channel: provider,
    agentId,
  });
  const existingGuard =
    [
      normalizeOptionalString(finalizedCtx.Body),
      normalizeOptionalString(finalizedCtx.BodyForAgent),
      normalizeOptionalString(finalizedCtx.BodyForCommands),
      normalizeOptionalString(finalizedCtx.CommandBody),
      normalizeOptionalString(sourceCtx.Body),
      normalizeOptionalString(sourceCtx.BodyForAgent),
      normalizeOptionalString(sourceCtx.BodyForCommands),
      normalizeOptionalString(sourceCtx.CommandBody),
    ].find((value): value is string => isVoiceCommandGuardText(value)) ?? null;

  const guardedBody =
    existingGuard ??
    (() => {
      const guard = [
        VOICE_COMMAND_GUARD_PREFIX,
        `intent: ${intentResult.intent}`,
        `risk: ${intentResult.risk}`,
        `confidence: ${intentResult.confidence}`,
        `requires_confirmation: ${intentResult.requiresConfirmation ? "yes" : "no"}`,
        `grounding_required: ${intentResult.groundingRequired ? "yes" : "no"}`,
        intentResult.evidenceTerms.length
          ? `evidence_terms: ${intentResult.evidenceTerms.join(", ")}`
          : "evidence_terms: none",
        intentResult.missingFields.length
          ? `missing_fields: ${intentResult.missingFields.join(", ")}`
          : "missing_fields: none",
        `instruction: ${intentResult.confirmationHint}`,
      ].join("\n");
      return `${guard}\n\nTRANSCRIBED_VOICE_TEXT:\n${voiceText}`;
    })();

  applyVoiceCommandGuardToContext(sourceCtx, guardedBody, transcript ?? body);
  applyVoiceCommandGuardToContext(finalizedCtx, guardedBody, transcript ?? body);
  return intentResult;
}

function formatVoiceIntentLabel(intent: VoiceCommandIntentResult["intent"]): string {
  switch (intent) {
    case "mail.send":
      return "Mail senden";
    case "mail.delete_draft":
      return "Entwurf loeschen";
    default:
      return intent;
  }
}

export function maybeBuildHighRiskVoiceIntentConfirmation(
  intentResult?: VoiceCommandIntentResult,
): ReplyPayload | undefined {
  if (
    !intentResult ||
    (intentResult.intent !== "mail.send" && intentResult.intent !== "mail.delete_draft")
  ) {
    return undefined;
  }
  const evidence = intentResult.evidenceTerms[0];
  return {
    text: `Meinst du ${formatVoiceIntentLabel(intentResult.intent)}${
      evidence ? ` fuer ${evidence}` : ""
    }?`,
  };
}
