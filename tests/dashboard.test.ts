// The dashboard's routes (lib/dashboard.ts): every view writes a hash that reads back as itself.

import { describe, expect, test } from 'bun:test';

import { parseRoute, routeHash, type DashboardRoute } from '../lib/dashboard';

describe('routes', () => {
  const routes: DashboardRoute[] = [
    { caseId: 'inbox', view: 'pages' },
    { caseId: 'inbox', view: 'pages', tag: 'lorem ipsum & co' },
    { caseId: 'inbox', view: 'selectors' },
    { caseId: 'inbox', view: 'sites' },
    { caseId: 'inbox', view: 'todos' },
    { caseId: 'a/b c?d', view: 'capture', captureId: 'x/y#z' },
    { view: 'cases' },
    { view: 'tags' },
  ];

  for (const route of routes) {
    test(`${routeHash(route)} reads back`, () => {
      expect(parseRoute(routeHash(route), 'fallback')).toEqual(route);
    });
  }

  test('the shapes in the hash', () => {
    expect(routeHash({ caseId: 'inbox', view: 'pages' })).toBe('#/inbox');
    expect(routeHash({ caseId: 'inbox', view: 'todos' })).toBe('#/inbox/todos');
    expect(routeHash({ view: 'tags' })).toBe('#/~tags');
  });

  test('anything else opens the pages of a case', () => {
    expect(parseRoute('', 'inbox')).toEqual({ caseId: 'inbox', view: 'pages' });
    expect(parseRoute('#/', 'inbox')).toEqual({ caseId: 'inbox', view: 'pages' });
    expect(parseRoute('#/case-1/nope', 'inbox')).toEqual({ caseId: 'case-1', view: 'pages' });
    expect(parseRoute('#/case-1/capture', 'inbox')).toEqual({ caseId: 'case-1', view: 'pages' });
    expect(parseRoute('#/%E0%A4%A', 'inbox')).toEqual({ caseId: '%E0%A4%A', view: 'pages' });
  });
});
