import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { jsonResult, readStringArrayParam, readStringParam, type AnyAgentTool } from "./common.js";

const execFileAsync = promisify(execFile);

export const MAIL_CREATE_DRAFT_TOOL_NAME = "mail_create_draft";
const MAIL_CREATE_DRAFT_MARKER = "openclaw-local-structured-mail-create-draft-v1";

type MailCreateDraftReceipt = {
  ok: boolean;
  action_id?: number;
  draft?: string;
  draft_md?: string;
  draft_html?: string;
  draft_eml?: string;
  server_draft?: boolean;
  draft_mailbox?: string;
  provider_draft_id?: string;
  approval?: string;
  recipient?: string;
  subject?: string;
  error?: string;
};

function defaultMailWorkspaceDir(): string {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "workspace-mail");
}

function parseCreateDraftOutput(stdout: string): MailCreateDraftReceipt {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const actionIdRaw = fields.get("action_id");
  const actionId = actionIdRaw ? Number(actionIdRaw) : undefined;
  return {
    ok: Number.isSafeInteger(actionId) && Number(actionId) > 0,
    ...(Number.isSafeInteger(actionId) && Number(actionId) > 0 ? { action_id: actionId } : {}),
    ...(fields.get("draft") ? { draft: fields.get("draft") } : {}),
    ...(fields.get("draft_md") ? { draft_md: fields.get("draft_md") } : {}),
    ...(fields.get("draft_html") ? { draft_html: fields.get("draft_html") } : {}),
    ...(fields.get("draft_eml") ? { draft_eml: fields.get("draft_eml") } : {}),
    ...(fields.get("server_draft") ? { server_draft: fields.get("server_draft") === "true" } : {}),
    ...(fields.get("draft_mailbox") ? { draft_mailbox: fields.get("draft_mailbox") } : {}),
    ...(fields.get("provider_draft_id")
      ? { provider_draft_id: fields.get("provider_draft_id") }
      : {}),
    ...(fields.get("approval") ? { approval: fields.get("approval") } : {}),
  };
}

function buildFailureReceipt(
  error: unknown,
  subject?: string,
  recipient?: string,
): MailCreateDraftReceipt {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
  const message =
    stderr ||
    stdout ||
    (error instanceof Error ? error.message : undefined) ||
    "mail draft creation failed";
  return {
    ok: false,
    ...(recipient ? { recipient } : {}),
    ...(subject ? { subject } : {}),
    error: message.replace(/^ERROR:\s*/i, "").trim(),
  };
}

export function createMailCreateDraftTool(options?: { mailWorkspaceDir?: string }): AnyAgentTool {
  const mailWorkspaceDir = options?.mailWorkspaceDir ?? defaultMailWorkspaceDir();
  return {
    name: MAIL_CREATE_DRAFT_TOOL_NAME,
    label: "mail.create_draft",
    displaySummary: "create mail draft",
    description: [
      "Structured Mail Layer tool for creating restaurant email drafts.",
      "Use this tool instead of exec/shell whenever a mail draft must be created.",
      "Only report Action-ID, draft mailbox, and approval phrase from this tool's JSON receipt.",
      `Marker: ${MAIL_CREATE_DRAFT_MARKER}`,
    ].join(" "),
    parameters: Type.Object({
      account: Type.String({
        description: 'Mail account id, normally "restaurant".',
      }),
      to: Type.Optional(
        Type.String({
          description: "Recipient email address. Optional only when reply_source is provided.",
        }),
      ),
      subject: Type.String({
        description: "Email subject.",
      }),
      body: Type.String({
        description: "Full visible email body, without invented signatures.",
      }),
      reply_source: Type.Optional(
        Type.String({
          description: "Path to exported source message when creating a reply draft.",
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.String({
            description: "Absolute or workspace-resolved attachment path.",
          }),
        ),
      ),
      message_uid: Type.Optional(Type.String({ description: "Source message UID." })),
      message_id: Type.Optional(Type.String({ description: "Source Message-ID." })),
      draft_id: Type.Optional(Type.String({ description: "Stable idempotent draft id." })),
      server_draft: Type.Optional(
        Type.Boolean({
          description: "Force creation/update in the IMAP Drafts folder.",
        }),
      ),
      local_only: Type.Optional(
        Type.Boolean({
          description: "Only create local audit artifacts, not a server-side draft.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const account = readStringParam(input, "account", { required: true });
      const recipient = readStringParam(input, "to");
      const subject = readStringParam(input, "subject", { required: true });
      const body = readStringParam(input, "body", { required: true, allowEmpty: false });
      const replySource = readStringParam(input, "reply_source");
      const attachments = readStringArrayParam(input, "attachments") ?? [];
      const messageUid = readStringParam(input, "message_uid");
      const messageId = readStringParam(input, "message_id");
      const draftId = readStringParam(input, "draft_id");
      const serverDraft = input.server_draft === true;
      const localOnly = input.local_only === true;
      if (!recipient && !replySource) {
        return jsonResult({
          ok: false,
          subject,
          error: "recipient required unless reply_source is provided",
        });
      }
      if (serverDraft && localOnly) {
        return jsonResult({
          ok: false,
          recipient,
          subject,
          error: "server_draft and local_only cannot both be true",
        });
      }

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mail-draft-"));
      const bodyFile = path.join(tmpDir, "body.txt");
      try {
        await fs.writeFile(bodyFile, body, "utf8");
        const args = [
          "scripts/create_draft.py",
          "--account",
          account,
          "--subject",
          subject,
          "--body-file",
          bodyFile,
        ];
        if (recipient) {
          args.push("--to", recipient);
        }
        if (replySource) {
          args.push("--reply-source", replySource);
        }
        if (messageUid) {
          args.push("--message-uid", messageUid);
        }
        if (messageId) {
          args.push("--message-id", messageId);
        }
        if (draftId) {
          args.push("--draft-id", draftId);
        }
        for (const attachment of attachments) {
          args.push("--attachment", attachment);
        }
        if (serverDraft) {
          args.push("--server-draft");
        }
        if (localOnly) {
          args.push("--local-only");
        }
        const { stdout } = await execFileAsync("python3", args, {
          cwd: mailWorkspaceDir,
          signal,
          timeout: 120_000,
          maxBuffer: 512 * 1024,
        });
        return jsonResult({
          ...parseCreateDraftOutput(typeof stdout === "string" ? stdout : stdout.toString("utf8")),
          recipient,
          subject,
        });
      } catch (error) {
        return jsonResult(buildFailureReceipt(error, subject, recipient));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  } as AnyAgentTool;
}
