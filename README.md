# Component Engine (CPX) Language Support

VS Code extension for `.cpx` files — the template language of [Component Engine](https://codeberg.org/PackageFactory/component-engine).

---

## Syntax Highlighting

The extension ships a full TextMate grammar that covers the complete CPX language spec as defined in `grammar.php`.

### Declarations

Top-level keywords `export component`, `export struct`, and `export enum` are highlighted, along with their names and body braces. Import statements (`from "…" import { … }`) highlight the path string and imported symbol names separately.

### Property declarations

Inside component and struct bodies, property declarations of the form `name: Type` are highlighted with the name as a variable token and the type as a type token. This covers:

- Primitive types: `string`, `boolean`, `integer`, `number`, `slot`
- Optional types: `?Type`
- Array types: `Type[]`
- Union types: `TypeA | TypeB | TypeC`
- Imported types: `MyEnum`, `MyStruct`

### The render block

The `render` keyword is highlighted as a control-flow keyword. Everything after it is treated as an expression, which means full expression highlighting including:

- Identifiers referencing props
- Operators: `===`, `!==`, `<`, `>`, `>=`, `<=`, `&&`, `||`, `??`, `?.`, `!`
- String literals with interpolation: `"Hello {name}!"` — the `{…}` regions inside strings are highlighted as embedded JavaScript
- Integer literals in all forms: decimal `42`, binary `0b1010`, octal `0o755`, hexadecimal `0xFF`
- `null`, `true`, `false` as keyword literals
- Array literals: `[a, b, c]`
- Parenthesized expressions: `(a && b)`
- Ternary expressions: `condition ? a : b`
- Null-coalescing: `value ?? fallback`
- Access chains: `item.field?.nested`

### Tags

CPX uses HTML-like tag syntax inside render expressions. The highlighter distinguishes:

- **Lowercase tags** (`<div>`, `<span>`, `<img/>`) — highlighted as HTML element tags, with Tailwind CSS IntelliSense active inside `class="…"` attribute values
- **Uppercase tags** (`<MyComponent>`, `<Button/>`) — highlighted as type/class references, visually distinct from HTML elements
- **Fragments** (`<>…</>`) — both angle brackets highlighted as punctuation
- Self-closing tags (`<br/>`, `<img src="…"/>`)
- Boolean attributes (`disabled`, `data-custom-thing`)
- Expression attributes: `class={cls}` — the `{…}` region is highlighted as an embedded expression
- String attributes: `href="/"`
- XML character references: `&amp;`, `&#x2F;`

### Match expressions

The `match` keyword is highlighted as a control keyword. The subject expression and each arm's `->` arrow are highlighted. Inside match bodies, tag results are fully highlighted as CPX markup.

### Comments

Both `// single-line` and `/* block */` comments are highlighted correctly, including inside render expressions, between match arms, and between access chain steps.

---

## Completions and Helpers

### Component tag scaffolding

Typing `<` followed by an uppercase letter triggers component completions. For each known component (local or workspace):

- If the component has a `content: slot` prop, the snippet expands to `<Name>$0</Name>`
- Otherwise it expands to `<Name prop1={$1} prop2={$2} />`

Components not yet imported are offered as **auto-import** completions — accepting one inserts both the tag snippet and the `from "…" import { … }` line at the top of the file.

### Attribute completions

Inside an open tag (`<MyComponent `), the extension offers the component's declared props as attribute completions. Accepting a prop inserts `propName=` ready for a value.

### Struct member completions

Typing `propName.` where `propName` is declared as a struct type triggers completions for all fields of that struct, with their types shown as detail.

### Prop name completions in expressions

Inside `{…}` in a render body or attribute, the extension offers all props declared on the enclosing component.

### Match arm autofill

This is the main CPX-specific helper. When you open a match body against a prop whose type is a known enum:

```cpx
render match (status) {
  // ← cursor here, trigger completion
```

The extension offers a single **`StatusEnum arms`** snippet that expands to all enum members plus a `default` arm:

```cpx
render match (status) {
  Status.ACTIVE -> $1,
  Status.INACTIVE -> $2,
  Status.PENDING -> $3,
  default -> $0
}
```

The enum members are read from the actual source — either defined locally or resolved through the import index. If the subject type cannot be resolved to a known enum, a generic two-arm skeleton is offered instead.

The snippet uses the file's own indentation style (tabs or spaces) so the inserted arms always match your existing code.

---

## Error Checking

The extension runs a full recursive-descent parser on every keystroke — built to mirror `grammar.php` exactly — and reports the first syntax or semantic error as a red squiggle with a precise line/column position.

### Syntax errors

Any deviation from the CPX grammar is caught immediately:

- **Unexpected tokens** — `{message 32rr3 "test"}` reports the position of the unexpected character
- **Unclosed strings** — `"hello` reports the missing closing quote
- **Missing keywords** — a component body without `render` reports the expected keyword
- **Unterminated block comments** — `/* comment` reports the missing `*/`
- **Junk after declaration** — content after the closing `}` of an export is flagged

### Tag errors

- **Mismatched closing tags** — `<div><span></div>` reports the wrong tag name at the closing position
- **Missing closing tag** — `<div><span>` reports the missing `</span>`

### Semantic errors enforced by the transpiler

These are rules beyond pure syntax that the CPX build step enforces:

- **String literal in a logic operation** — `message && "text"` is flagged. The `&&` and `||` operators require boolean-compatible operands; a string literal can never be used directly as one. The error points to the string literal.
- **Primitive collection type** — `boolean[]`, `string[]`, `number[]`, and `slot[]` are not valid — only component and struct types support `[]`. The error points to the type.
- **Undeclared prop reference** — A lowercase identifier used in a render expression (`match (columns)`, `{button}`, `item.field`) that is not declared as a prop on the enclosing component is flagged with a red squiggle. Deleting a prop declaration while it is still referenced in the render body immediately surfaces the error at every usage site.

### Unused import warnings

Imports that are never referenced in the file (not used as a component tag, prop type, or enum member access) are shown with reduced opacity and a yellow warning underline, matching the standard VS Code "unnecessary code" style. Partial unused imports — where only some names in a multi-name import are unused — are highlighted per-name rather than on the whole import line.

### What is NOT checked

- Type mismatches between a prop's declared type and what is passed at a call site
- Missing required props on component instantiation
- Import paths that don't exist on disk (these are caught as warnings by the semantic layer, not the parser)

---

## Tailwind CSS

Tailwind CSS IntelliSense is activated for `.cpx` via the bundled dependency on `bradlc.vscode-tailwindcss`. Class completions work inside `class="…"` attribute values on any tag.

If class completions don't appear, add this to your VS Code settings:

```json
{
  "tailwindCSS.includeLanguages": {
    "cpx": "html"
  }
}
```

---

## Development

```bash
npm install
```

Press `F5` in VS Code to open a development host. The extension activates on any `.cpx` file.

Run the parser test suite (127 tests covering all grammar constructs and error cases):

```bash
node cpxParser.test.js
```

## Packaging

```bash
npx @vscode/vsce package
```
