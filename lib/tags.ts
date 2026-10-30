// How tags look: a colour and an optional icon for each one. The server keeps tags as plain
// strings on each capture's annotations; their looks are the user's own, kept in extension
// storage (like the watch terms) and shared by the popup and the dashboard. A tag there is
// "known": it is suggested while typing, even before any capture has it.

import { normalizeTag } from './limits';
import { mergeTags } from './protocol';
import { readLocal, writeLocal } from './settings';

export const TAG_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** The icons a tag can have; components/tags.tsx draws them. */
export const TAG_ICONS = [
  'star',
  'flag',
  'bookmark',
  'alert',
  'check',
  'eye',
  'user',
  'users',
  'building',
  'pin',
  'mail',
  'phone',
  'money',
  'lock',
  'flame',
] as const;
export type TagIcon = (typeof TAG_ICONS)[number];

export interface TagDef {
  /** The spelling shown; tags are one tag whatever their case, as the server keeps them */
  name: string;
  color: TagColor;
  /** null: a plain dot */
  icon: TagIcon | null;
}

/** Known tags, by tagKey */
export type TagDefs = Record<string, TagDef>;

export const tagKey = (tag: string) => normalizeTag(tag).toLowerCase();

/** A tag no one has styled takes a colour from its name, so tags differ from the start. */
export function defaultColor(tag: string): TagColor {
  let h = 0;
  for (const ch of tagKey(tag)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  // Gray is left for the user to choose: as a default it reads as "disabled".
  return TAG_COLORS[1 + (Math.abs(h) % (TAG_COLORS.length - 1))]!;
}

export function defOf(defs: TagDefs, tag: string): TagDef {
  return defs[tagKey(tag)] ?? { name: tag, color: defaultColor(tag), icon: null };
}

export async function getTagDefs(): Promise<TagDefs> {
  return (await readLocal('tagDefs')) ?? {};
}

export async function setTagDefs(defs: TagDefs): Promise<void> {
  await writeLocal('tagDefs', defs);
}

/** Makes the tags known, in their default looks, unless they already are. */
export async function rememberTags(tags: string[]): Promise<void> {
  const defs = await getTagDefs();
  const fresh = mergeTags([], tags).filter((t) => !defs[tagKey(t)]);
  if (!fresh.length) return;
  for (const t of fresh) defs[tagKey(t)] = defOf(defs, t);
  await setTagDefs(defs);
}
