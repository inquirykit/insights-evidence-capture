// Tags as the popup and the dashboard show them: a coloured dot or icon before the name
// (lib/tags.ts keeps the looks), an input that turns what is typed into tags, and the picker
// for a tag's colour and icon. The CSS is in assets/tokens.css, shared by both pages.

import {
  Banknote,
  Bookmark,
  Building2,
  CircleCheck,
  Eye,
  Flag,
  Flame,
  Lock,
  Mail,
  MapPin,
  Phone,
  Star,
  TriangleAlert,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { mergeTags } from '@/lib/protocol';
import { onLocalChange } from '@/lib/settings';
import {
  defOf,
  getTagDefs,
  setTagDefs,
  TAG_COLORS,
  TAG_ICONS,
  tagKey,
  type TagColor,
  type TagDef,
  type TagDefs,
  type TagIcon,
} from '@/lib/tags';

export const ICONS: Record<TagIcon, { icon: LucideIcon; label: string }> = {
  star: { icon: Star, label: 'Star' },
  flag: { icon: Flag, label: 'Flag' },
  bookmark: { icon: Bookmark, label: 'Bookmark' },
  alert: { icon: TriangleAlert, label: 'Warning' },
  check: { icon: CircleCheck, label: 'Checked' },
  eye: { icon: Eye, label: 'Watch' },
  user: { icon: User, label: 'Person' },
  users: { icon: Users, label: 'Group' },
  building: { icon: Building2, label: 'Organisation' },
  pin: { icon: MapPin, label: 'Place' },
  mail: { icon: Mail, label: 'Email' },
  phone: { icon: Phone, label: 'Phone' },
  money: { icon: Banknote, label: 'Money' },
  lock: { icon: Lock, label: 'Credentials' },
  flame: { icon: Flame, label: 'Hot' },
};

const colorLabel = (c: TagColor) => c[0]!.toUpperCase() + c.slice(1);

/** The known tags, kept current when another page (popup, dashboard tab) changes them. */
export function useTagDefs(): [TagDefs, (defs: TagDefs) => Promise<void>] {
  const [defs, setDefs] = useState<TagDefs>({});
  useEffect(() => {
    let live = true;
    getTagDefs().then(
      (d) => live && setDefs(d),
      () => {},
    );
    const stop = onLocalChange('tagDefs', (next) => setDefs(next ?? {}));
    return () => {
      live = false;
      stop();
    };
  }, []);
  const save = useCallback(async (next: TagDefs) => {
    setDefs(next);
    await setTagDefs(next);
  }, []);
  return [defs, save];
}

/** The tag's dot, or its icon, in its colour. */
export function TagMark({ def }: { def: Pick<TagDef, 'color' | 'icon'> }) {
  if (!def.icon) return <span className={`tag-dot tag-c-${def.color}`} aria-hidden="true" />;
  const Icon = ICONS[def.icon].icon;
  return <Icon className={`tag-icon tag-c-${def.color}`} aria-hidden="true" />;
}

/** `def` gives the looks outright (a preview); otherwise they come from the known tags. */
export function TagChip(props: {
  tag: string;
  defs?: TagDefs;
  def?: Pick<TagDef, 'color' | 'icon'>;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const def = props.def ?? defOf(props.defs ?? {}, props.tag);
  return (
    <span className={`tag tag-c-${def.color}`}>
      <TagMark def={def} />
      {props.tag}
      {props.onRemove && (
        <button
          type="button"
          className="tag-x"
          title={`Remove the tag "${props.tag}"`}
          aria-label={`Remove the tag "${props.tag}"`}
          disabled={props.disabled}
          onClick={props.onRemove}
        >
          <X />
        </button>
      )}
    </span>
  );
}

/** Tags as chips, and an input that adds what is typed on Enter, a comma or leaving it. The
 *  known tags are offered as it is typed. `onChange` returning false (a failed save) keeps the
 *  text typed. */
export function TagInput(props: {
  id?: string;
  tags: string[];
  defs: TagDefs;
  /** More tags to offer besides the known ones: the case's, say */
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (tags: string[]) => unknown;
}) {
  const [draft, setDraft] = useState('');
  const list = useId();
  // The input is disabled while a save runs, which can blur it: that must not commit twice.
  const committing = useRef(false);

  const commit = async (text: string, rest = '') => {
    if (committing.current) return;
    const next = mergeTags(props.tags, text.split(','));
    committing.current = true;
    try {
      if (next.length === props.tags.length || (await props.onChange(next)) !== false) setDraft(rest);
    } finally {
      committing.current = false;
    }
  };
  const offered = mergeTags(
    [],
    [...Object.values(props.defs).map((d) => d.name), ...(props.suggestions ?? [])],
  ).filter((t) => !props.tags.some((x) => tagKey(x) === tagKey(t)));

  return (
    <div className="tag-edit">
      {props.tags.map((t) => (
        <TagChip
          key={t}
          tag={t}
          defs={props.defs}
          disabled={props.disabled}
          onRemove={() => props.onChange(props.tags.filter((x) => x !== t))}
        />
      ))}
      <input
        id={props.id}
        className="tag-input"
        list={list}
        autoComplete="off"
        value={draft}
        disabled={props.disabled}
        placeholder={props.tags.length ? 'Add a tag' : props.placeholder}
        onChange={(e) => {
          const parts = e.target.value.split(',');
          if (parts.length > 1) void commit(parts.slice(0, -1).join(','), parts.at(-1));
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          void commit(draft);
        }}
        onBlur={() => draft.trim() && void commit(draft)}
      />
      <datalist id={list}>
        {offered.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

/** Colour swatches and icon buttons; the icons show in the colour chosen. */
export function TagStylePicker(props: {
  color: TagColor;
  icon: TagIcon | null;
  onChange: (style: { color: TagColor; icon: TagIcon | null }) => void;
}) {
  const { color, icon } = props;
  return (
    <div className="style-picker">
      <div className="swatches" role="radiogroup" aria-label="Colour">
        {TAG_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            className={`swatch tag-c-${c}`}
            aria-checked={color === c}
            aria-label={colorLabel(c)}
            title={colorLabel(c)}
            onClick={() => props.onChange({ color: c, icon })}
          />
        ))}
      </div>
      <div className={`icon-grid tag-c-${color}`} role="radiogroup" aria-label="Icon">
        <button
          type="button"
          role="radio"
          aria-checked={icon === null}
          aria-label="No icon"
          title="No icon: a dot"
          onClick={() => props.onChange({ color, icon: null })}
        >
          <span className="tag-dot" />
        </button>
        {TAG_ICONS.map((i) => {
          const Icon = ICONS[i].icon;
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={icon === i}
              aria-label={ICONS[i].label}
              title={ICONS[i].label}
              onClick={() => props.onChange({ color, icon: i })}
            >
              <Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
}
