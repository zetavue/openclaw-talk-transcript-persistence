import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTelegramMailApprovalCallback,
  sendTelegramMailApprovalCallback,
} from "./mail-approval-callback.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

type ExecFileCallback = (error: unknown, stdout: string, stderr: string) => void;

function execArgsFromCall(args: unknown[]): string[] {
  return Array.isArray(args[1]) ? (args[1] as string[]) : [];
}

function callbackFromCall(args: unknown[]): ExecFileCallback {
  const callback = args.at(-1);
  if (typeof callback !== "function") {
    throw new Error("execFile callback missing");
  }
  return callback as ExecFileCallback;
}

function mockSendAndVerification(
  params: {
    actionId?: number;
    imapMatched?: boolean;
    verifyError?: string;
  } = {},
) {
  const actionId = params.actionId ?? 131;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const execArgs = execArgsFromCall(args);
    const callback = callbackFromCall(args);
    if (execArgs[0] === "scripts/send_smtp.py") {
      callback(null, "sent=true\nsent_folder=Gesendet\n", "");
      return {} as never;
    }
    if (execArgs[0] === "-c") {
      if (params.verifyError) {
        callback(
          Object.assign(new Error("verify failed"), { stderr: `${params.verifyError}\n` }),
          "",
          `${params.verifyError}\n`,
        );
        return {} as never;
      }
      callback(
        null,
        JSON.stringify({
          send_log: {
            id: 58,
            mail_action_id: actionId,
            provider_message_id: "<178339883273.334549.15237461021994293977@v-multani-agent>",
          },
          imap:
            params.imapMatched === false
              ? {
                  matched: false,
                  sent_folder: "Gesendet",
                  attempted_sent_folders: ["Gesendet"],
                }
              : {
                  matched: true,
                  sent_folder: "Gesendet",
                  sent_uid: "9357",
                  evidence_id: 102,
                },
        }),
        "",
      );
      return {} as never;
    }
    throw new Error(`unexpected execFile call: ${String(execArgs[0])}`);
  });
}

describe("Telegram mail approval callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses exact Mail Layer approval callback data", () => {
    expect(parseTelegramMailApprovalCallback("Senden freigeben: Action 131")).toEqual({
      actionId: 131,
      confirmation: "Senden freigeben: Action 131",
    });
  });

  it("rejects unrelated callback data", () => {
    expect(parseTelegramMailApprovalCallback("callback_data: Senden freigeben: Action 131")).toBe(
      null,
    );
    expect(parseTelegramMailApprovalCallback("/approve 123 allow-once")).toBe(null);
    expect(parseTelegramMailApprovalCallback("Senden freigeben: Action 0")).toBe(null);
  });

  it("requires send_log and IMAP evidence before reporting approval callbacks as sent", async () => {
    mockSendAndVerification({ actionId: 131 });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 131",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    const [command, args, options] = vi.mocked(execFile).mock.calls[0] ?? [];
    expect(command).toBe("python3");
    expect(args).toEqual([
      "scripts/send_smtp.py",
      "--action-id",
      "131",
      "--confirmation",
      "Senden freigeben: Action 131",
    ]);
    expect(options).toEqual(expect.objectContaining({ cwd: "/tmp/mail" }));
    const [verifyCommand, verifyArgs, verifyOptions] = vi.mocked(execFile).mock.calls[1] ?? [];
    expect(verifyCommand).toBe("python3");
    expect(verifyArgs).toEqual(expect.arrayContaining(["-c", "131"]));
    expect(verifyOptions).toEqual(expect.objectContaining({ cwd: "/tmp/mail" }));
    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        ok: true,
        actionId: 131,
      }),
    );
    expect(result.text).toContain("Mail Action 131 wurde gesendet.");
    expect(result.text).toContain("send_log=58");
    expect(result.text).toContain("imap_sent_uid=9357");
  });

  it("does not report sent when SMTP succeeds but IMAP verification is missing", async () => {
    mockSendAndVerification({ actionId: 132, imapMatched: false });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 132",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        ok: false,
        actionId: 132,
      }),
    );
    expect(result.text).toContain("Mail Action 132 konnte nicht verifiziert werden.");
    expect(result.text).not.toContain("wurde gesendet");
  });

  it("reports verification failures without reporting sent", async () => {
    mockSendAndVerification({ actionId: 133, verifyError: "ERROR: IMAP SELECT failed" });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 133",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        ok: false,
        actionId: 133,
      }),
    );
    expect(result.text).toContain("Mail Action 133 konnte nicht verifiziert werden.");
    expect(result.text).toContain("ERROR: IMAP SELECT failed");
    expect(result.text).not.toContain("wurde gesendet");
  });

  it("returns unhandled without running Mail Layer for unrelated callbacks", async () => {
    const result = await sendTelegramMailApprovalCallback({
      data: "commands_page_2",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });

  it("reports Mail Layer failures without throwing or running verification", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = callbackFromCall(args);
      callback(
        Object.assign(new Error("send failed"), { stderr: "ERROR: not approved\n" }),
        "",
        "ERROR: not approved\n",
      );
      return {} as never;
    });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 132",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        ok: false,
        actionId: 132,
      }),
    );
    expect(result.text).toContain("Mail Action 132 konnte nicht gesendet werden.");
    expect(result.text).toContain("ERROR: not approved");
  });
});
