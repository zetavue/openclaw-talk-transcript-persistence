import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailCreateDraftTool, createMailRegisterDraftSendTool } from "./mail-draft-tool.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const commandArgs = Array.isArray(args[1]) ? args[1] : [];
    const stdout =
      commandArgs[0] === "scripts/register_draft_send.py"
        ? JSON.stringify({
            ok: true,
            action_id: 118,
            draft: "/tmp/mail/drafts/000118-Re_Test.md",
            draft_md: "/tmp/mail/drafts/000118-Re_Test.md",
            draft_html: "/tmp/mail/drafts/000118-Re_Test.html",
            draft_eml: "/tmp/mail/drafts/000118-Re_Test.eml",
            server_draft: true,
            draft_mailbox: "Entwürfe",
            provider_draft_id: "10",
            recipient: "cistamea@outlook.com",
            subject: "Re: Test",
            body: "hello from existing draft",
            body_text: "hello from existing draft",
            short_approval: "Senden freigeben: Action 118",
          })
        : [
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

const tempDirs: string[] = [];

async function makeTempMailWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mail-workspace-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  it("returns the reply-source guard for reply drafts before the generic recipient guard", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "itskuhlmann@web.de",
      subject: "Re: Hessecup am 15.07",
      body: "Danke Peter fuer die Rueckmeldung.",
      grounding_required: true,
    });

    const details = resultDetails(result.details);
    expect(execFile).not.toHaveBeenCalled();
    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain("reply_source required");
    expect(String(details.error)).not.toContain("recipient for new mail drafts");
  });
});

describe("mail_create_draft risk results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns full body text and attachment warnings in create-draft receipts", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });
    const body = "Anbei erhalten Sie das Angebot als PDF.";

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "kunde@example.com",
      subject: "Ihr Angebot",
      body,
      recipient_source: "user_provided",
      recipient_confirmation: "Bitte schreiben Sie an kunde@example.com.",
    });

    const details = resultDetails(result.details);
    expect(execFile).toHaveBeenCalledOnce();
    expect(details.body).toBe(body);
    expect(details.body_text).toBe(body);
    expect(details.attachments).toEqual([]);
    expect(details.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment_implied_but_missing",
          severity: "warning",
        }),
      ]),
    );
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

  it("blocks create-draft when an attachment path is missing", async () => {
    const mailWorkspaceDir = await makeTempMailWorkspace();
    const missingAttachment = path.join(mailWorkspaceDir, "missing.pdf");
    const body = "Hier ist das Angebot.";
    const tool = createMailCreateDraftTool({ mailWorkspaceDir });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "kunde@example.com",
      subject: "Ihr Angebot",
      body,
      attachments: [missingAttachment],
      recipient_source: "user_provided",
      recipient_confirmation: "Bitte schreiben Sie an kunde@example.com.",
    });

    const details = resultDetails(result.details);
    expect(execFile).not.toHaveBeenCalled();
    expect(details.ok).toBe(false);
    expect(details.body_text).toBe(body);
    expect(details.attachments).toEqual([missingAttachment]);
    expect(details.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment_path_missing",
          severity: "blocker",
        }),
      ]),
    );
    expect(String(details.error)).toContain(
      `Attachment path does not exist or is not a file: ${missingAttachment}`,
    );
  });

  it("resolves relative attachments against the mail workspace before creating drafts", async () => {
    const mailWorkspaceDir = await makeTempMailWorkspace();
    await fs.writeFile(path.join(mailWorkspaceDir, "angebot.pdf"), "pdf", "utf8");
    const tool = createMailCreateDraftTool({ mailWorkspaceDir });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "kunde@example.com",
      subject: "Ihr Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      attachments: ["angebot.pdf"],
      recipient_source: "user_provided",
      recipient_confirmation: "Bitte schreiben Sie an kunde@example.com.",
    });

    const details = resultDetails(result.details);
    expect(details.ok).toBe(true);
    expect(details.blockers).toBeUndefined();
    expect(execFile).toHaveBeenCalledOnce();
    const [, args] = vi.mocked(execFile).mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["--attachment", "angebot.pdf"]));
  });
});

describe("mail_register_draft_send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers an existing server draft UID and returns approval buttons", async () => {
    const tool = createMailRegisterDraftSendTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-register-draft", {
      account: "test",
      mailbox: "Entwürfe",
      uid: "10",
    });

    const details = resultDetails(result.details);
    expect(execFile).toHaveBeenCalledOnce();
    const [command, args, options] = vi.mocked(execFile).mock.calls[0] ?? [];
    expect(command).toBe("python3");
    expect(args).toEqual([
      "scripts/register_draft_send.py",
      "--account",
      "test",
      "--mailbox",
      "Entwürfe",
      "--uid",
      "10",
    ]);
    expect(options).toEqual(expect.objectContaining({ cwd: "/tmp/mail" }));
    expect(details.ok).toBe(true);
    expect(details.action_id).toBe(118);
    expect(details.provider_draft_id).toBe("10");
    expect(details.body_text).toBe("hello from existing draft");
    expect(details.send_buttons).toEqual([
      [
        {
          text: "Senden freigeben",
          callback_data: "Senden freigeben: Action 118",
          style: "success",
        },
      ],
    ]);
  });
});
