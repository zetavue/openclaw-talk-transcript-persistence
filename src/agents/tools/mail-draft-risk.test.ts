import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { evaluateMailDraftRisk, splitMailDraftRiskIssues } from "./mail-draft-risk.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mail-draft-risk-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("evaluateMailDraftRisk", () => {
  test("warns when body promises an attachment without an attachment path", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      body: "Hallo Frau Muster,\n\nanbei finden Sie das Angebot als PDF.",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "attachment_implied_but_missing",
        severity: "warning",
      }),
    ]);
  });

  test("blocks missing attachment paths", () => {
    const missingPath = path.join(makeTempDir(), "missing.pdf");

    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      body: "Hallo Frau Muster,\n\nhier ist das Angebot.",
      attachments: [missingPath],
    });

    expect(splitMailDraftRiskIssues(issues)).toEqual({
      warnings: [],
      blockers: [
        {
          code: "attachment_path_missing",
          severity: "blocker",
          message: `Attachment path does not exist or is not a file: ${missingPath}`,
        },
      ],
    });
  });

  test("allows existing attachments", () => {
    const dir = makeTempDir();
    const attachmentPath = path.join(dir, "angebot.pdf");
    fs.writeFileSync(attachmentPath, "pdf");

    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      body: "Hallo Frau Muster,\n\nanbei finden Sie das Angebot.",
      attachments: [attachmentPath],
    });

    expect(issues).toEqual([]);
  });

  test("allows relative attachments resolved from an attachment base directory", () => {
    const baseDir = makeTempDir();
    fs.writeFileSync(path.join(baseDir, "angebot.pdf"), "pdf");

    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      body: "Hallo Frau Muster,\n\nanbei finden Sie das Angebot.",
      attachments: ["angebot.pdf"],
      attachmentBaseDir: baseDir,
    });

    expect(issues).toEqual([]);
  });

  test("blocks attachment paths that resolve to directories", () => {
    const attachmentDir = makeTempDir();

    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      body: "Hallo Frau Muster,\n\nhier ist das Angebot.",
      attachments: [attachmentDir],
    });

    expect(splitMailDraftRiskIssues(issues)).toEqual({
      warnings: [],
      blockers: [
        {
          code: "attachment_path_missing",
          severity: "blocker",
          message: `Attachment path does not exist or is not a file: ${attachmentDir}`,
        },
      ],
    });
  });

  test("warns on obvious customer-name and recipient mismatch", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "maria.muster@example.com",
      subject: "Ihr Angebot",
      body: "Sehr geehrter Herr Schmidt,\n\nvielen Dank fuer Ihre Anfrage.",
    });

    expect(issues).toEqual([
      {
        code: "customer_name_recipient_mismatch",
        severity: "warning",
        message:
          "Draft mentions Schmidt, but the recipient local part does not contain that name. Verify the original customer evidence before sending.",
      },
    ]);
  });

  test("does not warn when recipient local part contains the salutation name", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "maxmustermann@example.com",
      body: "Sehr geehrter Herr Mustermann,\n\nvielen Dank fuer Ihre Anfrage.",
    });

    expect(issues).toEqual([]);
  });
});
