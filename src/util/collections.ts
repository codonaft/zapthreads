export function getOrSetOrUpdate<K, V>(map: Map<K, V>, key: K, defaultValue: () => V, update?: (oldValue: V) => V): V {
  let replace = false;
  let oldValue;

  if (map.has(key)) {
    oldValue = map.get(key)!;
  } else {
    oldValue = defaultValue();
    replace = true;
  }

  let newValue;
  if (update) {
    newValue = update(oldValue);
    replace = true;
  } else {
    newValue = oldValue;
  }

  if (replace) {
    map.set(key, newValue);
  }
  return newValue;
}

export function medianOrZero(array: number[]): number {
  const n = array.length;
  if (n === 0) return 0;
  const sorted = array.toSorted((a, b) => a - b);
  const middle = Math.floor(n / 2);
  return n % 2 === 0 ? Math.floor((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

export function argmax(array: number[]): number | undefined {
  if (array.length === 0) {
    return;
  }

  let index = 0;
  let value = array[0];
  for (let i = 1; i < array.length; i++) {
    if (array[i] > value) {
      value = array[i];
      index = i;
    }
  }
  return index;
}

export function maxBy<T>(array: T[], f: (value: T) => number): T | undefined {
  if (array.length === 0) {
    return;
  }

  const maxIndex = argmax(array.map(f))!;
  return array[maxIndex];
}
