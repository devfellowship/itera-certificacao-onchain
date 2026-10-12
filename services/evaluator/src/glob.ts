// Minimal path globs for task.json editable_paths / protected_paths. Workspace-relative POSIX paths.
//   **  any number of characters, across "/"     (src/** matches src/a.ts and src/a/b.ts)
//   *   any characters except "/"                (vitest.config.* matches vitest.config.ts)
//   ?   one character except "/"
// A pattern without a wildcard matches that exact path, and also everything under it when it
// names a directory ("tests" matches "tests/a.ts").
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  // "dir/**" also matches "dir" itself.
  const tailAny = glob.endsWith('/**');
  const body = tailAny ? glob.slice(0, -3) : glob;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '*') {
      if (body[i + 1] === '*') {
        // "**/x" matches "x" at any depth.
        if (body[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  if (tailAny) re += '(?:/.*)?';
  const hasWildcard = /[*?]/.test(glob);
  const compiled = new RegExp(hasWildcard ? `^${re}$` : `^${re}(?:/.*)?$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
