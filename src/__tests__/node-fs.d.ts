// The one Node call the tests make (look.test.ts reads the stylesheets from
// disk); the project has no Node types.
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
