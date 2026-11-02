/** Built-in templates offered under "New from template". English on purpose: they are starting points to edit. */
export interface BuiltinTemplate {
  id: string;
  title: string;
  description: string;
  markdown: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'meeting-notes',
    title: 'Meeting notes',
    description: 'Agenda, notes, action items',
    markdown: `**Date:** [date] · **Attendees:** [names]

## Agenda

- Topic 1
- Topic 2

## Notes

-

## Decisions

-

## Action items

- [ ] [Owner] — [task] — due [date]
`,
  },
  {
    id: 'weekly-report',
    title: 'Weekly report',
    description: 'Done, next week, blockers',
    markdown: `**Week of** [date]

## Highlights

-

## Done this week

- [x]

## Next week

- [ ]

## Risks & blockers

-
`,
  },
  {
    id: 'product-spec',
    title: 'Product spec',
    description: 'Problem, goals, requirements',
    markdown: `**Owner:** [name] · **Status:** Draft · **Last updated:** [date]

## Problem

What problem are we solving, and for whom?

## Goals

-

## Non-goals

-

## User stories

- As a [user], I want [goal] so that [reason].

## Requirements

| Requirement | Priority | Notes |
| --- | --- | --- |
|  | P0 |  |
|  | P1 |  |

## Open questions

- [ ]
`,
  },
  {
    id: 'project-plan',
    title: 'Project plan',
    description: 'Milestones, owners, timeline',
    markdown: `## Overview

One paragraph on what this project delivers and why.

## Milestones

| Milestone | Owner | Date | Status |
| --- | --- | --- | --- |
|  |  |  | Not started |
|  |  |  | Not started |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
|  |  |  |

## Stakeholders

-
`,
  },
  {
    id: 'one-on-one',
    title: '1:1 notes',
    description: 'Running agenda for two',
    markdown: `## [date]

### Talking points

-

### Feedback

-

### Follow-ups

- [ ]
`,
  },
  {
    id: 'retrospective',
    title: 'Retrospective',
    description: 'Went well, to improve, actions',
    markdown: `**Sprint / project:** [name] · **Date:** [date]

## What went well

-

## What could be better

-

## Action items

- [ ] [Owner] — [action]
`,
  },
];
