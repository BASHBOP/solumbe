// Symbol extraction, one set of extractors per language.

export function extractCsharpTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractCsharpFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractCsharpConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractGoTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractGoFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractGoConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractJavaTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractJavaFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractJavaConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractPythonTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractPythonFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractPythonConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRubyTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRubyFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRubyConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRustTypes(source) {
  const definitions = [/\btype\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRustFunctions(source) {
  const definitions = [/\bfunc\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}

export function extractRustConstants(source) {
  const definitions = [/\bconst\s+(\w+)/g];
  const names = [];
  for (const definition of definitions) for (const match of source.matchAll(definition)) names.push(match[1]);
  return names;
}
