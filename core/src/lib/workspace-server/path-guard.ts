/**
 * PathGuard – central path-resolution security module.
 *
 * ALL filesystem and shell routes MUST pass client-supplied paths through
 * guardPath() before any read/write operation. Guards enforce:
 *
 *  1. Reject absolute paths from the client.
 *  2. Canonicalise the slot root via realpath (resolves mount-point symlinks).
 *  3. Resolve the candidate path and check prefix containment.
 *  4. Walk each component with lstat() to reject symlinks in the path chain.
 *  5. Final realpath check (for existing paths) to catch late-resolved escapes.
 *
 * guardSlotForDeletion() additionally enforces:
 *  - slot_id matches ^[a-z0-9-]{8,}$
 *  - realpath of the slot MUST start with WORKSPACE_ROOT + "/"
 *
 * These two guards together prevent path-traversal, symlink attacks, and
 * accidental rm -rf of arbitrary filesystem locations.
 */
import path from 'path';
import fs from 'fs/promises';

export const WORKSPACE_ROOT: string =
  process.env.WORKSPACE_ROOT ?? path.join(process.cwd(), '.jerome-workspaces');

// Validated at startup so misconfiguration is caught early.
if (!path.isAbsolute(WORKSPACE_ROOT)) {
  throw new Error(`WORKSPACE_ROOT must be absolute, got: ${WORKSPACE_ROOT}`);
}

export class PathGuardError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}

const SLOT_ID_RE = /^[a-z0-9][a-z0-9-]{7,}$/;
const SLOT_ID_DELETE_RE = /^[a-z0-9-]{8,}$/;

/**
 * Validates `clientPath` (relative, from client) against the workspace slot.
 *
 * @param slotId     Server-validated slot identifier.
 * @param clientPath Relative path from client request; MUST NOT be absolute.
 * @returns          Absolute, realpath-resolved safe path within the slot.
 * @throws           PathGuardError on any violation.
 */
export async function guardPath(slotId: string, clientPath: string): Promise<string> {
  // 1. Reject absolute paths from client.
  if (path.isAbsolute(clientPath)) {
    throw new PathGuardError('Absolute paths are not permitted');
  }

  // 2. Validate slot ID format.
  if (!SLOT_ID_RE.test(slotId)) {
    throw new PathGuardError('Invalid slot ID format');
  }

  // 3. Canonicalise slot root. realpath() will throw if the slot doesn't exist.
  const rawSlotRoot = path.join(WORKSPACE_ROOT, slotId);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rawSlotRoot);
  } catch {
    throw new PathGuardError('Slot does not exist or is inaccessible');
  }

  // 4. Verify the resolved root itself is inside WORKSPACE_ROOT.
  const rootPrefix = WORKSPACE_ROOT.endsWith(path.sep)
    ? WORKSPACE_ROOT
    : WORKSPACE_ROOT + path.sep;
  if (realRoot !== WORKSPACE_ROOT && !realRoot.startsWith(rootPrefix)) {
    throw new PathGuardError('Slot root escapes workspace boundary');
  }

  // 5. Build candidate and pre-check containment before any realpath.
  const candidate = path.resolve(realRoot, clientPath);
  const slotPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (candidate !== realRoot && !candidate.startsWith(slotPrefix)) {
    throw new PathGuardError('Path traversal detected');
  }

  // 6. Walk each path component and reject symlinks in the chain.
  const rel = path.relative(realRoot, candidate);
  if (rel) {
    let current = realRoot;
    for (const part of rel.split(path.sep)) {
      if (!part || part === '.') continue;
      current = path.join(current, part);
      let stat: Awaited<ReturnType<typeof fs.lstat>> | null;
      try {
        stat = await fs.lstat(current);
      } catch {
        // Path component doesn't exist yet (valid for writes) – stop checking.
        break;
      }
      if (stat.isSymbolicLink()) {
        throw new PathGuardError(
          `Symlink detected in path at: ${path.relative(realRoot, current)}`,
        );
      }
    }
  }

  // 7. Final realpath check for existing targets.
  try {
    const resolved = await fs.realpath(candidate);
    if (resolved !== realRoot && !resolved.startsWith(slotPrefix)) {
      throw new PathGuardError('Resolved path escapes slot boundary');
    }
    return resolved;
  } catch (err) {
    if (err instanceof PathGuardError) throw err;
    // ENOENT – path is new (write target); return the normalized candidate.
    return candidate;
  }
}

/**
 * Validates a slot ID before rm -rf operations.
 * Enforces BOTH the regex AND the realpath prefix requirement.
 *
 * @returns Absolute, realpath-verified slot path.
 * @throws  PathGuardError if either guard fails.
 */
export async function guardSlotForDeletion(slotId: string): Promise<string> {
  // Must match deletion-safe pattern.
  if (!SLOT_ID_DELETE_RE.test(slotId)) {
    throw new PathGuardError(
      'Slot ID does not match safe-deletion pattern ^[a-z0-9-]{8,}$',
    );
  }

  const slotPath = path.resolve(WORKSPACE_ROOT, slotId);

  let realPath: string;
  try {
    realPath = await fs.realpath(slotPath);
  } catch {
    throw new PathGuardError('Slot path does not exist – deletion blocked');
  }

  const rootPrefix = WORKSPACE_ROOT.endsWith(path.sep)
    ? WORKSPACE_ROOT
    : WORKSPACE_ROOT + path.sep;

  if (!realPath.startsWith(rootPrefix)) {
    throw new PathGuardError(
      'Slot realpath does not start with WORKSPACE_ROOT – deletion blocked',
    );
  }

  return realPath;
}

/**
 * Returns the server-controlled cwd for a slot.
 * Client-supplied cwd hints are IGNORED by design.
 */
export async function resolveSlotRoot(slotId: string): Promise<string> {
  if (!SLOT_ID_RE.test(slotId)) {
    throw new PathGuardError('Invalid slot ID format');
  }
  const raw = path.join(WORKSPACE_ROOT, slotId);
  try {
    return await fs.realpath(raw);
  } catch {
    throw new PathGuardError('Slot does not exist');
  }
}
