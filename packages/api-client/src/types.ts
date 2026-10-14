// Response shapes of the AORA API, as documented in docs/api/openapi.yaml.
// Amounts are strings of minor units.

export interface Me {
  account_id: string;
  is_platform_operator: boolean;
  memberships: { workspace_id: string; role: 'admin' | 'finance' | 'cashier' }[];
}

export interface Workspace {
  id: string;
  name: string;
  kind: 'registered' | 'unregistered';
  country: string;
  tier: string;
  limits: {
    currency: string;
    per_transaction_max_minor: string;
    daily_collection_max_minor: string;
    daily_payout_max_minor: string;
  }[];
}

export interface PaymentIntent {
  id: string;
  status: string;
  amount_minor: string;
  fee_minor: string;
  net_minor: string;
  tariff_version_id: string | null;
  currency: string;
  rail: string;
  branch_id: string | null;
  reference: string | null;
  provider: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface Quote {
  amount_minor: string;
  fee_minor: string;
  net_minor: string;
  tariff_version_id: string;
  tariff_version: number;
}

export interface Branch {
  id: string;
  name: string;
  status: 'active' | 'closed';
  created_at: string;
}

export interface Member {
  id: string;
  account_id: string;
  role: string;
  status: string;
  branch_id: string | null;
  display_name: string | null;
  email_masked: string;
  phone_hint: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  branch_id: string | null;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface MyInvitation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  role: string;
  expires_at: string;
}

export interface Application {
  id: string;
  status: 'submitted' | 'needs_review' | 'approved' | 'rejected';
  kind: string;
  name: string;
  country: string;
  workspace_id: string | null;
  decision_reason: string | null;
  created_at: string;
}

export interface ReviewItem extends Application {
  rule: string;
  matched_business_id: string | null;
  applicant_account_id: string;
}

export interface ReconciliationException {
  id: string;
  type: string;
  status: 'open' | 'resolved';
  workspace_id: string | null;
  subject_type: string;
  subject_ref: string;
  detail: unknown;
  created_at: string;
  resolution: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
}

export interface Balance {
  account_type: string;
  currency: string;
  balance_minor: string;
}

export interface AuditEvent {
  id: string;
  occurred_at: string;
  workspace_id: string | null;
  actor_kind: string;
  action: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
}

export interface List<T> {
  data: T[];
  next_cursor?: string | null;
}
