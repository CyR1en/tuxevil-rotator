// Effort levels and alias rules shared by the effort router and the dashboard's editor.
// Keep this module free of imports: the browser bundle uses it too.

/** Standard effort levels, lowest first. Custom level names sort after these. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * How an Anthropic Messages request without `output_config.effort` picks a
 * level from `thinking.budget_tokens`: the first bucket whose bound the budget
 * is below. Claude Code's "think" (4,000) lands on medium and "ultrathink"
 * (31,999) on high.
 */
export const CLAUDE_THINKING_BUDGET_EFFORTS: ReadonlyArray<{ below: number; effort: string }> = [
  { below: 4_000, effort: "low" },
  { below: 16_000, effort: "medium" },
  { below: Number.POSITIVE_INFINITY, effort: "high" },
];

/** Level an Anthropic Messages request with `thinking: { type: "disabled" }` asks for. */
export const CLAUDE_THINKING_DISABLED_EFFORT = "low";

/** Standard levels first, in order, then custom names in their given order. */
export function orderEffortLevels(levels: Iterable<string>): string[] {
  const all = [...levels];
  const standard: readonly string[] = EFFORT_LEVELS;
  return [
    ...EFFORT_LEVELS.filter((level) => all.includes(level)),
    ...all.filter((level) => !standard.includes(level)),
  ];
}

/**
 * Why `alias` can never name an effort route, or null. The compatibility
 * endpoints answer `auto` with automatic model selection before effort routing
 * runs, and browsers resolve `.` and `..` out of the dashboard's URLs, so such
 * a route could neither serve requests nor be edited.
 */
export function reservedEffortAlias(alias: string): string | null {
  const id = alias.trim();
  if (id.toLowerCase() === "auto") return `${id} is reserved for automatic model selection. Pick another ID.`;
  if (id === "." || id === "..") return `“${id}” can't be a model ID. Pick another one.`;
  return null;
}
