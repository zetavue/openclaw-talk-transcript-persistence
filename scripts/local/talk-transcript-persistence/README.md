# Local Post-Update Patch Guard

This directory contains local operator patches that keep critical site-specific
behavior across npm package updates until the behavior is fully upstreamed.

The patch is intentionally installed as a systemd `ExecStartPre` hook. Each
gateway start checks the currently installed OpenClaw `dist/*.js` bundles,
verifies whether the local markers are present, patches text-level bundles when
the upstream package has overwritten the local changes, and rebuilds/syncs the
Git-managed local OpenClaw source tree when source-level local fixes are missing.

## Current Patches

- Talk/WebUI realtime transcript persistence for voice input sessions.
- Telegram outbound text idempotency: suppresses duplicate pure-text sends with
  the same account, chat, thread, silence flag, and normalized body within a
  short time window.
- Telegram prompt-context dedupe: removes duplicate selected context messages
  when the same OpenClaw reply is present through both session transcript and
  Telegram cache/mirror history.
- Telegram delivery-mirror dedupe: suppresses transcript mirror rows when the
  latest assistant transcript text already matches the delivered Telegram final.
- Telegram visible-reply dedupe: suppresses repeated visible Telegram replies
  within the same inbound Telegram turn, covering the bot streaming/final
  delivery path that does not always go through the generic send tool.
- Telegram Mail Layer approval callback: source-backed deterministic handling
  for `Senden freigeben: Action <id>` button callbacks, so the button invokes
  Mail Layer send directly instead of relying on the model to run the send tool.
- Telegram ingress watchdog: source-backed restart guard for isolated Telegram
  polling when unattempted `pending` spool updates age out with no active spool
  handler, which recovers dispatcher stalls after network/suspend issues.
- `voice-command-guard`: source-backed local fix for Telegram voice intent safety.
  If an OpenClaw update overwrites it, the guard rebuilds the local source tree
  and syncs `dist/` back into the global installation.
- Reply session init conflict retry: source-backed limited backoff for transient
  `reply session initialization conflicted` races, so WebUI observation does not
  immediately abort Telegram replay processing.
- Cron Telegram delivery validation: source-backed fail-fast checks that reject
  phone-number Telegram targets and missing/default bot accounts before cron jobs
  are created or updated.
- Mail action claim guard: source-backed runtime guard that blocks unverified
  `Action-ID` success claims before they reach Telegram, including the live/block
  streaming path.
- Structured mail draft creation for all agents: source-backed checks that keep
  the `mail_create_draft` Mail Layer tool and the global `exec/bash` block for
  direct `create_draft.py` calls after package updates.
- Mail draft grounding guard: source-backed check that rejects draft creation
  for replies or old/prepared draft updates unless the original exported message
  is passed as `reply_source`.

## Files

- `ensure_talk_transcript_persistence_patch.py`: idempotent patcher for the
  installed OpenClaw Talk and Telegram bundles.
- `90-talk-transcript-persistence.conf`: systemd user drop-in template for
  `openclaw-gateway.service`.

## Install

```bash
mkdir -p ~/.openclaw/tools ~/.config/systemd/user/openclaw-gateway.service.d
cp scripts/local/talk-transcript-persistence/ensure_talk_transcript_persistence_patch.py ~/.openclaw/tools/
chmod +x ~/.openclaw/tools/ensure_talk_transcript_persistence_patch.py
cp scripts/local/talk-transcript-persistence/90-talk-transcript-persistence.conf ~/.config/systemd/user/openclaw-gateway.service.d/
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

## Verify

```bash
~/.openclaw/tools/ensure_talk_transcript_persistence_patch.py
openclaw health --json
tail -n 20 ~/.openclaw/logs/talk-transcript-persistence-guard.log
```

Expected log marker:

```text
openclaw-talk-transcript-guard: PASS: talk-transcript-persistence markers already present
openclaw-talk-transcript-guard: PASS: telegram-outbound-dedupe markers already present
openclaw-talk-transcript-guard: PASS: telegram-context-dedupe markers already present
openclaw-talk-transcript-guard: PASS: telegram-delivery-mirror-dedupe markers already present
openclaw-talk-transcript-guard: PASS: telegram-visible-reply-dedupe markers already present
openclaw-talk-transcript-guard: PASS: telegram-mail-approval-callback markers already present
openclaw-talk-transcript-guard: PASS: voice-command-guard markers already present
openclaw-talk-transcript-guard: PASS: mail-action-claim-guard markers already present
openclaw-talk-transcript-guard: PASS: structured-mail-create-draft-tool markers already present
openclaw-talk-transcript-guard: PASS: mail-draft-grounding-guard markers already present
openclaw-talk-transcript-guard: PASS: mail-draft-exec-block markers already present
openclaw-talk-transcript-guard: PASS: telegram-ingress-watchdog markers already present
openclaw-talk-transcript-guard: PASS: reply-session-init-conflict-retry markers already present
openclaw-talk-transcript-guard: PASS: cron-telegram-delivery-validation markers already present
```

## Environment Overrides

- `OPENCLAW_GLOBAL_ROOT`: path to the installed OpenClaw package root.
- `OPENCLAW_LOCAL_SOURCE_REPO`: path to the Git-managed local OpenClaw source
  checkout used to rebuild and restore source-backed local fixes.
- `OPENCLAW_TALK_PATCH_LOG`: path to the patch guard log file.
