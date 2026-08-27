/** A rule with actions and no conditions is a valid one-shot startup rule. */
export function shouldKeepRule(conditions = [], actions = []) {
  return actions.length > 0;
}
