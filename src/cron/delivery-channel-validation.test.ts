import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertValidCronAnnounceDelivery } from "./delivery-channel-validation.js";

const SYNTHETIC_BOT_TOKEN = "123456:synthetic-cron-test-token";

const configuredTelegram = {
  channels: { telegram: { enabled: true, botToken: SYNTHETIC_BOT_TOKEN } },
} satisfies OpenClawConfig;

describe("assertValidCronAnnounceDelivery Telegram targets", () => {
  beforeEach(() => {
    const telegram = {
      ...createChannelTestPluginBase({
        id: "telegram",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: () => true,
        },
      }),
      outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
    );
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  it("rejects a Telegram account that is not configured", async () => {
    await expect(
      assertValidCronAnnounceDelivery({
        cfg: configuredTelegram,
        delivery: {
          mode: "announce",
          channel: "telegram",
          accountId: "missing",
          to: "-1001234567890",
        },
      }),
    ).rejects.toThrow(/Telegram account "missing".*no bot token configured/u);
  });

  it("rejects a phone number as a Telegram recipient", async () => {
    await expect(
      assertValidCronAnnounceDelivery({
        cfg: configuredTelegram,
        delivery: { mode: "announce", channel: "telegram", to: "+15551234567" },
      }),
    ).rejects.toThrow(/numeric Telegram chat ID, not a phone number/u);
  });

  it("accepts a numeric chat ID with an optional topic suffix", async () => {
    await expect(
      assertValidCronAnnounceDelivery({
        cfg: configuredTelegram,
        delivery: { mode: "announce", channel: "telegram", to: "-1001234567890:topic:42" },
      }),
    ).resolves.toBeUndefined();
  });
});
