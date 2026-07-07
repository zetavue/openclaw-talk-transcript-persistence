import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTelegramMailApprovalCallback,
  sendTelegramMailApprovalCallback,
} from "./mail-approval-callback.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

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

  it("runs Mail Layer send_smtp for approval callbacks", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(null, "sent=true\nsent_folder=Gesendet\n", "");
      }
      return {} as never;
    });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 131",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).toHaveBeenCalledOnce();
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
    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        ok: true,
        actionId: 131,
      }),
    );
    expect(result.text).toContain("Mail Action 131 wurde gesendet.");
    expect(result.text).toContain("sent=true");
  });

  it("returns unhandled without running Mail Layer for unrelated callbacks", async () => {
    const result = await sendTelegramMailApprovalCallback({
      data: "commands_page_2",
      mailWorkspaceDir: "/tmp/mail",
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });

  it("reports Mail Layer failures without throwing", async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(
          Object.assign(new Error("send failed"), { stderr: "ERROR: not approved\n" }),
          "",
          "ERROR: not approved\n",
        );
      }
      return {} as never;
    });

    const result = await sendTelegramMailApprovalCallback({
      data: "Senden freigeben: Action 132",
      mailWorkspaceDir: "/tmp/mail",
    });

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
