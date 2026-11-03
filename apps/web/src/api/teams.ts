/* Team workspaces: members, invitations, the join link, moving content between workspaces. */
import { req } from './http';
import type {
  FolderDTO,
  GrantableRole,
  SharingDTO,
  InvitePreviewDTO,
  InviteRole,
  TeamInviteDTO,
  TeamLinkDTO,
  WorkspaceDTO,
  WorkspaceMemberDTO,
  WorkspaceRole,
} from './types';

export interface SentInvite {
  email: string;
  url: string;
  emailed: boolean;
}

export interface MyInvite extends TeamInviteDTO {
  workspace: { id: string; name: string; color: string };
}

export const teams = {
  create: (body: { name: string; color: string; emails: string[] }) =>
    req<{ workspace: WorkspaceDTO; invites: SentInvite[] }>('POST', '/workspaces', body),
  update: (id: string, patch: { name?: string; color?: string }) =>
    req<{ workspace: WorkspaceDTO }>('PATCH', `/workspaces/${id}`, patch),
  remove: (id: string, confirm: string) =>
    req('DELETE', `/workspaces/${id}?confirm=${encodeURIComponent(confirm)}`),
  members: async (id: string) =>
    (await req<{ members: WorkspaceMemberDTO[] }>('GET', `/workspaces/${id}/members`)).members,
  setRole: (id: string, userId: string, role: WorkspaceRole) =>
    req('PATCH', `/workspaces/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => req('DELETE', `/workspaces/${id}/members/${userId}`),
  invites: (id: string) =>
    req<{ invites: TeamInviteDTO[]; link: TeamLinkDTO | null }>('GET', `/workspaces/${id}/invites`),
  invite: async (id: string, emails: string[], role: InviteRole) =>
    (await req<{ invites: SentInvite[] }>('POST', `/workspaces/${id}/invites`, { emails, role })).invites,
  resend: async (id: string, inviteId: string) =>
    (await req<{ invite: SentInvite | null }>('POST', `/workspaces/${id}/invites/${inviteId}/resend`)).invite,
  revoke: (id: string, inviteId: string) => req('DELETE', `/workspaces/${id}/invites/${inviteId}`),
  setLink: async (id: string, patch: { enabled?: boolean; role?: InviteRole }) =>
    (await req<{ link: TeamLinkDTO }>('PATCH', `/workspaces/${id}/link`, patch)).link,
  resetLink: async (id: string) => (await req<{ link: TeamLinkDTO }>('POST', `/workspaces/${id}/link/reset`)).link,
  preview: async (token: string) =>
    (await req<{ invite: InvitePreviewDTO }>('GET', `/invites/${encodeURIComponent(token)}`)).invite,
  accept: async (token: string) =>
    (await req<{ workspace: WorkspaceDTO }>('POST', `/invites/${encodeURIComponent(token)}/accept`)).workspace,
  mine: async () => (await req<{ invites: MyInvite[] }>('GET', '/invites')).invites,
  answer: (inviteId: string, action: 'accept' | 'decline') =>
    req<{ ok: true; workspaceId?: string }>('POST', `/invites/id/${inviteId}/${action}`),
  moveDocument: (id: string, workspaceId: string, folderId: string | null) =>
    req('POST', `/documents/${id}/move`, { workspaceId, folderId }),
  moveFolder: (id: string, workspaceId: string, folderId: string | null) =>
    req('POST', `/folders/${id}/move`, { workspaceId, folderId }),
  setRestricted: (folderId: string, restricted: boolean) =>
    req('PATCH', `/folders/${folderId}`, { restricted }),
  folder: async (id: string) => (await req<{ folder: FolderDTO }>('GET', `/folders/${id}`)).folder,
  folderSharing: (folderId: string) => req<SharingDTO>('GET', `/folders/${folderId}/sharing`),
  addFolderGrant: (folderId: string, email: string, role: GrantableRole) =>
    req('POST', `/folders/${folderId}/grants`, { email, role }),
  /** "Everyone in the team" on a document or folder (remove the grant to go back to team roles). */
  setTeamGrant: (type: 'documents' | 'folders', id: string, role: GrantableRole) =>
    req('POST', `/${type}/${id}/grants`, { workspace: true, role }),
};
