import { describe, expect, it } from 'vitest';
import { effectiveRole, isReadOnly, type ChainNode } from './permissions.js';

const ws = 'ws1';
const doc = (grants: ChainNode['grants'] = [], ownerId = 'alice'): ChainNode => ({
  type: 'document',
  id: 'd1',
  ownerId,
  grants,
});
const folder = (id: string, grants: ChainNode['grants'] = [], ownerId = 'alice'): ChainNode => ({
  type: 'folder',
  id,
  ownerId,
  grants,
});

describe('effectiveRole', () => {
  it('owner of doc or ancestor folder is owner', () => {
    expect(
      effectiveRole({ userId: 'alice', workspaceId: ws, workspaceRole: 'editor', chain: [doc()] }),
    ).toBe('owner');
    expect(
      effectiveRole({
        userId: 'bob',
        workspaceId: ws,
        workspaceRole: 'editor',
        chain: [doc(), folder('f1', [], 'bob')],
      }),
    ).toBe('owner');
  });

  it('private by default', () => {
    expect(
      effectiveRole({
        userId: 'bob',
        workspaceId: ws,
        workspaceRole: 'editor',
        chain: [doc(), folder('f1')],
      }),
    ).toBeNull();
    expect(
      effectiveRole({ userId: null, workspaceId: ws, workspaceRole: null, chain: [doc()] }),
    ).toBeNull();
  });

  it('folder grants inherit, nearest grant wins', () => {
    const chain = [
      doc(),
      folder('f2'),
      folder('f1', [{ principalType: 'user', principalId: 'bob', role: 'editor' }]),
    ];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'editor', chain })).toBe(
      'editor',
    );
    const narrowed = [
      doc([{ principalType: 'user', principalId: 'bob', role: 'viewer' }]),
      ...chain.slice(1),
    ];
    expect(
      effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'editor', chain: narrowed }),
    ).toBe('viewer');
  });

  it('workspace grant applies to members only, max across principals', () => {
    const chain = [
      doc([
        { principalType: 'workspace', principalId: ws, role: 'commenter' },
        { principalType: 'user', principalId: 'bob', role: 'viewer' },
      ]),
    ];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'editor', chain })).toBe(
      'commenter',
    );
    expect(
      effectiveRole({ userId: 'carol', workspaceId: ws, workspaceRole: null, chain }),
    ).toBeNull();
  });

  it('share link role combines with own role', () => {
    expect(
      effectiveRole({
        userId: null,
        workspaceId: ws,
        workspaceRole: null,
        chain: [doc()],
        linkRole: 'viewer',
      }),
    ).toBe('viewer');
    const chain = [doc([{ principalType: 'user', principalId: 'bob', role: 'editor' }])];
    expect(
      effectiveRole({
        userId: 'bob',
        workspaceId: ws,
        workspaceRole: 'editor',
        chain,
        linkRole: 'viewer',
      }),
    ).toBe('editor');
  });

  describe('team workspaces', () => {
    const team = { workspaceId: ws, team: true } as const;
    const restricted = (id: string, grants: ChainNode['grants'] = [], ownerId = 'alice') => ({
      ...folder(id, grants, ownerId),
      restricted: true,
    });

    it('members get a baseline from their team role', () => {
      const chain = [doc(), folder('f1')];
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: 'owner', chain })).toBe('owner');
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: 'editor', chain })).toBe(
        'editor',
      );
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: 'viewer', chain })).toBe(
        'commenter',
      );
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: null, chain })).toBeNull();
    });

    it('a workspace grant replaces the baseline for non-owners', () => {
      const chain = [
        doc(),
        folder('f1', [{ principalType: 'workspace', principalId: ws, role: 'viewer' }]),
      ];
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: 'editor', chain })).toBe(
        'viewer',
      );
      expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: 'owner', chain })).toBe('owner');
      // a person's own grant still raises them
      const raised = [doc([{ principalType: 'user', principalId: 'bob', role: 'editor' }]), chain[1]!];
      expect(
        effectiveRole({ ...team, userId: 'bob', workspaceRole: 'viewer', chain: raised }),
      ).toBe('editor');
    });

    it('restricted folders hide their subtree from the team', () => {
      const chain = [doc(), folder('f2'), restricted('f1')];
      for (const r of ['owner', 'editor', 'viewer'] as const)
        expect(effectiveRole({ ...team, userId: 'bob', workspaceRole: r, chain })).toBeNull();
      const granted = [
        doc(),
        folder('f2'),
        restricted('f1', [{ principalType: 'user', principalId: 'bob', role: 'viewer' }]),
      ];
      expect(
        effectiveRole({ ...team, userId: 'bob', workspaceRole: 'owner', chain: granted }),
      ).toBe('viewer');
      expect(effectiveRole({ ...team, userId: 'alice', workspaceRole: 'viewer', chain })).toBe(
        'owner',
      );
      const ws_ = [
        doc(),
        restricted('f1', [{ principalType: 'workspace', principalId: ws, role: 'editor' }]),
      ];
      expect(
        effectiveRole({ ...team, userId: 'bob', workspaceRole: 'editor', chain: ws_ }),
      ).toBeNull();
    });

    it('ownership needs membership', () => {
      expect(
        effectiveRole({ ...team, userId: 'alice', workspaceRole: null, chain: [doc()] }),
      ).toBeNull();
    });
  });

  it('readOnly below editor', () => {
    expect(isReadOnly('commenter')).toBe(true);
    expect(isReadOnly('editor')).toBe(false);
  });
});
