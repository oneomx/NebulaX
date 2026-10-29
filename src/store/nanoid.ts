let counter = 0;
export function nanoid(): string {
  counter += 1;
  return `${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
