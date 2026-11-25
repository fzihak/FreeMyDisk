/** Shapes returned by the cleanup-rule scan (`scan_cleanup_rules`). */

export interface RuleScanCandidate {
  path: string;
  size_bytes: number;
  is_dir: boolean;
  rule_id: string;
  rule_name: string;
  category: string;
  risk: string;
  verified_rebuildable: boolean;
  default_action: string;
  protect_subpaths: string[];
}

export interface RuleScanSummary {
  rule_id: string;
  rule_name: string;
  category: string;
  risk: string;
  verified_rebuildable: boolean;
  default_action: string;
  default_selected: boolean;
  total_bytes: number;
  total_items: number;
  candidates: RuleScanCandidate[];
  is_locked_by_process?: boolean;
  locking_process_name?: string;
}
