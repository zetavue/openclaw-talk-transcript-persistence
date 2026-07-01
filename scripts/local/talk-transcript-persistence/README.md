# Talk Transcript Persistence Local Patch

This directory contains the local operator patch that keeps WebUI/voice Talk
transcripts persisted across npm package updates until the behavior is fully
upstreamed.

The patch is intentionally installed as a systemd `ExecStartPre` hook. Each
gateway start checks the currently installed `dist/talk-*.js` bundle, verifies
whether the persistence markers are present, and patches the bundle only when
the upstream package has overwritten the local change.

## Files

- `ensure_talk_transcript_persistence_patch.py`: idempotent patcher for the
  installed OpenClaw Talk bundle.
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
openclaw-talk-transcript-guard: PASS: persistence markers already present
```

## Environment Overrides

- `OPENCLAW_GLOBAL_ROOT`: path to the installed OpenClaw package root.
- `OPENCLAW_TALK_PATCH_LOG`: path to the patch guard log file.
