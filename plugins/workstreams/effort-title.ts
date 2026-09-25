// Shared by the confirmation preview and thread creation. No model call or
// persisted emoji is needed: the same effort name always produces the same title.
const TOPICS: readonly [RegExp, string][] = [
  [/\b(?:ci|builds?|pipelines?)\b/iu, "🚦"],
  [/\b(?:security|auth|authentication|permissions?|credentials?)\b/iu, "🔐"],
  [/\b(?:billing|payments?|invoices?|pricing|discounts?|checkout)\b/iu, "💳"],
  [/\b(?:insurance|eligibility|coverage|claims?)\b/iu, "🛡️"],
  [/\b(?:questionnaires?|surveys?|forms?|intake)\b/iu, "📝"],
  [/\b(?:releases?|deployments?|deploy|ota|rollout)\b/iu, "🚀"],
  [/\b(?:migrations?|schema|database|data)\b/iu, "🗃️"],
  [/\b(?:performance|cach(?:e|es|ing)|speed|latency)\b/iu, "⚡"],
  [/\b(?:email|notifications?|messaging|reminders?)\b/iu, "📬"],
  [/\b(?:search|discovery|indexing)\b/iu, "🔎"],
  [/\b(?:review|reviews|approval|approvals)\b/iu, "🔍"],
  [/\b(?:design|layout|styling|typography|ui)\b/iu, "🎨"],
];
const FALLBACKS = ["🪁", "🧩", "🧶", "🛠️", "🪴", "🛰️", "🪄", "🧭"] as const;
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

export function effortTitle(name: string): string {
  const trimmed = name.trim();
  if (LEADING_EMOJI.test(trimmed)) return trimmed;
  const topic = TOPICS.find(([pattern]) => pattern.test(trimmed));
  let hash = 2166136261;
  for (const character of trimmed.toLowerCase()) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return `${topic?.[1] ?? FALLBACKS[(hash >>> 0) % FALLBACKS.length]} ${trimmed}`;
}
