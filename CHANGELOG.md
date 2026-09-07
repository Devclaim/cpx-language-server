# Change Log

All notable changes to the "cpx" extension will be documented in this file.

## [0.4.1] - 2026-06-19

### HTML Tag Completions & Auto-close

- **HTML tag completions** — typing `<` now suggests all standard HTML tags alongside CPX components; void elements (`br`, `img`, `input`, `hr`, …) complete as self-closing `<br />`, regular elements complete as paired `<div>cursor</div>`
- **Auto-close on typing `>`** — when an opening tag is completed with `>`, the matching closing tag is inserted automatically via LSP `onTypeFormatting`; self-closing and void elements are excluded; works in VS Code and PhpStorm (LSP4IJ) without any extra extensions or settings
- **`editor.formatOnType` enabled by default** — the extension now sets this for `.cpx` files so auto-close works out of the box in VS Code
- **Generic list type syntax** — the parser now follows component-engine 1.0.0-alpha4/5: the old `Type[]` collection shorthand is gone, replaced by generic `list<Type>` syntax (including unions, nesting, multiple type arguments, trailing commas, and whitespace/comments inside `<…>`); `Type[]` is now correctly flagged as a syntax error
- **`list<Type>`-typed props are no longer invisible** — the property indexer used by hover, attribute completion, and match-arm autofill didn't recognize the new generic syntax at all, so any prop declared as `items: list<Foo>` silently vanished from the server's model of the component; fixed, and the obsolete "only components support `[]`" diagnostic (which the same migration made both redundant and wrong) was removed
- **Auto-import for collection props** now inserts `list<Type>` instead of the no-longer-valid `Type[]`, and is offered for any importable kind (component/struct/enum), not just components
- Added `server.integration.test.js` — drives the real `server.js` completion handler in-process (mocking the LSP transport) rather than re-testing standalone copies of its logic, to catch regressions that a real request would hit but an isolated helper wouldn't
- **`editor.quickSuggestions` enabled by default for `.cpx` files** — completions that trigger on typed text rather than a punctuation character (e.g. typing `match` to get the match-block snippet) depend on VS Code's automatic "suggest while typing"; without an explicit default it could stay off depending on the user's global/workspace settings, silently hiding these suggestions while trigger-character-based ones (`<`, `{`, …) kept working normally
- **Fixed: typing/completing inside `list<…>` was mistaken for opening a tag** — the real cause of the bogus `</AccordionItem>` insertion (the previous fix only patched one of several affected spots): `isTagContext`, `getOpenTagContext`, `getOpenHtmlTagContext`, `isClosingTagContext`, `getExistingCloseTagInfo`, and the `>`-auto-close logic all located "the tag" by finding the nearest `<` before the cursor, with no check that it actually opened a tag rather than a generic's argument list (`list<Foo`). All six now share one guard: a `<` directly preceded by an identifier character can never be a real CPX tag's `<`, so it's treated as a generic instead. `isTypeContext` was also extended to recognize being inside the single argument of a `list<…>`, so completions (including auto-import) work correctly while typing it, and the `list<Type>` auto-import suggestion no longer offers a nonsensical `list<list<Foo>>` double-wrap when already inside one
- **`list` now gets keyword coloring** in the TextMate grammar, alongside `boolean`/`string`/`number`/`slot`; the generic's `<…>` brackets and, for multiple type arguments, its commas are now styled as punctuation too — previously `list` in `list<Foo>` rendered as plain unstyled text

## [0.4.0] - 2026-06-12

### Package-Aware Imports

- **Package discovery** — Neos/Flow packages are now detected by convention from their `composer.json` (package key from `extra.neos.package-key`, falling back to the psr-4 namespace), with `Components/` as the CPX source root — matching the component-engine build's `CPXPackageLoader`. Packages existing at multiple locations (e.g. `Packages/Plugins/` and a local development copy) are all tracked under the same package key
- **Package-style import resolution** — imports like `from "Sitegeist.PaperTiger.CPX/Error/ErrorProps.cpx" import { ErrorProps }` now resolve for go-to-definition, hover, and validation; when a package exists in several copies, the copy where the file actually exists is preferred
- **Cross-package auto-imports** — auto-import now generates package-style paths (`Vendor.Package/Sub/Path.cpx`) when the target lives in a different package, and relative paths only within the same package — no more `../../../../../Packages/…` imports that the build can't resolve
- **One suggestion per package** — components sharing a name across packages each get their own auto-import suggestion (instead of an arbitrary single winner); same-package suggestions rank first, and exports outside any package source root (vendor copies, test fixtures) are excluded

### Error Checking

- **Escaping relative imports** — a relative import that resolves outside its package's `Components/` root is flagged as an error, with a quick fix that converts it to the equivalent package-style import
- **Unknown package keys** — package-style imports referencing a package key not found in the workspace are flagged with a warning
- **Missing imports are errors** — using a component tag or prop type that is not imported or locally declared is now an error (previously a warning that was suppressed whenever a same-named export existed anywhere in the workspace); a quick fix offers `Import X from "…"` for every valid source

### Bug Fixes

- **Null literals on optional props** — `width={null}` on a `?number` prop no longer reports "expects ?number, not a null literal"; null is accepted for optional (`?`) prop types and types that explicitly include `null`

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
