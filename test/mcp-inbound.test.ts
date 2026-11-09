import { describe, expect, it } from 'vitest';
import { inboundClientSessionShape, inboundIdentityFromHeaders, inboundRequestId, requestIdFromHeader, withInboundRequestId } from '../src/main/mcp/inbound.js';

describe('MCP inbound request id boundary', () => {
  it('bounds conversation metadata inspection without reading getters or promoting hints', () => {
    const wrap = (value: unknown) => ({ params: { _meta: { 'openai/session': value } } });
    for (const value of ['', ' ', 'private\nvalue', 'x'.repeat(1025), null, 7, {}, []])
      expect(inboundClientSessionShape(wrap(value))).toBe('invalid');
    expect(inboundClientSessionShape(wrap('opaque-session'))).toBe('present');
    expect(inboundClientSessionShape({ _meta: { 'openai/session': 'envelope-only' } })).toBe('missing');
    expect(inboundClientSessionShape({ params: { arguments: { _meta: { 'openai/session': 'ignored' } } } })).toBe('missing');
    expect(inboundClientSessionShape({ params: { _meta: Object.create({ 'openai/session': 'inherited' }) } })).toBe('missing');
    const getter = Object.defineProperty({}, 'openai/session', { get() { throw new Error('must not run'); } });
    expect(inboundClientSessionShape({ params: { _meta: getter } })).toBe('invalid');
    expect(inboundClientSessionShape({ params: { _meta: [] } })).toBe('invalid');
    expect(inboundClientSessionShape([wrap('a'), wrap('b')])).toBe('batch');
    expect(inboundClientSessionShape(null)).toBe('missing');
    expect(inboundRequestId()).toBeNull();
  });

  it('snapshots missing and alternative header shapes without inventing an owner', () => {
    expect(inboundIdentityFromHeaders({}, [])).toEqual({ requestId: null, headers: {
      'x-request-id': 'missing', 'x-openai-request-id': 'missing', 'openai-request-id': 'missing' } });
    const headers = { 'x-openai-request-id': 'private-alternative/attempt', 'openai-request-id': 'invalid.value' };
    const observed = inboundIdentityFromHeaders(headers, Object.entries(headers).flat());
    headers['x-openai-request-id'] = 'another-private-value';
    expect(observed).toEqual({ requestId: null, headers: {
      'x-request-id': 'missing', 'x-openai-request-id': 'valid', 'openai-request-id': 'invalid' } });
    expect(JSON.stringify(observed)).not.toMatch(/private|invalid.value|attempt/);
  });

  it('retains only an unambiguous primary header even when Node merges duplicates after the slash', () => {
    expect(inboundIdentityFromHeaders({ 'x-request-id': 'workflow_a/hop' }, ['X-Request-Id', 'workflow_a/hop']).requestId)
      .toBe('workflow_a');
    const repeated = inboundIdentityFromHeaders({ 'x-request-id': 'workflow_a/hop' },
      ['X-Request-Id', 'workflow_a/hop', 'x-request-id', 'workflow_a/hop']);
    expect(repeated.requestId).toBeNull();
    expect(repeated.headers['x-request-id']).toBe('ambiguous');
    expect(inboundIdentityFromHeaders({ 'x-request-id': ['workflow_a/hop', 'workflow_b/hop'] }, []).requestId).toBeNull();
    expect(inboundIdentityFromHeaders({ 'x-request-id': 'workflow_a/hop,workflow_b/hop' }, []).requestId).toBeNull();
  });

  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_00000000000000000000000000000001/yqy1')).toBe(
      'wfr_00000000000000000000000000000001'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_only/a'])).toBe('wfr_only');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBeNull();

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      withInboundRequestId('wfr_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId('wfr_b', async () => {
        await Promise.resolve();
        return inboundRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(inboundRequestId()).toBeNull();
  });
});
