import { describe, expect, it } from "vitest";
import { guardUnverifiedMailActionClaim } from "./mail-action-claim-guard.js";

describe("guardUnverifiedMailActionClaim", () => {
  it("replaces draft-created claims when the action id is not registered", async () => {
    const text = [
      "Test-Mail-Entwurf erstellt (Action-ID 70).",
      "",
      "Der Entwurf liegt in Entwuerfe.",
    ].join("\n");

    await expect(
      guardUnverifiedMailActionClaim(text, {
        agentId: "restaurant",
        lookupActionIds: async () => new Set(),
      }),
    ).resolves.toContain("Mail-Aktion nicht bestaetigt.");
  });

  it("preserves mail claims when every action id is registered", async () => {
    const text = "Entwurf erstellt (Action-ID 67). Der Entwurf liegt in Entwuerfe.";

    await expect(
      guardUnverifiedMailActionClaim(text, {
        agentId: "restaurant",
        lookupActionIds: async () => new Set([67]),
      }),
    ).resolves.toBe(text);
  });

  it("leaves non-success diagnostic text unchanged", async () => {
    const text = "ERROR: mail action not found: 70";

    await expect(
      guardUnverifiedMailActionClaim(text, {
        agentId: "restaurant",
        lookupActionIds: async () => new Set(),
      }),
    ).resolves.toBe(text);
  });
});
