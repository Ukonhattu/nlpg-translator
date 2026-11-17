/**
 * Identifier policy for generated C (C11).
 *
 * Starts from the canonical (Python) identifier so both targets agree on which
 * names are the same variable, then:
 *  - transliterates letters with diacritics to ASCII (määrä -> maara) and drops
 *    any other non-ASCII character,
 *  - appends `_` to C keywords and to the C library names generated code uses,
 *  - prefixes `user_` to names in the runtime's `nl_` / `Nl` namespace.
 */

export const C_KEYWORDS: ReadonlySet<string> = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double",
  "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long",
  "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct",
  "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "_Alignas",
  "_Alignof", "_Atomic", "_Bool", "_Complex", "_Generic", "_Imaginary", "_Noreturn",
  "_Static_assert", "_Thread_local",
  // <stdbool.h>, <assert.h> and other macros
  "bool", "true", "false", "assert", "NULL", "EOF", "errno",
]);

/** Library functions and types the generated program (or its runtime) may use. */
export const C_RESERVED: ReadonlySet<string> = new Set([
  "main", "printf", "fprintf", "puts", "fputs", "putchar", "getchar", "fflush",
  "fgets", "scanf", "stdin", "stdout", "stderr", "malloc", "realloc", "calloc",
  "free", "exit", "abs", "labs", "atoi", "atof", "strtol", "strtod", "strlen",
  "strcmp", "strncmp", "strcpy", "strncpy", "strcat", "strstr", "strchr", "memcpy",
  "memset", "memcmp", "snprintf", "vsnprintf", "sprintf", "fmod", "fabs", "pow",
  "sqrt", "floor", "ceil", "round", "nearbyint", "isspace", "isdigit", "isalpha",
  "toupper", "tolower", "size_t", "va_list", "va_start", "va_arg", "va_end",
  "index",
]);

/**
 * Standard library functions that compilers know as builtins: a global
 * variable or function with one of these names is an error even without the
 * header. Locals may shadow them, so only file-scope names are renamed.
 */
export const C_LIBRARY_NAMES: ReadonlySet<string> = new Set([
  // <math.h>
  "acos", "asin", "atan", "atan2", "cos", "sin", "tan", "cosh", "sinh", "tanh", "exp",
  "exp2", "expm1", "log", "log10", "log2", "log1p", "logb", "pow", "sqrt", "cbrt",
  "hypot", "ceil", "floor", "trunc", "round", "lround", "rint", "nearbyint", "fmod",
  "remainder", "fabs", "fmin", "fmax", "fdim", "fma", "frexp", "ldexp", "modf", "erf",
  "erfc", "tgamma", "lgamma", "copysign", "nan", "signbit", "isnan", "isinf",
  // <stdlib.h>
  "abort", "atexit", "getenv", "system", "qsort", "bsearch", "div", "ldiv", "rand",
  "srand", "atol", "strtoul", "strtoll", "strtof", "strtold",
  // <stdio.h>
  "fopen", "fclose", "fread", "fwrite", "fscanf", "sscanf", "fputc", "fgetc", "getc",
  "putc", "gets", "perror", "remove", "rename", "rewind", "fseek", "ftell", "feof",
  "ferror", "tmpfile", "vprintf", "vfprintf", "vsprintf", "ungetc",
  // <string.h>, <ctype.h>
  "strrchr", "strspn", "strcspn", "strpbrk", "strtok", "strerror", "strncat",
  "strcoll", "strxfrm", "memmove", "memchr", "isupper", "islower", "isalnum",
  "ispunct", "isprint", "iscntrl", "isgraph", "isxdigit", "isblank",
]);

export function toCIdentifier(canonical: string, fileScope = false): string {
  let id = canonical
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  if (!id || /^_*$/.test(id)) return "value";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (/^(nl_|Nl)/i.test(id)) id = `user_${id}`;
  if (C_KEYWORDS.has(id) || C_RESERVED.has(id) || (fileScope && C_LIBRARY_NAMES.has(id))) {
    id = `${id}_`;
  }
  return id;
}
