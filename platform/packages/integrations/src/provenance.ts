const simulatorAdapters = new WeakSet<object>();
const productionCapabilities = new WeakMap<
  object,
  ReadonlySet<ProductionAdapterCapability>
>();

export type ProductionAdapterCapability =
  "SMS" | "NIA" | "OBJECT_STORAGE" | "MALWARE_SCANNER";

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

export function markProductionAdapter<T extends object>(
  adapter: T,
  capability: ProductionAdapterCapability,
): T {
  const existing = productionCapabilities.get(adapter) ?? new Set();
  productionCapabilities.set(
    adapter,
    new Set([
      ...existing,
      capability,
    ]) as ReadonlySet<ProductionAdapterCapability>,
  );
  return adapter;
}

export function hasProductionAdapterCapability(
  value: unknown,
  capability: ProductionAdapterCapability,
): boolean {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    (productionCapabilities.get(value as object)?.has(capability) ?? false)
  );
}
