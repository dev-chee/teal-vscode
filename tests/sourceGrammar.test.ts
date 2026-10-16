import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { IGrammar, Registry } from 'vscode-textmate';
import { createGrammarRegistry, scopesAt } from './helpers/grammar';

let registry: Registry;
let grammar: IGrammar;
before(async () => {
    registry = await createGrammarRegistry();
    const loaded = await registry.loadGrammar('source.teal');
    assert.ok(loaded);
    grammar = loaded;
});
after(() => registry?.dispose());

function expectScope(source: string, word: string, scope: string): void {
    const scopes = scopesAt(grammar, source, word);
    assert.ok(scopes.includes(scope), `${word}: expected ${scope}, got ${scopes.join(', ')}`);
}

test('source attributes cover configuration, custom attributes and reflection projections', () => {
    for (const source of [
        '@optimization("aggressive");',
        '@edition("2026");',
        '@build_profile("release");',
        '@compiler_debug(false);',
        '@debug_info(true);',
        '@lint { unused: "warn" };',
        '@model("provider/model") agent Worker {}',
        '@options { max_turns: 8 } agent Worker {}',
        '@role("assistant") agent Worker {}',
        '@attribute class Route { path: string }',
        '@allow("unused-private-type") class Point {}',
        '@Route { path: "/" } fn index() {}',
        '@Mode.safe { level: 2 } fn index() {}',
        'let path = reflect(fn index).@Route.path;',
        'let attributes=@custom;',
    ]) {
        const attribute = source.match(/@[A-Za-z_][A-Za-z_0-9]*/)![0];
        expectScope(source, attribute, 'entity.other.attribute-name.teal');
        expectScope(source, attribute.slice(1), 'entity.other.attribute-name.teal');
    }
    for (const source of ['@tools::requires("gpu")', '@tools :: requires("gpu")', 'reflect(index).@web::Route.path']) {
        const name = source.includes('requires') ? 'requires' : 'Route';
        expectScope(source, name, 'entity.other.attribute-name.teal');
    }
    assert.ok(!scopesAt(grammar, 'reflect(index).@Route.path', 'path').includes('entity.other.attribute-name.teal'));
});

test('declaration names, receiver, wildcard and namespace paths have dedicated scopes', () => {
    for (const source of ['pub fn identity<T>(value: T) -> T {}', 'task identity<T>() -> T {}']) {
        expectScope(source, 'identity', 'entity.name.function.teal');
    }
    for (const keyword of ['class', 'struct', 'enum', 'trait', 'agent']) {
        expectScope(`${keyword} Example {}`, 'Example', 'entity.name.type.teal');
        expectScope(`${keyword} lower_case {}`, 'lower_case', 'entity.name.type.teal');
    }
    expectScope('type PointList = Point[];', 'PointList', 'entity.name.type.teal');
    expectScope('trait Collection { type Item; }', 'Item', 'entity.name.type.teal');
    expectScope('pub const LIMIT = 3;', 'LIMIT', 'variable.other.constant.teal');
    expectScope('return self.value;', 'self', 'variable.language.teal');
    expectScope('match result { _ => 0 }', '_', 'constant.language.teal');
    expectScope('_ = operation();', '_', 'constant.language.teal');
    expectScope('std::math::abs(-1)', 'std', 'entity.name.namespace.teal');
    expectScope('std::math::abs(-1)', 'math', 'entity.name.namespace.teal');
    expectScope('std::math::abs(-1)', 'abs', 'entity.name.function.teal');
    for (const word of ['selfish', '_value', 'className', 'identity']) {
        assert.deepEqual(scopesAt(grammar, `let ${word} = 1;`, word), ['source.teal']);
    }
});

test('interpolation highlights qualified variable and field paths while preserving literal escapes', () => {
    const source = String.raw`let message = "{{literal}} \{escaped} {user.name} {module::item.field} {self.value}\n";`;
    expectScope(source, 'literal', 'string.quoted.double.teal');
    expectScope(source, '{{', 'constant.character.escape.teal');
    expectScope(source, '\\{', 'constant.character.escape.teal');
    expectScope(source, '\\n', 'constant.character.escape.teal');
    expectScope(source, 'user', 'variable.other.readwrite.teal');
    expectScope(source, 'name', 'variable.other.property.teal');
    expectScope(source, 'module', 'entity.name.namespace.teal');
    expectScope(source, 'item', 'variable.other.readwrite.teal');
    expectScope(source, 'field', 'variable.other.property.teal');
    expectScope(source, 'self', 'variable.language.teal');
    assert.ok(!scopesAt(grammar, source, 'literal').includes('meta.interpolation.teal'));
    assert.ok(!scopesAt(grammar, source, 'escaped').includes('meta.interpolation.teal'));
});

test('comments and multiline strings isolate attributes and declarations from surrounding code', () => {
    for (const source of ['// @optimization("none") class Example self _', '"@optimization class Example self _"', '"first line\n@optimization class Example self _\nlast line"']) {
        for (const word of ['@optimization', 'Example', 'self', '_']) {
            const scopes = scopesAt(grammar, source, word);
            assert.ok(scopes.includes(source.startsWith('//') ? 'comment.line.double-slash.teal' : 'string.quoted.double.teal'));
            assert.ok(!scopes.some((scope) => /^(entity\.|variable\.|constant.language)/.test(scope)), `${word}: ${scopes}`);
        }
    }
    expectScope('"line one\nline two";\n@optimization("none");', '@optimization', 'entity.other.attribute-name.teal');
    expectScope('"broken {value";\n@optimization("none");', '@optimization', 'entity.other.attribute-name.teal');
});

test('existing keyword, literal, label, type and operator coverage remains intact', () => {
    for (const word of ['if', 'else', 'match', 'for', 'in', 'try', 'catch', 'return', 'break', 'continue', 'loop', 'await']) {
        expectScope(word, word, 'keyword.control.teal');
    }
    for (const word of ['dylib', 'host', 'import', 'pub', 'impl', 'trait', 'as', 'fn', 'class', 'enum', 'let', 'static', 'const', 'reflect', 'struct', 'type', 'agent', 'task']) {
        expectScope(word, word, 'storage.type.teal');
    }
    for (const word of ['int', 'float', 'bool', 'string', 'Task', 'Error']) {
        expectScope(word, word, 'support.type.teal');
    }
    for (const word of ['none', 'true', 'false']) expectScope(word, word, 'constant.language.teal');
    for (const word of ['42', '0.5', '.5', '2147483648']) expectScope(`-${word}`, word, 'constant.numeric.teal');
    expectScope('1..10', '..', 'keyword.operator.teal');
    expectScope('1..10', '10', 'constant.numeric.teal');
    expectScope("'outer: loop { break 'outer; }", "'outer", 'entity.name.label.teal');
    for (const operator of ['+=', '-=', '*=', '/=', '%=', '^=', '||', '|', '?', '&&', '==', '!=', '<=', '<', '>=', '>', '+', '-', '*', '/', '%', '^', '!', '=', '@', '..', '::', ':', '=>', '->']) {
        expectScope(operator, operator, 'keyword.operator.teal');
    }
});
