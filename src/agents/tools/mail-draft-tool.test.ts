import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMailCreateDraftTool } from "./mail-draft-tool.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const stdout = [
      "action_id=1",
      "draft=/tmp/mail/drafts/000001-test.md",
      "draft_md=/tmp/mail/drafts/000001-test.md",
      "server_draft=false",
      "approval=Senden freigeben: Test",
      "short_approval=Senden freigeben: Action 1",
    ].join("\n");
    const callback = args.at(-1);
    if (typeof callback === "function") {
      callback(null, stdout, "");
    }
  }),
}));

function resultDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("expected result details");
  }
  return value as Record<string, unknown>;
}

describe("mail_create_draft recipient grounding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects ungrounded recipients on new drafts", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "kundenservice@aryzta.de",
      subject: "Beschwerde: Fehlende Kaiserbrötchen",
      body: "Bitte erstellen Sie eine Gutschrift.",
    });

    const details = resultDetails(result.details);
    expect(execFile).not.toHaveBeenCalled();
    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain("recipient for new mail drafts must be confirmed");
  });

  it("allows new drafts when the recipient address was explicitly provided by the user", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "info.de@aryzta.com",
      subject: "Beschwerde: Fehlende Kaiserbrötchen",
      body: "Bitte erstellen Sie eine Gutschrift.",
      recipient_source: "user_provided",
      recipient_confirmation: "Der Kunde schrieb: Die E-Mail-Adresse ist info.de@aryzta.com.",
    });

    const details = resultDetails(result.details);
    expect(execFile).toHaveBeenCalledOnce();
    const [command, args, options] = vi.mocked(execFile).mock.calls[0] ?? [];
    expect(command).toBe("python3");
    expect(args).toEqual(expect.arrayContaining(["--to", "info.de@aryzta.com"]));
    expect(options).toEqual(expect.objectContaining({ cwd: "/tmp/mail" }));
    expect(details.ok).toBe(true);
    expect(details.short_approval).toBe("Senden freigeben: Action 1");
    expect(details.send_buttons).toEqual([
      [
        {
          text: "Senden freigeben",
          callback_data: "Senden freigeben: Action 1",
          style: "success",
        },
      ],
    ]);
  });

  it("rejects user-provided recipient metadata when the confirmation text omits the address", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "info.de@aryzta.com",
      subject: "Beschwerde: Fehlende Kaiserbrötchen",
      body: "Bitte erstellen Sie eine Gutschrift.",
      recipient_source: "user_provided",
      recipient_confirmation: "Der Kunde hat eine Aryzta-Adresse genannt.",
    });

    const details = resultDetails(result.details);
    expect(execFile).not.toHaveBeenCalled();
    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain(
      "recipient_confirmation must include the exact recipient address",
    );
  });
});
