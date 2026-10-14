import { createHash } from "node:crypto";

export type RelayFinalTranscriptDedupeState = {
  sequence: number;
  current?: {
    userFingerprint?: string;
    assistantFingerprint?: string;
    assistantCompleted: boolean;
  };
};

function fingerprintTranscriptText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function isDuplicateRelayFinalTranscript(
  state: RelayFinalTranscriptDedupeState,
  role: "user" | "assistant",
  text: string,
): boolean {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return false;
  }
  const fingerprint = fingerprintTranscriptText(normalizedText);
  if (role === "user") {
    return Boolean(
      state.current &&
      !state.current.assistantCompleted &&
      state.current.userFingerprint === fingerprint,
    );
  }
  return state.current?.assistantFingerprint === fingerprint;
}

export function recordRelayFinalTranscript(
  state: RelayFinalTranscriptDedupeState,
  role: "user" | "assistant",
  text: string,
): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  const fingerprint = fingerprintTranscriptText(normalizedText);
  if (role === "user") {
    if (
      !state.current ||
      state.current.assistantCompleted ||
      state.current.userFingerprint !== fingerprint
    ) {
      state.sequence += 1;
      state.current = { userFingerprint: fingerprint, assistantCompleted: false };
    }
    return;
  }
  if (!state.current) {
    state.sequence += 1;
    state.current = { assistantFingerprint: fingerprint, assistantCompleted: true };
    return;
  }
  state.current.assistantFingerprint = fingerprint;
  state.current.assistantCompleted = true;
}
