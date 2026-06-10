/**
 * PathGuard – central path-resolution security module.
 *
 * ALL filesystem and shell routes MUST pass client-supplied paths through
 * guardPath() before any read/write operation. Guards enforce:
 *
 *  1. Reject absolute paths from the client.
 *  2. Canonicalise the working root via realpath (resolves mount-point symlinks).
 *  3. Resolve the candidate path and check prefix containment.
 *  4. Walk each component with lstat() to reject symlinks in the path chain.
 *  5. Final realpath check (for existing paths) to catch late-resolved escapes.
 *
 * guardSlotForDeletion() additionally enforces (SANDBOX-ONLY):
 *  - slot_id matches ^[a-z0-9-]{8,}$
 *  - realpath of the slot MUST start with WORKSPACE_ROOT + "/"
 *
 * These two guards together prevent path-traversal, symlink attacks, and
 * accidental rm -rf of arbitrary filesystem locations.
 *
 * Ported from the Spectre monolith (src/lib/workspace-server/path-guard.ts).
 * GENERALIZED for the standalone dual-mode service: guardPath() now takes an
 * already-resolved ABSOLUTE root directory instead of a slot id, so the same
 * security walk can guard BOTH sandbox slots (<WORKSPACE_ROOT>/<id>/repo) AND
 * trusted bind-mounted folders (arbitrary registered abs paths). Deletion
 * remains sandbox-only and never accepts a trusted folder.
 */
import path from 'path';
import fs from 'fs/promises';

export const WORKSPACE_ROOT: string =
  process.env.WORKSPACE_ROOT ?? '/workspaces';

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
 * Validates `clientPath` (relative, from client) against an already-resolved
 * absolute working root.
 *
 * The caller is responsible for resolving the root (e.g. via
 * SlotManager.resolveRoot()): for sandbox slots that is
 * <WORKSPACE_ROOT>/<id>/repo, for trusted folders it is the registered abs
 * path. guardPath() does NOT join with WORKSPACE_ROOT.
 *
 * @param rootDir    Server-resolved ABSOLUTE working root. NEVER from client.
 * @param clientPath Relative path from client request; MUST NOT be absolute.
 * @returns          Absolute, realpath-resolved safe path within the root.
 * @throws           PathGuardError on any violation.
 */
export async function guardPath(rootDir: string, clientPath: string): Promise<string> {
  // 1. Reject absolute paths from client.
  if (path.isAbsolute(clientPath)) {
    throw new PathGuardError('Absolute paths are not permitted');
  }

  // 2. The root must itself be an absolute path (server bug if not).
  if (!path.isAbsolute(rootDir)) {
    throw new PathGuardError('Working root must be absolute');
  }

  // 3. Canonicalise working root. realpath() will throw if it doesn't exist.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch {
    throw new PathGuardError('Working root does not exist or is inaccessible');
  }

  // 4. Build candidate and pre-check containment before any realpath.
  const candidate = path.resolve(realRoot, clientPath);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (candidate !== realRoot && !candidate.startsWith(rootPrefix)) {
    throw new PathGuardError('Path traversal detected');
  }

  // 5. Walk each path component and reject symlinks in the chain.
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

  // 6. Final realpath check for existing targets.
  try {
    const resolved = await fs.realpath(candidate);
    if (resolved !== realRoot && !resolved.startsWith(rootPrefix)) {
      throw new PathGuardError('Resolved path escapes working-root boundary');
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
 * SANDBOX-ONLY: the realpath MUST stay under WORKSPACE_ROOT, so a trusted
 * bind-mounted folder (whose realpath lives elsewhere) can NEVER be deleted
 * through this path.
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
 * Returns the server-controlled SANDBOX slot directory (NOT the /repo subdir).
 * Client-supplied cwd hints are IGNORED by design.
 *
 * For unified dual-mode resolution use SlotManager.resolveRoot() instead, which
 * returns the working root for both sandbox (<id>/repo) and trusted folders.
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
