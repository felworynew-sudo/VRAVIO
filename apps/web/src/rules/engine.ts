/**
 * The rules engine (stage 6 of docs/migration-plan.md).
 *
 * A rule is a file that gets a chance to change or refuse an edit before it
 * lands. The engine itself knows nothing about pixels, layers or selections:
 * it orders the rules, hands each the edit, and carries a veto back. What an
 * "edit" is belongs to the environment that defines one — raster's lives in
 * `environments/raster/rules/`.
 *
 * Why an engine at all, when four of the first rules already existed as
 * ordinary code: they existed in four different places, each enforced by
 * whoever remembered to. Section 4.4 of the plan records what that costs —
 * a rule with one checkpoint is a rule until the first caller that skips it.
 */

export interface Rule<TEdit, TContext> {
  /** Stable id, used in diagnostics when this rule is the one that refused. */
  readonly id: string;
  /**
   * Where in the sequence this rule runs. Application is deterministic and
   * must stay that way: two rules that both rewrite an edit produce different
   * results in different orders, and a bug that depends on registration order
   * is a bug that moves when a file is renamed.
   */
  readonly order: number;
  /** Whether this rule has anything to say about this edit at all. */
  applies(edit: TEdit, context: TContext): boolean;
  /** The edit as this rule would have it, or `null` to refuse it outright. */
  transform(edit: TEdit, context: TContext): TEdit | null;
}

export interface RuleOutcome<TEdit> {
  /** The edit after every applicable rule has had it, or `null` if refused. */
  readonly edit: TEdit | null;
  /** Which rule refused it, for the message the user sees. */
  readonly vetoedBy: string | null;
}

/**
 * Runs the rules over one edit, in `order`, stopping at the first veto.
 *
 * Each rule receives what the previous one produced, not the original: rules
 * compose, so "confine to the selection" and "do not touch transparent
 * pixels" both hold at the end rather than the last one winning.
 */
export function applyRules<TEdit, TContext>(
  rules: readonly Rule<TEdit, TContext>[],
  edit: TEdit,
  context: TContext,
): RuleOutcome<TEdit> {
  let current = edit;
  for (const rule of [...rules].sort((a, b) => a.order - b.order)) {
    if (!rule.applies(current, context)) continue;
    const next = rule.transform(current, context);
    if (next === null) return { edit: null, vetoedBy: rule.id };
    current = next;
  }
  return { edit: current, vetoedBy: null };
}
