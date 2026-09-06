export function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  name: string,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${name} has missing or unknown fields`);
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function integer(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${String(minimum)}`,
    );
  }
  return value;
}

export function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return value;
}

export function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}
