import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GuardMailActionClaimOptions = {
  agentId?: string;
  dbPath?: string;
  lookupActionIds?: (ids: readonly number[]) => Promise<ReadonlySet<number>>;
};

const MAIL_ACTION_ID_PATTERN = /\bAction-ID\s*:?\s*(\d+)\b/gi;
const MAIL_ACTION_CLAIM_GUARD_MARKER = "openclaw-local-mail-action-claim-guard-v1";
const MAIL_ACTION_LIVE_CLAIM_GUARD_MARKER = "openclaw-local-mail-action-live-claim-guard-v1";

const MAIL_SUCCESS_CLAIM_PATTERN =
  /(?:\b[\w-]*Entwurf[\w-]*\s+(?:erstellt|aktualisiert|angelegt|neu erstellt)\b|\bDer Entwurf liegt\b|\bliegt in\s+\*\*?Entw[uü]rfe\b|\bwurde\s+versendet\b|\bMail\s+wurde\s+versendet\b|\bE-?Mail\s+wurde\s+versendet\b|\bVersendet\.\b|\bGesendet-UID\b)/iu;

function defaultMailActionDbPath(): string {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "workspace-mail", "mail_agent.sqlite");
}

function extractActionIds(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(MAIL_ACTION_ID_PATTERN)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      ids.add(id);
    }
  }
  return [...ids];
}

function looksLikeMailSuccessClaim(text: string): boolean {
  return MAIL_SUCCESS_CLAIM_PATTERN.test(text);
}

export function shouldSuppressLiveMailActionClaim(text: string | undefined): boolean {
  if (!text || process.env.OPENCLAW_MAIL_ACTION_CLAIM_GUARD === "0") {
    return false;
  }
  if (
    process.env.OPENCLAW_MAIL_ACTION_LIVE_CLAIM_GUARD_MARKER === MAIL_ACTION_LIVE_CLAIM_GUARD_MARKER
  ) {
    void text;
  }
  return extractActionIds(text).length > 0 && looksLikeMailSuccessClaim(text);
}

async function lookupSqliteMailActionIds(
  ids: readonly number[],
  dbPath: string,
): Promise<ReadonlySet<number> | null> {
  try {
    await access(dbPath);
  } catch {
    return null;
  }

  const uniqueIds = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (uniqueIds.length === 0) {
    return new Set();
  }

  const query = `select id from mail_actions where id in (${uniqueIds.join(",")});`;
  const { stdout } = await execFileAsync("sqlite3", [dbPath, query], {
    timeout: 1500,
    maxBuffer: 64 * 1024,
  });
  const output = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  return new Set(
    output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

function formatUnverifiedMailActionClaim(ids: readonly number[], reason: string): string {
  const idLabel = ids.length === 1 ? `Action-ID ${ids[0]}` : `Action-IDs ${ids.join(", ")}`;
  return [
    "Mail-Aktion nicht bestaetigt.",
    "",
    `Die genannte ${idLabel} konnte nicht im Mail-Layer bestaetigt werden (${reason}).`,
    "Ich bestaetige deshalb keinen Entwurf und keinen Versand.",
    "",
    "Bitte die Mail-Aktion erneut erstellen oder den Mail-Layer pruefen.",
  ].join("\n");
}

export async function guardUnverifiedMailActionClaim(
  text: string | undefined,
  options: GuardMailActionClaimOptions = {},
): Promise<string | undefined> {
  if (!text || process.env.OPENCLAW_MAIL_ACTION_CLAIM_GUARD === "0") {
    return text;
  }
  if (process.env.OPENCLAW_MAIL_ACTION_CLAIM_GUARD_MARKER === MAIL_ACTION_CLAIM_GUARD_MARKER) {
    void text;
  }

  const actionIds = extractActionIds(text);
  if (!shouldSuppressLiveMailActionClaim(text)) {
    return text;
  }

  try {
    const foundIds =
      options.lookupActionIds?.(actionIds) ??
      lookupSqliteMailActionIds(
        actionIds,
        options.dbPath ?? process.env.OPENCLAW_MAIL_ACTION_DB ?? defaultMailActionDbPath(),
      );
    const found = await foundIds;
    if (found === null) {
      return text;
    }
    const missing = actionIds.filter((id) => !found.has(id));
    if (missing.length === 0) {
      return text;
    }
    return formatUnverifiedMailActionClaim(missing, "nicht registriert");
  } catch {
    if (options.agentId === "restaurant") {
      return formatUnverifiedMailActionClaim(actionIds, "Registry-Pruefung fehlgeschlagen");
    }
    return text;
  }
}
