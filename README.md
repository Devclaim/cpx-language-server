# CPX Language

VS Code support for `.cpx` files.

## Status

This extension is placeholder work. It is heavily vibe-coded and not representative of the real CPX grammar. The current implementation is only a rough editor aid for experimentation.

## Current Features

- Syntax highlighting for top-level CPX constructs such as:
  - `from "..."`
  - `import`
  - `export component`
  - `export struct`
  - `export enum`
- Highlighting for typed properties, enums, union types, and `render` blocks
- CPX-native markup highlighting in `render`
- Uppercase component tags highlighted differently from normal HTML-like tags
- JS-like interpolation support inside `{...}`
- Basic go-to-definition for:
  - import paths
  - imported symbols
  - component tags
  - prop type references
  - enums and structs
- Basic auto-import completions for workspace CPX exports
- Struct-member completions for prop access like `link.` when the prop resolves to a CPX `struct`
- Semantic token coloring for component/type references

## Tailwind

Tailwind support is not reliable by default across all setups.

If Tailwind CSS IntelliSense does not activate for `.cpx`, add this to your VS Code settings:

```json
{
  "tailwindCSS.includeLanguages": {
    "cpx": "function"
  }
}
```

## Limitations

- The grammar is not authoritative CPX syntax.
- The language server is regex-based.
- Completion behavior is heuristic-based.
- Emmet suggestions are disabled by default for `cpx` so struct/member completion is usable inside expressions.
- Editor integration with other extensions can still vary by theme and VS Code setup.

## Development

Install dependencies:

```bash
npm install
```

Run the extension in a development host:

```bash
code .
```

Then press `F5` in VS Code.

## Packaging

Build a VSIX:

```bash
npx @vscode/vsce package
```
