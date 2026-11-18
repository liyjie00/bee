import { createContext, useContext } from 'react';
import type { TicketDTO, TicketFilter, TicketType } from '@bee/shared';
import type { TicketPatch } from '../api/tickets';
import type { ProjectData } from './useProject';

export interface ProjectCtx extends ProjectData {
  filter: TicketFilter;
  /** tickets passing the filter bar */
  visible: TicketDTO[];
  openTicket(id: string): void;
  /** changes status, asking for a resolution when the status needs one */
  move(id: string, statusId: string, extra?: TicketPatch): void;
  newTicket(defaults?: TicketPatch): void;
  selected: Set<string>;
  setSelected(s: Set<string>): void;
  /** creates a ticket from an inline row */
  createQuick(p: TicketPatch & { title: string; type: TicketType }): Promise<void>;
}

export const ProjectContext = createContext<ProjectCtx | null>(null);
export const useProjectCtx = () => useContext(ProjectContext)!;
