import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.(?:ts|mjs|js|json)$/.test(specifier)) return next(specifier + '.ts', context);
    throw error;
  }
}
export async function load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: transpileModule(await readFile(new URL(url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText };
  return next(url, context);
}
