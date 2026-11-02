import { describe, expect, it } from 'vitest';
import { effectiveRole, isReadOnly, type ChainNode } from './permissions.js';

const ws = 'ws1';
const doc = (grants: ChainNode['grants'] = [], ownerId = 'alice'): ChainNode => ({
  type: 'document', id: 'd1', ownerId, grants,
});
const folder = (id: string, grants: ChainNode['grants'] = [], ownerId = 'alice'): ChainNode => ({
  type: 'folder', id, ownerId, grants,
});

describe('effectiveRole', () => {
  it('owner of doc or ancestor folder is owner', () => {
    expect(effectiveRole({ userId: 'alice', workspaceId: ws, workspaceRole: 'member', chain: [doc()] })).toBe('owner');
    expect(
      effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain: [doc(), folder('f1', [], 'bob')] }),
    ).toBe('owner');
  });

  it('private by default', () => {
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain: [doc(), folder('f1')] })).toBeNull();
    expect(effectiveRole({ userId: null, workspaceId: ws, workspaceRole: null, chain: [doc()] })).toBeNull();
  });

  it('folder grants inherit, nearest grant wins', () => {
    const chain = [doc(), folder('f2'), folder('f1', [{ principalType: 'user', principalId: 'bob', role: 'editor' }])];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain })).toBe('editor');
    const narrowed = [doc([{ principalType: 'user', principalId: 'bob', role: 'viewer' }]), ...chain.slice(1)];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain: narrowed })).toBe('viewer');
  });

  it('workspace grant applies to members only, max across principals', () => {
    const chain = [
      doc([
        { principalType: 'workspace', principalId: ws, role: 'commenter' },
        { principalType: 'user', principalId: 'bob', role: 'viewer' },
      ]),
    ];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain })).toBe('commenter');
    expect(effectiveRole({ userId: 'carol', workspaceId: ws, workspaceRole: null, chain })).toBeNull();
  });

  it('share link role combines with own role', () => {
    expect(effectiveRole({ userId: null, workspaceId: ws, workspaceRole: null, chain: [doc()], linkRole: 'viewer' })).toBe('viewer');
    const chain = [doc([{ principalType: 'user', principalId: 'bob', role: 'editor' }])];
    expect(effectiveRole({ userId: 'bob', workspaceId: ws, workspaceRole: 'member', chain, linkRole: 'viewer' })).toBe('editor');
  });

  it('readOnly below editor', () => {
    expect(isReadOnly('commenter')).toBe(true);
    expect(isReadOnly('editor')).toBe(false);
  });
});
