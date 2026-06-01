# Change Log

All notable changes to the "cpx" extension will be documented in this file.

## [0.1.0] - 2026-06-01

### Syntax Highlighting

- Rewrote TextMate grammar from scratch to mirror the complete CPX language spec
- HTML and component tags now correctly scope their body content as plain text — text inside `<span>text</span>` is colored as text even when the tag is nested inside a `{…}` expression
- Attribute zone and tag body zone are cleanly separated: attributes before `>`, text content after
- Closing tags properly color `</`, the tag name, and `>` as distinct tokens
- Fragments (`<>…</>`) highlighted correctly
- String interpolation `"Hello {name}!"` — the `{…}` region highlighted as an embedded expression
- Integer literals in all four bases: decimal, binary `0b`, octal `0o`, hex `0x`
- Operators: `===`, `!==`, `&&`, `||`, `??`, `?.`, `!`, `<`, `>`, `>=`, `<=`
- Match expressions: `match` keyword, subject, arm arrows `->`, `default`
- Single-line and block comments in all positions

### Language Server

- Replaced regex-based validation with a full recursive-descent parser mirroring `grammar.php`
- Syntax error diagnostics with precise line/column squiggles:
  - Unexpected tokens, unclosed strings, unterminated block comments
  - Missing `render` keyword, mismatched or missing closing tags
  - Junk content after a declaration
- Semantic error: string literal used as a logical operand (`message && "text"`) flagged at the string position
- Semantic checks run only when the file is syntax-clean
- Import validation: missing files and unresolved named exports reported as errors
- Component tag validation: undeclared/unimported tags reported as warnings
- Match arm autofill: opening `match (status) {` against an enum-typed prop offers a snippet with all enum members and a `default` arm; falls back to a generic skeleton when the type is unresolvable
- Attribute completions inside open tags (`<MyComponent `) offer declared props as `propName=` snippets
- Struct member completions on `propName.` expressions
- Prop name completions inside `{…}` render expressions
- Auto-import completions insert both the tag snippet and the `from "…" import { … }` line

## [0.0.2]

- Added hover support for CPX components, structs, and enums
- Added prop hovers in component tags, including inline struct and enum details

## [0.0.1]

- Initial placeholder release
- TextMate grammar for experimental CPX syntax highlighting
- CPX-native `render` markup highlighting with uppercase component tags
- Regex-based language server for basic definitions and auto-imports
- Semantic token coloring for CPX type and component references
- Placeholder editor integration for Tailwind, Emmet, and tag helpers
- Not representative of the real CPX grammar
