import { describe, expect, it } from "vitest";
import { analyzeVoiceCommandIntent } from "./voice-command-intent.js";

describe("analyzeVoiceCommandIntent", () => {
  it("marks send mail as high risk and confirmation required", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Schick die Antwort an Emily raus",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.send");
    expect(result.risk).toBe("high");
    expect(result.confidence).toBe("medium");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.groundingRequired).toBe(true);
  });

  it("marks unclear pronoun references as missing target", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Leg den Entwurf fuer sie ab",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.draft");
    expect(result.missingFields).toContain("target_person_or_mail");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("treats read-only lookup as low risk", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Such bitte die Mail von Conrath von heute Morgen",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.lookup");
    expect(result.risk).toBe("low");
    expect(result.confidence).toBe("high");
    expect(result.groundingRequired).toBe(true);
  });

  it("classifies draft creation intent as medium risk", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Leg den Entwurf fuer Emily ab",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.draft");
    expect(result.risk).toBe("medium");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.groundingRequired).toBe(true);
    expect(result.missingFields).toStrictEqual([]);
    expect(result.evidenceTerms).toContain("Emily");
  });

  it("classifies draft update intent as medium risk", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Aktualisiere den Entwurf von Emily bitte",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.update_draft");
    expect(result.risk).toBe("medium");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.missingFields).toStrictEqual([]);
  });

  it("classifies imperative draft updates before draft fallback", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Bitte den Entwurf fuer Emily aktualisieren",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.update_draft");
    expect(result.evidenceTerms[0]).toBe("Emily");
  });

  it("classifies draft deletion intent as high risk", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Lösche den Entwurf von Emily aus Entwürfe",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.delete_draft");
    expect(result.risk).toBe("high");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.groundingRequired).toBe(true);
  });

  it("classifies reservation updates", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Bitte ändere meine Tischreservierung auf nächsten Donnerstag",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("reservation.update");
    expect(result.risk).toBe("medium");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("classifies reservation rescheduling phrases conservatively", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Kannst du den Termin fuer die Tischreservierung verschieben",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("reservation.update");
  });

  it("keeps non-mail generic send text out of mail.send", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Schick den Tischplan raus",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("unknown");
  });

  it("does not classify weg-only phrases as delete_draft", () => {
    const result = analyzeVoiceCommandIntent({
      text: "Lass den Entwurf von Emily weg",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).not.toBe("mail.delete_draft");
  });

  it("extracts lowercase person evidence and classifies draft", () => {
    const result = analyzeVoiceCommandIntent({
      text: "entwurf fuer emily richter ablegen",
      channel: "telegram",
      agentId: "restaurant",
    });
    expect(result.intent).toBe("mail.draft");
    expect(result.evidenceTerms).toContain("emily richter");
    expect(result.evidenceTerms).not.toContain("emily richter ablegen");
    expect(result.missingFields).toStrictEqual([]);
  });
});
