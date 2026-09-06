import type { StructuralAnalysis } from "../types.js";
import type { TreeSitterNode as Node } from "./extractors/types.js";

/** Supplemental declarations the structural extractor cannot fully verify.
 * Null means unknown; an empty owner means a file-level binding. */
export interface PossibleSymbol {
  kind: "callable" | "class" | null;
  owner: string | null;
  name: string | null;
  nameSuffix?: string;
  lineRange: [number, number];
  reason: string;
}
export interface SymbolEvidence {
  version: 1;
  possible: PossibleSymbol[];
  functions: Array<{ name: string; owner: string | null; lineRange: [number, number] }>;
}

const CLASS_NODES = new Set(["class", "module", "class_declaration", "class_definition", "class_specifier",
  "struct_specifier", "struct_declaration", "struct_item", "enum_item", "interface_declaration"]);
const FUNCTION_NODES = new Set(["method", "singleton_method", "method_definition", "function_definition",
  "function_declaration", "function_item", "method_declaration", "constructor_declaration", "arrow_function", "function_expression", "lambda"]);
const ACCESSORS = new Set(["attr", "attr_reader", "attr_writer", "attr_accessor"]);
const RUBY_INSTALLERS = new Set([...ACCESSORS, "define_method", "define_singleton_method", "alias_method"]);
const EVALUATORS = new Set(["eval", "exec", "Function", "class_eval", "module_eval", "instance_eval",
  "class_exec", "module_exec", "instance_exec", "send", "public_send", "__send__"]);
const JS_INSTALLERS = new Set(["defineProperty", "defineProperties", "__defineGetter__", "__defineSetter__"]);
const PY_INSTALLERS = new Set(["setattr", "__setattr__", "new_class"]);
const JS_EVALUATORS = new Set(["eval", "Function"]);
const PY_EVALUATORS = new Set(["eval", "exec"]);

function unescaped(text: string): boolean {
  return !text.includes("\\") && !text.includes("`") && !text.startsWith("@")
    && !text.startsWith("r#") && text.normalize("NFKC") === text;
}
function literal(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "simple_symbol") return unescaped(node.text) ? node.text.slice(1) : null;
  if (["string", "delimited_symbol"].includes(node.type)) {
    if (!unescaped(node.text) || node.namedChildren.some(child =>
      !["string_fragment", "string_content", "string_start", "string_end"].includes(child.type)
      || child.namedChildren.length > 0)) return null;
    return node.namedChildren.filter(child => ["string_fragment", "string_content"].includes(child.type))
      .map(child => child.text).join("");
  }
  return null;
}
function identifier(node: Node | null | undefined): string | null {
  return node && ["identifier", "property_identifier", "private_property_identifier", "field_identifier", "type_identifier", "constant",
    "simple_identifier", "scope_resolution", "scoped_type_identifier", "qualified_identifier",
    "shorthand_property_identifier", "shorthand_property_identifier_pattern"].includes(node.type)
    && unescaped(node.text) ? node.text : null;
}
function declarationName(node: Node | null | undefined): string | null {
  return identifier(node) ?? literal(node);
}
function unwrap(node: Node | null): Node | null {
  while (node && ["parenthesized_expression", "parenthesized_statements"].includes(node.type)
    && node.namedChildren.length === 1) node = node.namedChildren[0];
  return node;
}
function classExpression(node: Node): boolean {
  return node.type === "class" && node.childForFieldName("body")?.type === "class_body";
}
function expressionOwner(node: Node): string | null {
  let value = node;
  while (value.parent?.type === "parenthesized_expression") value = value.parent;
  const parent = value.parent;
  if (parent?.type === "variable_declarator") return identifier(parent.childForFieldName("name"));
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === value.id) {
    return identifier(parent.childForFieldName("left"));
  }
  return null;
}
function lexicalOwner(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "singleton_class") return null;
    if (classExpression(parent)) return expressionOwner(parent);
    if (parent.parent && CLASS_NODES.has(parent.type)) return identifier(parent.childForFieldName("name"));
  }
  return "";
}

interface Scope {
  parent: Scope | null;
  kind: "root" | "class" | "function" | "block";
  bindings: Map<string, Map<number, string | null>>;
  unknownBindings: boolean;
}
/** Resolve class references through lexical bindings; a shadow/reassignment
 * must never turn an unknown receiver into a known, unrelated class. */
function classReferences(root: Node, language: string): {
  owner(node: Node, name: string): string | null;
  unbound(node: Node, name: string): boolean;
} {
  const scopes = new Map<number, Scope>();
  const globalScope: Scope = { parent: null, kind: "root", bindings: new Map(), unknownBindings: false };
  const assignments: Node[] = [];
  const isJS = ["javascript", "typescript", "tsx"].includes(language);
  const targets = (node: Node | null): Array<string | null> => {
    if (!node) return [];
    const name = identifier(node);
    if (name) return [name];
    if (["identifier", "constant", "shorthand_property_identifier_pattern"].includes(node.type)) return [null];
    const pattern = node.childForFieldName("pattern") ?? node.childForFieldName("name")
      ?? node.childForFieldName("left") ?? node.childForFieldName("value");
    if (pattern) return targets(pattern);
    if (["formal_parameters", "parameters", "method_parameters", "object_pattern", "array_pattern", "pattern_list",
      "rest_pattern", "rest_parameter", "splat_parameter", "list_splat_pattern", "dictionary_splat_pattern"].includes(node.type)) {
      return node.namedChildren.flatMap(targets);
    }
    if (node.type === "typed_parameter") return targets(node.namedChildren[0] ?? null);
    return [];
  };
  const bind = (scope: Scope, name: string | null, node: Node, owner: string | null) => {
    if (name === null) { scope.unknownBindings = true; return; }
    if (!scope.bindings.has(name)) scope.bindings.set(name, new Map());
    scope.bindings.get(name)!.set(node.id, owner);
  };
  const scan = (node: Node, parent: Scope) => {
    let scope = parent;
    const isClass = node !== root && CLASS_NODES.has(node.type);
    const isFunction = FUNCTION_NODES.has(node.type);
    const declaresFunctionBinding = isFunction && !["method", "singleton_method", "method_definition",
      "method_declaration", "constructor_declaration", "function_expression"].includes(node.type);
    const name = identifier(node.childForFieldName("name"));
    if (isClass && name) bind(parent, name, node, name);
    else if (declaresFunctionBinding && name) bind(parent, name, node, null);
    else if ((isClass || declaresFunctionBinding) && node.childForFieldName("name")) parent.unknownBindings = true;
    if (isClass || isFunction || isJS && node.type === "statement_block") {
      scope = { parent, kind: isClass ? "class" : isFunction ? "function" : "block", bindings: new Map(), unknownBindings: false };
      if (isClass && name && isJS) bind(scope, name, node, name);
      if (node.type === "function_expression" && node.childForFieldName("name")) bind(scope, name, node, null);
      if (isFunction) for (const parameter of targets(node.childForFieldName("parameters"))) bind(scope, parameter, node, null);
    }
    scopes.set(node.id, scope);
    if (node.type === "variable_declarator") {
      let destination = scope;
      if (node.parent?.type === "variable_declaration") while (destination.kind === "block" && destination.parent) destination = destination.parent;
      for (const target of targets(node.childForFieldName("name"))) bind(destination, target, node, null);
    } else if (["assignment", "augmented_assignment"].includes(node.type) && !isJS) {
      for (const target of targets(node.childForFieldName("left"))) bind(scope, target, node, null);
    } else if (isJS && ["assignment_expression", "augmented_assignment_expression"].includes(node.type)) assignments.push(node);
    if (node.type === "global_statement") {
      const names = [node];
      while (names.length) {
        const part = names.pop()!;
        if (part.type === "identifier") bind(globalScope, identifier(part), node, null);
        names.push(...part.namedChildren);
      }
    }
    if (isJS && node.type === "import_specifier") {
      bind(scope, identifier(node.childForFieldName("alias") ?? node.childForFieldName("name")), node, null);
    } else if (isJS && ["import_clause", "namespace_import", "import_require_clause"].includes(node.type)) {
      for (const part of node.namedChildren.filter(child => child.type === "identifier")) bind(scope, identifier(part), node, null);
    } else if (language === "python" && ["import_statement", "import_from_statement"].includes(node.type)) {
      const module = node.childForFieldName("module_name");
      for (const part of node.namedChildren.filter(child => child.id !== module?.id)) {
        const alias = part.childForFieldName("alias");
        const imported = part.childForFieldName("name") ?? part;
        const local = alias ?? imported.namedChildren.find(child => child.type === "identifier") ?? imported;
        if (["identifier", "dotted_name", "aliased_import"].includes(part.type)) bind(scope, identifier(local), node, null);
        else if (part.type === "wildcard_import") scope.unknownBindings = true;
      }
    }
    for (const child of node.namedChildren) scan(child, scope);
  };
  scan(root, globalScope);
  const binding = (scope: Scope | null, name: string): Map<number, string | null> | null | undefined => {
    while (scope) {
      if (scope.unknownBindings) return null;
      const found = scope.bindings.get(name);
      if (found) return found;
      const leavingFunction = scope.kind === "function";
      scope = scope.parent;
      if (language === "python" && leavingFunction) while (scope?.kind === "class") scope = scope.parent;
    }
    return undefined;
  };
  for (const node of assignments) {
    for (const name of targets(node.childForFieldName("left"))) {
      if (name === null) {
        for (let scope: Scope | null = scopes.get(node.id) ?? globalScope; scope; scope = scope.parent) scope.unknownBindings = true;
        continue;
      }
      const found = binding(scopes.get(node.id) ?? globalScope, name);
      if (found === undefined) bind(globalScope, name, node, null);
      else found?.set(node.id, null);
    }
  }
  return {
    owner(node, name) {
      const found = binding(scopes.get(node.id) ?? globalScope, name);
      return found?.size === 1 ? [...found.values()][0] : null;
    },
    unbound: (node, name) => binding(scopes.get(node.id) ?? globalScope, name) === undefined,
  };
}
function localBinding(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (FUNCTION_NODES.has(parent.type)) return true;
    if (CLASS_NODES.has(parent.type)) return false;
  }
  return false;
}
function member(node: Node | null): { object: Node | null; name: string | null } | null {
  node = unwrap(node);
  if (!node) return null;
  if (["member_expression", "attribute"].includes(node.type)) {
    return { object: node.childForFieldName("object"), name: identifier(node.childForFieldName("property")
      ?? node.childForFieldName("attribute")) };
  }
  if (["subscript_expression", "subscript"].includes(node.type)) {
    return { object: node.childForFieldName("object") ?? node.childForFieldName("value"),
      name: literal(node.childForFieldName("index") ?? node.childForFieldName("subscript")) };
  }
  return null;
}

/** One AST walk emits scoped possibilities, never file-wide text matches. */
export function collectSymbolEvidence(root: Node, structure: StructuralAnalysis, language: string): SymbolEvidence {
  const possible: PossibleSymbol[] = [];
  const isJS = ["javascript", "typescript", "tsx"].includes(language);
  const isRuby = language === "ruby";
  const isPython = language === "python";
  const knownClasses = new Set(structure.classes.map(cls => cls.name));
  const resolveClass = classReferences(root, language);
  const functions: SymbolEvidence["functions"] = [];
  const matchedFunctions = new Set<number>();
  const classScopes = new Map<string, string | null>();
  const handledReferences = new Set<number>();
  const add = (node: Node, owner: string | null, name: string | null, reason: string,
    kind: PossibleSymbol["kind"] = "callable", nameSuffix?: string) => {
    possible.push({ kind, owner, name, ...(nameSuffix ? { nameSuffix } : {}),
      lineRange: [node.startPosition.row + 1, node.endPosition.row + 1], reason });
  };
  const consume = (node: Node | null) => {
    if (!node) return;
    const pending = [node];
    while (pending.length) { const item = pending.pop()!; handledReferences.add(item.id); pending.push(...item.namedChildren); }
  };
  const targetOwner = (target: Node | null, context: Node): string | null => {
    target = unwrap(target);
    const name = identifier(target);
    if (name && knownClasses.has(name)) return resolveClass.owner(target!, name);
    if (target && ["self", "this"].includes(target.text)) return lexicalOwner(context) || null;
    const access = member(target);
    if (access?.name === "prototype" || access?.name === "__dict__") return targetOwner(access.object, context);
    return null;
  };
  const objectKeys = (object: Node | undefined, owner: string | null, context: Node) => {
    if (!object || !["object", "dictionary"].includes(object.type)) {
      add(context, owner, null, "Unresolved property descriptor collection", null); return;
    }
    for (const field of object.namedChildren) {
      const key = field.childForFieldName("key") ?? field.childForFieldName("name")
        ?? (field.type === "shorthand_property_identifier" ? field : null);
      const computed = key?.type === "computed_property_name";
      add(field, owner, computed ? literal(key.namedChildren[0]) : declarationName(key), "Runtime property definition", null);
    }
  };
  const visit = (node: Node) => {
    const owner = lexicalOwner(node);
    const declared = node.childForFieldName("name");
    const declaredName = declared?.type === "computed_property_name" ? literal(declared.namedChildren[0]) : declarationName(declared);
    const objectMethod = isJS && node.type === "method_definition" && node.parent?.type === "object";
    const localDeclaration = FUNCTION_NODES.has(node.type) && localBinding(node);
    if (isJS && classExpression(node)) {
      add(node, "", expressionOwner(node), "Unextracted class expression", "class");
    }
    if (isJS && node.type === "method_definition" && node.parent?.parent && classExpression(node.parent.parent)) {
      add(node, owner, declaredName, "Unextracted class expression method");
    }
    if (node !== root && CLASS_NODES.has(node.type) && declaredName) {
      let qualifiedScope = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (["namespace_definition", "namespace_declaration"].includes(parent.type)) qualifiedScope = true;
      }
      // Some extractors omit namespace qualification in class records while
      // preserving it on out-of-class methods. Do not assert incompatible scopes.
      classScopes.set(JSON.stringify([declaredName, node.startPosition.row + 1, node.endPosition.row + 1]), qualifiedScope ? null : declaredName);
    }
    if (FUNCTION_NODES.has(node.type) && !objectMethod && !localDeclaration) {
      const name = declaredName ?? (["arrow_function", "function_expression"].includes(node.type)
        ? identifier(node.parent?.childForFieldName("name")) : null);
      const matches = structure.functions.map((fn, index) => ({ fn, index })).filter(({ fn }) => fn.owner === undefined
        && (fn.name === name || node.type === "singleton_method" && fn.name === `self.${name}`)
        && fn.lineRange[0] === node.startPosition.row + 1 && fn.lineRange[1] === node.endPosition.row + 1);
      if (matches.length) {
        let scope = localBinding(node) ? null : owner;
        if (node.type === "singleton_method") {
          const receiver = node.childForFieldName("object") ?? node.childForFieldName("receiver");
          scope = receiver?.text === "self" ? owner : targetOwner(receiver, node);
        }
        functions.push({ name: matches[0].fn.name, owner: scope,
          lineRange: [node.startPosition.row + 1, node.endPosition.row + 1] });
        for (const { index } of matches) matchedFunctions.add(index);
      }
    }
    // Escaped/opaque declaration spellings cannot establish absence. Ordinary
    // identifiers, references and string literals do not imply declarations.
    if (declared && !objectMethod && !localDeclaration && (CLASS_NODES.has(node.type) || FUNCTION_NODES.has(node.type))
      && declaredName === null) {
      add(declared, CLASS_NODES.has(node.type) ? "" : owner, null, "Unresolved declaration name",
        CLASS_NODES.has(node.type) ? "class" : "callable");
    }
    if (owner === null && !objectMethod && !localDeclaration && FUNCTION_NODES.has(node.type) && declaredName !== null) {
      add(node, null, declaredName, "Unresolved declaring type");
    }
    if (isJS && !objectMethod && node.type === "method_definition" && declared?.type === "string") {
      add(node, owner, literal(declared), "Quoted method declaration");
    }
    if (isJS && ["public_field_definition", "field_definition", "method_signature", "abstract_method_signature"].includes(node.type)) {
      const name = node.childForFieldName("name");
      add(node, owner, name?.type === "computed_property_name" ? literal(name.namedChildren[0]) : declarationName(name),
        "Class member not verified by structural extraction");
    }
    if (isJS && node.type === "computed_property_name" && node.parent?.type === "method_definition"
      && node.parent.parent?.type === "class_body") {
      add(node, owner, literal(node.namedChildren[0]), "Computed method declaration");
    }
    if ((isJS || isPython) && ["assignment_expression", "augmented_assignment_expression", "assignment", "augmented_assignment",
      "variable_declarator"].includes(node.type)) {
      const target = node.childForFieldName("left") ?? node.childForFieldName("name");
      const inspect = (part: Node) => {
        const access = member(part);
        if (access) {
          if (isJS && access.name === "prototype") objectKeys(node.childForFieldName("right")
            ?? node.childForFieldName("value") ?? undefined, targetOwner(access.object, node), node);
          else add(part, targetOwner(access.object, node), access.name, "Property assignment", null);
        } else if (identifier(part) && !localBinding(node)) {
          add(part, owner, identifier(part), "Binding assignment", null);
        } else if (["object_pattern", "array_pattern", "pair_pattern", "parenthesized_expression"].includes(part.type)) {
          const value = part.childForFieldName("value");
          for (const child of value ? [value] : part.namedChildren) inspect(child);
        }
      };
      if (target) inspect(target);
    }
    if (isRuby && node.type === "alias" && declared?.type !== "global_variable") {
      add(node, owner, declarationName(declared), "Ruby alias declaration");
    }
    if (isRuby && node.type === "call") {
      const methodNode = node.childForFieldName("method");
      const method = methodNode?.text;
      const args = [...(node.childForFieldName("arguments")?.namedChildren ?? [])];
      const receiver = node.childForFieldName("receiver");
      const boundOwner = !receiver || receiver.text === "self" ? owner : targetOwner(receiver, node);
      if (method && RUBY_INSTALLERS.has(method)) {
        consume(methodNode);
        if (ACCESSORS.has(method)) {
          let writer = ["attr_writer", "attr_accessor"].includes(method);
          if (method === "attr" && args.length === 2 && ["true", "false"].includes(args[1].type)) writer = args.pop()!.type === "true";
          for (const arg of args) {
            const name = literal(arg);
            if (method !== "attr_writer") add(arg, boundOwner, name, "Ruby accessor reader");
            if (writer) add(arg, boundOwner, name === null ? null : `${name}=`, "Ruby accessor writer", "callable", name === null ? "=" : undefined);
          }
        } else if (args.length) {
          const name = literal(args[0]);
          add(node, boundOwner, method === "define_singleton_method" && name !== null ? `self.${name}` : name, "Ruby method installer");
        }
      } else if (method && ["method", "public_method", "instance_method", "public_instance_method", "singleton_method"].includes(method) && args.length) {
        const name = literal(args[0]);
        if (name === null || RUBY_INSTALLERS.has(name)) add(node, method.includes("instance_method") ? null : boundOwner, null, "Indirect method installer");
      } else if (method && EVALUATORS.has(method)) {
        consume(methodNode); add(node, null, null, "Dynamic dispatch or code evaluation", null);
      }
    }
    if ((isJS && node.type === "call_expression") || (isPython && node.type === "call")) {
      const callee = unwrap(node.childForFieldName("function"));
      const access = member(callee);
      const method = access?.name ?? identifier(callee);
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const directInstaller = method && (isJS ? JS_INSTALLERS.has(method) || method === "set"
        && access?.object?.text === "Reflect" : PY_INSTALLERS.has(method));
      if (directInstaller) {
        consume(callee);
        const namespace = access?.object;
        const standard = isJS
          ? namespace && resolveClass.unbound(namespace, namespace.text)
            && (namespace.text === "Object" && ["defineProperty", "defineProperties"].includes(method)
              || namespace.text === "Reflect" && ["defineProperty", "set"].includes(method))
          : !access && method === "setattr" && resolveClass.unbound(callee!, method);
        if (!standard) add(node, null, null, "Runtime installer identity is unresolved", null);
        else if (method === "defineProperties") objectKeys(args[1], targetOwner(args[0] ?? null, node), node);
        else add(node, targetOwner(args[0] ?? null, node), literal(args[1]), "Runtime property definition", null);
      } else if (isJS && method === "assign" && access?.object?.text === "Object") {
        consume(callee);
        if (!resolveClass.unbound(access.object, "Object")) add(node, null, null, "Runtime installer identity is unresolved", null);
        else for (const arg of args.slice(1)) objectKeys(arg, targetOwner(args[0] ?? null, node), node);
      } else if (method && ((isJS ? JS_EVALUATORS : PY_EVALUATORS).has(method) || isPython && method === "type" && args.length >= 3)) {
        consume(callee); add(node, null, null, "Dynamic code or class evaluation", null);
      } else if (access && access.name === null) {
        consume(callee); add(node, null, null, "Computed callee may select a runtime installer", null);
      }
    }
    // References to installers may escape through aliases. Direct calls were
    // already consumed and retain their more precise target/name evidence.
    if (!handledReferences.has(node.id)) {
      const access = member(node);
      if (isJS && access?.object?.text === "Reflect" && resolveClass.unbound(access.object, "Reflect")
        && ["get", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "isExtensible"].includes(access.name ?? "")) {
        consume(node);
      } else if (isJS && access && (access.name !== null && JS_INSTALLERS.has(access.name)
        || access.object?.text === "Object" && (access.name === "assign" || access.name === null))) {
        consume(node); add(node, null, null, "Aliased property installer", null);
      } else if (isPython && access?.name === "__dict__") {
        consume(node); add(node, targetOwner(access.object, node), null, "Indirect attribute dictionary", null);
      } else if (node.type === "identifier" && node.parent?.childForFieldName("name")?.id !== node.id
        && (isJS && (JS_INSTALLERS.has(node.text) || node.text === "Reflect" || JS_EVALUATORS.has(node.text))
        || isPython && (PY_INSTALLERS.has(node.text) || ["exec", "eval", "globals", "locals", "vars"].includes(node.text)))) {
        add(node, null, null, "Aliased runtime installer or evaluation", null);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  if (!isJS && !isRuby && !isPython) {
    // A callable may become an unextracted function-valued field. Retain the
    // extractor's property inventory as scoped possibilities, without treating
    // arbitrary identifier/string uses as declarations.
    for (const cls of structure.classes) for (const name of cls.properties) {
      possible.push({ kind: "callable", owner: classScopes.get(JSON.stringify([cls.name, ...cls.lineRange])) ?? null,
        name: unescaped(name) ? name : null, lineRange: cls.lineRange, reason: "Property callability is not structurally verified" });
    }
  }
  for (const [index, fn] of structure.functions.entries()) {
    if (fn.owner === undefined && !matchedFunctions.has(index)) functions.push({ name: fn.name, owner: null, lineRange: fn.lineRange });
  }
  for (const fn of [...structure.functions, ...functions]) {
    // The C++ extractor can leave nested qualification in the function name
    // (N::A::run -> owner N, name A::run). That decomposition cannot prove
    // an inline A.run disappeared when its definition moved out of class.
    if (language === "cpp" && fn.name.includes("::")) possible.push({ kind: "callable", owner: null,
      name: fn.name.split("::").at(-1) ?? null, lineRange: fn.lineRange,
      reason: "Unverified compound C++ qualification" });
    if (fn.owner === null) possible.push({ kind: "callable", owner: null, name: fn.name,
      lineRange: fn.lineRange, reason: "Unresolved source receiver ownership" });
  }
  return { version: 1, possible, functions };
}
