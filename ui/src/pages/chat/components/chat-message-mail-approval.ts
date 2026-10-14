import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";

export type MailDraftApprovalBlock = Extract<MessageContentItem, { type: "mail_draft_approval" }>;

export function readMailDraftApprovals(
  content: readonly MessageContentItem[],
): MailDraftApprovalBlock[] {
  return content.filter(
    (item): item is MailDraftApprovalBlock => item.type === "mail_draft_approval",
  );
}

export function isMailDraftApprovalLifted(message: unknown): boolean {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  return metadata?.mailDraftApprovalLifted === true;
}

export function renderMailDraftApprovals(
  approvals: readonly MailDraftApprovalBlock[],
  onSend?: (confirmation: string) => void | Promise<void>,
) {
  if (!onSend || approvals.length === 0) {
    return nothing;
  }
  return html`<div class="chat-tool-card__mail-approval chat-mail-draft-approval">
    ${approvals.map(
      (approval) => html`<button
        class="chat-tool-card__mail-approval-btn"
        type="button"
        @click=${() => void onSend(approval.confirmation)}
      >
        ${approval.label}
      </button>`,
    )}
  </div>`;
}
