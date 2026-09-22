// Channel-aware cron delivery validation for gateway-owned mutations.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { CronDelivery, CronJobCreate } from "./types.js";

function hasExplicitChannelConfigEntry(cfg: OpenClawConfig): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  return Object.entries(channels).some(([channelId, entry]) => {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      return false;
    }
    return Boolean(
      entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length > 0,
    );
  });
}

async function assertConfiguredAnnounceChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  if (params.channel === "last") {
    return;
  }
  const configuredChannels = (await listConfiguredMessageChannels(params.cfg)).toSorted();
  const normalizedChannel = normalizeMessageChannel(params.channel);
  if (!normalizedChannel) {
    if (configuredChannels.length <= 1) {
      return;
    }
    throw new Error(
      `${params.field} is required when multiple channels are configured: ${configuredChannels.join(", ")}`,
    );
  }
  if (configuredChannels.length === 0) {
    if (!hasExplicitChannelConfigEntry(params.cfg)) {
      if (!isDeliverableMessageChannel(normalizedChannel)) {
        throw new Error(`${params.field} is not a known channel: ${normalizedChannel}`);
      }
      return;
    }
    throw new Error(`${params.field} is not configured: ${normalizedChannel}`);
  }
  if (!configuredChannels.includes(normalizedChannel)) {
    throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
  }
}

function resolveAnnounceValidationChannel(params: {
  channel?: string;
  to?: string;
}): string | undefined {
  return params.channel && params.channel !== "last"
    ? params.channel
    : (resolveTargetPrefixedChannel(params.to) ?? params.channel);
}

function assertCompatibleAnnounceTarget(params: {
  channel?: string;
  to?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  if (!params.channel || params.channel === "last") {
    return;
  }
  const error = validateTargetProviderPrefix({ channel: params.channel, to: params.to });
  if (error) {
    throw new Error(`${params.field}: ${error.message}`);
  }
}

const OPENCLAW_LOCAL_CRON_TELEGRAM_DELIVERY_VALIDATION_MARKER =
  "openclaw-local-cron-telegram-delivery-validation-v1";

function resolveTelegramCronDeliveryAccountToken(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): boolean {
  const telegram = params.cfg.channels?.telegram;
  if (!telegram || typeof telegram !== "object" || Array.isArray(telegram)) {
    return false;
  }
  const resolveAccountToken = (account: unknown): boolean => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      return false;
    }
    const { botToken, tokenFile } = account as {
      botToken?: unknown;
      tokenFile?: unknown;
    };
    return Boolean(
      (typeof botToken === "string" && botToken.trim()) ||
      (typeof tokenFile === "string" && tokenFile.trim()) ||
      (botToken && typeof botToken === "object") ||
      (tokenFile && typeof tokenFile === "object"),
    );
  };
  const accountId = params.accountId?.trim();
  if (!accountId || accountId === "default") {
    if (resolveAccountToken(telegram)) {
      return true;
    }
    return resolveAccountToken(telegram.accounts?.default);
  }
  return resolveAccountToken(telegram.accounts?.[accountId]);
}

function stripTelegramCronTargetPrefix(to: string): string {
  let value = to.trim();
  while (true) {
    const next = value
      .replace(/^(telegram|tg):/iu, "")
      .replace(/^group:/iu, "")
      .trim();
    if (next === value) {
      return value;
    }
    value = next;
  }
}

function assertValidTelegramCronTarget(params: {
  cfg: OpenClawConfig;
  delivery?: Pick<CronDelivery, "channel" | "to" | "accountId">;
  field: "delivery" | "delivery.failureDestination";
}) {
  const delivery = params.delivery;
  const channel = delivery ? resolveAnnounceValidationChannel(delivery) : undefined;
  if (!delivery || channel !== "telegram") {
    return;
  }
  if (
    !resolveTelegramCronDeliveryAccountToken({ cfg: params.cfg, accountId: delivery.accountId })
  ) {
    const accountId = delivery.accountId?.trim() || "default";
    throw new Error(
      `${OPENCLAW_LOCAL_CRON_TELEGRAM_DELIVERY_VALIDATION_MARKER}: ${params.field}.accountId references Telegram account "${accountId}", but that account has no bot token configured`,
    );
  }
  const target = delivery.to?.trim();
  if (!target) {
    return;
  }
  const stripped = stripTelegramCronTargetPrefix(target);
  if (/^\+\d[\d\s().-]*$/u.test(stripped)) {
    throw new Error(`${params.field}.to must be a numeric Telegram chat ID, not a phone number`);
  }
  if (!/^-?\d+(?::(?:topic:)?\d+)?$/u.test(stripped)) {
    throw new Error(
      `${params.field}.to must be a numeric Telegram chat ID, optionally suffixed with :topic:<id>`,
    );
  }
}

export async function assertValidCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  delivery?: CronDelivery;
}) {
  if (params.delivery && (params.delivery.mode ?? "announce") === "announce") {
    assertCompatibleAnnounceTarget({
      channel: params.delivery.channel,
      to: params.delivery.to,
      field: "delivery.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(params.delivery),
      field: "delivery.channel",
    });
    assertValidTelegramCronTarget({
      cfg: params.cfg,
      delivery: params.delivery,
      field: "delivery",
    });
  }

  const failureDestination = params.delivery?.failureDestination;
  if (failureDestination && (failureDestination.mode ?? "announce") === "announce") {
    if (
      failureDestination.channel === undefined &&
      failureDestination.to === undefined &&
      failureDestination.accountId === undefined &&
      failureDestination.mode === undefined
    ) {
      return;
    }
    assertCompatibleAnnounceTarget({
      channel: failureDestination.channel,
      to: failureDestination.to,
      field: "delivery.failureDestination.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(failureDestination),
      field: "delivery.failureDestination.channel",
    });
    assertValidTelegramCronTarget({
      cfg: params.cfg,
      delivery: failureDestination,
      field: "delivery.failureDestination",
    });
  }
}

export async function assertValidCronCreateDelivery(cfg: OpenClawConfig, job: CronJobCreate) {
  await assertValidCronAnnounceDelivery({ cfg, delivery: job.delivery });
}
