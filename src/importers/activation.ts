/** What is known about the workspace before an import is written, to decide whether the environment that came with it may take over. */
export interface ActivationFacts {
  /** Whether an environment is the active one already. */
  hasActive: boolean;
  /** How many collections the workspace had before the import. */
  collectionsBefore: number;
  /** The names of the variables of the whole workspace. */
  workspaceVariables: readonly string[];
  /** The names of the variables of the environment that would be activated. */
  environmentVariables: readonly string[];
}

/**
 * Requests that use `{{baseUrl}}` send nothing useful until an environment is the active one, so the first environment of an import is made the active one
 * when it can harm no one: nothing is active, the workspace had no collection that the environment could redirect (an active environment comes before the
 * variables of the workspace and a `.env` file, so the `{{baseUrl}}` and the token of every other collection would go to the host of the description),
 * and none of its variables hides a variable of the whole workspace. In every other case the person chooses it.
 */
export function mayActivateEnvironment(facts: ActivationFacts): boolean {
  if (facts.hasActive || facts.collectionsBefore > 0) return false;
  const workspace = new Set(facts.workspaceVariables);
  return !facts.environmentVariables.some(name => workspace.has(name));
}
