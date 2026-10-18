import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BlobNotFoundError, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

export const IMAGE_STORE = Symbol('IMAGE_STORE');

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** Kept under the API's 4.5 MB body limit even though images never pass through it. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export interface UploadGrant {
  /** Which store issued it; `simulator` is labelled as such on screens. */
  readonly provider: 'vercel_blob' | 'simulator';
  readonly access: 'public';
  readonly pathname: string;
  /** A client token for exactly this pathname. Short-lived; not a secret worth storing. */
  readonly token: string;
  readonly valid_until: string;
}

export interface StoredImage {
  readonly pathname: string;
  readonly url: string;
  readonly contentType: string;
  readonly size: number;
}

/**
 * Where listing images live (P4-7, O-7). The browser uploads straight to the
 * store with a token bound to one pathname, type and size; the API then
 * inspects what arrived before attaching it. The bytes never reach the API.
 */
export interface ImageStore {
  grantUpload(input: {
    pathname: string;
    contentType: ImageType;
    validForSeconds: number;
  }): Promise<UploadGrant>;
  /** What is stored at a pathname, or null if nothing is. */
  inspect(pathname: string): Promise<StoredImage | null>;
}

/** Vercel Blob, public store (vercel.com/docs/vercel-blob, read 2026-10-18; SDK 2.8.0). */
export class VercelBlobImageStore implements ImageStore {
  constructor(private readonly readWriteToken: string) {}

  async grantUpload(input: {
    pathname: string;
    contentType: ImageType;
    validForSeconds: number;
  }): Promise<UploadGrant> {
    const validUntil = Date.now() + input.validForSeconds * 1000;
    const token = await generateClientTokenFromReadWriteToken({
      token: this.readWriteToken,
      pathname: input.pathname,
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes: IMAGE_MAX_BYTES,
      validUntil,
      // The API chose an unguessable pathname already; it must stay exactly that.
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return {
      provider: 'vercel_blob',
      access: 'public',
      pathname: input.pathname,
      token,
      valid_until: new Date(validUntil).toISOString(),
    };
  }

  async inspect(pathname: string): Promise<StoredImage | null> {
    try {
      const blob = await head(pathname, { token: this.readWriteToken });
      return {
        pathname: blob.pathname,
        url: blob.url,
        contentType: blob.contentType,
        size: blob.size,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }
}

/**
 * SANDBOX SIMULATOR for tests and local work: remembers grants and lets a test
 * play the browser's upload. Nothing is stored anywhere real.
 */
@Injectable()
export class SimulatedImageStore implements ImageStore {
  private readonly grants = new Map<
    string,
    { allowedContentTypes: string[]; maximumSizeInBytes: number }
  >();
  private readonly uploads = new Map<string, StoredImage>();

  grantUpload(input: {
    pathname: string;
    contentType: ImageType;
    validForSeconds: number;
  }): Promise<UploadGrant> {
    this.grants.set(input.pathname, {
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes: IMAGE_MAX_BYTES,
    });
    return Promise.resolve({
      provider: 'simulator',
      access: 'public',
      pathname: input.pathname,
      token: `sim_${randomBytes(16).toString('hex')}`,
      valid_until: new Date(Date.now() + input.validForSeconds * 1000).toISOString(),
    });
  }

  inspect(pathname: string): Promise<StoredImage | null> {
    return Promise.resolve(this.uploads.get(pathname) ?? null);
  }

  /** Tests: the constraints a grant carried. */
  constraintsFor(
    pathname: string,
  ): { allowedContentTypes: string[]; maximumSizeInBytes: number } | null {
    return this.grants.get(pathname) ?? null;
  }

  /** Tests: plays the browser uploading to the store. */
  simulateUpload(pathname: string, contentType: string, size: number): void {
    this.uploads.set(pathname, {
      pathname,
      url: `https://sandbox-images.aora.test/${pathname}`,
      contentType,
      size,
    });
  }
}
