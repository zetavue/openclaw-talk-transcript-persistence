import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { readToolStringParam } from "./common.js";

const execFileAsync = promisify(execFile);
const MAIL_APPROVAL_PATTERN = /\bSenden freigeben:\s*Action\s+(\d+)\b/u;
const MAIL_MESSAGE_PARAM_KEYS = ["message", "text", "content", "caption", "SendMessage"] as const;
const MAIL_APPROVAL_PRESENTATION_CHANNELS = new Set(["telegram", "dashboard", "webchat"]);

type MailActionReceipt = {
  id: number;
  account?: string;
  recipient?: string;
  subject?: string;
  bodyText?: string;
  draftMailbox?: string;
  providerDraftId?: string;
};

export type LookupMailActionReceipt = (
  actionId: number,
) => Promise<MailActionReceipt | null | undefined>;

function isMailApprovalPresentationChannel(channel: string | undefined): boolean {
  return channel ? MAIL_APPROVAL_PRESENTATION_CHANNELS.has(channel) : false;
}

function defaultMailActionDbPath(): string {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "workspace-mail", "mail_agent.sqlite");
}

function readSqliteText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readNonEmptySqliteText(value: unknown): string | undefined {
  const text = readSqliteText(value);
  return text && text.trim().length > 0 ? text : undefined;
}

async function lookupSqliteMailActionReceipt(
  actionId: number,
): Promise<MailActionReceipt | undefined> {
  if (!Number.isSafeInteger(actionId) || actionId <= 0) {
    return undefined;
  }
  const dbPath = process.env.OPENCLAW_MAIL_ACTION_DB?.trim() || defaultMailActionDbPath();
  try {
    await fs.access(dbPath);
  } catch {
    return undefined;
  }

  const query = [
    "select id, account, recipient, subject, body_text, draft_mailbox, provider_draft_id",
    "from mail_actions",
    `where id = ${actionId}`,
    "limit 1;",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, query], {
      timeout: 1500,
      maxBuffer: 1024 * 1024,
    });
    const rows = JSON.parse(stdout.trim() || "[]") as unknown;
    if (!Array.isArray(rows) || rows.length === 0) {
      return undefined;
    }
    const row = rows[0] as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return undefined;
    }
    const account = readNonEmptySqliteText(row.account);
    const recipient = readNonEmptySqliteText(row.recipient);
    const subject = readNonEmptySqliteText(row.subject);
    const bodyText = readSqliteText(row.body_text);
    const draftMailbox = readNonEmptySqliteText(row.draft_mailbox);
    const providerDraftId = readNonEmptySqliteText(row.provider_draft_id);
    return {
      id,
      ...(account ? { account } : {}),
      ...(recipient ? { recipient } : {}),
      ...(subject ? { subject } : {}),
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(draftMailbox ? { draftMailbox } : {}),
      ...(providerDraftId ? { providerDraftId } : {}),
    };
  } catch {
    return undefined;
  }
}

function formatMailDraftReceipt(params: {
  actionId: number;
  approval: string;
  receipt: MailActionReceipt;
}): string {
  const lines = ["Draft created.", "", `Action ID: ${params.receipt.id || params.actionId}`];
  if (params.receipt.recipient) {
    lines.push(`Recipient: ${params.receipt.recipient}`);
  }
  if (params.receipt.subject) {
    lines.push(`Subject: ${params.receipt.subject}`);
  }
  const bodyText = params.receipt.bodyText ?? "";
  if (bodyText.includes("\n")) {
    lines.push("Body:", bodyText);
  } else {
    lines.push(`Body: ${bodyText}`);
  }
  if (params.receipt.draftMailbox) {
    lines.push(`Server draft mailbox: ${params.receipt.draftMailbox}`);
  }
  if (params.receipt.providerDraftId) {
    lines.push(`Provider draft ID: ${params.receipt.providerDraftId}`);
  }
  lines.push(`Approval: ${params.approval}`);
  return lines.join("\n");
}

function readFirstStringParamEntry(
  params: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = readToolStringParam(params, key);
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}

export async function maybeAddMailApprovalPresentation(
  params: Record<string, unknown>,
  options: {
    agentId?: string;
    currentChannelProvider?: string;
    lookupMailActionReceipt?: LookupMailActionReceipt;
  },
): Promise<void> {
  const action = normalizeOptionalString(params.action);
  if (action !== "send") {
    return;
  }
  const channel = normalizeMessageChannel(
    normalizeOptionalString(params.channel) ??
      normalizeOptionalString(params.provider) ??
      options.currentChannelProvider,
  );
  if (!isMailApprovalPresentationChannel(channel)) {
    return;
  }
  const messageParam = readFirstStringParamEntry(params, MAIL_MESSAGE_PARAM_KEYS);
  const actionMatch = messageParam ? MAIL_APPROVAL_PATTERN.exec(messageParam.value) : null;
  if (!messageParam || !actionMatch) {
    return;
  }
  const actionId = Number(actionMatch[1]);
  if (!Number.isSafeInteger(actionId) || actionId <= 0) {
    return;
  }
  const approval = `Senden freigeben: Action ${actionId}`;
  const receipt = await (options.lookupMailActionReceipt ?? lookupSqliteMailActionReceipt)(
    actionId,
  );
  const receiptMatchesAgent =
    !receipt?.account || !options.agentId || receipt.account === options.agentId;
  if (receipt && receiptMatchesAgent) {
    params[messageParam.key] = formatMailDraftReceipt({
      actionId,
      approval,
      receipt,
    });
  }
  if (params.presentation === undefined) {
    params.presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Senden freigeben",
              value: approval,
              style: "success",
            },
          ],
        },
      ],
    };
  }
}
