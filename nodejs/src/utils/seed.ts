export function computeSeed(
  departure: string,
  destination: string,
  startDate: string,
  endDate: string,
  budget: number,
): number {
  const input = `${departure}|${destination}|${startDate}|${endDate}|${budget}`;
  return fnv1a(input);
}

export function agentSeed(baseSeed: number, agentSalt: string, round: number): number {
  return (baseSeed + fnv1a(agentSalt + round)) >>> 0;
}

function fnv1a(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
