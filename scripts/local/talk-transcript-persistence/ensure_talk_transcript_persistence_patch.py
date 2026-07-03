#!/usr/bin/env python3
"""Keep local Talk realtime transcript persistence across package updates.

This is a local operator patch for installations where the upstream package does
not yet include realtime Talk transcript persistence. It patches the currently
installed OpenClaw `dist/talk-*.js` bundle at gateway startup.

The script is idempotent and fails closed. If the expected bundle shape changes,
the gateway startup hook fails instead of silently running without persistence.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


HOME = Path.home()
ROOT = Path(
    os.environ.get(
        "OPENCLAW_GLOBAL_ROOT",
        str(HOME / ".npm-global" / "lib" / "node_modules" / "openclaw"),
    )
)
DIST = ROOT / "dist"
LOG = Path(
    os.environ.get(
        "OPENCLAW_TALK_PATCH_LOG",
        str(HOME / ".openclaw" / "logs" / "talk-transcript-persistence-guard.log"),
    )
)
MARKERS = (
    "//#region src/gateway/talk-transcript-persistence.ts",
    'const TALK_TRANSCRIPT_SOURCE = "realtime-talk";',
    "async function persistFinalTalkTranscript(params)",
    "function enqueueRelayTranscriptPersistence(session, params)",
    "transcriptWriteQueue: Promise.resolve()",
)
VOICE_COMMAND_GUARD_MARKERS = (
    "VOICE_COMMAND_GUARD",
    "openclaw-local-voice-command-guard-v1",
)
TELEGRAM_SEND_MARKERS = (
    'const OPENCLAW_LOCAL_TELEGRAM_OUTBOUND_DEDUPE_MARKER = "openclaw-local-telegram-outbound-dedupe-v1";',
    "function buildOpenClawLocalTelegramOutboundDedupeKey(params)",
    "function runOpenClawLocalTelegramOutboundDedupe(key, send)",
)
TELEGRAM_CONTEXT_MARKERS = (
    'const OPENCLAW_LOCAL_TELEGRAM_CONTEXT_DEDUPE_MARKER = "openclaw-local-telegram-context-dedupe-v1";',
    "function dedupeOpenClawLocalTelegramPromptMessages(messages)",
)
TELEGRAM_MIRROR_MARKERS = (
    'const OPENCLAW_LOCAL_TELEGRAM_DELIVERY_MIRROR_DEDUPE_MARKER = "openclaw-local-telegram-delivery-mirror-dedupe-v1";',
    "const latestAssistant = await readLatestAssistantTextByIdentity({",
    "latestAssistant?.text?.trim() === text.trim()",
)
TELEGRAM_VISIBLE_REPLY_MARKERS = (
    'const OPENCLAW_LOCAL_TELEGRAM_VISIBLE_REPLY_DEDUPE_MARKER = "openclaw-local-telegram-visible-reply-dedupe-v1";',
    "function buildOpenClawLocalTelegramVisibleReplyDedupeKey(params)",
    "rememberOpenClawLocalTelegramVisibleReply(visibleReplyDedupeKey)",
)
PROVIDER_MEDIA_REF_HINT_MARKERS = (
    'const OPENCLAW_LOCAL_PROVIDER_MEDIA_REF_HINT_MARKER = "openclaw-local-provider-media-ref-hint-v1";',
    "function normalizePromptMediaLocator(value)",
    'mediaRef.startsWith("telegram:file/")',
)
MAIL_ACTION_CLAIM_GUARD_MARKERS = (
    "openclaw-local-mail-action-claim-guard-v1",
    "openclaw-local-mail-action-live-claim-guard-v1",
    "Mail-Aktion nicht bestaetigt.",
    "OPENCLAW_MAIL_ACTION_CLAIM_GUARD",
)


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(message: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{now()}] openclaw-talk-transcript-guard: {message}"
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    print(line)


def fail(message: str) -> None:
    log(f"FAIL: {message}")
    raise SystemExit(1)


def find_talk_bundle() -> Path:
    candidates: list[Path] = []
    for path in DIST.glob("talk-*.js"):
        if path.name.startswith("talk-config-runtime-"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "//#region src/gateway/talk-realtime-relay.ts" in text and "createTalkRealtimeRelaySession" in text:
            candidates.append(path)
    if not candidates:
        fail(f"no realtime Talk bundle found under {DIST}")
    candidates.sort(key=lambda candidate: candidate.stat().st_mtime, reverse=True)
    return candidates[0]


def has_patch(text: str) -> bool:
    return all(marker in text for marker in MARKERS)


def has_markers(text: str, markers: tuple[str, ...]) -> bool:
    return all(marker in text for marker in markers)


def find_dist_bundle(label: str, required: tuple[str, ...]) -> Path:
    candidates: list[Path] = []
    for path in DIST.glob("*.js"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if all(marker in text for marker in required):
            candidates.append(path)
    if not candidates:
        fail(f"no {label} bundle found under {DIST}")
    candidates.sort(key=lambda candidate: candidate.stat().st_mtime, reverse=True)
    return candidates[0]


def find_optional_dist_bundle(label: str, required: tuple[str, ...]) -> Path | None:
    candidates: list[Path] = []
    for path in DIST.glob("*.js"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        if all(marker in text for marker in required):
            candidates.append(path)
    if not candidates:
        log(f"WARN: no {label} bundle found under {DIST}; skipping optional patch")
        return None
    candidates.sort(key=lambda candidate: candidate.stat().st_mtime, reverse=True)
    return candidates[0]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        fail(f"expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def detect_imports(text: str) -> dict[str, str]:
    patterns = {
        "chat": r'import \{ r as chatHandlers \} from "(\.\/chat-[^"]+\.js)";',
        "session_key": r'import \{ p as resolveAgentIdFromSessionKey \} from "(\.\/session-key-[^"]+\.js)";',
        "paths": r'import \{ d as resolveStorePath \} from "(\.\/paths-[^"]+\.js)";',
        "session_accessor": r'import \{ b as persistSessionTranscriptTurn, m as loadSessionEntry \} from "(\.\/session-accessor-[^"]+\.js)";',
    }
    found: dict[str, str] = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, text)
        if match:
            found[key] = match.group(1)
    if "chat" not in found:
        fail("could not locate chatHandlers import anchor")
    if "session_key" not in found:
        matches = sorted(DIST.glob("session-key-*.js"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not matches:
            fail("could not locate session-key dist module")
        found["session_key"] = f"./{matches[0].name}"
    if "paths" not in found:
        matches = sorted(DIST.glob("paths-*.js"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not matches:
            fail("could not locate paths dist module")
        found["paths"] = f"./{matches[0].name}"
    if "session_accessor" not in found:
        shim = next(
            (
                path
                for path in DIST.glob("session-accessor-*.js")
                if "export {" in path.read_text(encoding="utf-8", errors="ignore")[:3000]
            ),
            None,
        )
        if not shim:
            fail("could not locate session-accessor dist module")
        found["session_accessor"] = f"./{shim.name}"
    return found


def patch_text(text: str) -> str:
    imports = detect_imports(text)
    chat_import = f'import {{ r as chatHandlers }} from "{imports["chat"]}";\n'
    extra_imports = (
        f'import {{ p as resolveAgentIdFromSessionKey }} from "{imports["session_key"]}";\n'
        f'import {{ d as resolveStorePath }} from "{imports["paths"]}";\n'
        f'import {{ b as persistSessionTranscriptTurn, m as loadSessionEntry }} from "{imports["session_accessor"]}";\n'
    )
    if "resolveAgentIdFromSessionKey" not in text:
        text = replace_once(text, chat_import, chat_import + extra_imports, "chat import anchor")

    persistence_block = '''//#endregion
//#region src/gateway/talk-transcript-persistence.ts
const TALK_TRANSCRIPT_SOURCE = "realtime-talk";
const GATEWAY_INJECTED_PROVIDER = "openclaw";
const GATEWAY_INJECTED_MODEL = "gateway-injected";
const ZERO_TOKEN_USAGE = {
\tinput: 0,
\toutput: 0,
\tcacheRead: 0,
\tcacheWrite: 0,
\ttotalTokens: 0,
\tcost: {
\t\tinput: 0,
\t\toutput: 0,
\t\tcacheRead: 0,
\t\tcacheWrite: 0,
\t\ttotal: 0
\t}
};
function buildTalkIdempotencyKey(params) {
\tconst textHash = createHash("sha256").update(params.text).digest("hex");
\treturn `talk:${params.relaySessionId}:${params.turnId}:${params.role}:${textHash}`;
}
function buildTalkProvenance(params) {
\treturn {
\t\trelaySessionId: params.relaySessionId,
\t\tturnId: params.turnId,
\t\tprovider: params.provider,
\t\tsource: TALK_TRANSCRIPT_SOURCE
\t};
}
function buildTalkTranscriptMessage(params) {
\tconst { idempotencyKey, provenance: openclawTalk } = params;
\tif (params.role === "user") return {
\t\trole: "user",
\t\tcontent: params.text,
\t\ttimestamp: params.now,
\t\tidempotencyKey,
\t\topenclawTalk
\t};
\treturn {
\t\trole: "assistant",
\t\tcontent: [{
\t\t\ttype: "text",
\t\t\ttext: params.text
\t\t}],
\t\tprovider: GATEWAY_INJECTED_PROVIDER,
\t\tmodel: GATEWAY_INJECTED_MODEL,
\t\tusage: ZERO_TOKEN_USAGE,
\t\tstopReason: "stop",
\t\ttimestamp: params.now,
\t\tidempotencyKey,
\t\topenclawTalk
\t};
}
async function persistFinalTalkTranscript(params) {
\tconst sessionKey = params.sessionKey?.trim();
\tconst text = params.text.trim();
\tif (!sessionKey || !text) return { status: "skipped" };
\tconst agentId = resolveAgentIdFromSessionKey(sessionKey);
\tconst storePath = resolveStorePath(params.config?.session?.store, agentId ? { agentId } : {});
\tconst sessionId = loadSessionEntry({
\t\tsessionKey,
\t\tstorePath
\t})?.sessionId;
\tif (!sessionId) return { status: "skipped" };
\tconst now = params.now ?? Date.now();
\tconst idempotencyKey = buildTalkIdempotencyKey({
\t\trelaySessionId: params.relaySessionId,
\t\tturnId: params.turnId,
\t\trole: params.role,
\t\ttext
\t});
\tconst message = buildTalkTranscriptMessage({
\t\trole: params.role,
\t\ttext,
\t\tnow,
\t\tidempotencyKey,
\t\tprovenance: buildTalkProvenance({
\t\t\trelaySessionId: params.relaySessionId,
\t\t\tturnId: params.turnId,
\t\t\tprovider: params.provider
\t\t})
\t});
\tconst appendResult = (await persistSessionTranscriptTurn({
\t\tsessionKey,
\t\tsessionId,
\t\tstorePath,
\t\t...agentId ? { agentId } : {},
\t\t...params.config ? { config: params.config } : {}
\t}, {
\t\tupdateMode: "inline",
\t\tmessages: [{
\t\t\tmessage,
\t\t\tidempotencyLookup: "scan",
\t\t\tnow
\t\t}]
\t})).messages[0];
\tif (!appendResult) return { status: "skipped" };
\treturn {
\t\tstatus: appendResult.appended ? "appended" : "duplicate",
\t\tmessageId: appendResult.messageId
\t};
}
//#endregion
//#region src/gateway/talk-realtime-relay.ts
'''
    text = replace_once(
        text,
        "//#endregion\n//#region src/gateway/talk-realtime-relay.ts\n",
        persistence_block,
        "realtime relay region anchor",
    )

    helper_block = '''function resolveTranscriptTurnForPersistence(session, role, text) {
\tconst current = session.transcriptTurn;
\tif (role === "user") {
\t\tif (!current || current.userFinalized) {
\t\t\tsession.transcriptTurnSeq += 1;
\t\t\tsession.transcriptTurn = {
\t\t\t\tid: `t${session.transcriptTurnSeq}`,
\t\t\t\tuserFinalized: Boolean(text.trim()),
\t\t\t\tassistantFinalized: false
\t\t\t};
\t\t\treturn session.transcriptTurn.id;
\t\t}
\t\tcurrent.userFinalized = true;
\t\treturn current.id;
\t}
\tif (!current || current.assistantFinalized) {
\t\tsession.transcriptTurnSeq += 1;
\t\tsession.transcriptTurn = {
\t\t\tid: `t${session.transcriptTurnSeq}`,
\t\t\tuserFinalized: false,
\t\t\tassistantFinalized: true
\t\t};
\t\treturn session.transcriptTurn.id;
\t}
\tcurrent.assistantFinalized = true;
\treturn current.id;
}
function enqueueRelayTranscriptPersistence(session, params) {
\tsession.transcriptWriteQueue = session.transcriptWriteQueue.catch(() => {}).then(() => persistFinalTalkTranscript({
\t\trelaySessionId: session.id,
\t\tturnId: params.turnId,
\t\trole: params.role,
\t\ttext: params.text,
\t\tsessionKey: session.sessionKey,
\t\tprovider: session.providerId,
\t\tconfig: params.cfg
\t})).catch((error) => {
\t\tsession.context.logGateway?.warn("Talk transcript persistence failed", {
\t\t\trelaySessionId: session.id,
\t\t\terror: formatForLog(error)
\t\t});
\t});
}
async function closeRelaySessionInBackground(session, reason) {
\tcloseRelaySession(session, reason);
\ttry {
\t\tawait session.transcriptWriteQueue;
\t} catch {}
}
'''
    text = replace_once(
        text,
        "function submitRelayAgentControlProviderResults(session, result, turnId) {\n",
        helper_block + "function submitRelayAgentControlProviderResults(session, result, turnId) {\n",
        "submit helper anchor",
    )
    text = replace_once(
        text,
        'if (active) closeRelaySession(active, "completed");',
        'if (active) closeRelaySessionInBackground(active, "completed");',
        "cleanup close anchor",
    )

    transcript_replacement = '''if (final && relay) {
\t\t\t\trecordRealtimeVoiceTranscript(relay.transcript, role, text);
\t\t\t\tconst normalizedText = text.trim();
\t\t\t\tconst transcriptTurnId = normalizedText ? resolveTranscriptTurnForPersistence(relay, role, normalizedText) : void 0;
\t\t\t\tif (transcriptTurnId) enqueueRelayTranscriptPersistence(relay, {
\t\t\t\t\tturnId: transcriptTurnId,
\t\t\t\t\trole,
\t\t\t\t\ttext: normalizedText,
\t\t\t\t\tcfg: params.cfg
\t\t\t\t});
\t\t\t}'''
    text = replace_once(
        text,
        'if (final && relay) recordRealtimeVoiceTranscript(relay.transcript, role, text);',
        transcript_replacement,
        "final transcript record anchor",
    )
    text = replace_once(
        text,
        "\t\tforcedConsults: createRealtimeVoiceForcedConsultCoordinator(),\n\t\ttranscript: []\n\t};",
        "\t\tforcedConsults: createRealtimeVoiceForcedConsultCoordinator(),\n\t\ttranscript: [],\n\t\ttranscriptWriteQueue: Promise.resolve(),\n\t\tproviderId: params.provider.id,\n\t\ttranscriptTurn: void 0,\n\t\ttranscriptTurnSeq: 0\n\t};",
        "relay session fields anchor",
    )
    return text


def patch_telegram_send_text(text: str) -> str:
    if has_markers(text, TELEGRAM_SEND_MARKERS):
        return text
    helper = '''const OPENCLAW_LOCAL_TELEGRAM_OUTBOUND_DEDUPE_MARKER = "openclaw-local-telegram-outbound-dedupe-v1";
const OPENCLAW_LOCAL_TELEGRAM_OUTBOUND_DEDUPE_TTL_MS = 90 * 1000;
const openclawLocalTelegramOutboundDedupe = /* @__PURE__ */ new Map();
function normalizeOpenClawLocalTelegramOutboundText(text) {
\treturn String(text ?? "").replace(/\\s+/gu, " ").trim();
}
function pruneOpenClawLocalTelegramOutboundDedupe(now) {
\tfor (const [key, entry] of openclawLocalTelegramOutboundDedupe) if (now - entry.at > OPENCLAW_LOCAL_TELEGRAM_OUTBOUND_DEDUPE_TTL_MS) openclawLocalTelegramOutboundDedupe.delete(key);
}
function buildOpenClawLocalTelegramOutboundDedupeKey(params) {
\tconst normalized = normalizeOpenClawLocalTelegramOutboundText(params.text);
\tif (!normalized) return;
\treturn [params.accountId ?? "", params.chatId ?? "", params.threadId ?? "", params.silent === true ? "silent" : "normal", normalized].join("\\u001f");
}
function runOpenClawLocalTelegramOutboundDedupe(key, send) {
\tconst now = Date.now();
\tpruneOpenClawLocalTelegramOutboundDedupe(now);
\tconst existing = openclawLocalTelegramOutboundDedupe.get(key);
\tif (existing && now - existing.at <= OPENCLAW_LOCAL_TELEGRAM_OUTBOUND_DEDUPE_TTL_MS) {
\t\tlogVerbose("telegram outbound duplicate suppressed by local post-update patch");
\t\treturn existing.promise;
\t}
\tconst promise = Promise.resolve().then(send);
\topenclawLocalTelegramOutboundDedupe.set(key, { at: now, promise });
\tpromise.catch(() => {
\t\tif (openclawLocalTelegramOutboundDedupe.get(key)?.promise === promise) openclawLocalTelegramOutboundDedupe.delete(key);
\t});
\treturn promise;
}
'''
    text = replace_once(
        text,
        "async function sendMessageTelegram(to, text, opts) {\n",
        helper + "async function sendMessageTelegram(to, text, opts) {\n",
        "telegram send function anchor",
    )
    text = replace_once(
        text,
        '\tif (!text || !text.trim()) throw new Error("Message must be non-empty for Telegram sends");\n\tconst textResult = await sendChunkedText(text, "text send");\n',
        '\tif (!text || !text.trim()) throw new Error("Message must be non-empty for Telegram sends");\n\tconst outboundDedupeKey = buildOpenClawLocalTelegramOutboundDedupeKey({\n\t\taccountId: account.accountId,\n\t\tchatId,\n\t\tthreadId: threadParams.message_thread_id,\n\t\ttext,\n\t\tsilent: opts.silent\n\t});\n\tconst textResult = await (outboundDedupeKey ? runOpenClawLocalTelegramOutboundDedupe(outboundDedupeKey, () => sendChunkedText(text, "text send")) : sendChunkedText(text, "text send"));\n',
        "telegram text send anchor",
    )
    return text


def patch_telegram_context_text(text: str) -> str:
    if has_markers(text, TELEGRAM_CONTEXT_MARKERS):
        return text
    helper = '''const OPENCLAW_LOCAL_TELEGRAM_CONTEXT_DEDUPE_MARKER = "openclaw-local-telegram-context-dedupe-v1";
function normalizeOpenClawLocalTelegramPromptSender(sender) {
\tconst value = String(sender ?? "").replace(/\\s*\\([^)]*\\)\\s*$/u, "").trim().toLowerCase();
\tif (value === "openclaw") return "assistant";
\tif (value === "user") return "user";
\treturn value;
}
function normalizeOpenClawLocalTelegramPromptBody(body) {
\treturn String(body ?? "").replace(/\\s+/gu, " ").trim().toLowerCase();
}
function dedupeOpenClawLocalTelegramPromptMessages(messages) {
\tconst seen = /* @__PURE__ */ new Set();
\tconst kept = [];
\tfor (const message of messages) {
\t\tconst body = normalizeOpenClawLocalTelegramPromptBody(message?.body);
\t\tconst sender = normalizeOpenClawLocalTelegramPromptSender(message?.sender);
\t\tconst key = body ? `${sender}\\u001f${body}` : "";
\t\tif (key && seen.has(key)) continue;
\t\tif (key) seen.add(key);
\t\tkept.push(message);
\t}
\treturn kept;
}
'''
    text = replace_once(
        text,
        "const registerTelegramNativeCommands = ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, mediaMaxBytes, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, telegramDeps = defaultTelegramNativeCommandDeps, opts }) => {\n",
        helper + "const registerTelegramNativeCommands = ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, mediaMaxBytes, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, telegramDeps = defaultTelegramNativeCommandDeps, opts }) => {\n",
        "telegram context helper anchor",
    )
    text = replace_once(
        text,
        "\t\tconst promptMessages = [...sessionOnlyPromptMessages, ...cachePromptMessages].toSorted((left, right) => (left.timestamp_ms ?? 0) - (right.timestamp_ms ?? 0));\n",
        "\t\tconst promptMessages = dedupeOpenClawLocalTelegramPromptMessages([...sessionOnlyPromptMessages, ...cachePromptMessages].toSorted((left, right) => (left.timestamp_ms ?? 0) - (right.timestamp_ms ?? 0)));\n",
        "telegram prompt messages anchor",
    )
    return text


def patch_telegram_delivery_mirror_text(text: str) -> str:
    if has_markers(text, TELEGRAM_MIRROR_MARKERS):
        return text
    text = replace_once(
        text,
        "async function mirrorTelegramAssistantReplyToTranscript(params) {\n",
        'const OPENCLAW_LOCAL_TELEGRAM_DELIVERY_MIRROR_DEDUPE_MARKER = "openclaw-local-telegram-delivery-mirror-dedupe-v1";\n'
        "async function mirrorTelegramAssistantReplyToTranscript(params) {\n",
        "telegram delivery mirror function anchor",
    )
    text = replace_once(
        text,
        "\tif (!session) return;\n\tconst appended = await appendAssistantMirrorMessageByIdentity({\n",
        "\tif (!session) return;\n\tconst latestAssistant = await readLatestAssistantTextByIdentity({\n\t\tagentId: params.route.agentId,\n\t\tsessionId: session.sessionId,\n\t\tsessionKey: params.sessionKey,\n\t\tstorePath: session.storePath\n\t});\n\tif (latestAssistant?.text?.trim() === text.trim()) {\n\t\tlogVerbose(\"telegram delivery mirror duplicate suppressed by local post-update patch\");\n\t\treturn;\n\t}\n\tconst appended = await appendAssistantMirrorMessageByIdentity({\n",
        "telegram delivery mirror append anchor",
    )
    return text


def patch_telegram_visible_reply_text(text: str) -> str:
    if has_markers(text, TELEGRAM_VISIBLE_REPLY_MARKERS):
        return text
    helper = '''const OPENCLAW_LOCAL_TELEGRAM_VISIBLE_REPLY_DEDUPE_MARKER = "openclaw-local-telegram-visible-reply-dedupe-v1";
const OPENCLAW_LOCAL_TELEGRAM_VISIBLE_REPLY_DEDUPE_TTL_MS = 5 * 60 * 1000;
const openclawLocalTelegramVisibleReplyDedupe = /* @__PURE__ */ new Map();
function normalizeOpenClawLocalTelegramVisibleReplyText(text) {
\treturn String(text ?? "").replace(/\\s+/gu, " ").trim();
}
function pruneOpenClawLocalTelegramVisibleReplyDedupe(now) {
\tfor (const [key, entry] of openclawLocalTelegramVisibleReplyDedupe) if (now - entry.at > OPENCLAW_LOCAL_TELEGRAM_VISIBLE_REPLY_DEDUPE_TTL_MS) openclawLocalTelegramVisibleReplyDedupe.delete(key);
}
function buildOpenClawLocalTelegramVisibleReplyDedupeKey(params) {
\tconst normalized = normalizeOpenClawLocalTelegramVisibleReplyText(params.text);
\tif (!normalized) return;
\treturn [params.accountId ?? "", params.chatId ?? "", params.threadId ?? "", params.turnId ?? "", params.silent === true ? "silent" : "normal", normalized].join("\\u001f");
}
function hasOpenClawLocalTelegramVisibleReply(key) {
\tconst now = Date.now();
\tpruneOpenClawLocalTelegramVisibleReplyDedupe(now);
\treturn openclawLocalTelegramVisibleReplyDedupe.has(key);
}
function rememberOpenClawLocalTelegramVisibleReply(key) {
\tconst now = Date.now();
\tpruneOpenClawLocalTelegramVisibleReplyDedupe(now);
\topenclawLocalTelegramVisibleReplyDedupe.set(key, { at: now });
}
'''
    text = replace_once(
        text,
        "const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;\n",
        helper + "const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;\n",
        "telegram visible reply helper anchor",
    )
    text = replace_once(
        text,
        "\t\tconst sendPayload = async (payload, options) => {\n\t\t\tif (isDispatchSuperseded()) return false;\n\t\t\tconst deliverablePayload = applyQuoteReplyTarget(payload);\n\t\t\tconst silent = options?.silent ?? (silentErrorReplies && payload.isError === true);\n\t\t\tconst durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;\n",
        "\t\tconst sendPayload = async (payload, options) => {\n\t\t\tif (isDispatchSuperseded()) return false;\n\t\t\tconst deliverablePayload = applyQuoteReplyTarget(payload);\n\t\t\tconst silent = options?.silent ?? (silentErrorReplies && payload.isError === true);\n\t\t\tconst visibleReplyDedupeKey = buildOpenClawLocalTelegramVisibleReplyDedupeKey({\n\t\t\t\taccountId: route.accountId,\n\t\t\t\tchatId: String(chatId),\n\t\t\t\tthreadId: threadSpec.id,\n\t\t\t\tturnId: transcriptMirrorTurnId,\n\t\t\t\ttext: deliverablePayload.text,\n\t\t\t\tsilent\n\t\t\t});\n\t\t\tif (visibleReplyDedupeKey && hasOpenClawLocalTelegramVisibleReply(visibleReplyDedupeKey)) {\n\t\t\t\tlogVerbose(\"telegram visible reply duplicate suppressed by local post-update patch\");\n\t\t\t\tdeliveryState.markDelivered();\n\t\t\t\treturn true;\n\t\t\t}\n\t\t\tconst durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;\n",
        "telegram visible reply pre-send anchor",
    )
    text = replace_once(
        text,
        "\t\t\t\tif (durable.status === \"handled_visible\") {\n\t\t\t\t\tdeliveryState.markDelivered();\n\t\t\t\t\treturn true;\n\t\t\t\t}\n",
        "\t\t\t\tif (durable.status === \"handled_visible\") {\n\t\t\t\t\tif (visibleReplyDedupeKey) rememberOpenClawLocalTelegramVisibleReply(visibleReplyDedupeKey);\n\t\t\t\t\tdeliveryState.markDelivered();\n\t\t\t\t\treturn true;\n\t\t\t\t}\n",
        "telegram visible reply durable success anchor",
    )
    text = replace_once(
        text,
        "\t\t\tif (result.delivered) deliveryState.markDelivered();\n\t\t\treturn result.delivered;\n",
        "\t\t\tif (result.delivered) {\n\t\t\t\tif (visibleReplyDedupeKey) rememberOpenClawLocalTelegramVisibleReply(visibleReplyDedupeKey);\n\t\t\t\tdeliveryState.markDelivered();\n\t\t\t}\n\t\t\treturn result.delivered;\n",
        "telegram visible reply fallback success anchor",
    )
    return text


def patch_provider_media_ref_hint_text(text: str) -> str:
    if has_markers(text, PROVIDER_MEDIA_REF_HINT_MARKERS):
        return text
    text = replace_once(
        text,
        'const INBOUND_SOURCE_MODALITIES = new Set([\n\t"text",\n\t"voice",\n\t"audio",\n\t"image",\n\t"video",\n\t"document"\n]);\n',
        'const INBOUND_SOURCE_MODALITIES = new Set([\n\t"text",\n\t"voice",\n\t"audio",\n\t"image",\n\t"video",\n\t"document"\n]);\nconst OPENCLAW_LOCAL_PROVIDER_MEDIA_REF_HINT_MARKER = "openclaw-local-provider-media-ref-hint-v1";\n',
        "provider media ref marker anchor",
    )
    text = replace_once(
        text,
        'function formatChatWindowMessage(value, envelope) {\n',
        'function normalizePromptMediaLocator(value) {\n\tconst mediaPath = normalizePromptMediaPath(value["media_path"]);\n\tif (mediaPath) return mediaPath;\n\tconst mediaRef = sanitizeTranscriptField(value["media_ref"]);\n\tif (!mediaRef) return;\n\tif (mediaRef.startsWith("telegram:file/")) return `${mediaRef} (provider-only; not image-tool-readable)`;\n\treturn mediaRef;\n}\nfunction formatChatWindowMessage(value, envelope) {\n',
        "provider media ref helper anchor",
    )
    text = replace_once(
        text,
        'const mediaLocator = normalizePromptMediaPath(value["media_path"]) ?? sanitizeTranscriptField(value["media_ref"]);\n',
        'const mediaLocator = normalizePromptMediaLocator(value);\n',
        "provider media ref locator anchor",
    )
    return text


def patch_bundle(bundle: Path, markers: tuple[str, ...], patcher, label: str) -> bool:
    text = bundle.read_text(encoding="utf-8")
    log(f"checking {label} bundle={bundle}")
    if has_markers(text, markers):
        subprocess.run(["node", "--check", str(bundle)], check=True, stdout=subprocess.DEVNULL)
        log(f"PASS: {label} markers already present")
        return False
    backup = bundle.with_name(
        f"{bundle.name}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}-pre-auto-{label}"
    )
    shutil.copy2(bundle, backup)
    patched = patcher(text)
    if not has_markers(patched, markers):
        fail(f"patched {label} text does not contain all required markers")
    tmp = bundle.with_name(f"{bundle.stem}.tmp-{label}{bundle.suffix}")
    tmp.write_text(patched, encoding="utf-8")
    subprocess.run(["node", "--check", str(tmp)], check=True, stdout=subprocess.DEVNULL)
    os.replace(tmp, bundle)
    log(f"PATCHED: wrote {label} patch to {bundle}; backup={backup}")
    return True


def main() -> int:
    bundle = find_talk_bundle()
    patch_bundle(bundle, MARKERS, patch_text, "talk-transcript-persistence")
    telegram_send_bundle = find_dist_bundle(
        "telegram send",
        (
            "async function sendMessageTelegram(to, text, opts)",
            'const sendChunkedText = async (rawText, context) =>',
            'recordChannelActivity({\n\t\tchannel: "telegram",',
        ),
    )
    patch_bundle(telegram_send_bundle, TELEGRAM_SEND_MARKERS, patch_telegram_send_text, "telegram-outbound-dedupe")
    telegram_context_bundle = find_dist_bundle(
        "telegram context",
        (
            "buildTelegramSessionTranscriptPromptMessages",
            "buildTelegramConversationContext",
            "const cacheTextKeys = new Set(cachePromptMessages.map",
            "Conversation context",
        ),
    )
    patch_bundle(telegram_context_bundle, TELEGRAM_CONTEXT_MARKERS, patch_telegram_context_text, "telegram-context-dedupe")
    patch_bundle(telegram_context_bundle, TELEGRAM_MIRROR_MARKERS, patch_telegram_delivery_mirror_text, "telegram-delivery-mirror-dedupe")
    patch_bundle(telegram_context_bundle, TELEGRAM_VISIBLE_REPLY_MARKERS, patch_telegram_visible_reply_text, "telegram-visible-reply-dedupe")
    find_optional_dist_bundle(
        "voice-command-guard",
        VOICE_COMMAND_GUARD_MARKERS,
    )
    get_reply_bundle = find_optional_dist_bundle(
        "get-reply inbound metadata",
        (
            "function formatChatWindowMessage(value, envelope)",
            "Current local chat window",
            "media_ref",
        ),
    )
    if get_reply_bundle is not None:
        patch_bundle(
            get_reply_bundle,
            PROVIDER_MEDIA_REF_HINT_MARKERS,
            patch_provider_media_ref_hint_text,
            "provider-media-ref-hint",
        )
    mail_action_guard_bundle = find_dist_bundle(
        "mail-action-claim-guard",
        MAIL_ACTION_CLAIM_GUARD_MARKERS,
    )
    patch_bundle(
        mail_action_guard_bundle,
        MAIL_ACTION_CLAIM_GUARD_MARKERS,
        lambda text: text,
        "mail-action-claim-guard",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
