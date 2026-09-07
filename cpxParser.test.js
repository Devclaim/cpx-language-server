'use strict';

/**
 * Parser test suite for cpxParser.js.
 *
 * Test cases are derived from:
 *  - component-engine/test/Examples/*.cpx  (real-world components)
 *  - component-engine/test/Grammar/*       (grammar-level cases)
 *  - component-engine/test/Behavior/Rendering/  (feature specs)
 *
 * Run with:  node cpxParser.test.js
 */

const { parseCPX } = require('./cpxParser.js');

let passed = 0;
let failed = 0;

function ok(label, source) {
    const errors = parseCPX(source);
    if (errors.length === 0) {
        console.log(`  ✓  ${label}`);
        passed++;
    } else {
        console.log(`  ✗  ${label}`);
        console.log(`       got: ${errors[0].message} @ ${errors[0].startLine}:${errors[0].startCol}`);
        failed++;
    }
}

function fail(label, source, expectedSubstring) {
    const errors = parseCPX(source);
    if (errors.length > 0 && (!expectedSubstring || errors[0].message.includes(expectedSubstring))) {
        console.log(`  ✓  ${label}`);
        passed++;
    } else if (errors.length === 0) {
        console.log(`  ✗  ${label}  (expected error but parsed OK)`);
        failed++;
    } else {
        console.log(`  ✗  ${label}`);
        console.log(`       expected message containing: "${expectedSubstring}"`);
        console.log(`       got: "${errors[0].message}"`);
        failed++;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap an expression in a minimal component so parseCPX can check it. */
function component(renderBody) {
    return `export component X {\n  render ${renderBody}\n}`;
}

function componentWithProp(prop, renderBody) {
    return `export component X {\n  ${prop}\n  render ${renderBody}\n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. COMPONENT-ENGINE EXAMPLE FILES
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Example files (component-engine/test/Examples/) ──────────────────────');

ok('Empty.cpx', `export component Empty { render "" }`);

ok('Text.cpx', `export component Text {
  text: string
  render <p>{text}</p>
}`);

ok('Image.cpx', `export component Image {
  src: string
  alt: string
  title: string
  render <img src={src} alt={alt} title={title} />
}`);

ok('ImageStruct.cpx', `export struct ImageStruct {
  src: string
  alt: string
  title: ?string
}`);

ok('ImageLoadingMethod.cpx', `export enum ImageLoadingMethod {
  EAGER("eager")
  LAZY("lazy")
}`);

ok('TrafficLight.cpx', `export enum TrafficLight {
  RED(1)
  YELLOW(2)
  GREEN(3)
}`);

ok('DayOfWeek.cpx', `export enum DayOfWeek {
  MONDAY
  TUESDAY
  WEDNESDAY
  THURSDAY
  FRIDAY
  SATURDAY
  SUNDAY
}`);

ok('ButtonType.cpx', `export enum ButtonType {
  LINK
  BUTTON
  SUBMIT
  NONE
}`);

ok('Fragments.cpx', `export component Fragments {
  render <>
    Some Text
    <div>A Div</div>
    Some More Text
    <>A Fragment</>
    <a>
      <b>
        <>Some</>
        <>More</>
        <>Fragments</>
      </b>
    </a>
  </>
}`);

ok('TextWithImage.cpx', `from "./Text.cpx" import { Text }

export component TextWithImage {
  src: string
  alt: string
  title: string
  text: string
  render <div class="text-with-image">
    <img class="image" src={src} alt={alt} title={title} />
    <p class="text">
      <Text text={text}/>
    </p>
  </div>
}`);

ok('ButtonWithMatch.cpx', `from "./ButtonType.cpx" import { ButtonType }

export component ButtonWithMatch {
  type: ButtonType
  content: slot
  render match (type) {
    ButtonType.LINK -> (
      <a class="btn" href="#">{content}</a>
    ),
    ButtonType.BUTTON,
    ButtonType.SUBMIT -> (
      <button
        class="btn"
        type={match (type) {
          ButtonType.SUBMIT -> "submit",
          default -> "button",
        }}
      >
        {content}
      </button>
    ),
    ButtonType.NONE -> (
      <div class="btn">{content}</div>
    ),
  }
}`);

ok('Expression.cpx', `export component Expression {
  a: number
  b: number
  render a <= 120
    ? b || a || 17
    : b && a
}`);

ok('Numbers.cpx – decimal, binary, octal, hex in ||', `export component Numbers {
  render
  0 ||
  1234567890 ||
  42 ||
  0b10000000000000000000000000000000 ||
  0b01111111100000000000000000000000 ||
  0B00000000011111111111111111111111 ||
  0o755 ||
  0o644 ||
  0xFFFFFFFFFFFFFFFFF ||
  0x123456789ABCDEF ||
  0xA
}`);

ok('DeeplyNested.cpx', `export component DeeplyNested {
  render <ul>
    <li></li>
    <li></li>
    <li>
      <ul>
        <li>
          <dl>
            <dt></dt>
            <dd>Bottom.</dd>
          </dl>
        </li>
      </ul>
    </li>
  </ul>
}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Imports ──────────────────────────────────────────────────────────────');

ok('single import', `from "Pkg/Button/Button.cpx" import { Button }
export component X { render <Button/> }`);

ok('multiple imports from same file', `from "Pkg/A.cpx" import { Foo, Bar, Baz }
export component X { render <Foo/> }`);

ok('import with alias', `from "Pkg/A.cpx" import { Foo as F }
export component X { render <F/> }`);

ok('multiple from statements', `from "Pkg/A.cpx" import { A }
from "Pkg/B.cpx" import { B }
export component X { render <A/> }`);

ok('package-relative import path', `from "Vendor.Package/Component/Component.cpx" import { Component }
export component X { render <Component/> }`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. DECLARATIONS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Declarations ─────────────────────────────────────────────────────────');

ok('struct – no props', `export struct Empty {}`);

ok('struct – all type variants', `export struct S {
  a: string
  b: ?string
  c: integer
  d: boolean
  e: MyType
  f: list<Button>
  g: Red | Green | Blue
}`);

ok('enum – no values', `export enum Status { Active Inactive }`);

ok('enum – string values', `export enum ImageLoading {
  EAGER("eager")
  LAZY("lazy")
}`);

ok('enum – integer values', `export enum Priority {
  LOW(1)
  MEDIUM(2)
  HIGH(3)
}`);

ok('component – no props', `export component Logo { render <svg/> }`);

ok('component – with props', `export component Card {
  title: string
  body: ?string
  render <div>{title}</div>
}`);

ok('component – slot prop', `export component Wrapper {
  content: slot
  render <div>{content}</div>
}`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. EXPRESSIONS – PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Expressions: primitives ──────────────────────────────────────────────');

ok('null literal', component('null'));
ok('true literal', component('true'));
ok('false literal', component('false'));
ok('decimal integer', component('42'));
ok('zero', component('0'));
ok('binary integer', component('0b1010'));
ok('binary integer uppercase B', component('0B1010'));
ok('octal integer', component('0o755'));
ok('hex integer lowercase', component('0xff'));
ok('hex integer uppercase X', component('0XFF'));
ok('string literal – simple', component('"hello"'));
ok('string literal – empty', component('""'));
ok('string literal – with interpolation', component('"Hello {name}!"'));
ok('string literal – with escape sequences', component('"a\\nb\\tc"'));
ok('array literal – empty', component('[]'));
ok('array literal – items', component('[1, 2, 3]'));
ok('array literal – mixed', component('[foo, "bar", 42]'));

// ─────────────────────────────────────────────────────────────────────────────
// 5. EXPRESSIONS – OPERATORS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Expressions: operators ───────────────────────────────────────────────');

ok('unary !', componentWithProp('a: boolean', '!a'));
ok('unary !! (double negation)', componentWithProp('a: boolean', '!!a'));
ok('access .', componentWithProp('item: Data', 'item.label'));
ok('access chain', componentWithProp('item: Data', 'item.a.b.c'));
ok('optional access ?.', componentWithProp('item: ?Data', 'item?.label'));
ok('optional + regular access chain', componentWithProp('item: ?Data', 'item?.a.b?.c'));
ok('access with whitespace', componentWithProp('item: Data', 'item  .  label'));
ok('access with comments', componentWithProp('item: Data', `item
  // access
  .label`));
ok('binary ===', componentWithProp('a: string', 'a === "foo"'));
ok('binary !==', componentWithProp('a: string', 'a !== "foo"'));
ok('binary <', componentWithProp('a: integer', 'a < 10'));
ok('binary >', componentWithProp('a: integer', 'a > 10'));
ok('binary >=', componentWithProp('a: integer', 'a >= 10'));
ok('binary <=', componentWithProp('a: integer', 'a <= 10'));
ok('binary &&', componentWithProp('a: boolean\n  b: boolean', 'a && b'));
ok('binary ||', componentWithProp('a: boolean\n  b: boolean', 'a || b'));
ok('null-coalescing ??', componentWithProp('a: ?string', 'a ?? "default"'));
ok('ternary ? :', componentWithProp('a: boolean', 'a ? "yes" : "no"'));
ok('nested ternary', componentWithProp('a: boolean\n  b: boolean', 'a ? "a" : b ? "b" : "c"'));
ok('bracketed expression', componentWithProp('a: boolean', '(a)'));
ok('integer operands in ||', componentWithProp('a: integer', 'a || 0 || 42'));
ok('integer operands in &&', componentWithProp('a: integer', 'a && 1'));
ok('precedence: comparison before &&', componentWithProp('a: integer\n  b: integer', 'a > 0 && b > 0'));
ok('precedence: && before ||', componentWithProp('a: boolean\n  b: boolean\n  c: boolean', 'a && b || c'));
ok('precedence: ?? after ||', componentWithProp('a: ?boolean\n  b: ?boolean', 'a || b ?? false'));

// ─────────────────────────────────────────────────────────────────────────────
// 6. MATCH EXPRESSIONS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Match expressions ────────────────────────────────────────────────────');

ok('match – compact', componentWithProp('x: T', 'match(x){A->B}'));
ok('match – spaced', componentWithProp('x: T', 'match (x) { A -> B }'));
ok('match – parenthesized subject', componentWithProp('x: T', 'match (x) { A -> B }'));
ok('match – default arm', componentWithProp('x: T', 'match (x) { A -> B, default -> C }'));
ok('match – trailing comma', componentWithProp('x: T', 'match (x) { A -> B, }'));
ok('match – multiple left values', componentWithProp('x: T', 'match (x) { A, B -> C, default -> D }'));
ok('match – multi-arm', componentWithProp('x: T', `match (x) {
  A, B -> foo,
  C, D -> bar,
  default -> baz
}`));
ok('match – tag result', componentWithProp('x: T', 'match (x) { A -> <span>a</span>, default -> <span>b</span> }'));
ok('match – nested match', componentWithProp('x: T\n  y: U', `match (x) {
  A -> match (y) { P -> "p", default -> "q" },
  default -> "z"
}`));
ok('match – with comments', componentWithProp('x: T', `match // comment
  (x) { // comment
  A -> B // comment
}`));

// ─────────────────────────────────────────────────────────────────────────────
// 7. TAGS AND FRAGMENTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Tags and fragments ───────────────────────────────────────────────────');

ok('self-closing tag', component('<br/>'));
ok('self-closing with attributes', component('<img src="a.png" alt=""/>'));
ok('open/close tag – empty', component('<div></div>'));
ok('open/close tag – text content', component('<p>Hello world</p>'));
ok('tag – boolean attribute', component('<input disabled/>'));
ok('tag – string attribute', component('<div class="foo">x</div>'));
ok('tag – expression attribute', componentWithProp('cls: string', '<div class={cls}/>'));
ok('tag – multiple attributes', component('<a href="/" class="link" target="_blank">text</a>'));
ok('tag – XML namespaced name', component('<x:foo/>'));
ok('tag – hyphenated name', component('<my-element/>'));
ok('tag – uppercase (component)', component('<MyComponent/>'));
ok('fragment empty', component('<></>'));
ok('fragment with children', component('<><div/><span/></>'));
ok('nested tags', component('<ul><li>a</li><li>b</li></ul>'));
ok('tag – child interpolation', componentWithProp('msg: string', '<p>{msg}</p>'));
ok('tag – child interpolation empty {}', component('<div>{}</div>'));
ok('tag – xml char ref in content', component('<p>&amp;</p>'));
ok('tag – ternary child', componentWithProp('x: boolean', '<div>{x ? "yes" : "no"}</div>'));
ok('tag – match child', componentWithProp('x: T', '<div>{match (x) { A -> "a", default -> "b" }}</div>'));
ok('deeply nested', component(`<div>
  <section>
    <article>
      <p>Deep content</p>
    </article>
  </section>
</div>`));

// ─────────────────────────────────────────────────────────────────────────────
// 8. RENDERING SCENARIOS (from Behavior feature files)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Rendering scenarios (from feature specs) ─────────────────────────────');

ok('ternary render', `export component Expression {
  aBoolean: boolean
  render aBoolean ? "this is true" : "no false"
}`);

ok('null-coalescing render', `export component Expression {
  aString: ?string
  render aString ?? "aString is null"
}`);

ok('component with slot', `export component Layout {
  content: slot
  render <div class="layout">{content}</div>
}`);

ok('component instantiation in render', `from "Button.cpx" import { Button }

export component Page {
  render <Button label="Click me"/>
}`);

ok('enum access in match', `from "./DayOfWeek.cpx" import { DayOfWeek }

export component Day {
  day: DayOfWeek
  render match day {
    DayOfWeek.MONDAY -> <span>Monday</span>,
    DayOfWeek.FRIDAY -> <span>Friday</span>,
    default -> <span>Other</span>
  }
}`);

ok('string interpolation', `export component Greeting {
  name: string
  render <p>{"Hello, {name}!"}</p>
}`);

ok('html attributes with expressions', `export component Link {
  href: string
  label: string
  render <a href={href} class="link">{label}</a>
}`);

ok('conditional class attribute', `export component Button {
  primary: boolean
  label: string
  render <button class={primary ? "btn-primary" : "btn-secondary"}>{label}</button>
}`);

ok('optional chaining in render', `export component Card {
  image: ?ImageStruct
  render <img src={image?.src ?? ""} alt={image?.alt ?? ""}/>
}`);

// ─────────────────────────────────────────────────────────────────────────────
// 9. COMMENTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Comments ─────────────────────────────────────────────────────────────');

ok('single-line comment before render', `export component X {
  // This is a comment
  render <div/>
}`);

ok('single-line comment in render expression', `export component X {
  render // render something
    <div/>
}`);

ok('block comment', `export component X {
  /* A block comment */
  render <div/>
}`);

ok('comment in match', componentWithProp('x: T', `match /* subject */ (x) {
  // arm
  A -> B
}`));

ok('comment between access chain', componentWithProp('item: Data', `item
  // fetch bar
  .bar
  // then baz
  .baz`));

// ─────────────────────────────────────────────────────────────────────────────
// 10. ERROR CASES
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Error cases ──────────────────────────────────────────────────────────');

fail('missing export keyword', `component X { render <div/> }`, 'Expected keyword "export"');
fail('missing declaration after export', `export X {}`, 'Expected "component", "enum", or "struct"');
fail('unknown keyword after export', `export function X() {}`, 'Expected "component", "enum", or "struct"');
fail('component missing render', `export component X { name: string }`, 'Expected keyword "render"');
fail('mismatched closing tag', `export component X { render <div><span></div></span> }`, 'Mismatched closing tag');
fail('unterminated string literal', 'export component X { render "hello }', 'Expected "\""');
fail('bad char in expression', `export component X { render {!} }`, null);
fail('junk after declaration', `export component X { render <div/> } garbage`, 'Unexpected content after declaration');
fail('string literal in && (right)', `export component X {
  a: boolean
  render <div>{a && "text"}</div>
}`, 'String literal is not allowed inside a logic operation');
fail('string literal in && (left)', `export component X {
  render <div>{"text" && true}</div>
}`, 'String literal is not allowed inside a logic operation');
fail('string literal in ||', `export component X {
  a: boolean
  render <div>{a || "fallback"}</div>
}`, 'String literal is not allowed inside a logic operation');
fail('missing arrow in match arm', `export component X {
  x: T
  render match (x) { A B }
}`, null);
fail('empty enum body', `export enum E {}`, null);
fail('missing closing brace in component', `export component X { render <div/>`, '"}"');
// `Type[]` collection shorthand was replaced by generic `list<Type>` syntax
// in component-engine 1.0.0-alpha4/5 — `[]` is no longer valid grammar.
fail('boolean[] is no longer valid syntax', `export component X {
  items: boolean[]
  render <div />
}`, null);
fail('component[] is no longer valid syntax', `export component X {
  items: Button[]
  render <div />
}`, null);

ok('list<boolean> is allowed', `export component X {
  items: list<boolean>
  render <div />
}`);
ok('list<string> is allowed', `export component X {
  items: list<string>
  render <div />
}`);
ok('list<number> is allowed', `export component X {
  items: list<number>
  render <div />
}`);
ok('list<slot> is allowed', `export component X {
  items: list<slot>
  render <div />
}`);
ok('list<component> is allowed', `export component X {
  items: list<Button>
  render <div />
}`);
ok('nested generic type', `export component X {
  items: list<list<Button>>
  render <div />
}`);
ok('generic type with multiple arguments', `export component X {
  items: list<Foo, Bar>
  render <div />
}`);
ok('generic type with trailing comma', `export component X {
  items: list<Foo, Bar,>
  render <div />
}`);
ok('generic type with whitespace and comments', `export component X {
  items: list<
    // comment
    Foo,
    /* comment */ Bar,
  >
  render <div />
}`);
fail('space before "<" is not allowed', `export component X {
  items: list <Foo>
  render <div />
}`, null);

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
