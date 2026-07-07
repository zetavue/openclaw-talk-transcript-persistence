// Telegram plugin module implements Mail Layer approval callback handling.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAIL_APPROVAL_CALLBACK_PATTERN = /^Senden freigeben:\s*Action\s+([1-9]\d*)$/u;
const VERIFY_SENT_EVIDENCE_SCRIPT = String.raw`
import imaplib
import json
import sys

from mail_layer import (
    DEFAULT_ACCOUNTS,
    DEFAULT_DB,
    MailLayerError,
    authenticate_imap_connection,
    configured_sent_mailbox_candidates,
    connect,
    decode_imap_error,
    discover_sent_mailbox_candidates,
    encode_imap_utf7,
    fallback_sent_mailbox_candidates,
    get_account,
    get_action,
    init_db,
    parse_imap_uid_search_results,
    record_reply_evidence,
    reply_source_context,
    select_first_available_sent_mailbox,
)


def row_to_dict(row):
    return None if row is None else {key: row[key] for key in row.keys()}


def load_send_log(action_id, action_hash):
    with connect(DEFAULT_DB) as conn:
        row = conn.execute(
            """
            SELECT *
            FROM send_log
            WHERE mail_action_id = ?
              AND action_hash = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (action_id, action_hash),
        ).fetchone()
    return row_to_dict(row)


def select_sent_folder(conn, account):
    attempted = []
    resolved, attempted, select_error = select_first_available_sent_mailbox(
        conn,
        configured_sent_mailbox_candidates(account),
        attempted,
    )
    if not resolved:
        try:
            discovered = discover_sent_mailbox_candidates(conn)
        except Exception:
            discovered = []
        resolved, attempted, select_error = select_first_available_sent_mailbox(
            conn,
            discovered,
            attempted,
        )
    if not resolved:
        resolved, attempted, select_error = select_first_available_sent_mailbox(
            conn,
            fallback_sent_mailbox_candidates(),
            attempted,
        )
    return resolved, attempted, select_error


def search_sent_message_uid(conn, provider_message_id):
    candidates = [provider_message_id]
    stripped = provider_message_id.strip()
    if stripped.startswith("<") and stripped.endswith(">"):
        candidates.append(stripped[1:-1])
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        typ, data = conn.uid("SEARCH", None, "HEADER", "Message-ID", candidate)
        if typ != "OK":
            raise MailLayerError(
                f"IMAP SEARCH failed for sent Message-ID {candidate}: {decode_imap_error(data)}"
            )
        uids = parse_imap_uid_search_results(data)
        if uids:
            return uids[-1]
    return None


def verify_action(action_id):
    init_db(DEFAULT_DB)
    action = get_action(DEFAULT_DB, action_id)
    if not action:
        raise MailLayerError(f"mail action not found: {action_id}")
    send_log = load_send_log(action_id, action.get("action_hash"))
    if not send_log:
        raise MailLayerError(f"send_log missing for action {action_id}")
    provider_message_id = str(send_log.get("provider_message_id") or "").strip()
    if not provider_message_id:
        raise MailLayerError(f"send_log provider_message_id missing for action {action_id}")

    account_name = action.get("account")
    account = get_account(account_name, DEFAULT_ACCOUNTS)
    imap = account.get("imap", {})
    host = imap.get("host")
    port = int(imap.get("port", 993))
    username = account.get("username")
    if not host or not username:
        raise MailLayerError("account requires username and imap.host")

    with imaplib.IMAP4_SSL(host, port) as conn:
        authenticate_imap_connection(conn, account)
        sent_folder, attempted, select_error = select_sent_folder(conn, account)
        if not sent_folder:
            return {
                "send_log": send_log,
                "imap": {
                    "matched": False,
                    "attempted_sent_folders": attempted,
                    "error": select_error,
                },
            }
        typ, data = conn.select(encode_imap_utf7(sent_folder), readonly=True)
        if typ != "OK":
            raise MailLayerError(
                f"IMAP SELECT failed for sent folder {sent_folder}: {decode_imap_error(data)}"
            )
        sent_uid = search_sent_message_uid(conn, provider_message_id)

    if not sent_uid:
        return {
            "send_log": send_log,
            "imap": {
                "matched": False,
                "sent_folder": sent_folder,
                "attempted_sent_folders": attempted,
            },
        }

    source = reply_source_context(action) or {}
    evidence_id = record_reply_evidence(
        DEFAULT_DB,
        account=source.get("account") or account_name,
        mailbox=source.get("mailbox"),
        uid=source.get("uid"),
        message_id=source.get("message_id"),
        evidence_type="imap_sent_match",
        source="imap_sent",
        sent_message_id=provider_message_id,
        sent_uid=sent_uid,
        draft_id=action_id,
        details={
            "mail_action_id": action_id,
            "action_hash": action.get("action_hash"),
            "provider_message_id": provider_message_id,
            "sent_folder": sent_folder,
            "matched_header": "Message-ID",
        },
    )
    return {
        "send_log": send_log,
        "imap": {
            "matched": True,
            "sent_folder": sent_folder,
            "sent_uid": sent_uid,
            "evidence_id": evidence_id,
        },
    }


try:
    print(json.dumps(verify_action(int(sys.argv[1])), ensure_ascii=False, sort_keys=True))
except Exception as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    raise SystemExit(1)
`;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringifyEvidenceValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function parseSendEvidence(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout);
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("verification output is not an object");
    }
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid verification output: ${message}`);
  }
}

function validateSendEvidence(evidence: Record<string, unknown>): string | null {
  const sendLog = asRecord(evidence.send_log);
  if (!sendLog) {
    return "send_log evidence missing";
  }
  if (!stringifyEvidenceValue(sendLog.id)) {
    return "send_log id missing";
  }
  if (!stringifyEvidenceValue(sendLog.provider_message_id)) {
    return "send_log provider_message_id missing";
  }
  const imap = asRecord(evidence.imap);
  if (!imap || imap.matched !== true) {
    return "IMAP sent Message-ID evidence missing";
  }
  if (!stringifyEvidenceValue(imap.sent_uid)) {
    return "IMAP sent UID missing";
  }
  if (!stringifyEvidenceValue(imap.sent_folder)) {
    return "IMAP sent folder missing";
  }
  return null;
}

function formatVerifiedSendEvidence(evidence: Record<string, unknown>): string {
  const sendLog = asRecord(evidence.send_log) ?? {};
  const imap = asRecord(evidence.imap) ?? {};
  return [
    stringifyEvidenceValue(sendLog.id) ? `send_log=${stringifyEvidenceValue(sendLog.id)}` : null,
    stringifyEvidenceValue(sendLog.provider_message_id)
      ? `provider_message_id=${stringifyEvidenceValue(sendLog.provider_message_id)}`
      : null,
    stringifyEvidenceValue(imap.sent_folder)
      ? `imap_sent_folder=${stringifyEvidenceValue(imap.sent_folder)}`
      : null,
    stringifyEvidenceValue(imap.sent_uid)
      ? `imap_sent_uid=${stringifyEvidenceValue(imap.sent_uid)}`
      : null,
    stringifyEvidenceValue(imap.evidence_id)
      ? `reply_evidence=${stringifyEvidenceValue(imap.evidence_id)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function verifyTelegramMailApprovalSendEvidence(params: {
  actionId: number;
  cwd: string;
}): Promise<Record<string, unknown>> {
  const result = await execFileAsync(
    "python3",
    ["-c", VERIFY_SENT_EVIDENCE_SCRIPT, String(params.actionId)],
    { cwd: params.cwd, maxBuffer: 1024 * 1024 },
  );
  return parseSendEvidence(readExecFileStdout(result));
}

function formatExecFileError(
  error: unknown,
  fallback: string,
): {
  stdout: string;
  stderr: string;
  message: string;
} {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const stdout = normalizeOutput(record.stdout);
  const stderr = normalizeOutput(record.stderr);
  const message =
    stderr || stdout || (error instanceof Error ? error.message : undefined) || fallback;
  return { stdout, stderr, message };
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
  let output = "";
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
    output = readExecFileStdout(result);
  } catch (error) {
    const { stdout, stderr, message } = formatExecFileError(error, "Mail Layer send failed");
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

  let evidence: Record<string, unknown>;
  try {
    evidence = await verifyTelegramMailApprovalSendEvidence({
      actionId: parsed.actionId,
      cwd,
    });
  } catch (error) {
    const { stdout, stderr, message } = formatExecFileError(
      error,
      "Mail Layer send verification failed",
    );
    return {
      handled: true,
      ok: false,
      actionId: parsed.actionId,
      confirmation: parsed.confirmation,
      stdout: [output, stdout].filter(Boolean).join("\n\n"),
      stderr,
      error: message,
      text: [`Mail Action ${parsed.actionId} konnte nicht verifiziert werden.`, message, output]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const verificationError = validateSendEvidence(evidence);
  if (verificationError) {
    return {
      handled: true,
      ok: false,
      actionId: parsed.actionId,
      confirmation: parsed.confirmation,
      stdout: output,
      stderr: "",
      error: verificationError,
      text: [
        `Mail Action ${parsed.actionId} konnte nicht verifiziert werden.`,
        verificationError,
        output,
        formatVerifiedSendEvidence(evidence),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  const evidenceSummary = formatVerifiedSendEvidence(evidence);
  return {
    handled: true,
    ok: true,
    actionId: parsed.actionId,
    confirmation: parsed.confirmation,
    stdout: output,
    text: [`Mail Action ${parsed.actionId} wurde gesendet.`, output, evidenceSummary]
      .filter(Boolean)
      .join("\n\n"),
  };
}
