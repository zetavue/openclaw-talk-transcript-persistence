// Telegram plugin module implements Mail Layer approval callback handling.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAIL_APPROVAL_CALLBACK_PATTERN = /^Senden freigeben:\s*Action\s+([1-9]\d*)$/u;

export type TelegramMailApprovalCallback = {
  actionId: number;
  confirmation: string;
};

export type TelegramMailApprovalCallbackResult =
  | { handled: false }
  | {
      handled: true;
      ok: true;
      actionId: number;
      confirmation: string;
      text: string;
      stdout: string;
    }
  | {
      handled: true;
      ok: false;
      actionId: number;
      confirmation: string;
      text: string;
      stdout: string;
      stderr: string;
      error: string;
    };

export type SendTelegramMailApprovalCallbackParams = {
  data: string;
  mailWorkspaceDir?: string;
};

function defaultMailWorkspaceDir(): string {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "workspace-mail");
}

function normalizeOutput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readExecFileStdout(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "stdout" in value) {
    return normalizeOutput((value as { stdout?: unknown }).stdout);
  }
  return "";
}

export function parseTelegramMailApprovalCallback(
  data: string,
): TelegramMailApprovalCallback | null {
  const match = MAIL_APPROVAL_CALLBACK_PATTERN.exec(data.trim());
  if (!match) {
    return null;
  }
  const actionId = Number(match[1]);
  if (!Number.isSafeInteger(actionId) || actionId <= 0) {
    return null;
  }
  return {
    actionId,
    confirmation: `Senden freigeben: Action ${actionId}`,
  };
}

export async function sendTelegramMailApprovalCallback(
  params: SendTelegramMailApprovalCallbackParams,
): Promise<TelegramMailApprovalCallbackResult> {
  const parsed = parseTelegramMailApprovalCallback(params.data);
  if (!parsed) {
    return { handled: false };
  }
  const cwd = params.mailWorkspaceDir ?? defaultMailWorkspaceDir();
  try {
    const result = await execFileAsync(
      "python3",
      [
        "scripts/send_smtp.py",
        "--action-id",
        String(parsed.actionId),
        "--confirmation",
        parsed.confirmation,
      ],
      { cwd },
    );
    const output = readExecFileStdout(result);
    return {
      handled: true,
      ok: true,
      actionId: parsed.actionId,
      confirmation: parsed.confirmation,
      stdout: output,
      text: [`Mail Action ${parsed.actionId} wurde gesendet.`, output].filter(Boolean).join("\n\n"),
    };
  } catch (error) {
    const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const stdout = normalizeOutput(record.stdout);
    const stderr = normalizeOutput(record.stderr);
    const message =
      stderr ||
      stdout ||
      (error instanceof Error ? error.message : undefined) ||
      "Mail Layer send failed";
    return {
      handled: true,
      ok: false,
      actionId: parsed.actionId,
      confirmation: parsed.confirmation,
      stdout,
      stderr,
      error: message,
      text: [`Mail Action ${parsed.actionId} konnte nicht gesendet werden.`, message]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
}
