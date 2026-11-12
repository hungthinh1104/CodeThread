/* global structuredClone */
export function createNavigationHistory(limit = 20) {
  const past = [],
    future = [];
  return {
    remember(current) {
      past.push(structuredClone(current));
      future.length = 0;
      if (past.length > limit) past.shift();
    },
    move(direction, current) {
      const source = direction === 'back' ? past : future;
      const destination = direction === 'back' ? future : past;
      const target = source.pop();
      if (!target) return null;
      destination.push(structuredClone(current));
      return target;
    },
    get canBack() {
      return past.length > 0;
    },
    get canForward() {
      return future.length > 0;
    },
  };
}
