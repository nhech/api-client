import { finding } from '../model/findings';
import type { Finding, FindingCode, Severity } from '../model/findings';

/**
 * Collects findings during normalisation and keeps a report readable: after `cap` findings of one code in one scope, the
 * rest are counted and become a single "and N more" finding in `flush()`. The findings kept are the first ones in the
 * deterministic order the caller adds them in, so which ones appear never depends on the order of the input.
 */
export class FindingSink {
  readonly findings: Finding[] = [];
  private readonly counts = new Map<FindingCode, Map<string, number>>();

  constructor(private readonly cap = 20) {}

  add(scope: string, code: FindingCode, where: string, message?: string, severity?: Severity): void {
    const byScope = this.counts.get(code) ?? new Map<string, number>();
    this.counts.set(code, byScope);
    const seen = (byScope.get(scope) ?? 0) + 1;
    byScope.set(scope, seen);
    if (seen <= this.cap) this.findings.push(finding(code, where, message, severity));
  }

  /** Adds the summary findings for what went over the cap and returns every finding. */
  flush(): Finding[] {
    for (const [code, byScope] of this.counts) {
      for (const [scope, seen] of byScope) {
        if (seen > this.cap) this.findings.push(finding(code, scope, `${seen - this.cap} more like the ones above were found here.`));
      }
    }
    this.counts.clear();
    return this.findings;
  }
}
