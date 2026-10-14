import type {
  ChannelIngressQueue,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import { computeBackoff, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
const TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

export const OPENCLAW_LOCAL_TELEGRAM_INGRESS_WATCHDOG_MARKER =
  "openclaw-local-telegram-ingress-watchdog-v1";
export const TELEGRAM_SPOOLED_UPDATE_PENDING_STALL_MS = 5 * 60 * 1000;

export type TelegramStalledSpooledUpdateSummary = {
  count: number;
  oldestAgeMs: number;
  oldestReceivedAt?: number;
  sampleUpdateIds: number[];
};

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

export function telegramQueueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

export function openTelegramIngressQueue(params: {
  accountId?: string;
  stateDir?: string;
}): ChannelIngressQueue<TelegramSpooledUpdatePayload> {
  return getTelegramRuntime().state.openChannelIngressQueue<TelegramSpooledUpdatePayload>({
    accountId: normalizeTelegramStateAccountId(params.accountId),
    stateDir: params.stateDir,
  });
}

export async function summarizeStalledTelegramSpooledUpdates(params: {
  accountId?: string;
  staleMs?: number;
  now?: number;
  sampleLimit?: number;
}): Promise<TelegramStalledSpooledUpdateSummary> {
  const staleMs = Math.max(
    0,
    Math.floor(params.staleMs ?? TELEGRAM_SPOOLED_UPDATE_PENDING_STALL_MS),
  );
  const now = params.now ?? Date.now();
  const sampleLimit = Math.max(1, Math.floor(params.sampleLimit ?? 5));
  const queue = openTelegramIngressQueue({ accountId: params.accountId });
  const records = await queue.listPending({ limit: "all", orderBy: "id" });
  let count = 0;
  let oldestReceivedAt: number | undefined;
  const sampleUpdateIds: number[] = [];
  for (const record of records) {
    const pending = parsePendingTelegramIngressRecord(record);
    if (!pending || pending.attempts > 0 || now - pending.receivedAt < staleMs) {
      continue;
    }
    count += 1;
    if (oldestReceivedAt === undefined || pending.receivedAt < oldestReceivedAt) {
      oldestReceivedAt = pending.receivedAt;
    }
    if (sampleUpdateIds.length < sampleLimit) {
      sampleUpdateIds.push(pending.updateId);
    }
  }
  return {
    count,
    oldestAgeMs: oldestReceivedAt === undefined ? 0 : Math.max(0, now - oldestReceivedAt),
    oldestReceivedAt,
    sampleUpdateIds,
  };
}

function parsePendingTelegramIngressRecord(
  record: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
): { updateId: number; receivedAt: number; attempts: number } | null {
  const payload = record.payload;
  if (
    payload.version !== 1 ||
    !isValidUpdateId(payload.updateId) ||
    !Number.isFinite(payload.receivedAt)
  ) {
    return null;
  }
  return {
    updateId: payload.updateId,
    receivedAt: payload.receivedAt,
    attempts: record.attempts,
  };
}

/** Backoff for irrevocable-adoption completion retries (bot-message only). */
export function resolveSpooledUpdatePersistenceRetryDelayMs(attempt: number): number {
  return computeBackoff(TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY, attempt);
}
