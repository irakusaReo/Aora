import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceHomeScreen } from '../src/screens/workspace-home';
import { WorkspacesScreen } from '../src/screens/workspaces';
import { me, routes, workspace, WS } from './fixtures';

describe('workspaces', () => {
  it('lists workspaces by name and opens one', async () => {
    const go = vi.fn();
    const api = fakeApi(
      routes('finance', ({ path }) => (path === '/v1/me/invitations' ? { data: [] } : undefined)),
    );
    renderWith(services(api), <WorkspacesScreen go={go} />);
    fireEvent.click(await screen.findByText(workspace.name));
    expect(go).toHaveBeenCalledWith(`/w/${WS}`);
  });

  it('asks for the phone number when it is missing', async () => {
    const api = fakeApi((call) => {
      if (call.path === '/v1/me') return me('admin', false);
      if (call.path === '/v1/me/invitations') return { data: [] };
      return routes('admin')(call);
    });
    renderWith(services(api), <WorkspacesScreen go={vi.fn()} />);
    expect(await screen.findByText(/Add your phone number/)).toBeTruthy();
  });

  it('accepts an invitation explicitly', async () => {
    let accepted = false;
    const api = fakeApi(
      routes('admin', ({ method, path }) => {
        if (path === '/v1/me/invitations')
          return accepted
            ? { data: [] }
            : {
                data: [
                  {
                    id: 'inv_1',
                    workspace_id: 'w2',
                    workspace_name: 'Duka',
                    role: 'cashier',
                    expires_at: '2026-10-26T00:00:00Z',
                  },
                ],
              };
        if (method === 'POST' && path === '/v1/me/invitations/inv_1/accept') {
          accepted = true;
          return { workspace_id: 'w2', role: 'cashier', mode: 'sandbox' };
        }
        throw new Error(`unexpected ${path}`);
      }),
    );
    renderWith(services(api), <WorkspacesScreen go={vi.fn()} />);
    fireEvent.click(await screen.findByText('Accept invitation'));
    await waitFor(() => {
      expect(accepted).toBe(true);
    });
  });
});

describe('workspace menu', () => {
  it('shows a cashier only collecting (the API still decides)', async () => {
    renderWith(
      services(fakeApi(routes('cashier'))),
      <WorkspaceHomeScreen workspaceId={WS} go={vi.fn()} />,
    );
    await screen.findByText('Collect a payment');
    expect(screen.queryByText('Pay out')).toBeNull();
    expect(screen.queryByText('USDC treasury')).toBeNull();
  });

  it('shows finance the money screens', async () => {
    renderWith(
      services(fakeApi(routes('finance'))),
      <WorkspaceHomeScreen workspaceId={WS} go={vi.fn()} />,
    );
    expect(await screen.findByText('Pay out')).toBeTruthy();
    expect(screen.getByText('USDC treasury')).toBeTruthy();
  });

  it('sends every workspace request with the workspace header', async () => {
    const api = fakeApi(routes('finance'));
    const seen: (string | undefined)[] = [];
    const scoped = fakeApi((call) => {
      seen.push(call.workspaceId);
      return routes('finance')(call);
    });
    renderWith(
      services(api, undefined, {
        api: (workspaceId) => Promise.resolve(workspaceId ? scoped.forWorkspace(workspaceId) : api),
      }),
      <WorkspaceHomeScreen workspaceId={WS} go={vi.fn()} />,
    );
    await screen.findByText('Pay out');
    expect(seen).toContain(WS);
  });
});
