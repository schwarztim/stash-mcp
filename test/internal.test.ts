import { internal } from '../src/index.ts';

describe('internal helpers', () => {
  test('buildAuthError returns error when missing config', () => {
    const error = internal.buildAuthError({ baseUrl: '' });
    expect(error).not.toBeNull();
    expect(error?.isError).toBe(true);
  });

  test('buildAuthError returns null when token configured', () => {
    const error = internal.buildAuthError({ baseUrl: 'https://stash.example.com', token: 'token' });
    expect(error).toBeNull();
  });

  test('resolveProject prefers explicit project over default', () => {
    expect(internal.resolveProject('PROJ', 'DEFAULT')).toBe('PROJ');
  });

  test('truncateDiff keeps headers and truncates content', () => {
    const diff = [
      'diff --git a/file.txt b/file.txt',
      'index 123..456 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      '-old line 1',
      '+new line 1',
      '+new line 2',
      '+new line 3',
      '+new line 4',
      '+new line 5',
      '+new line 6',
      '+new line 7',
    ].join('\n');

    const result = internal.truncateDiff(diff, 4);
    expect(result).toContain('diff --git a/file.txt b/file.txt');
    expect(result).toContain('FILE TRUNCATED');
  });
});
