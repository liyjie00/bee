import { Extension, InputRule } from '@tiptap/core';

/**
 * Markdown-style "- [ ] " in a bullet list: the "- " already made a bullet item, so typing "[ ] "
 * (or "[x] ") at its start converts the list to a task list instead of nesting one.
 */
export const TaskListShortcuts = Extension.create({
  name: 'beeTaskListShortcuts',
  priority: 1000,

  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.depth < 2 || $from.node(-1).type.name !== 'listItem') return null;
          const checked = (match[1] ?? '').toLowerCase() === 'x';
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .command(({ tr }) => {
              if (!checked) return true;
              // The cursor stays inside the converted item.
              const $pos = tr.selection.$from;
              for (let d = $pos.depth; d > 0; d--) {
                if ($pos.node(d).type.name === 'taskItem') {
                  tr.setNodeAttribute($pos.before(d), 'checked', true);
                  break;
                }
              }
              return true;
            })
            .run();
        },
      }),
    ];
  },
});
