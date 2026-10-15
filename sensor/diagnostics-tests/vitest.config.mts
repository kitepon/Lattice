// Local observer checks only. The product's original suite inventory is unchanged.
import base from '../vitest.config.mts';
export default {
  ...base,
  test: { ...base.test, include: ['__tests__/**/*.test.ts', 'diagnostics-tests/**/*.test.ts'] },
};
