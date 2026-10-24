import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeAggregateRuleStatus } from './portForwardingStatus';

describe('computeAggregateRuleStatus', () => {
  it('returns inactive for an empty mapping set', () => {
    assert.equal(computeAggregateRuleStatus([]), 'inactive');
  });

  it('returns the unanimous status unchanged', () => {
    assert.equal(computeAggregateRuleStatus(['active', 'active']), 'active');
    assert.equal(computeAggregateRuleStatus(['error', 'error']), 'error');
    assert.equal(computeAggregateRuleStatus(['inactive']), 'inactive');
    assert.equal(computeAggregateRuleStatus(['unknown', 'unknown']), 'unknown');
  });

  it('lets connecting win over any other state', () => {
    assert.equal(computeAggregateRuleStatus(['connecting', 'active', 'error']), 'connecting');
  });

  it('reports partial for a mix containing an active mapping', () => {
    assert.equal(computeAggregateRuleStatus(['active', 'error']), 'partial');
    assert.equal(computeAggregateRuleStatus(['active', 'error', 'inactive']), 'partial');
  });

  it('reports error for a mix without any active mapping', () => {
    assert.equal(computeAggregateRuleStatus(['error', 'inactive']), 'error');
  });
});
