export type VoiceIntent =
  | "mail.lookup"
  | "mail.draft"
  | "mail.update_draft"
  | "mail.send"
  | "mail.delete_draft"
  | "reservation.update"
  | "unknown";

export type VoiceRisk = "low" | "medium" | "high";

export type VoiceConfidence = "low" | "medium" | "high";

export type VoiceCommandIntentResult = {
  intent: VoiceIntent;
  risk: VoiceRisk;
  confidence: VoiceConfidence;
  requiresConfirmation: boolean;
  groundingRequired: boolean;
  missingFields: string[];
  evidenceTerms: string[];
  confirmationHint: string;
};

type AnalyzeVoiceCommandIntentParams = {
  text: string;
  channel?: string;
  agentId?: string;
};

const MAIL_DOMAIN_NOUNS =
  /\b(mail|e-?mail|email|e-mail|antwort|entwurf|bewerbung|anfrage|posteingang|evolution)\b/i;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const ADDRESS_PREFIX_PATTERN =
  /(?:\ban\b|\bfür\b|\bfuer\b|\bvon\b)\s+([A-ZÄÖÜa-zäöüß]+(?:\s+[A-ZÄÖÜa-zäöüß]+){0,2})/gi;

const EVIDENCE_STOPWORDS = new Set([
  "den",
  "die",
  "das",
  "der",
  "dem",
  "des",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "mein",
  "meine",
  "dein",
  "deine",
  "deinem",
  "unser",
  "unsere",
  "an",
  "von",
  "für",
  "fuer",
  "heute",
  "morgen",
  "gestern",
  "mail",
  "email",
  "posteingang",
  "bitte",
  "antwort",
  "entwurf",
  "reservierung",
  "termin",
  "tisch",
]);

const ACTION_VERB_PREFIXES = [
  "schick",
  "send",
  "versend",
  "abschick",
  "absend",
  "loesch",
  "lösch",
  "entfern",
  "aktualis",
  "aender",
  "änder",
  "korrig",
  "anpass",
  "bearbeit",
  "update",
  "ableg",
  "leg",
  "mach",
  "erstell",
  "such",
  "find",
  "check",
  "pruef",
  "prüf",
  "verschieb",
  "raus",
  "weg",
  "aus",
];

export function analyzeVoiceCommandIntent(
  params: AnalyzeVoiceCommandIntentParams,
): VoiceCommandIntentResult {
  const text = params.text.trim();
  const lower = text.toLocaleLowerCase("de-DE");
  const channel = params.channel?.toLocaleLowerCase("de-DE") ?? "";
  const agentId = params.agentId?.toLocaleLowerCase("de-DE") ?? "";
  const evidenceTerms = extractEvidenceTerms(text);
  const mailContextNoun = MAIL_DOMAIN_NOUNS.test(lower);
  const hasEmailAddress = hasEmailEvidence(lower);
  const hasAddressablePersonEvidence = extractEvidenceFromAddressablePersonContext(text).length > 0;
  const hasMailContext =
    mailContextNoun || hasEmailAddress || (hasAddressablePersonEvidence && mailContextNoun);
  const contextHint = channel === "telegram" || agentId === "restaurant";

  const mentionsDraft = /\b(entwurf|draft|vorlage)\b/i.test(lower);
  const mentionsSend = /\b(senden|schicken|versenden|abschicken|absenden|raus)\b/i.test(lower);
  const mentionsDelete =
    /\b(loesch|löschen|lösche|lösch|entfernen|entferne|entfern|delete|entfernung)\b/i.test(lower);
  const mentionsLookup =
    /\b(such|find|nachschau|prüf|pruef|check|lookup|schaue nach|lies|zeigt|zeigen|liegen)\b/i.test(
      lower,
    );
  const mentionsUpdate =
    /(änder\w*|aender\w*|aktualis\w*|korrigier\w*|korrekt\w*|anpass\w*|bearbeit\w*|\bneu\b|update\w*|verschieb\w*)/i.test(
      lower,
    );
  const mentionsReservation =
    /\b(tischreservierung\w*|reservierung\w*|reservier\w*|tisch\w*|buchung\w*|datum|zeit|termin\w*)\b/i.test(
      lower,
    );

  const pronounOnly =
    /\b(sie|ihn|ihr|ihm|jene|jenen|jenes|jemand|jemanden|jemandem|diese)\b/i.test(lower) &&
    !mentionsSend &&
    !mentionsLookup;

  let intent: VoiceIntent = "unknown";

  if (hasMailContext && mentionsDelete && mentionsDraft) {
    intent = "mail.delete_draft";
  } else if (hasMailContext && mentionsSend) {
    intent = "mail.send";
  } else if (hasMailContext && mentionsDraft && mentionsUpdate) {
    intent = "mail.update_draft";
  } else if (hasMailContext && mentionsDraft) {
    intent = "mail.draft";
  } else if (hasMailContext && mentionsLookup) {
    intent = "mail.lookup";
  } else if (mentionsReservation && mentionsUpdate) {
    intent = "reservation.update";
  } else if (contextHint && isPotentialMailTerm(lower)) {
    intent = "mail.lookup";
  }

  const risk: VoiceRisk =
    intent === "mail.send" || intent === "mail.delete_draft"
      ? "high"
      : intent === "mail.draft" || intent === "mail.update_draft" || intent === "reservation.update"
        ? "medium"
        : "low";

  const groundingRequired = intent.startsWith("mail.");
  const missingFields =
    pronounOnly || (intent.startsWith("mail.") && evidenceTerms.length === 0)
      ? ["target_person_or_mail"]
      : [];

  const confidence: VoiceConfidence =
    intent === "unknown" || missingFields.length > 0 ? "low" : risk === "high" ? "medium" : "high";

  const requiresConfirmation =
    risk !== "low" || confidence !== "high" || missingFields.length > 0 || intent === "unknown";

  return {
    intent,
    risk,
    confidence,
    requiresConfirmation,
    groundingRequired,
    missingFields,
    evidenceTerms,
    confirmationHint: buildConfirmationHint({
      intent,
      risk,
      confidence,
      missingFields,
      evidenceTerms,
    }),
  };
}

function isPotentialMailTerm(lowerText: string): boolean {
  return /\b(antwort|anfrage|bewerbung|entwurf|mail|email|e-mail|posteingang)\b/i.test(lowerText);
}

function hasEmailEvidence(text: string): boolean {
  return new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags).test(text);
}

function extractEvidenceTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const value of extractEvidenceFromAddressablePersonContext(text)) {
    terms.add(value);
  }

  for (const match of text.matchAll(/[A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?/g)) {
    const value = match[0];
    if (!EVIDENCE_STOPWORDS.has(value.toLocaleLowerCase("de-DE")) && !isActionVerbToken(value)) {
      terms.add(value);
    }
  }

  for (const match of text.matchAll(EMAIL_PATTERN)) {
    terms.add(match[0]);
  }

  for (const match of text.matchAll(
    /\b(?:heute|gestern|morgen|\d{1,2}[:.]\d{2}|\d{1,2}\.\d{1,2}\.?\d{0,4})\b/gi,
  )) {
    terms.add(match[0]);
  }

  return [...terms].slice(0, 8);
}

function extractEvidenceFromAddressablePersonContext(text: string): string[] {
  return [...text.matchAll(ADDRESS_PREFIX_PATTERN)]
    .map((entry) => normalizePersonCandidate(entry[1] ?? ""))
    .filter((value): value is string => Boolean(value));
}

function normalizePersonCandidate(candidate: string): string | undefined {
  const words = candidate
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-ZÄÖÜa-zäöüß-]/g, ""))
    .filter(Boolean);

  const actionVerbIndex = words.findIndex((word) => isActionVerbToken(word));
  const trimmedWords = actionVerbIndex >= 0 ? words.slice(0, actionVerbIndex) : words;

  if (trimmedWords.length < 1 || trimmedWords.length > 3) {
    return undefined;
  }

  if (trimmedWords.some((word) => EVIDENCE_STOPWORDS.has(word.toLocaleLowerCase("de-DE")))) {
    return undefined;
  }

  return trimmedWords.join(" ");
}

function isActionVerbToken(word: string): boolean {
  const normalized = word.toLocaleLowerCase("de-DE");
  return ACTION_VERB_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function buildConfirmationHint(params: {
  intent: VoiceIntent;
  risk: VoiceRisk;
  confidence: VoiceConfidence;
  missingFields: string[];
  evidenceTerms: string[];
}): string {
  if (params.intent === "unknown") {
    return "Die Sprachnachricht ist nicht eindeutig. Frage kurz nach, was genau getan werden soll.";
  }
  if (params.missingFields.includes("target_person_or_mail")) {
    return "Zielperson oder E-Mail fehlt. Nicht ausführen; erst kurz nachfragen oder Mail Layer anhand des Kontextes durchsuchen.";
  }
  if (params.risk === "high") {
    return "Hochriskante Mail-Aktion. Vor dem Senden oder Löschen erst Mail Layer prüfen und explizit bestätigen lassen.";
  }
  if (params.risk === "medium") {
    return "Entwurf- oder Termin-Aktion. Mail Layer prüfen; erst mit eindeutigem Ziel bestätigen.";
  }
  return "Read-only Aktion. Mail Layer zuerst prüfen und Ergebnis knapp berichten.";
}
