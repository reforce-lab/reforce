export interface PortableSourceIdentity {
  readonly realpath: string;
  readonly id: string;
}

export function registerPortableSourceIdentity(
  identities: Map<string, PortableSourceIdentity>,
  candidate: PortableSourceIdentity,
): PortableSourceIdentity | undefined {
  const key = candidate.id.toLowerCase();
  const existing = identities.get(key);
  if (existing === undefined) {
    identities.set(key, candidate);
    return undefined;
  }
  return existing.realpath === candidate.realpath ? undefined : existing;
}
