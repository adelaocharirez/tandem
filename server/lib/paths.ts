/**
 * Path matching for file claims.
 *
 * Claims are advisory: an agent says "I'm editing src/api/users.ts" (or a
 * folder, or a glob) and another agent asking for an overlapping path gets
 * told who holds it. Two claims overlap when one could touch a file the other
 * covers — we err on the side of reporting a conflict, because a false alarm
 * costs one message and a missed one costs a merge conflict.
 */

export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

const isGlob = (p: string) => p.includes('*');

/** The literal part of a glob before its first wildcard, e.g. `src/api/` for `src/api/**`. */
function staticPrefix(glob: string): string {
  return glob.slice(0, glob.indexOf('*'));
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero directories
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function pathsOverlap(rawA: string, rawB: string): boolean {
  const a = normalizePath(rawA);
  const b = normalizePath(rawB);
  if (a === b) return true;

  const aGlob = isGlob(a);
  const bGlob = isGlob(b);

  // Two plain paths: same file, or one is a folder containing the other.
  if (!aGlob && !bGlob) return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

  // Two globs: compare the literal parts. Conservative by design.
  if (aGlob && bGlob) {
    const pa = staticPrefix(a);
    const pb = staticPrefix(b);
    return pa.startsWith(pb) || pb.startsWith(pa);
  }

  const glob = aGlob ? a : b;
  const plain = aGlob ? b : a;
  if (globToRegExp(glob).test(plain)) return true;
  // The plain path is a folder the glob reaches into (`src` vs `src/**/*.ts`).
  if (staticPrefix(glob).startsWith(`${plain}/`)) return true;
  // The plain path sits inside a folder the glob matches (`src/*` vs `src/api/users.ts`).
  return globToRegExp(`${glob}/**`).test(plain);
}

/**
 * Turn the absolute path Claude Code reports into the repo-relative path
 * claims are written in. Returns null for files outside the project.
 * Handles Windows paths (backslashes, drive letters, case-insensitive).
 */
export function repoRelative(root: string | undefined, file: string): string | null {
  const clean = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const f = clean(file);
  const absolute = f.startsWith('/') || /^[a-zA-Z]:\//.test(f);
  if (!absolute) return f.startsWith('..') ? null : normalizePath(f) || null;
  if (!root) return null;

  const r = clean(root);
  const windows = /^[a-zA-Z]:\//.test(r);
  const [cf, cr] = windows ? [f.toLowerCase(), r.toLowerCase()] : [f, r];
  if (!cf.startsWith(`${cr}/`)) return null;
  return normalizePath(f.slice(r.length + 1)) || null;
}
