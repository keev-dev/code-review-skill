# Vendored code renderer

`pierre-diffs.js` is a local browser bundle of `@pierre/diffs@1.6.2`.

- Source: `@pierre/diffs@1.6.2`
- License: Apache-2.0. See `pierre-diffs.LICENSE.md`.
- Bundle format: IIFE with the global name `PierreDiffs`.
- Build tool: esbuild 0.25.0.
- SHA-256: `D14C3520B3645B04E515ED1E837097104B84D665493085C92E6AEBD04CF0EEA7`

The bundle exports `File` and `FileDiff`. It is built once and committed so the skill makes no external network requests.

Rebuild entry:

```js
export { File, FileDiff } from "@pierre/diffs";
```

```sh
esbuild entry.js --bundle --format=iife --global-name=PierreDiffs --platform=browser --minify --legal-comments=inline --outfile=pierre-diffs.js
```
