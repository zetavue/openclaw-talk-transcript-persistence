import fs from "node:fs";
import path from "node:path";

export type MailDraftRiskSeverity = "warning" | "blocker";

export type MailDraftRiskIssue = {
  code:
    | "attachment_implied_but_missing"
    | "attachment_path_missing"
    | "customer_name_recipient_mismatch";
  severity: MailDraftRiskSeverity;
  message: string;
};

export type MailDraftRiskInput = {
  recipient?: string;
  subject?: string;
  body?: string;
  attachments?: string[];
};

const ATTACHMENT_HINT_RE =
  /\b(?:anhang|angeh[aä]ngt|beigef[uü]gt|beilage|anbei|im anhang|attached|attachment|pdf|datei|angebot liegt bei)\b/iu;

function normalizeToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/giu, "")
    .toLowerCase();
}

function normalizedRecipientLocal(recipient?: string): string {
  const local = (recipient ?? "").split("@", 1)[0] ?? "";
  return normalizeToken(local);
}

function salutationNames(text: string): string[] {
  const names: string[] = [];
  const re = /\b(?:Frau|Herr|Familie)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,})\b/gu;
  for (const match of text.matchAll(re)) {
    const rawName = match[1];
    if (rawName) {
      names.push(rawName);
    }
  }
  return names;
}

function attachmentExists(attachmentPath: string): boolean {
  try {
    return fs.statSync(path.resolve(attachmentPath)).isFile();
  } catch {
    return false;
  }
}

export function evaluateMailDraftRisk(input: MailDraftRiskInput): MailDraftRiskIssue[] {
  const body = input.body ?? "";
  const attachments = input.attachments ?? [];
  const issues: MailDraftRiskIssue[] = [];

  if (ATTACHMENT_HINT_RE.test(body) && attachments.length === 0) {
    issues.push({
      code: "attachment_implied_but_missing",
      severity: "warning",
      message:
        "Draft text refers to an attachment/PDF, but no attachment path was provided. Add the attachment or remove the attachment wording before send approval.",
    });
  }

  for (const attachment of attachments) {
    if (!attachmentExists(attachment)) {
      issues.push({
        code: "attachment_path_missing",
        severity: "blocker",
        message: `Attachment path does not exist or is not a file: ${attachment}`,
      });
    }
  }

  const recipientLocal = normalizedRecipientLocal(input.recipient);
  if (recipientLocal.length >= 3) {
    for (const name of salutationNames(`${input.subject ?? ""}\n${body}`)) {
      const normalizedName = normalizeToken(name);
      if (normalizedName && !recipientLocal.includes(normalizedName)) {
        issues.push({
          code: "customer_name_recipient_mismatch",
          severity: "warning",
          message: `Draft mentions ${name}, but the recipient local part does not contain that name. Verify the original customer evidence before sending.`,
        });
        break;
      }
    }
  }

  return issues;
}

export function splitMailDraftRiskIssues(issues: MailDraftRiskIssue[]): {
  warnings: MailDraftRiskIssue[];
  blockers: MailDraftRiskIssue[];
} {
  return {
    warnings: issues.filter((issue) => issue.severity === "warning"),
    blockers: issues.filter((issue) => issue.severity === "blocker"),
  };
}
