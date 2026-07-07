# Customer Evidence And Mail Safety Design

Date: 2026-07-07

## Context

On 2026-07-07 the restaurant agent failed Vishal's workflow around Frau Feldmann/Felzmann/Felsmann:

- It searched only the dictated spelling `Feldmann` and missed local historical offers for `Felzmann` and the current 2026 files for `Felsmann`.
- It did not reliably conclude long-running mail searches.
- It created an offer email draft that was too short and needed repeated correction.
- It wrote text implying an offer PDF was attached while the resulting Mail Layer action had `attachments_json=[]`.
- It left the user to attach the PDF manually even though the user requested the current PDF from the restaurant offer folder.

The fix should be system-level rather than only prompt-level: agent instructions should improve, but Mail Layer and helper tools must also provide evidence, warnings, and send-time enforcement.

## Goals

- Search customer evidence using spelling variants, email-derived terms, current offers, historical offers, indexed documents, OneDrive file names, and mail history.
- Make mail drafts return complete visible content, attachment state, warnings, and approval information.
- Warn at draft time when likely-risky content is detected.
- Block sending when high-risk conditions remain, especially "text says attachment is included" but no attachment is present.
- Ensure slow mail searches time out, degrade to local cached results when possible, and return a clear final status.
- Keep the first implementation focused on the restaurant workflow while designing reusable Mail Layer checks for all agents.

## Non-Goals

- Do not rewrite the full Mail Layer.
- Do not change the visual UI design.
- Do not add automatic sending.
- Do not require a global contact database before this workflow is useful.
- Do not attempt perfect fuzzy matching across all languages; implement conservative, explainable variants and evidence reporting.

## Components

### 1. Customer Evidence Search

Add a reusable customer-evidence search capability, initially available from the restaurant workspace or Mail Layer scripts.

Inputs:

- `query`: original user-provided name, email, or phrase.
- Optional `account`, `event_date`, `event_type`, and `mailboxes`.
- Optional `max_seconds` for mail search.

Behavior:

- Generate conservative search variants:
  - Original query.
  - Case-folded query.
  - Email local-part tokens, for example `u.felzmann@gmx.de` -> `felzmann`.
  - Common dictated-name variants for this class of issue, for example `Feldmann`, `Felzmann`, `Felsmann`.
  - Variants discovered from file-name or database hits.
- Search:
  - `restaurant.sqlite.offers`.
  - `restaurant.sqlite.documents`.
  - OneDrive file names under `/home/openclaw/onedrive/02_Restaurant_Herrenhaus/`.
  - Current offer directory `03_Angebote_Veranstaltungen/Angebote_2026/`.
  - Historical offer directories under `03_Angebote_Veranstaltungen/Alte_Angebote/`.
  - Mail Layer exported messages and bounded IMAP searches.
- Return structured evidence:
  - Source type: `offer_db`, `document_db`, `file_name`, `mail_cache`, `imap`.
  - Path or mailbox/UID.
  - Matched variant.
  - Extracted customer name, email, phone, address, event date, event type, persons, and short summary where available.
  - Searched variants and searched sources even when no result is found.

### 2. Mail Draft Risk Checker

Create a reusable risk-checking module used by draft creation and send confirmation.

Inputs:

- Recipient.
- Subject.
- Visible body.
- Attachments.
- Optional evidence records.
- Optional previous action metadata.

Checks:

- Body implies an attachment is included but no attachment is stored.
  - German indicators include `anbei`, `beigefügt`, `füge ich bei`, `Angebot liegt bei`, `PDF`, `Datei`.
- Attachment path does not exist or is not a file.
- Recipient is not grounded by user confirmation, reply source, or verified evidence.
- Body/customer name, recipient email local-part, and selected evidence have conflicting spellings.
- Body is suspiciously short for an offer or event email, for example a one-sentence confirmation request when the context requested a complete offer email.

Severity model:

- Draft stage:
  - Missing/invalid attachment path is a hard error.
  - Attachment implied but missing is a warning.
  - Name-spelling conflict is a warning.
  - Short body is a warning.
- Send stage:
  - Attachment implied but missing is a blocker.
  - Invalid attachment path is a blocker.
  - Recipient not grounded is a blocker.
  - Name-spelling conflict is a blocker only when there is no explicit user confirmation of the chosen spelling; otherwise it remains a warning.

### 3. Draft And Send Enforcement

Enhance `mail_create_draft` and the send-confirmation path.

Draft creation must return:

- `action_id`.
- Recipient and subject.
- Complete visible body.
- Attachment paths and attachment names.
- Server draft mailbox and provider draft ID when available.
- Warnings and blockers from the risk checker.
- Existing approval phrase and button data.

Send confirmation must:

- Load the Mail Layer action by action ID.
- Re-run the risk checker using stored body and attachments.
- Stop before SMTP/Graph send when blockers exist.
- Return clear repair instructions, for example: "Attach the current offer PDF or update the text so it does not claim an attachment is included."
- Continue normal send and `Gesendet` verification when no blockers remain.

### 4. Restaurant Agent Skill Updates

Update the restaurant workspace skills to make the agent use the new system capability correctly.

Affected skills:

- `dokument-finden`.
- `restaurant-knowledge-db`.
- `mail-dictation`.
- `angebot-erstellung`.

New rules:

- A no-result search is not complete until spelling variants have been tried.
- For customer workflows, check current offers, old offers, and documents before saying no local data exists.
- When the user says the offer/PDF is included, find the file and pass it as `attachments` to `mail_create_draft`.
- If the attachment cannot be found, do not write "attached" or "beigefügt" in the email body.
- When showing a draft, include the full visible customer text, attachment list, server draft UID, warnings, and approval phrase.
- Keep responses short in Telegram, but do not omit required draft content or warnings.

## Data Flow

### Customer Data Flow

1. User asks for data about a person or previous offers.
2. Agent calls customer-evidence search with the raw query.
3. Search generates variants and queries local DB, OneDrive file names, offer folders, local mail cache, and bounded IMAP.
4. Agent summarizes evidence with source paths and confidence.
5. If no evidence is found, agent reports searched variants and sources instead of a bare "nothing found".

### Draft Creation Flow

1. User dictates an email or asks for an offer email draft.
2. Agent resolves recipient and attachment requirements.
3. If an offer attachment is requested, agent locates the latest PDF before drafting.
4. Agent calls `mail_create_draft` with body, recipient, subject, and attachments.
5. Tool creates/updates the draft, runs risk checks, and returns complete receipt.
6. Agent displays complete visible body, attachments, warnings, draft UID, and approval phrase.

### Send Flow

1. User provides exact approval phrase or clicks approval button.
2. Send path loads the action.
3. Risk checker runs again using stored action data.
4. If blockers exist, send is refused with repair instructions.
5. If clean, message is sent and verified in `Gesendet`.

## Error Handling

- IMAP timeout:
  - Stop the mailbox search at a configured timeout.
  - Fall back to local exported messages when available.
  - Return `partial=true`, the timed-out mailbox names, and the source of results.
- Multiple customer spellings:
  - Keep all spellings in evidence.
  - Warn before send if body spelling and evidence spelling differ.
  - Allow explicit user confirmation to resolve the warning.
- Missing latest PDF:
  - Create no false attachment claim.
  - Draft warning should say the PDF was requested but not attached.
- Tool failures:
  - Return structured `ok=false`, `error`, and `repair_hint`.
  - Do not let the agent report success without tool evidence.

## Testing

### Customer Evidence Tests

- Query `Feldmann` returns evidence for `Felzmann` and `Felsmann` from old offers and 2026 files.
- Query `u.felzmann@gmx.de` generates `felzmann` and finds relevant records.
- No-result case returns searched variants and sources.
- Slow IMAP search returns a timeout/partial result instead of hanging.

### Mail Draft Risk Tests

- Body mentions an offer/PDF attachment with `attachments=[]`: draft warning is present.
- Same action at send time: send is blocked.
- Existing valid attachment path: no missing-attachment blocker.
- Invalid attachment path: draft creation fails or returns a hard error.
- Name spelling conflict: warning includes body spelling, email-derived spelling, and evidence spelling.
- Complete draft receipt includes visible body, attachments, warnings, and approval metadata.

### Restaurant Skill Validation

- Skills mention variant search after no results.
- Skills require passing attachments when the text says an offer is attached.
- Skills forbid saying "beigefügt" when no attachment is present.

## Rollout

1. Implement customer-evidence search and tests.
2. Implement Mail Draft Risk Checker and tests.
3. Wire warnings into `mail_create_draft`.
4. Wire blockers into send confirmation.
5. Update restaurant skills.
6. Build, test, deploy, and restart gateway.
7. Run a dry scenario using the Felzmann/Felsmann example:
   - Search `Feldmann`.
   - Confirm old 2015/2021 offers and current 2026 PDF are found.
   - Create a draft with the current PDF attached.
   - Verify send would block if the attachment is removed while the body still says the PDF is attached.

## Open Decisions Already Resolved

- Scope: system-level implementation.
- Enforcement policy: graded handling, with warnings at draft time and blockers at send time for high-risk conditions.
- First concrete domain: restaurant workflow, while keeping Mail Layer checks reusable for other agents.
