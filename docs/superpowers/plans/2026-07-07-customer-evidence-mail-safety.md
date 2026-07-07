# Customer Evidence Mail Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve restaurant-agent reliability for customer evidence search and mail sending so Vishal gets grounded answers, full draft visibility, inline send buttons for both new and existing drafts, and a send-time block when a draft promises an attachment but none is attached.

**Architecture:** Add a small risk engine in the OpenClaw mail draft tool, add a final send-time risk check in the local Mail Layer, add a customer-evidence search CLI for restaurant data, and update restaurant skills to require the new workflow. Keep UI button rendering untouched because the previous Telegram/WebUI button fix already works when `send_buttons` is present.

**Tech Stack:** TypeScript/Vitest in `/home/openclaw/src/openclaw`, Python/pytest in `/home/openclaw/.openclaw/workspace-mail`, SQLite stdlib access, existing Mail Layer scripts, existing restaurant skills.

---

## File Map

OpenClaw repo files:

- `src/agents/tools/mail-draft-risk.ts` - new pure risk helper for draft creation receipts.
- `src/agents/tools/mail-draft-risk.test.ts` - new Vitest coverage for attachment and customer-name risk signals.
- `src/agents/tools/mail-draft-tool.ts` - include body/attachments/warnings in `mail_create_draft`, block invalid attachment paths before creating drafts.
- `src/agents/tools/mail-draft-tool.test.ts` - extend current structured tool tests for warnings and attachment args.
- `docs/superpowers/specs/2026-07-07-customer-evidence-mail-safety-design.md` - approved design reference.
- `docs/superpowers/plans/2026-07-07-customer-evidence-mail-safety.md` - this plan.

Local operational files:

- `/home/openclaw/.openclaw/workspace-mail/scripts/mail_layer.py` - add send-time risk helpers and block unsafe sends.
- `/home/openclaw/.openclaw/workspace-mail/tests/test_mail_layer.py` - add risk helper tests where existing Mail Layer fixtures live.
- `/home/openclaw/.openclaw/workspace-mail/tests/test_send_smtp_cli.py` - add dry-run/CLI failure coverage for unsafe approved actions.
- `/home/openclaw/.openclaw/workspace-mail/scripts/send_graph_approved.py` - apply the same send-time risk guard to Microsoft Graph approved sends.
- `/home/openclaw/.openclaw/workspace-mail/tests/test_send_graph_approved_cli.py` - add Graph dry-run coverage for unsafe approved actions.
- `/home/openclaw/.openclaw/workspace-mail/scripts/find_customer_evidence.py` - new read-only search CLI for restaurant customers.
- `/home/openclaw/.openclaw/workspace-mail/tests/test_find_customer_evidence_cli.py` - new CLI tests with temp DB and temp file tree.
- `/home/openclaw/.openclaw/workspace-restaurant/skills/dokument-finden/SKILL.md` - require variant search and evidence summary.
- `/home/openclaw/.openclaw/workspace-restaurant/skills/restaurant-knowledge-db/SKILL.md` - require customer evidence script before offer/customer lookup answers.
- `/home/openclaw/.openclaw/workspace-restaurant/skills/mail-dictation/SKILL.md` - require full draft text, attachments, and unchanged `send_buttons` for create/register flows.
- `/home/openclaw/.openclaw/workspace-restaurant/skills/angebot-erstellung/SKILL.md` - require customer evidence script before similar-offer selection.
- `/home/openclaw/.openclaw/workspace-restaurant/skills/angebot-pruefung/SKILL.md` - require customer evidence script when checking customer status/history.

Do not stage or modify the unrelated dirty UI files currently shown by `git status --short`.

---

## Task 1: Add Draft Risk Engine In OpenClaw

- [ ] Create `src/agents/tools/mail-draft-risk.ts`.

Implementation:

```ts
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

function recipientLocalTokens(recipient?: string): Set<string> {
  const local = (recipient ?? "").split("@", 1)[0] ?? "";
  return new Set(
    local
      .split(/[._+\-\s]+/u)
      .map(normalizeToken)
      .filter((token) => token.length >= 3),
  );
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

  const tokens = recipientLocalTokens(input.recipient);
  if (tokens.size > 0) {
    for (const name of salutationNames(`${input.subject ?? ""}\n${body}`)) {
      const normalizedName = normalizeToken(name);
      if (normalizedName && !tokens.has(normalizedName)) {
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
```

- [ ] Create `src/agents/tools/mail-draft-risk.test.ts`.

Test cases:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateMailDraftRisk, splitMailDraftRiskIssues } from "./mail-draft-risk.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mail-risk-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "attachment", "utf8");
  return filePath;
}

describe("evaluateMailDraftRisk", () => {
  it("warns when body promises an attachment without an attachment path", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      attachments: [],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "attachment_implied_but_missing",
        severity: "warning",
      }),
    ]);
  });

  it("blocks missing attachment paths", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      attachments: ["/tmp/openclaw-does-not-exist.pdf"],
    });

    expect(splitMailDraftRiskIssues(issues).blockers).toEqual([
      expect.objectContaining({ code: "attachment_path_missing" }),
    ]);
  });

  it("allows existing attachments", () => {
    const filePath = tempFile("angebot.pdf");

    const issues = evaluateMailDraftRisk({
      recipient: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      attachments: [filePath],
    });

    expect(issues.some((issue) => issue.code === "attachment_path_missing")).toBe(false);
    expect(issues.some((issue) => issue.code === "attachment_implied_but_missing")).toBe(false);
  });

  it("warns on obvious customer-name and recipient mismatch", () => {
    const issues = evaluateMailDraftRisk({
      recipient: "u.felzmann@gmx.de",
      subject: "Angebot",
      body: "Sehr geehrte Frau Feldmann,\n\nanbei das Angebot.",
      attachments: [tempFile("angebot.pdf")],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "customer_name_recipient_mismatch",
        severity: "warning",
      }),
    ]);
  });
});
```

- [ ] Run targeted test before wiring:

```bash
cd /home/openclaw/src/openclaw
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/mail-draft-risk.test.ts
```

Expected result: the new risk test file passes.

---

## Task 2: Wire Risk Results Into `mail_create_draft`

- [ ] Import the risk helper in `src/agents/tools/mail-draft-tool.ts`.

```ts
import { evaluateMailDraftRisk, splitMailDraftRiskIssues } from "./mail-draft-risk.js";
```

- [ ] Add `warnings`, `blockers`, and `attachments` to `MailCreateDraftReceipt`.

```ts
  attachments?: string[];
  warnings?: Array<{ code: string; severity: "warning"; message: string }>;
  blockers?: Array<{ code: string; severity: "blocker"; message: string }>;
```

- [ ] In `createMailCreateDraftTool().execute`, after the existing `serverDraft/localOnly` guard and before creating the temp body file, evaluate the risk.

Implementation:

```ts
      const riskIssues = evaluateMailDraftRisk({
        recipient,
        subject,
        body,
        attachments,
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
```

- [ ] Include body, body_text, attachments, and warnings in successful `mail_create_draft` receipts.

Implementation:

```ts
        return jsonResult({
          ...parseCreateDraftOutput(stdout),
          recipient,
          subject,
          body,
          body_text: body,
          attachments,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
```

- [ ] Extend `src/agents/tools/mail-draft-tool.test.ts`.

Add cases:

```ts
  it("returns full body text and attachment warnings in create-draft receipts", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "info.de@aryzta.com",
      subject: "Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      recipient_source: "user_provided",
      recipient_confirmation: "Der Kunde schrieb: info.de@aryzta.com",
    });

    const details = resultDetails(result.details);
    expect(execFile).toHaveBeenCalledOnce();
    expect(details.body_text).toBe("Anbei erhalten Sie das Angebot als PDF.");
    expect(details.attachments).toEqual([]);
    expect(details.warnings).toEqual([
      expect.objectContaining({ code: "attachment_implied_but_missing" }),
    ]);
  });

  it("blocks create-draft when an attachment path is missing", async () => {
    const tool = createMailCreateDraftTool({ mailWorkspaceDir: "/tmp/mail" });

    const result = await tool.execute("call-mail-draft", {
      account: "restaurant",
      to: "info.de@aryzta.com",
      subject: "Angebot",
      body: "Anbei erhalten Sie das Angebot als PDF.",
      recipient_source: "user_provided",
      recipient_confirmation: "Der Kunde schrieb: info.de@aryzta.com",
      attachments: ["/tmp/openclaw-does-not-exist.pdf"],
    });

    const details = resultDetails(result.details);
    expect(execFile).not.toHaveBeenCalled();
    expect(details.ok).toBe(false);
    expect(details.blockers).toEqual([
      expect.objectContaining({ code: "attachment_path_missing" }),
    ]);
  });
```

- [ ] Adjust the existing execFile mock only if needed. It can keep the same `stdout`; the tool now adds `body_text` and `attachments` from input.

- [ ] Run targeted tests:

```bash
cd /home/openclaw/src/openclaw
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/mail-draft-risk.test.ts src/agents/tools/mail-draft-tool.test.ts
```

Expected result: both test files pass.

---

## Task 3: Add Send-Time Safety In Mail Layer

- [x] Edit `/home/openclaw/.openclaw/workspace-mail/scripts/mail_layer.py`.

Add helper functions after `action_attachment_paths(action)`:

```python
ATTACHMENT_PROMISE_RE = re.compile(
    r"\b(?:anhang|angeh[aä]ngt(?:e[nsrm]?)?|beigef[uü]gt(?:e[nsrm]?)?|beilage|anbei|im anhang|attached|attachment|pdf|datei|dokument(?:e[nsrm]?)?|unterlagen|angebot liegt bei)\b",
    re.IGNORECASE,
)


def body_promises_attachment(body):
    return bool(ATTACHMENT_PROMISE_RE.search(body or ""))


def evaluate_send_risk(action, body):
    issues = []
    attachment_paths = action_attachment_paths(action)
    if body_promises_attachment(body) and not attachment_paths:
        issues.append(
            {
                "code": "attachment_implied_but_missing",
                "severity": "blocker",
                "message": (
                    "send blocked: draft text refers to an attachment/PDF, "
                    "but this mail action has no attachments_json entries"
                ),
            }
        )
    for attachment_path in attachment_paths:
        if not Path(attachment_path).is_file():
            issues.append(
                {
                    "code": "attachment_path_missing",
                    "severity": "blocker",
                    "message": f"send blocked: attachment path is missing: {attachment_path}",
                }
            )
    return issues


def require_no_send_risk(action, body):
    issues = evaluate_send_risk(action, body)
    blockers = [issue for issue in issues if issue.get("severity") == "blocker"]
    if blockers:
        raise MailLayerError("; ".join(issue["message"] for issue in blockers))
    return issues
```

- [x] Call `require_no_send_risk` in `send_smtp_message` immediately after `ensure_send_allowed`, and again after signature/reply-quote assembly on the combined final body before the provider call.

Implementation:

```python
    with connect(db_path) as conn:
        action = ensure_send_allowed(conn, action_id)
    require_no_send_risk(action, body)
    validate_outgoing_body(body)
```

Final-body check:

```python
    signed_body = build_signed_email_body(...)
    require_no_send_risk(
        action,
        "\n".join(
            part
            for part in (body, signed_body.get("plain"), signed_body.get("html"))
            if part
        ),
    )
```

- [x] Add `validate_send_confirmation` in `mail_layer.py`, so CLIs can validate the exact approval phrase without mutating the action state.

Implementation:

```python
def validate_send_confirmation(*, db_path=DEFAULT_DB, action_id, confirmation):
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM mail_actions WHERE id = ?", (action_id,)
        ).fetchone()
        if row is None:
            raise MailLayerError(f"mail action not found: {action_id}")
        expected = confirm_phrase(row["subject"] or "")
        short_expected = short_confirm_phrase(action_id)
        if confirmation.strip() not in {expected, short_expected}:
            raise MailLayerError(
                "approval rejected; expected exactly one of: "
                f"{short_expected} OR {expected}"
            )
        return row_to_dict(row)
```

`require_send_approval` now calls `validate_send_confirmation` first, then writes `approved_by_user=1,status='approved'`.

- [x] Also call the risk check in `send_smtp.py` before `require_send_approval`, so blocked dry-runs expose the same safety failure without changing the action to approved.

Implementation:

```python
        action = validate_send_confirmation(
            db_path=args.db,
            action_id=args.action_id,
            confirmation=args.confirmation,
        )
        require_no_send_risk(action, body)
        signed_body = build_signed_email_body(
            body,
            action["account"],
            accounts_path=args.accounts,
        )
        require_no_send_risk(
            action,
            "\n".join(
                part
                for part in (body, signed_body.get("plain"), signed_body.get("html"))
                if part
            ),
        )
        require_send_approval(
            db_path=args.db,
            action_id=args.action_id,
            confirmation=args.confirmation,
        )
```

Update imports:

```python
    require_no_send_risk,
    validate_send_confirmation,
    build_signed_email_body,
```

- [x] Apply the same send-time risk check and body validation parity to `send_graph_approved.py`, because Microsoft Graph is another approved send path using the same Mail Layer actions.

Implementation:

```python
from mail_layer import (
    DEFAULT_ACCOUNTS,
    DEFAULT_DB,
    DEFAULT_DRAFTS,
    MailLayerError,
    action_attachment_paths,
    build_signed_email_body,
    connect,
    ensure_send_allowed,
    get_account,
    mark_sent,
    require_no_send_risk,
    require_send_approval,
    resolve_action_body,
    validate_send_confirmation,
    validate_outgoing_body,
)

        body = resolve_action_body(
            db_path=args.db,
            action_id=args.action_id,
            body_file=args.body_file,
            drafts_dir=args.drafts_dir,
        )
        validate_outgoing_body(body)
        action = validate_send_confirmation(
            db_path=args.db,
            action_id=args.action_id,
            confirmation=args.confirmation,
        )
        require_no_send_risk(action, body)
        account = get_account(action["account"], args.accounts)
        signed_body = build_signed_email_body(
            body,
            action["account"],
            accounts_path=args.accounts,
        )
        require_no_send_risk(
            action,
            "\n".join(
                part
                for part in (body, signed_body.get("plain"), signed_body.get("html"))
                if part
            ),
        )
        action = require_send_approval(
            db_path=args.db,
            action_id=args.action_id,
            confirmation=args.confirmation,
        )
        with connect(args.db) as conn:
            ensure_send_allowed(conn, args.action_id)
        if args.dry_run:
            print("approved=true")
            print("dry_run=true")
            return 0
```

- [x] Add atomic provider-send claim to close the duplicate-send race.

Implementation:

```python
def claim_send_action(db_path=DEFAULT_DB, action_id=None):
    with connect(db_path) as conn:
        row = ensure_send_allowed(conn, action_id)
        updated = conn.execute(
            """
            UPDATE mail_actions
            SET status = 'sending'
            WHERE id = ?
              AND status = 'approved'
              AND approved_by_user = 1
              AND NOT EXISTS (
                SELECT 1 FROM send_log WHERE send_log.action_hash = ?
              )
            """,
            (action_id, row["action_hash"]),
        ).rowcount
        if updated != 1:
            raise MailLayerError("send rejected; action is already sending or sent")
    return get_action(db_path, action_id)
```

SMTP and Graph call `claim_send_action` immediately before the external provider send. `mark_sent` accepts `approved` or `sending`, then writes `sent`.

If the external provider call fails after the action is claimed, the action is moved to `send_failed`. A later exact approval phrase can move `send_failed` back to `approved` for an explicit retry; `sending` cannot be overwritten by a concurrent approval call. SMTP refused-recipient results are moved to `send_unknown`, because partial provider acceptance cannot be safely retried without human review. Approval updates are guarded by the validated `action_hash`, so a stale approval phrase cannot approve changed content.

- [x] Extend `/home/openclaw/.openclaw/workspace-mail/tests/test_mail_layer.py` using its existing DB fixture style.

Add tests that:

1. Insert or create a mail action with `body_text="Anbei das Angebot als PDF."` and `attachments_json=None`.
2. Mark it approved.
3. Assert `require_no_send_risk(action, body)` raises `MailLayerError` containing `no attachments_json`.
4. Repeat with a temp PDF path encoded in `attachments_json` and assert no exception.

- [x] Extend `/home/openclaw/.openclaw/workspace-mail/tests/test_send_smtp_cli.py`.

Add a dry-run test that creates an approved action with no attachments and a body promising a PDF, then runs:

```python
result = subprocess.run(
    [
        sys.executable,
        "scripts/send_smtp.py",
        "--db",
        str(db_path),
        "--action-id",
        str(action_id),
        "--confirmation",
        f"Senden freigeben: Action {action_id}",
        "--dry-run",
    ],
    cwd=workspace_root,
    text=True,
    capture_output=True,
    check=False,
)
```

Expected process result:

- exit code `1`
- stderr contains `send blocked`
- stdout does not contain `approved=true`
- DB action remains `status='pending'` and `approved_by_user=0`

- [x] Extend `/home/openclaw/.openclaw/workspace-mail/tests/test_send_graph_approved_cli.py`.

Add a dry-run test that creates a pending Graph action with no attachments and a body promising a PDF, then runs `send_graph_approved.main([... "--dry-run" ...])`.

Expected process result:

- return code `1`
- stderr contains `send blocked`
- stdout does not contain `approved=true`
- DB action remains `status='pending'` and `approved_by_user=0`

Also add Graph parity tests that:

1. Reject a `--body-file` that does not match stored `mail_actions.body_text` before token acquisition or Graph send.
2. Reject a legacy draft-audit body before token acquisition or Graph send.
3. Reject a final signed Graph body that introduces attachment/PDF wording before token acquisition or Graph send.

- [x] Run Python Mail Layer tests:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 -m pytest tests/test_mail_layer.py tests/test_send_smtp_cli.py tests/test_send_graph_approved_cli.py -q
```

Expected result: selected tests pass.

Actual result:

- `/tmp/openclaw-mail-pytest-venv/bin/python -m pytest tests/test_mail_layer.py tests/test_send_smtp_cli.py tests/test_send_graph_approved_cli.py tests/test_mail_protocol_auth.py tests/test_find_customer_evidence_cli.py -q`
- `130 passed`

---

## Task 4: Add Customer Evidence Search CLI

- [x] Create `/home/openclaw/.openclaw/workspace-mail/scripts/find_customer_evidence.py`.

Behavior:

- Read-only.
- Search restaurant SQLite `offers` and `documents`.
- Search file names under the restaurant OneDrive root.
- Generate typo-tolerant variants for common dictated customer-name errors using normalized spelling and compact Levenshtein distance.
- Emit JSON by default and a readable text summary with `--format text`.
- Exit `0` even with no hits; report `hits: []`.

Implementation outline:

```python
#!/usr/bin/env python3
import argparse
import json
import re
import sqlite3
import unicodedata
from pathlib import Path

DEFAULT_RESTAURANT_DB = Path.home() / ".openclaw/workspace-restaurant/data/restaurant.sqlite"
DEFAULT_ONEDRIVE_ROOT = Path.home() / "onedrive/02_Restaurant_Herrenhaus"


def normalize(value):
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = curr
    return prev[-1]


def query_variants(query):
    raw = query.strip()
    variants = {raw}
    n = normalize(raw)
    if n:
        variants.add(n)
        variants.add(n.replace("dt", "t"))
        variants.add(n.replace("tz", "ts"))
        variants.add(n.replace("z", "s"))
        variants.add(n.replace("s", "z"))
    return sorted(variant for variant in variants if variant)


def likely_match(query, candidate):
    nq = normalize(query)
    nc = normalize(candidate)
    if not nq or not nc:
        return False
    if nq in nc or any(normalize(v) in nc for v in query_variants(query)):
        return True
    words = [normalize(part) for part in re.split(r"[^A-Za-zÄÖÜäöüß0-9]+", candidate)]
    words = [word for word in words if len(word) >= 4]
    return any(levenshtein(nq, word) <= 2 for word in words)
```

Search functions:

- `search_db(db_path, query)`:
  - `offers`: select `source_file, year, event_type, persons, menu_type, price_per_person, total_price` and rank matching rows.
  - `documents`: select `file_path, document_type, summary`.
- `search_files(root, query)`:
  - recursively scan only file names under `root`.
  - skip hidden directories and obvious caches.
  - include `.docx`, `.pdf`, `.xlsx`, `.txt`, `.md`, `.eml`, `.html`.
- Output shape:

```json
{
  "query": "Feldmann",
  "variants": ["feldmann", "felmann"],
  "hits": [
    {
      "source": "offers",
      "match": "Felzmann",
      "path": "/home/openclaw/onedrive/02_Restaurant_Herrenhaus/03_Angebote_Veranstaltungen/Alte_Angebote/Angebote 2021/Restaurant Im Herrenh. - 09. August 2021 - Geburtstagsfeier - Familie Felzmann.docx",
      "summary": "2021 Geburtstagsfeier Familie Felzmann",
      "score": 95
    }
  ]
}
```

- [x] Create `/home/openclaw/.openclaw/workspace-mail/tests/test_find_customer_evidence_cli.py`.

Test cases:

1. Temp SQLite contains `offers.source_file='Restaurant Im Herrenh. - 09. August 2021 - Geburtstagsfeier - Familie Felzmann.docx'`; query `Feldmann` returns that hit.
2. Temp OneDrive tree contains `Restaurant Im Herrenhaus - 9. August 2026 - Frau Felsmann - 85. Geburtstag.pdf`; query `Feldmann` returns that file hit.
3. No hits returns JSON with `hits=[]` and exit code `0`.
4. `--format text` includes source labels and paths.

- [x] Run CLI tests:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 -m pytest tests/test_find_customer_evidence_cli.py -q
```

Expected result: new CLI tests pass.

Actual result:

- `/tmp/openclaw-mail-pytest-venv/bin/python -m pytest tests/test_find_customer_evidence_cli.py -q`
- `4 passed`

- [x] Run real read-only smoke check:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 scripts/find_customer_evidence.py --query Feldmann --format text --limit 10
```

Expected result includes the 2021 `Felzmann` document and the 2026 `Felsmann` offer/PDF found during investigation.

Actual result:

- `/tmp/openclaw-mail-pytest-venv/bin/python scripts/find_customer_evidence.py --query Feldmann --format text --limit 5`
- Found 2015/2021 `Felzmann` documents and 2026 `Fellmann` DOCX/PDF evidence in `/home/openclaw/onedrive/02_Restaurant_Herrenhaus`.

---

## Task 5: Update Restaurant Skills

- [x] Update `/home/openclaw/.openclaw/workspace-restaurant/skills/dokument-finden/SKILL.md`.

Add after step 2:

````md
2a. Wenn es um Kundennamen, Angebotsnamen oder alte Veranstaltungen geht, immer zusätzlich den Customer-Evidence-Search nutzen. Nicht nur die vom Nutzer diktierte Schreibweise suchen; Varianten/Fuzzy-Treffer prüfen. Im Beispiel steht `Feldmann`; im echten Auftrag diesen Wert durch den aktuellen Kundennamen ersetzen.

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 scripts/find_customer_evidence.py --query "Feldmann" --format text --limit 10
```

Wenn Treffer mit ähnlicher Schreibweise vorkommen (z. B. Feldmann/Felzmann/Felsmann), diese offen nennen und nicht als sichere Identität ausgeben, bis ein Pfad, eine Mail oder Vishal die Schreibweise bestätigt.
````

- [x] Update `/home/openclaw/.openclaw/workspace-restaurant/skills/restaurant-knowledge-db/SKILL.md`.

Add to Required Behavior:

```md
Before answering customer-history questions or preparing an offer for a named customer, run `scripts/find_customer_evidence.py --query "Feldmann" --format text --limit 10` from `/home/openclaw/.openclaw/workspace-mail`, replacing `Feldmann` with the current customer name. Use its hits as the first evidence list, then query `restaurant.sqlite` directly only for deeper details.
```

- [x] Update `/home/openclaw/.openclaw/workspace-restaurant/skills/mail-dictation/SKILL.md`.

Add to the structured tool section:

```md
For both `mail_create_draft` and `mail_register_draft_send`, the user-facing answer must include:
- complete visible draft body from `body_text`/`body` or `draft_md`;
- recipient, subject, server draft mailbox and provider UID when present;
- all attachment paths or a clear "no attachment" warning when the body mentions an attachment;
- the unchanged `send_buttons` payload whenever the tool receipt includes it.

If a registered existing draft returns `send_buttons`, it must be presented with the same message as the approval phrase; do not send a separate text-only approval message that loses the inline button.
```

Add to Safety:

```md
If the body says `anbei`, `PDF`, `Anhang`, `beigefügt`, `attached`, or similar but no attachment path is present, stop before sending. Either attach the correct file or create a corrected draft without attachment wording.
```

- [x] Update `angebot-erstellung/SKILL.md` under historical search:

```md
Before selecting similar offers for a named customer, run the Customer-Evidence-Search from the mail workspace. Include spelling variants in the comparison list and do not discard fuzzy hits without mentioning them.
```

- [x] Update `angebot-pruefung/SKILL.md` under e-mail/doc checks:

```md
For a named customer status/history check, first run Customer-Evidence-Search. Then verify with OneDrive paths and Mail Layer hits before stating that no information exists.
```

- [x] Verify skill edits:

```bash
rg -n "find_customer_evidence|send_buttons|attachment|Anhang|Feldmann|Felzmann|Felsmann" /home/openclaw/.openclaw/workspace-restaurant/skills
```

Expected result: each updated skill contains the new rules.

Actual result:

- `rg -n "find_customer_evidence|Customer-Evidence|Customer Evidence|send_buttons|blockers|warnings|bestehender Server-Draft" ...`
- All five updated skill files contain the expected rules.

---

## Task 6: End-To-End Local Verification

- [x] OpenClaw targeted tests:

```bash
cd /home/openclaw/src/openclaw
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/mail-draft-risk.test.ts src/agents/tools/mail-draft-tool.test.ts
```

Expected result: all targeted TypeScript tests pass.

Actual result:

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/mail-draft-risk.test.ts src/agents/tools/mail-draft-tool.test.ts`
- `2 passed`, `15 passed`

- [x] Mail workspace targeted tests:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 -m pytest tests/test_mail_layer.py tests/test_send_smtp_cli.py tests/test_find_customer_evidence_cli.py -q
```

Expected result: all targeted Python tests pass.

Actual result:

- `/tmp/openclaw-mail-pytest-venv/bin/python -m pytest tests/test_mail_layer.py tests/test_send_smtp_cli.py tests/test_send_graph_approved_cli.py tests/test_mail_protocol_auth.py tests/test_find_customer_evidence_cli.py -q`
- `130 passed`

- [x] Real read-only evidence smoke:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 scripts/find_customer_evidence.py --query Feldmann --format text --limit 10
```

Expected result: output includes at least one `Felzmann` or `Felsmann` hit and paths under `/home/openclaw/onedrive/02_Restaurant_Herrenhaus`.

Actual result: output includes 2015/2021 `Felzmann` and 2026 `Fellmann` hits under `/home/openclaw/onedrive/02_Restaurant_Herrenhaus`.

- [x] Draft risk smoke without sending:

Use this exact temporary DB smoke command:

```bash
cd /home/openclaw/.openclaw/workspace-mail
tmpdir="$(mktemp -d)"
db="$tmpdir/mail.sqlite"
action_id="$(PYTHONPATH=scripts python3 - "$db" <<'PY'
import sys
from mail_layer import connect, init_db, upsert_draft_action

db_path = sys.argv[1]
body = "Anbei das Angebot als PDF."
init_db(db_path)
action_id, _ = upsert_draft_action(
    db_path=db_path,
    account="restaurant",
    recipient="kunde@example.com",
    subject="Risk smoke",
    body=body,
    draft_id="risk-smoke",
    stored_body=body,
)
with connect(db_path) as conn:
    conn.execute(
        "UPDATE mail_actions SET approved_by_user = 1, status = 'approved' WHERE id = ?",
        (action_id,),
    )
print(action_id)
PY
)"
python3 scripts/send_smtp.py --db "$db" --action-id "$action_id" --confirmation "Senden freigeben: Action $action_id" --dry-run
```

Expected result: exit code `1` and `stderr` contains `send blocked`.

Actual result: exit code `1`; output contains `send blocked: draft text refers to an attachment/PDF`.

- [x] Build OpenClaw after tests:

```bash
cd /home/openclaw/src/openclaw
pnpm tsgo:core
```

Expected result: TypeScript core check passes.

Actual result: `pnpm` was not directly on `PATH`; `corepack pnpm tsgo:core` ran but failed on pre-existing/unrelated TypeScript errors in untouched files:

- `src/agents/tools/message-tool.ts`
- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/inbound-meta.ts`
- `src/auto-reply/reply/mail-action-claim-guard.ts`

The two `src/agents/tools/mail-draft-tool.ts` errors from this task were fixed and no longer appear.

---

## Task 7: Deploy And Commit

- [ ] Check repo status and avoid unrelated UI files:

```bash
cd /home/openclaw/src/openclaw
git status --short
```

Expected relevant repo changes only:

- `src/agents/tools/mail-draft-risk.ts`
- `src/agents/tools/mail-draft-risk.test.ts`
- `src/agents/tools/mail-draft-tool.ts`
- `src/agents/tools/mail-draft-tool.test.ts`
- forced-added `docs/superpowers/plans/2026-07-07-customer-evidence-mail-safety.md`

Unrelated UI files may remain modified; do not stage them.

- [ ] Stage only relevant OpenClaw repo files:

```bash
cd /home/openclaw/src/openclaw
git add src/agents/tools/mail-draft-risk.ts \
  src/agents/tools/mail-draft-risk.test.ts \
  src/agents/tools/mail-draft-tool.ts \
  src/agents/tools/mail-draft-tool.test.ts
git add -f docs/superpowers/plans/2026-07-07-customer-evidence-mail-safety.md
git status --short
```

Expected result: only the intended files are staged.

- [ ] Commit:

```bash
git commit -m "fix: add customer evidence and mail safety guards"
```

- [ ] Deploy local OpenClaw runtime only after tests pass. Use the same deployment pattern already used on this machine; if uncertain, inspect recent shell history and package scripts before running service-affecting commands.

Suggested verification commands after deployment:

```bash
openclaw --version
systemctl --user status openclaw --no-pager
```

Expected result: service is active and reports the local build/version.

- [ ] Push if the branch has a configured upstream:

```bash
git push
```

If `git push` reports no upstream, stop and report the branch name and exact push command needed.

---

## Rollback

OpenClaw repo rollback:

```bash
cd /home/openclaw/src/openclaw
git revert "$(git rev-parse HEAD)"
```

Local Mail Layer rollback:

- Revert the specific helper blocks added to `/home/openclaw/.openclaw/workspace-mail/scripts/mail_layer.py`.
- Remove `/home/openclaw/.openclaw/workspace-mail/scripts/find_customer_evidence.py`.
- Remove `/home/openclaw/.openclaw/workspace-mail/tests/test_find_customer_evidence_cli.py`.
- Revert the skill snippets added to `/home/openclaw/.openclaw/workspace-restaurant/skills/*.md`.

After rollback run:

```bash
cd /home/openclaw/.openclaw/workspace-mail
python3 -m pytest tests/test_mail_layer.py tests/test_send_smtp_cli.py -q
```

---

## Acceptance Criteria

- `mail_create_draft` returns complete `body_text`, `attachments`, and `warnings` while preserving existing `send_buttons`.
- `mail_create_draft` blocks missing attachment paths before writing drafts.
- `send_smtp.py` blocks approved unsafe actions when the body promises an attachment but the action has no attachments.
- Existing server draft registration still returns full body and `send_buttons`.
- `find_customer_evidence.py --query Feldmann` finds Felzmann/Felsmann evidence across DB and files.
- Restaurant skills require the evidence script and full draft/button presentation.
- Targeted TypeScript and Python tests pass.
- OpenClaw repo commit excludes unrelated UI worktree changes.
