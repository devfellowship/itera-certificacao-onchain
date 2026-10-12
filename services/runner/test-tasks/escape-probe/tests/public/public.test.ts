import { expect, it } from 'vitest';
import { answer } from '../../src/index.js';

it('the module loads', () => {
  expect(typeof answer).toBe('number');
});
