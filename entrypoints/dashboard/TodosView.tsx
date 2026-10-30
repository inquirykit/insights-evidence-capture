// The case's to-do list (#/<case>/todos): what is left to check, ask for or follow up. The
// server keeps it beside the case like tags and notes, never in a signed record. Open todos
// come first in the list's order; done ones after, the latest done first.

import { ListTodo, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { MAX_TODO } from '@/lib/limits';
import { errorMessage, type Todo, type TodoChange } from '@/lib/protocol';

import type { CaseData } from './data';
import { fmtDay, fmtTime, plural } from './ui';

export default function TodosView({ data, query }: { data: CaseData; query: string }) {
  const [text, setText] = useState('');
  // The todo whose text is being edited
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (fn: (todos: TodoChange[]) => TodoChange[]) => {
    setError(null);
    try {
      await data.changeTodos(fn);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const update = (id: string, patch: Partial<TodoChange>) =>
    void change((todos) => todos.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const remove = (id: string) => void change((todos) => todos.filter((t) => t.id !== id));

  // The field is cleared at once, so the next todo can be typed while this one is saved.
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (!(await change((todos) => [...todos, { text: t, done: false }]))) setText((now) => now || t);
  };

  if (!data.todos) {
    return data.todosError ? (
      <div className="empty">
        <TriangleAlert />
        <strong>Could not load the to-do list</strong>
        <span className="error small">{data.todosError}</span>
      </div>
    ) : (
      <div className="todos-wrap">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 40, marginBottom: 8 }} />
        ))}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? data.todos.filter((t) => t.text.toLowerCase().includes(q)) : data.todos;
  const open = shown.filter((t) => !t.done);
  const done = shown
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  const allDone = data.todos.filter((t) => t.done).length;
  const clearDone = () => {
    if (confirm(`Delete ${plural(allDone, 'done todo')}? They cannot be brought back.`))
      void change((todos) => todos.filter((t) => !t.done));
  };
  const row = (t: Todo) => (
    <TodoRow
      key={t.id}
      todo={t}
      editing={editing === t.id}
      onEdit={() => setEditing(t.id)}
      onEdited={(next) => {
        setEditing(null);
        if (next && next !== t.text) update(t.id, { text: next });
      }}
      onToggle={() => update(t.id, { done: !t.done })}
      onDelete={() => remove(t.id)}
    />
  );

  return (
    <div className="todos-wrap">
      <div className="todo-add">
        <Plus />
        <input
          placeholder="Add a todo, then Enter"
          aria-label="New todo"
          maxLength={MAX_TODO}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
      </div>
      {error && <p className="error small">{error}</p>}

      {data.todos.length === 0 ? (
        <div className="empty">
          <ListTodo />
          <strong>Nothing to do yet</strong>
          <span className="small">
            Note what is left to check, ask for or follow up in this case. Todos are kept beside the
            case, never in a signed record.
          </span>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted">No todo matches "{query.trim()}".</p>
      ) : (
        <>
          {open.length > 0 ? (
            <ul className="todos">{open.map(row)}</ul>
          ) : (
            !q && <p className="muted todos-clear">All done.</p>
          )}
          {done.length > 0 && (
            <>
              <div className="todo-section">
                <h3>Done · {done.length.toLocaleString()}</h3>
                <button className="link small" onClick={clearDone}>
                  Clear done
                </button>
              </div>
              <ul className="todos">{done.map(row)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function TodoRow(props: {
  todo: Todo;
  editing: boolean;
  onEdit: () => void;
  /** The new text, trimmed; empty or unchanged leaves the todo as it is */
  onEdited: (text: string) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { todo: t } = props;
  const history = [
    `Added ${fmtTime(t.createdAt)}`,
    t.updatedAt && `edited ${fmtTime(t.updatedAt)}`,
    t.doneAt && `done ${fmtTime(t.doneAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={t.done ? 'todo-done' : undefined}>
      <input type="checkbox" checked={t.done} onChange={props.onToggle} aria-label={t.text} />
      {props.editing ? (
        <input
          className="todo-edit"
          autoFocus
          aria-label="Todo text"
          maxLength={MAX_TODO}
          defaultValue={t.text}
          onBlur={(e) => props.onEdited(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = t.text;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className="todo-text">{t.text}</span>
      )}
      <span className="todo-meta" title={history}>
        {t.done && t.doneAt ? `done ${fmtDay(t.doneAt)}` : fmtDay(t.createdAt)}
      </span>
      <span className="todo-actions">
        <button className="ghost icon" title="Edit" aria-label="Edit todo" onClick={props.onEdit}>
          <Pencil />
        </button>
        <button className="ghost icon danger" title="Delete" aria-label="Delete todo" onClick={props.onDelete}>
          <Trash2 />
        </button>
      </span>
    </li>
  );
}
