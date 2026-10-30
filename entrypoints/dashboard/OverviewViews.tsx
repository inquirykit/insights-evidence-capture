// Views across the cases: every case side by side (#/~cases) and every tag (#/~tags), where
// tags get their colour and icon and are renamed or deleted on every page that has them.

import { Folder, Pencil, Plus, Tag, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { TagChip, TagStylePicker, useTagDefs } from '@/components/tags';
import { routeHash } from '@/lib/dashboard';
import { MAX_TAG, normalizeTag } from '@/lib/limits';
import { errorMessage, mergeTags, sendToBackground, type Annotation, type Case } from '@/lib/protocol';
import { defaultColor, defOf, tagKey, type TagDef, type TagDefs } from '@/lib/tags';

import type { CaseOverview, Overview } from './data';
import { fmtDay, fmtTime, hostOf, plural } from './ui';

// Tags shown in a case's row; the rest are counted.
const ROW_TAGS = 5;

interface TagUse {
  name: string;
  pages: number;
  /** Pages with the tag, by case */
  byCase: Map<string, number>;
}

/** Every tag on a page in the cases, by tagKey, in the spelling first met. */
function tagUses(byCase: Overview['byCase']): Map<string, TagUse> {
  const uses = new Map<string, TagUse>();
  for (const [caseId, entry] of byCase) {
    for (const a of entry.annotations ?? []) {
      for (const tag of a.tags) {
        const key = tagKey(tag);
        const use = uses.get(key) ?? { name: tag, pages: 0, byCase: new Map<string, number>() };
        use.pages++;
        use.byCase.set(caseId, (use.byCase.get(caseId) ?? 0) + 1);
        uses.set(key, use);
      }
    }
  }
  return uses;
}

function failures(overview: Overview): string | null {
  const errors = [...overview.byCase.values()].map((e) => e.error).filter(Boolean);
  return errors.length ? `${plural(errors.length, 'case')} could not be loaded: ${errors[0]}` : null;
}

// ---------------------------------------------------------------------------

export function CasesView(props: { cases: Case[]; overview: Overview; onCreated: (c: Case) => void }) {
  const { overview } = props;
  const [defs] = useTagDefs();
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name?.trim()) return;
    try {
      props.onCreated(await sendToBackground({ type: 'createCase', name: name.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const entries = [...overview.byCase.values()];
  const pages = entries.reduce((n, e) => n + (e.captures?.length ?? 0), 0);
  const loading = entries.some((e) => !e.captures);
  const problem = failures(overview);

  return (
    <>
      <header className="case-header overview-header">
        <div>
          <h1>Cases</h1>
          <p className="muted">
            {plural(props.cases.length, 'case')}
            {!loading && ` · ${plural(pages, 'page')}`}
          </p>
        </div>
        <button aria-pressed={name !== null} onClick={() => setName(name === null ? '' : null)}>
          <Plus />
          New case
        </button>
      </header>

      {name !== null && (
        <div className="inline-form rise">
          <input
            autoFocus
            placeholder="New case name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => (e.key === 'Enter' ? create() : e.key === 'Escape' && setName(null))}
          />
          <button className="primary" disabled={!name.trim()} onClick={create}>
            Create
          </button>
          <button onClick={() => setName(null)}>Cancel</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {problem && (
        <p className="warn small">
          <TriangleAlert /> {problem}
        </p>
      )}

      <table className="table overview">
        <thead>
          <tr>
            <th>Case</th>
            <th className="num">Pages</th>
            <th className="num">Sites</th>
            <th className="num">Todos</th>
            <th>Tags</th>
            <th>Last capture</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {props.cases.map((c) => (
            <CaseRow key={c.id} item={c} entry={overview.byCase.get(c.id)} defs={defs} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function CaseRow(props: { item: Case; entry?: CaseOverview; defs: TagDefs }) {
  const { item: c, entry } = props;
  const captures = entry?.captures;
  const tags = useMemo(() => {
    const counts = new Map<string, { tag: string; pages: number }>();
    for (const a of entry?.annotations ?? []) {
      for (const tag of a.tags) {
        const known = counts.get(tagKey(tag));
        if (known) known.pages++;
        else counts.set(tagKey(tag), { tag, pages: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.pages - a.pages || a.tag.localeCompare(b.tag));
  }, [entry?.annotations]);
  const sites = new Set(captures?.map((x) => hostOf(x.url)).filter(Boolean)).size;
  const loadingCell = <span className="skeleton" style={{ display: 'inline-block', width: 24, height: 14 }} />;
  const cell = (value: number) => (captures ? value.toLocaleString() : loadingCell);
  const todos = entry?.todos;
  const openTodos = todos?.filter((t) => !t.done).length ?? 0;

  return (
    <tr>
      <td>
        <a className="case-name" href={routeHash({ caseId: c.id, view: 'pages' })}>
          <Folder />
          {c.name}
        </a>
      </td>
      <td className="num">{cell(captures?.length ?? 0)}</td>
      <td className="num">{cell(sites)}</td>
      <td className="num">
        {!todos ? (
          loadingCell
        ) : todos.length ? (
          <a
            href={routeHash({ caseId: c.id, view: 'todos' })}
            title={`${plural(openTodos, 'open todo')} of ${todos.length.toLocaleString()}`}
          >
            {openTodos.toLocaleString()}
          </a>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
      <td>
        <div className="tags">
          {tags.slice(0, ROW_TAGS).map(({ tag, pages }) => (
            <a
              key={tag}
              className="tag-link"
              href={routeHash({ caseId: c.id, view: 'pages', tag })}
              title={`${plural(pages, 'page')} tagged "${tag}"`}
            >
              <TagChip tag={tag} defs={props.defs} />
            </a>
          ))}
          {tags.length > ROW_TAGS && <span className="muted small">+{tags.length - ROW_TAGS}</span>}
        </div>
      </td>
      <td className="nowrap muted">{captures?.[0] ? fmtTime(captures[0].receivedAt) : captures ? '–' : ''}</td>
      <td className="nowrap muted">{fmtDay(c.createdAt)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

interface TagRow {
  key: string;
  name: string;
  pages: number;
  byCase: Map<string, number>;
}

export function TagsView(props: { cases: Case[]; overview: Overview }) {
  const { overview } = props;
  const [defs, saveDefs] = useTagDefs();
  // The tag being edited, by key; '' for a new one
  const [editing, setEditing] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const uses = useMemo(() => tagUses(overview.byCase), [overview.byCase]);
  const rows: TagRow[] = useMemo(
    () =>
      [...new Set([...uses.keys(), ...Object.keys(defs)])]
        .map((key) => {
          const use = uses.get(key);
          return {
            key,
            name: defs[key]?.name ?? use!.name,
            pages: use?.pages ?? 0,
            byCase: use?.byCase ?? new Map<string, number>(),
          };
        })
        .sort((a, b) => b.pages - a.pages || a.name.localeCompare(b.name)),
    [uses, defs],
  );
  const loading = [...overview.byCase.values()].some((e) => !e.annotations);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.key.includes(q)) : rows;
  // An error belongs to the editor it came from.
  const edit = (key: string | null) => {
    setError(null);
    setEditing(key);
  };
  const caseName = (id: string) => props.cases.find((c) => c.id === id)?.name ?? id;
  const problem = failures(overview);

  /** Renames the tag on every page that has it, or takes it off them (to: null). */
  const retag = async (key: string, to: string | null) => {
    const targets: { caseId: string; a: Annotation }[] = [];
    for (const [caseId, entry] of overview.byCase) {
      for (const a of entry.annotations ?? []) if (a.tags.some((t) => tagKey(t) === key)) targets.push({ caseId, a });
    }
    let done = 0;
    setProgress(`Updating ${plural(targets.length, 'page')}…`);
    try {
      for (const { caseId, a } of targets) {
        const next =
          to === null
            ? a.tags.filter((t) => tagKey(t) !== key)
            : mergeTags([], a.tags.map((t) => (tagKey(t) === key ? to : t)));
        await overview.saveTags(caseId, a.captureId, next);
        setProgress(`Updated ${++done} of ${plural(targets.length, 'page')}…`);
      }
    } finally {
      setProgress(null);
    }
  };

  /** `work` returning false (the user said no) leaves the editor open. */
  const run = async (work: () => Promise<boolean | void>) => {
    setError(null);
    try {
      if ((await work()) !== false) setEditing(null);
    } catch (e) {
      setError(errorMessage(e));
      overview.reload(); // some pages may have changed before the failure
    }
  };

  const save = (row: TagRow | null, draft: TagDef) =>
    run(async () => {
      const name = normalizeTag(draft.name);
      if (!name || name.length > MAX_TAG) throw new Error(`A tag is 1-${MAX_TAG} characters`);
      const key = tagKey(name);
      const existing = rows.find((r) => r.key === key && r.key !== row?.key);
      if (existing && !row) throw new Error(`"${existing.name}" is already a tag`);
      if (
        existing &&
        row &&
        !confirm(`"${existing.name}" is already a tag. Merge "${row.name}" into it, on every page that has it?`)
      )
        return false;
      if (row && row.pages && name !== row.name) await retag(row.key, name);
      const next = { ...defs };
      if (row) delete next[row.key];
      // Merged into another tag: that one keeps its name and looks.
      next[key] = existing ? defOf(defs, existing.name) : { ...draft, name };
      await saveDefs(next);
    });

  const remove = (row: TagRow) =>
    run(async () => {
      const question = row.pages
        ? `Remove the tag "${row.name}" from ${plural(row.pages, 'page')}? The pages and their notes stay.`
        : `Delete the tag "${row.name}"? No page has it.`;
      if (!confirm(question)) return false;
      if (row.pages) await retag(row.key, null);
      const next = { ...defs };
      delete next[row.key];
      await saveDefs(next);
    });

  return (
    <>
      <header className="case-header overview-header">
        <div>
          <h1>Tags</h1>
          <p className="muted">
            Colours and icons are kept in this browser. Renaming or deleting a tag changes every page that has it.
          </p>
        </div>
        <button aria-pressed={editing === ''} disabled={!!progress} onClick={() => edit(editing === '' ? null : '')}>
          <Plus />
          New tag
        </button>
      </header>

      {editing === '' && (
        <TagEditor
          initial={{ name: '', color: defaultColor(''), icon: null }}
          busy={!!progress}
          onSave={(draft) => save(null, draft)}
          onCancel={() => edit(null)}
        />
      )}
      {progress && <p className="muted small">{progress}</p>}
      {error && <p className="error small">{error}</p>}
      {problem && (
        <p className="warn small">
          <TriangleAlert /> {problem}
        </p>
      )}

      <div className="view-bar">
        <span className="muted">{loading ? 'Loading…' : plural(shown.length, 'tag')}</span>
        <input
          type="search"
          className="filter"
          placeholder="Filter tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {rows.length === 0 && !loading ? (
        <div className="empty">
          <Tag />
          <strong>No tags yet</strong>
          <span className="small">Tag pages in the popup or on a capture, or make one here with New tag.</span>
        </div>
      ) : (
        <table className="table overview">
          <thead>
            <tr>
              <th>Tag</th>
              <th className="num">Pages</th>
              <th>In cases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) =>
              editing === row.key ? (
                <tr key={row.key} className="editing">
                  <td colSpan={4}>
                    <TagEditor
                      initial={{ ...defOf(defs, row.name), name: row.name }}
                      pages={row.pages}
                      busy={!!progress}
                      onSave={(draft) => save(row, draft)}
                      onDelete={() => remove(row)}
                      onCancel={() => edit(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={row.key}>
                  <td>
                    <TagChip tag={row.name} defs={defs} />
                  </td>
                  <td className="num">{row.pages.toLocaleString()}</td>
                  <td>
                    <div className="case-links">
                      {[...row.byCase].map(([caseId, n]) => (
                        <a key={caseId} href={routeHash({ caseId, view: 'pages', tag: row.name })}>
                          {caseName(caseId)} <span className="count">{n}</span>
                        </a>
                      ))}
                      {row.pages === 0 && <span className="muted small">on no page yet</span>}
                    </div>
                  </td>
                  <td className="actions">
                    <button
                      className="ghost"
                      disabled={!!progress}
                      onClick={() => edit(row.key)}
                      aria-label={`Edit the tag "${row.name}"`}
                    >
                      <Pencil />
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </>
  );
}

function TagEditor(props: {
  initial: TagDef;
  /** Pages with the tag now: renaming changes them */
  pages?: number;
  busy: boolean;
  onSave: (draft: TagDef) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const isNew = !props.onDelete;
  const [name, setName] = useState(props.initial.name);
  // A new tag takes its name's default colour, as a tag typed on a page would, until one is picked.
  const [style, setStyle] = useState<Pick<TagDef, 'color' | 'icon'> | null>(isNew ? null : props.initial);
  const draft: TagDef = { name, color: style?.color ?? defaultColor(name), icon: style?.icon ?? null };
  const renamed = !isNew && name.trim() !== props.initial.name && !!props.pages;

  return (
    <div className="tag-editor rise">
      <div className="tag-editor-head">
        <input
          autoFocus
          aria-label="Tag name"
          placeholder="Tag name"
          maxLength={MAX_TAG}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' ? props.onSave(draft) : e.key === 'Escape' && props.onCancel())}
        />
        <TagChip tag={name.trim() || 'Preview'} def={draft} />
      </div>
      <TagStylePicker color={draft.color} icon={draft.icon} onChange={setStyle} />
      <div className="tag-editor-bar">
        {props.onDelete && (
          <button className="ghost danger" disabled={props.busy} onClick={props.onDelete}>
            <Trash2 />
            Delete
          </button>
        )}
        <span className="grow muted small">
          {renamed && `Renames it on ${plural(props.pages ?? 0, 'page')}.`}
        </span>
        <button disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={props.busy || !draft.name.trim()} onClick={() => props.onSave(draft)}>
          {isNew ? 'Create tag' : 'Save'}
        </button>
      </div>
    </div>
  );
}
