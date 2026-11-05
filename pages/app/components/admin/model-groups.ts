import type { ModelConfig } from "~/apis";

export function getModelSections<T extends Pick<ModelConfig, "model" | "group">>(models: T[]) {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const items = groups.get(model.group) ?? [];
    items.push(model);
    groups.set(model.group, items);
  }
  return [...groups].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  }).map(([group, items]) => ({
    group,
    models: [...items].sort((a, b) => a.model.localeCompare(b.model)),
  }));
}
