import type { KeloListingStatus, KeloListingType } from '@aora/api-client';

// Labels for the KELO section, kept in one place so they can be translated
// (kelo-experience.md §4): whole phrases, no sentence built from fragments.

export const LISTING_TYPE: Record<KeloListingType, string> = {
  stock_item: 'Item with stock',
  scheduled_service: 'Dated service',
  quote_service: 'Service by quote',
};

export const LISTING_STATUS: Record<KeloListingStatus, string> = {
  draft: 'Draft',
  in_review: 'Waiting for review',
  published: 'Live on KELO',
  rejected: 'Not approved',
  suspended: 'Suspended',
};
