# Local Post-Update Patch Guard

This directory contains local operator patches that keep critical site-specific
behavior across npm package updates until the behavior is fully upstreamed.

The patch is intentionally installed as a systemd `ExecStartPre` hook. Each
gateway start checks the currently installed OpenClaw `dist/*.js` bundles,
verifies whether the local markers are present, and patches only when the
upstream package has overwritten the local changes.

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
- `voice-command-guard`: optional local patch for Telegram voice intent safety. Missing
  bundle is WARN-only and must never prevent gateway startup.
- Mail action claim guard: fail-closed marker check for the runtime guard that
  blocks unverified `Action-ID` success claims before they reach Telegram,
  including the live/block streaming path.

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
openclaw-talk-transcript-guard: PASS: mail-action-claim-guard markers already present
```

## Environment Overrides

- `OPENCLAW_GLOBAL_ROOT`: path to the installed OpenClaw package root.
- `OPENCLAW_TALK_PATCH_LOG`: path to the patch guard log file.
