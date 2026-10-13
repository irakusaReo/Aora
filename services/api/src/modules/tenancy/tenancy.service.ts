import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database.js';
import type { Role } from '../../platform/http.js';

/** Workspaces and memberships. The tenant is the workspace. Platform role only. */
@Injectable()
export class TenancyService {
  async createWorkspace(tx: Tx, businessId: string): Promise<string> {
    const workspace = await tx.workspace.create({
      data: { business_id: businessId, product: 'kony' },
    });
    return workspace.id;
  }

  async addMember(tx: Tx, tenantId: string, accountId: string, role: Role): Promise<void> {
    await tx.membership.create({ data: { tenant_id: tenantId, account_id: accountId, role } });
  }
}
