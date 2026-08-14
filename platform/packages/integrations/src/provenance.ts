const simulatorAdapters = new WeakSet<object>();

export function markSimulatorAdapter<T extends object>(adapter: T): T {
  simulatorAdapters.add(adapter);
  return adapter;
}

export function isSimulatorAdapter(value: unknown): boolean {
  return (typeof value === "object" && value !== null) ||
    typeof value === "function"
    ? simulatorAdapters.has(value as object)
    : false;
}
