import { describe, expect, it } from 'vitest';
import { normalizePath, pathsOverlap } from '../server/lib/paths';

describe('normalizePath', () => {
  it('cleans up the ways people write the same path', () => {
    expect(normalizePath('./src/api/users.ts')).toBe('src/api/users.ts');
    expect(normalizePath('src\\api\\users.ts')).toBe('src/api/users.ts');
    expect(normalizePath('src//api/')).toBe('src/api');
    expect(normalizePath('  web/  ')).toBe('web');
  });
});

describe('pathsOverlap', () => {
  const overlapping: [string, string][] = [
    ['src/api/users.ts', 'src/api/users.ts'],
    ['src/api/users.ts', './src/api/users.ts'],
    ['src/api', 'src/api/users.ts'], // folder contains file
    ['src/api/', 'src/api/routes/users.ts'],
    ['src/api/**', 'src/api/users.ts'],
    ['src/**/*.ts', 'src/api/users.ts'],
    ['src/*.ts', 'src/index.ts'],
    ['src', 'src/**/*.ts'], // folder the glob reaches into
    ['src/*', 'src/api/users.ts'], // file inside a folder the glob matches
    ['src/api/**', 'src/**/*.test.ts'], // two globs sharing a root
    ['**/*.md', 'README.md'],
  ];

  const separate: [string, string][] = [
    ['src/api/users.ts', 'src/api/orders.ts'],
    ['src/api', 'src/apiary/bees.ts'], // prefix of the name, not the folder
    ['src/*.ts', 'src/api/users.ts'], // single star doesn't cross folders
    ['web/**', 'server/index.ts'],
    ['src/**/*.css', 'src/api/users.ts'],
    ['web/src/**', 'server/**'],
  ];

  it.each(overlapping)('%s overlaps %s', (a, b) => {
    expect(pathsOverlap(a, b)).toBe(true);
    expect(pathsOverlap(b, a)).toBe(true);
  });

  it.each(separate)('%s does not overlap %s', (a, b) => {
    expect(pathsOverlap(a, b)).toBe(false);
    expect(pathsOverlap(b, a)).toBe(false);
  });
});
