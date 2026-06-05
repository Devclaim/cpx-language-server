# Change Log

All notable changes to the "cpx" extension will be documented in this file.

## [0.3.0] - 2026-06-05

### Completions

- **Property snippet** — accepting a prop completion now inserts `propName={$1}` with cursor inside the braces; string/slot-typed props insert `propName="$1"` instead
- **Instant value suggestions** — after accepting a prop snippet, the suggestion list opens immediately inside the braces without requiring an extra keystroke
- **Attribute completions fixed** — prop suggestions on component tags were silently blocked inside component bodies due to a false positive in the expression context detector; this is now fixed for both self-closing and regular tags
- **Auto-import enum values** — enum member completions in attribute values (e.g. `size={CopySize.SIZE_MD}`) now work even when the enum type is not yet imported; accepting a member inserts the `from "…" import { EnumType }` line automatically
- **Match keyword triggers earlier** — match snippet suggestions now appear from `ma` onward, rather than requiring the full `match` keyword to be typed
- **Focused match-body suggestions** — typing inside a `match` body only suggests the specific enum being matched on, keeping the list focused; other enum names are still available outside match bodies
- **Nested match expressions** — completions and enum suggestions work correctly inside `{match (x) { … }}` expression blocks; attribute value context inside match arms no longer incorrectly inherits the match subject's enum restriction

### Error Checking

- **Class array string enforcement** — match arm values inside `class={[ … ]}` arrays must be strings; any arm that produces a tag (component or HTML element) is now flagged as an error, since class values are CSS class names and cannot be rendered elements

## [0.2.0] - 2026-06-01

### Error Checking

- **Undeclared prop reference** — identifiers used in render expressions (`match (x)`, `{x}`, access chains `x.field`) that are not declared as props on the enclosing component are now flagged as errors
- **Primitive collection types** — `boolean[]`, `string[]`, `number[]`, and `slot[]` are now flagged at both the parser level and the semantic level (only component/struct types support `[]`)

### Unused Import Warnings

- Imports not referenced anywhere in the file are shown with reduced opacity and a yellow warning squiggle (`DiagnosticTag.Unnecessary`)
- Partial unused imports — where only some names in a multi-name import are unused — highlight the specific unused name rather than the whole import line
- Fixed a false positive where a component name appearing inside a file path string (e.g. `"../Accordion/Accordion.cpx"`) was incorrectly counted as a usage, suppressing the warning

## [0.1.5] - 2026-06-01

### Language Server

- Primitive types (`string`, `number`, `boolean`, `slot`) are now offered as completions when declaring a prop type, alongside enums and components

## [0.1.4] - 2026-06-01

### Bug Fixes

- Fixed completions (component suggestions, prop hints, auto-imports) becoming stale after typing — indexing now runs immediately on every change; only diagnostic squiggles are debounced

## [0.1.3] - 2026-06-01

### Syntax Highlighting

- `EnumName.MEMBER` access expressions now correctly color the member as `variable.other.enummember.js` (blue) instead of the class/type color (teal)

### Language Server

- Match completions now appear while typing `mat`/`matc`/`match` — no longer requires a trailing space to trigger
- Fixed match snippet eating the `match` keyword on insertion — completion now uses an explicit text edit range covering from `match` to the cursor
- Fixed spurious error squiggle appearing immediately after inserting a match snippet — validation is debounced (300 ms) so rapid edits don't fire on a transient document state
- Fixed component suggestions and other completions being blocked when match context was detected but no enum props were found

## [0.1.2] - 2026-06-01

### Bug Fixes

- Fixed language server not starting after VSIX install — dependencies are now bundled correctly

## [0.1.1] - 2026-06-01

### Language Server

- Match arm snippets now use the file's actual indentation (tabs or spaces) instead of hardcoded two-space indent

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
