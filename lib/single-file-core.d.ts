// single-file-core ships no type declarations: the part of its API this extension uses.
declare module 'single-file-core/single-file.js' {
  export interface SingleFileResponse {
    status: number;
    url?: string;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }
  export type SingleFileFetch = (
    url: string,
    options: { headers?: Record<string, string>; frameId?: string; cache?: string },
  ) => Promise<SingleFileResponse>;

  export function init(initOptions: { fetch?: SingleFileFetch; frameFetch?: SingleFileFetch }): void;
  export function getPageData(
    options: Record<string, unknown>,
    initOptions?: { fetch?: SingleFileFetch; frameFetch?: SingleFileFetch },
    doc?: Document,
    win?: Window,
  ): Promise<{ content: string; title: string; filename: string; stats?: unknown }>;
}
