// Response shapes of the AORA API, as documented in docs/api/openapi.yaml.
// Amounts are strings of minor units.

export interface Me {
  account_id: string;
  is_platform_operator: boolean;
  memberships: { workspace_id: string; role: 'admin' | 'finance' | 'cashier' }[];
  phone_set: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  kind: 'registered' | 'unregistered';
  country: string;
  tier: string;
  restrictions: ('payouts_suspended' | 'listing_suspended')[];
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

export interface Settlement {
  id: string;
  currency: string;
  gross_minor: string;
  fee_minor: string;
  net_minor: string;
  collections: number;
  created_at: string;
}

export interface PayoutRecipient {
  id: string;
  label: string;
  rail: string;
  status: 'unconfirmed' | 'confirmed' | 'disabled';
  phone_hint: string;
  confirmed_at: string | null;
  confirmation_proves?: string;
}

export interface Payout {
  id: string;
  status: string;
  recipient_id: string;
  amount_minor: string;
  fee_minor: string;
  total_minor: string;
  currency: string;
  tariff_version_id: string;
  failure_code: string | null;
  receipt: string | null;
  created_at: string;
}

export interface PayoutQuote {
  amount_minor: string;
  fee_minor: string;
  total_minor: string;
  tariff_version_id: string;
  tariff_version: number;
}

// --- KELO (ADR 0017) ---

export interface KeloCategory {
  slug: string;
  name: string;
  version: number;
  listing_types: KeloListingType[];
  restricted: boolean;
}

export type KeloListingType = 'stock_item' | 'scheduled_service' | 'quote_service';
export type KeloListingStatus = 'draft' | 'in_review' | 'published' | 'rejected' | 'suspended';

export interface KeloStore {
  id: string;
  status: 'submitted' | 'approved' | 'rejected';
  display_name: string;
  categories: string[];
  workspace_id: string | null;
  provisioning_status: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeloStoreForVetting extends Omit<KeloStore, 'categories'> {
  applicant_account_id: string;
  business: { kind: string | null; name: string | null; country: string | null };
  existing_workspace_id: string | null;
  verification: string | null;
  restrictions: string[];
  categories: { slug: string; name: string; version: number; requirements: string[] }[];
}

export interface KeloWorkspaceStore {
  store: {
    id: string;
    display_name: string;
    categories: { slug: string; name: string; listing_types: KeloListingType[] }[];
  } | null;
}

export interface KeloProvisioning {
  id: string;
  store_id: string;
  status: string;
  last_step: string;
  reason: string | null;
  business_id: string | null;
  workspace_id: string | null;
  attempts: number;
  updated_at: string;
}

export interface KeloListing {
  id: string;
  status: KeloListingStatus;
  category: string;
  type: KeloListingType;
  title: string;
  description: string;
  currency: string;
  revision: number;
  variants: {
    id: string;
    name: string;
    price_minor: string;
    stock_on_hand: number;
    stock_reserved: number;
  }[];
  sessions: {
    id: string;
    starts_at: string;
    price_minor: string;
    capacity: number;
    reserved: number;
  }[];
  images: { id: string; url: string; content_type: string; size_bytes: number }[];
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeloUploadGrant {
  provider: 'vercel_blob' | 'simulator';
  access: 'public';
  pathname: string;
  token: string;
  valid_until: string;
}

export interface KeloListingSummary {
  id: string;
  title: string;
  category: string;
  type: KeloListingType;
  currency: string;
  store_name: string;
  from_price_minor: string | null;
  image_url: string | null;
}

export interface KeloPublicListing {
  id: string;
  title: string;
  description: string;
  category: string;
  type: KeloListingType;
  currency: string;
  store: { display_name: string };
  from_price_minor: string | null;
  variants: { id: string; name: string; price_minor: string; in_stock: boolean }[];
  sessions: { id: string; starts_at: string; price_minor: string; available: boolean }[];
  images: { url: string }[];
}

export interface KeloPlan {
  template_key: string;
  name: string;
  plan_type: 'layaway';
  instalments: { seq: number; due_on: string; amount_minor: string }[];
  total_minor: string;
  fees_minor: string;
  currency: string;
  receive_after_last_payment: true;
  cancellation: { fee_bps: number; fee_cap_minor: string; after_start_returned_bps: number };
  terms: { key: string; version: string };
}

export interface KeloPurchase {
  id: string;
  status:
    'placed' | 'payment_ready' | 'merchant_confirmed' | 'fulfilled' | 'completed' | 'cancelled';
  plan_status: 'active' | 'paid_in_full' | 'settled' | 'cancelled' | 'refunded';
  plan_type: 'layaway';
  listing_id: string;
  listing_title: string;
  total_minor: string;
  paid_minor: string;
  currency: string;
  receive_after_last_payment: true;
  instalments: {
    seq: number;
    due_on: string;
    amount_minor: string;
    status: 'due' | 'pending' | 'paid' | 'cancelled';
  }[];
  refund: { paid_minor: string; fee_minor: string; refund_minor: string; status: string } | null;
  created_at: string;
}

export interface KeloMerchantPurchase {
  id: string;
  status: KeloPurchase['status'];
  plan_status: KeloPurchase['plan_status'];
  listing_title: string;
  total_minor: string;
  paid_minor: string;
  merchant_fee_minor: string;
  net_minor: string;
  currency: string;
  next_action: 'wait_for_payments' | 'confirm' | 'fulfil' | 'wait_for_buyer' | 'none';
  created_at: string;
}

export interface KeloPlanOption {
  template_key: string;
  name: string;
  plan_type: string;
  instalment_count: number;
  interval_days: number;
  merchant_fee_bps: number;
  offered: boolean;
}
