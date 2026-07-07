import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { jsonResult, readStringArrayParam, readStringParam, type AnyAgentTool } from "./common.js";
import { evaluateMailDraftRisk, splitMailDraftRiskIssues } from "./mail-draft-risk.js";

const execFileAsync = promisify(execFile);

export const MAIL_CREATE_DRAFT_TOOL_NAME = "mail_create_draft";
export const MAIL_REGISTER_DRAFT_SEND_TOOL_NAME = "mail_register_draft_send";
const MAIL_CREATE_DRAFT_MARKER = "openclaw-local-structured-mail-create-draft-v1";
const MAIL_REGISTER_DRAFT_SEND_MARKER = "openclaw-local-structured-mail-register-draft-send-v1";
const MAIL_CREATE_DRAFT_GROUNDING_GUARD_MARKER = "openclaw-local-mail-draft-grounding-guard-v1";

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
  short_approval?: string;
  send_buttons?: Array<
    Array<{
      text: string;
      callback_data: string;
      style: "success";
    }>
  >;
  recipient?: string;
  subject?: string;
  body?: string;
  body_text?: string;
  attachments?: string[];
  warnings?: Array<{ code: string; severity: "warning"; message: string }>;
  blockers?: Array<{ code: string; severity: "blocker"; message: string }>;
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
  const shortApproval = fields.get("short_approval");
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
    ...(shortApproval ? { short_approval: shortApproval } : {}),
    ...(Number.isSafeInteger(actionId) && Number(actionId) > 0 && shortApproval
      ? {
          send_buttons: [
            [
              {
                text: "Senden freigeben",
                callback_data: shortApproval,
                style: "success" as const,
              },
            ],
          ],
        }
      : {}),
  };
}

function readReceiptString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRegisterDraftSendOutput(stdout: string): MailCreateDraftReceipt {
  const parsed = JSON.parse(stdout || "{}") as Record<string, unknown>;
  const actionId = Number(parsed.action_id);
  const shortApproval = readReceiptString(parsed, "short_approval");
  return {
    ok: parsed.ok === true && Number.isSafeInteger(actionId) && actionId > 0,
    ...(Number.isSafeInteger(actionId) && actionId > 0 ? { action_id: actionId } : {}),
    ...(readReceiptString(parsed, "draft") ? { draft: readReceiptString(parsed, "draft") } : {}),
    ...(readReceiptString(parsed, "draft_md")
      ? { draft_md: readReceiptString(parsed, "draft_md") }
      : {}),
    ...(readReceiptString(parsed, "draft_html")
      ? { draft_html: readReceiptString(parsed, "draft_html") }
      : {}),
    ...(readReceiptString(parsed, "draft_eml")
      ? { draft_eml: readReceiptString(parsed, "draft_eml") }
      : {}),
    ...(typeof parsed.server_draft === "boolean" ? { server_draft: parsed.server_draft } : {}),
    ...(readReceiptString(parsed, "draft_mailbox")
      ? { draft_mailbox: readReceiptString(parsed, "draft_mailbox") }
      : {}),
    ...(readReceiptString(parsed, "provider_draft_id")
      ? { provider_draft_id: readReceiptString(parsed, "provider_draft_id") }
      : {}),
    ...(readReceiptString(parsed, "approval")
      ? { approval: readReceiptString(parsed, "approval") }
      : {}),
    ...(shortApproval ? { short_approval: shortApproval } : {}),
    ...(readReceiptString(parsed, "recipient")
      ? { recipient: readReceiptString(parsed, "recipient") }
      : {}),
    ...(readReceiptString(parsed, "subject")
      ? { subject: readReceiptString(parsed, "subject") }
      : {}),
    ...(readReceiptString(parsed, "body") ? { body: readReceiptString(parsed, "body") } : {}),
    ...(readReceiptString(parsed, "body_text")
      ? { body_text: readReceiptString(parsed, "body_text") }
      : {}),
    ...(Number.isSafeInteger(actionId) && actionId > 0 && shortApproval
      ? {
          send_buttons: [
            [
              {
                text: "Senden freigeben",
                callback_data: shortApproval,
                style: "success" as const,
              },
            ],
          ],
        }
      : {}),
  };
}

function buildFailureReceipt(
  error: unknown,
  subject?: string,
  recipient?: string,
  fallbackMessage = "mail draft creation failed",
): MailCreateDraftReceipt {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
  const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
  const message =
    stderr || stdout || (error instanceof Error ? error.message : undefined) || fallbackMessage;
  return {
    ok: false,
    ...(recipient ? { recipient } : {}),
    ...(subject ? { subject } : {}),
    error: message.replace(/^ERROR:\s*/i, "").trim(),
  };
}

function normalizeMailDraftGuardText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function looksLikeExistingMailDraftRequest(params: {
  subject?: string;
  body?: string;
  draftId?: string;
}): boolean {
  const subject = normalizeMailDraftGuardText(params.subject);
  const body = normalizeMailDraftGuardText(params.body);
  const draftId = normalizeMailDraftGuardText(params.draftId);
  if (/^(re|aw|fwd|fw):/u.test(subject)) {
    return true;
  }
  const joined = `${subject} ${body} ${draftId}`;
  return /\b(antwort|reply|antwortentwurf|bestehende(?:n|r)? mail|existierende(?:n|r)? mail|alter entwurf|alten entwurf|alte e-mail|vorbereitete(?:n|r)? e-mail|gestern eine e-mail|entwurf anpassen|draft update|update draft|probearbeit-einladung)\b/u.test(
    joined,
  );
}

function isExplicitlyConfirmedRecipient(params: {
  recipient?: string;
  recipientSource?: string;
  recipientConfirmation?: string;
}): boolean {
  const recipient = normalizeMailDraftGuardText(params.recipient);
  const source = normalizeMailDraftGuardText(params.recipientSource);
  const confirmation = normalizeMailDraftGuardText(params.recipientConfirmation);
  if (!recipient || !confirmation) {
    return false;
  }
  if (source !== "user_provided" && source !== "verified_source") {
    return false;
  }
  return confirmation.includes(recipient);
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
      "Only report Action-ID, draft mailbox, short_approval, and approval phrase from this tool's JSON receipt.",
      "When the receipt includes send_buttons and the current channel supports inline buttons, send the visible draft receipt with message(action=send) and pass send_buttons unchanged as buttons; the send button is the user's explicit send confirmation.",
      "For replies or updates to existing/prepared drafts, pass reply_source from the original exported INBOX message; the tool rejects ungrounded draft updates.",
      "For standalone new outbound drafts without reply_source, pass recipient_source=user_provided or verified_source and recipient_confirmation containing the exact recipient address.",
      `Marker: ${MAIL_CREATE_DRAFT_MARKER}`,
      `Grounding marker: ${MAIL_CREATE_DRAFT_GROUNDING_GUARD_MARKER}`,
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
      recipient_source: Type.Optional(
        Type.Union([Type.Literal("user_provided"), Type.Literal("verified_source")], {
          description:
            "How the recipient was grounded for a standalone new outbound draft without reply_source.",
        }),
      ),
      recipient_confirmation: Type.Optional(
        Type.String({
          description:
            "Verbatim user statement or verified source excerpt containing the exact recipient address.",
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
      grounding_required: Type.Optional(
        Type.Boolean({
          description:
            "Set true when the user references an existing mail, old draft, screenshot, person, date, or prior prepared draft. Requires reply_source.",
        }),
      ),
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
      const recipientSource = readStringParam(input, "recipient_source");
      const recipientConfirmation = readStringParam(input, "recipient_confirmation");
      const attachments = readStringArrayParam(input, "attachments") ?? [];
      const messageUid = readStringParam(input, "message_uid");
      const messageId = readStringParam(input, "message_id");
      const draftId = readStringParam(input, "draft_id");
      const groundingRequired = input.grounding_required === true;
      const serverDraft = input.server_draft === true;
      const localOnly = input.local_only === true;
      const recipientExplicitlyConfirmed = isExplicitlyConfirmedRecipient({
        recipient,
        recipientSource,
        recipientConfirmation,
      });
      const existingMailDraftRequest =
        groundingRequired ||
        looksLikeExistingMailDraftRequest({
          subject,
          body,
          draftId,
        });
      if (!replySource && !recipientExplicitlyConfirmed && existingMailDraftRequest) {
        return jsonResult({
          ok: false,
          recipient,
          subject,
          error: `${MAIL_CREATE_DRAFT_GROUNDING_GUARD_MARKER}: reply_source required before creating or updating a draft that references an existing mail, old draft, person/date/screenshot, or prior prepared draft. Search INBOX/Entwürfe first and pass the exported original message path as reply_source. If an IMAP/tool result already verified the exact address but no exported source path is available, retry with recipient_source=verified_source and recipient_confirmation containing the exact recipient address.`,
        });
      }
      if (recipient && !replySource && !recipientExplicitlyConfirmed) {
        return jsonResult({
          ok: false,
          recipient,
          subject,
          error: `${MAIL_CREATE_DRAFT_GROUNDING_GUARD_MARKER}: recipient for new mail drafts must be confirmed from a reply_source, recipient_source=user_provided, or another verified source before creating a draft. recipient_confirmation must include the exact recipient address. Do not guess or infer recipient addresses from company names, images, websites, or general knowledge; ask the user to confirm the exact recipient address first.`,
        });
      }
      if (!recipient && !replySource) {
        return jsonResult({
          ok: false,
          subject,
          error: `${MAIL_CREATE_DRAFT_GROUNDING_GUARD_MARKER}: recipient required unless reply_source is provided. Ask the user to confirm the exact recipient address before creating a new outbound draft.`,
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
      const riskIssues = evaluateMailDraftRisk({
        recipient,
        subject,
        body,
        attachments,
        attachmentBaseDir: mailWorkspaceDir,
      });
      const { warnings, blockers } = splitMailDraftRiskIssues(riskIssues);
      if (blockers.length > 0) {
        return jsonResult({
          ok: false,
          recipient,
          subject,
          body_text: body,
          attachments,
          blockers,
          error: blockers.map((issue) => issue.message).join("; "),
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
        const execResult = await execFileAsync("python3", args, {
          cwd: mailWorkspaceDir,
          signal,
          timeout: 120_000,
          maxBuffer: 512 * 1024,
        });
        const stdout =
          typeof execResult === "string"
            ? execResult
            : typeof execResult.stdout === "string"
              ? execResult.stdout
              : execResult.stdout.toString("utf8");
        return jsonResult({
          ...parseCreateDraftOutput(stdout),
          recipient,
          subject,
          body,
          body_text: body,
          attachments,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return jsonResult(buildFailureReceipt(error, subject, recipient));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  } as AnyAgentTool;
}

export function createMailRegisterDraftSendTool(options?: {
  mailWorkspaceDir?: string;
}): AnyAgentTool {
  const mailWorkspaceDir = options?.mailWorkspaceDir ?? defaultMailWorkspaceDir();
  return {
    name: MAIL_REGISTER_DRAFT_SEND_TOOL_NAME,
    label: "mail.register_draft_send",
    displaySummary: "register server draft send action",
    description: [
      "Structured Mail Layer tool for turning an existing IMAP Drafts UID into a pending send action.",
      "Use this when the user asks to send a draft by UID from Entwürfe/Drafts and no Action ID is available.",
      "This tool never sends mail directly; it registers the server draft, stores the full body in Mail Layer, and returns short_approval plus send_buttons.",
      "After the receipt includes send_buttons and the current channel supports inline buttons, send the visible draft receipt with message(action=send) and pass send_buttons unchanged as buttons.",
      `Marker: ${MAIL_REGISTER_DRAFT_SEND_MARKER}`,
    ].join(" "),
    parameters: Type.Object({
      account: Type.String({
        description: 'Mail account id, for example "test" or "restaurant".',
      }),
      uid: Type.String({
        description: "IMAP UID of the existing server-side draft.",
      }),
      mailbox: Type.Optional(
        Type.String({
          description: 'Draft mailbox containing the UID. Defaults to "Entwürfe" when omitted.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const account = readStringParam(input, "account", { required: true });
      const uid = readStringParam(input, "uid", { required: true });
      const mailbox = readStringParam(input, "mailbox") ?? "Entwürfe";
      try {
        const execResult = await execFileAsync(
          "python3",
          [
            "scripts/register_draft_send.py",
            "--account",
            account,
            "--mailbox",
            mailbox,
            "--uid",
            uid,
          ],
          {
            cwd: mailWorkspaceDir,
            signal,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
          },
        );
        const stdout =
          typeof execResult === "string"
            ? execResult
            : typeof execResult.stdout === "string"
              ? execResult.stdout
              : execResult.stdout.toString("utf8");
        return jsonResult(parseRegisterDraftSendOutput(stdout));
      } catch (error) {
        return jsonResult(
          buildFailureReceipt(
            error,
            undefined,
            undefined,
            "server draft send action registration failed",
          ),
        );
      }
    },
  } as AnyAgentTool;
}
