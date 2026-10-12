import { describe, expect, it } from 'vitest';
import { parseGatewayUsage } from './model-usage.js';

describe('parseGatewayUsage', () => {
  it('takes the LAST usage line of the gateway log', () => {
    const logs = [
      '{"at":"t","listening":3128}',
      '{"at":"t","event":"usage","cost_usd":0,"tokens_in":0,"tokens_out":0,"calls":0,"refused":0,"max_cost_usd":0.5,"cap_reached":false}',
      '{"at":"t","verdict":"allow","path":"/api/v1/chat/completions","status":200}',
      '{"at":"t","event":"usage","cost_usd":0.0042,"tokens_in":1500,"tokens_out":200,"calls":1,"refused":0,"max_cost_usd":0.5,"cap_reached":false}',
      'not json',
    ].join('\n');
    expect(parseGatewayUsage(logs)).toEqual({ costUsd: 0.0042, tokensIn: 1500, tokensOut: 200, calls: 1, refused: 0, maxCostUsd: 0.5, capStopped: false });
  });
  it('capStopped only when the gateway refused a call', () => {
    const line = '{"verdict":"cap_reached","event":"usage","cost_usd":0.52,"tokens_in":1,"tokens_out":1,"calls":9,"refused":1,"max_cost_usd":0.5,"cap_reached":true}';
    expect(parseGatewayUsage(line)?.capStopped).toBe(true);
  });
  it('null when there is no usage line', () => {
    expect(parseGatewayUsage('')).toBeNull();
    expect(parseGatewayUsage('{"event":"other","usage":1}')).toBeNull();
  });
});
