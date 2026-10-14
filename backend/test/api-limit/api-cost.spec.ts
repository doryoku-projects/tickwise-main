import { describe, expect, it } from 'vitest';
import { API_COST_WEIGHTS, DEEP_PAGE_ROWS, classifyApiCost } from '../../src/common/api-cost.js';

describe('classifyApiCost', () => {
  it('prices a plain list page as a list', () => {
    expect(classifyApiCost('list', {})).toMatchObject({ class: 'list', base: 1, surcharge: 2 });
    expect(classifyApiCost('list', { page: '3', limit: '25' })).toMatchObject({ class: 'list' });
  });

  it('prices a page past 1,000 rows as a deep walk, and exactly 1,000 as a list', () => {
    expect(25 * 40).toBe(DEEP_PAGE_ROWS);
    expect(classifyApiCost('list', { page: '40', limit: '25' }).class).toBe('list');
    expect(classifyApiCost('list', { page: '41', limit: '25' }).class).toBe('deep');
    expect(classifyApiCost('list', { page: 51, limit: 20 }).class).toBe('deep');
  });

  it('uses the DTO defaults (page 1, limit 20) for a missing or unreadable value', () => {
    for (const q of [{ page: 'abc' }, { limit: '' }, { page: '-4', limit: '0' }, { page: ['1', '2'] }, { limit: { $gt: '1' } }]) {
      expect(classifyApiCost('list', q as never).class, JSON.stringify(q)).toBe('list');
    }
    // A readable page with an unreadable limit still counts rows at limit 20.
    expect(classifyApiCost('list', { page: '51', limit: 'abc' }).class).toBe('deep');
    expect(classifyApiCost('list', { page: '50', limit: 'abc' }).class).toBe('list');
  });

  it('prices a search above a list: a pool search, a position id and an owner', () => {
    for (const q of [{ search: 'usdc' }, { positionId: '123' }, { owner: '0xabc' }]) {
      expect(classifyApiCost('list', q), JSON.stringify(q)).toMatchObject({ class: 'search', base: 3 });
    }
    // Blank is not a search; neither is a pool filter, which is the pool modal's own list.
    expect(classifyApiCost('list', { search: '   ' }).class).toBe('list');
    expect(classifyApiCost('list', { poolId: '0xabc' }).class).toBe('list');
    // A search beats depth: it is the dearer reading of the same request.
    expect(classifyApiCost('list', { search: 'x', page: '99', limit: '25' }).class).toBe('search');
  });

  it('prices the other kinds by their own row', () => {
    expect(classifyApiCost('count', {})).toMatchObject({ class: 'count', ...API_COST_WEIGHTS.count });
    expect(classifyApiCost('detail', {})).toMatchObject({ class: 'detail', ...API_COST_WEIGHTS.detail });
    expect(classifyApiCost('chart', {})).toMatchObject({ class: 'chart', ...API_COST_WEIGHTS.chart });
    // A count with a search in its query is still a count.
    expect(classifyApiCost('count', { search: 'usdc' }).class).toBe('count');
  });

  it('survives a missing query', () => {
    expect(classifyApiCost('list', undefined).class).toBe('list');
  });

  it('weights a miss above a hit everywhere, and a chart above a detail', () => {
    for (const row of Object.values(API_COST_WEIGHTS)) {
      expect(row.base).toBeGreaterThan(0);
      expect(row.surcharge).toBeGreaterThan(0);
    }
    expect(API_COST_WEIGHTS.chart.base).toBeGreaterThan(API_COST_WEIGHTS.detail.base);
    expect(API_COST_WEIGHTS.deep.base).toBeGreaterThan(API_COST_WEIGHTS.list.base);
  });
});
