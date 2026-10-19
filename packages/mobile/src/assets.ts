import type { List } from '@aora/api-client';
import { type Resource, useResource } from './resource';

export interface Asset {
  code: string;
  exponent: number;
}

/** The API's asset list: the only source of an amount's exponent (CLAUDE.md rule 3). */
export function useAssets(): Resource<List<Asset>> {
  return useResource('assets', (api) => api.get<List<Asset>>('/v1/assets'));
}

export function exponentOf(assets: List<Asset>, code: string): number {
  const asset = assets.data.find((entry) => entry.code === code);
  if (!asset) throw new Error(`Unknown asset ${code}`);
  return asset.exponent;
}
