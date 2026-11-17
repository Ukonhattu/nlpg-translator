/**
 * Small C helper functions that generated programs use for Python-like
 * features (strings, input, dynamic lists). Code generation records which
 * helpers it calls; only those (and their dependencies) are emitted, in
 * dependency order. All names start with `nl_` / `Nl`, which the identifier
 * policy keeps free for these helpers.
 *
 * Memory is allocated and never freed: generated programs are short-running
 * exercises and the operating system reclaims everything at exit.
 */

export type Helper = {
  includes: string[];
  deps: string[];
  code: string;
};

export type ListElem = "int" | "double" | "bool" | "str";

export const LIST_ELEMS: readonly ListElem[] = ["int", "double", "bool", "str"];

export function listElemCType(elem: ListElem): string {
  return elem === "str" ? "const char *" : elem;
}

export function listTypeName(elem: ListElem): string {
  return `NlList${elem === "str" ? "Str" : elem[0].toUpperCase() + elem.slice(1)}`;
}

export function listFn(elem: ListElem, op: string): string {
  return `nl_list_${elem}_${op}`;
}

const BASE: Record<string, Helper> = {
  fail: {
    includes: ["stdio.h", "stdlib.h"],
    deps: [],
    code: `/* Stops the program with an error message (like an uncaught Python exception). */
static void nl_fail(const char *message) {
    fprintf(stderr, "Error: %s\\n", message);
    exit(1);
}`,
  },
  alloc: {
    includes: ["stdlib.h"],
    deps: ["fail"],
    code: `/* Memory is never freed: the operating system reclaims it when the program ends. */
static void *nl_alloc(size_t size) {
    void *memory = malloc(size);
    if (memory == NULL) {
        nl_fail("out of memory");
    }
    return memory;
}`,
  },
  input: {
    includes: ["stdio.h", "stdlib.h"],
    deps: ["alloc"],
    code: `/* Prints the prompt and reads one line from standard input (without the newline). */
static char *nl_input(const char *prompt) {
    size_t capacity = 64;
    size_t length = 0;
    char *line = nl_alloc(capacity);
    int ch;
    fputs(prompt, stdout);
    fflush(stdout);
    while ((ch = getchar()) != EOF && ch != '\\n') {
        if (length + 1 == capacity) {
            capacity *= 2;
            line = realloc(line, capacity);
            if (line == NULL) {
                nl_fail("out of memory");
            }
        }
        line[length++] = (char)ch;
    }
    line[length] = '\\0';
    return line;
}`,
  },
  str_to_int: {
    includes: ["stdlib.h", "ctype.h"],
    deps: ["fail"],
    code: `/* Converts text to an int, like Python's int(text). */
static int nl_str_to_int(const char *text) {
    char *end;
    long value = strtol(text, &end, 10);
    if (end == text) {
        nl_fail("invalid literal for int()");
    }
    while (isspace((unsigned char)*end)) {
        end++;
    }
    if (*end != '\\0') {
        nl_fail("invalid literal for int()");
    }
    return (int)value;
}`,
  },
  str_to_double: {
    includes: ["stdlib.h", "ctype.h"],
    deps: ["fail"],
    code: `/* Converts text to a double, like Python's float(text). */
static double nl_str_to_double(const char *text) {
    char *end;
    double value = strtod(text, &end);
    if (end == text) {
        nl_fail("could not convert string to float");
    }
    while (isspace((unsigned char)*end)) {
        end++;
    }
    if (*end != '\\0') {
        nl_fail("could not convert string to float");
    }
    return value;
}`,
  },
  format: {
    includes: ["stdio.h", "stdarg.h"],
    deps: ["alloc"],
    code: `/* Like printf, but returns the text as a new string. */
static char *nl_format(const char *format, ...) {
    va_list args;
    int size;
    char *text;
    va_start(args, format);
    size = vsnprintf(NULL, 0, format, args);
    va_end(args);
    text = nl_alloc((size_t)size + 1);
    va_start(args, format);
    vsnprintf(text, (size_t)size + 1, format, args);
    va_end(args);
    return text;
}`,
  },
  int_to_str: {
    includes: [],
    deps: ["format"],
    code: `static char *nl_int_to_str(int value) {
    return nl_format("%d", value);
}`,
  },
  double_to_str: {
    includes: [],
    deps: ["format"],
    code: `static char *nl_double_to_str(double value) {
    return nl_format("%g", value);
}`,
  },
  str_concat: {
    includes: ["string.h"],
    deps: ["alloc"],
    code: `/* Joins two strings into a new string. */
static char *nl_str_concat(const char *left, const char *right) {
    size_t left_length = strlen(left);
    size_t right_length = strlen(right);
    char *result = nl_alloc(left_length + right_length + 1);
    memcpy(result, left, left_length);
    memcpy(result + left_length, right, right_length + 1);
    return result;
}`,
  },
  str_repeat: {
    includes: ["string.h"],
    deps: ["alloc"],
    code: `/* The string repeated count times, like Python's text * count. */
static char *nl_str_repeat(const char *text, int count) {
    size_t length = strlen(text);
    size_t total = count > 0 ? length * (size_t)count : 0;
    char *result = nl_alloc(total + 1);
    for (int i = 0; i < count; i++) {
        memcpy(result + length * (size_t)i, text, length);
    }
    result[total] = '\\0';
    return result;
}`,
  },
  str_char_at: {
    includes: ["string.h"],
    deps: ["alloc", "fail"],
    code: `/* The character at index (negative counts from the end) as a new string. */
static char *nl_str_char_at(const char *text, int index) {
    int length = (int)strlen(text);
    char *result;
    if (index < 0) {
        index += length;
    }
    if (index < 0 || index >= length) {
        nl_fail("string index out of range");
    }
    result = nl_alloc(2);
    result[0] = text[index];
    result[1] = '\\0';
    return result;
}`,
  },
  str_copy: {
    includes: ["string.h"],
    deps: ["alloc"],
    code: `static char *nl_str_copy(const char *text) {
    size_t length = strlen(text);
    char *result = nl_alloc(length + 1);
    memcpy(result, text, length + 1);
    return result;
}`,
  },
  str_upper: {
    includes: ["ctype.h"],
    deps: ["str_copy"],
    code: `static char *nl_str_upper(const char *text) {
    char *result = nl_str_copy(text);
    for (char *p = result; *p != '\\0'; p++) {
        *p = (char)toupper((unsigned char)*p);
    }
    return result;
}`,
  },
  str_lower: {
    includes: ["ctype.h"],
    deps: ["str_copy"],
    code: `static char *nl_str_lower(const char *text) {
    char *result = nl_str_copy(text);
    for (char *p = result; *p != '\\0'; p++) {
        *p = (char)tolower((unsigned char)*p);
    }
    return result;
}`,
  },
  str_capitalize: {
    includes: ["ctype.h"],
    deps: ["str_lower"],
    code: `/* First character upper case, the rest lower case. */
static char *nl_str_capitalize(const char *text) {
    char *result = nl_str_lower(text);
    result[0] = (char)toupper((unsigned char)result[0]);
    return result;
}`,
  },
  str_strip_sides: {
    includes: ["ctype.h", "string.h"],
    deps: ["alloc"],
    code: `/* Removes whitespace from the start and/or end of the text. */
static char *nl_str_strip_sides(const char *text, int left, int right) {
    const char *start = text;
    const char *end = text + strlen(text);
    char *result;
    while (left && start < end && isspace((unsigned char)*start)) {
        start++;
    }
    while (right && end > start && isspace((unsigned char)end[-1])) {
        end--;
    }
    result = nl_alloc((size_t)(end - start) + 1);
    memcpy(result, start, (size_t)(end - start));
    result[end - start] = '\\0';
    return result;
}`,
  },
  str_strip: {
    includes: [],
    deps: ["str_strip_sides"],
    code: `static char *nl_str_strip(const char *text) {
    return nl_str_strip_sides(text, 1, 1);
}`,
  },
  str_lstrip: {
    includes: [],
    deps: ["str_strip_sides"],
    code: `static char *nl_str_lstrip(const char *text) {
    return nl_str_strip_sides(text, 1, 0);
}`,
  },
  str_rstrip: {
    includes: [],
    deps: ["str_strip_sides"],
    code: `static char *nl_str_rstrip(const char *text) {
    return nl_str_strip_sides(text, 0, 1);
}`,
  },
  str_replace: {
    includes: ["string.h"],
    deps: ["alloc", "str_copy"],
    code: `/* Replaces every occurrence of old with replacement. */
static char *nl_str_replace(const char *text, const char *old, const char *replacement) {
    size_t old_length = strlen(old);
    size_t new_length = strlen(replacement);
    size_t count = 0;
    const char *p;
    char *result;
    char *out;
    if (old_length == 0) {
        return nl_str_copy(text);
    }
    for (p = strstr(text, old); p != NULL; p = strstr(p + old_length, old)) {
        count++;
    }
    result = nl_alloc(strlen(text) - count * old_length + count * new_length + 1);
    out = result;
    while ((p = strstr(text, old)) != NULL) {
        memcpy(out, text, (size_t)(p - text));
        out += p - text;
        memcpy(out, replacement, new_length);
        out += new_length;
        text = p + old_length;
    }
    strcpy(out, text);
    return result;
}`,
  },
  str_startswith: {
    includes: ["string.h", "stdbool.h"],
    deps: [],
    code: `static bool nl_str_startswith(const char *text, const char *prefix) {
    return strncmp(text, prefix, strlen(prefix)) == 0;
}`,
  },
  str_endswith: {
    includes: ["string.h", "stdbool.h"],
    deps: [],
    code: `static bool nl_str_endswith(const char *text, const char *suffix) {
    size_t text_length = strlen(text);
    size_t suffix_length = strlen(suffix);
    return suffix_length <= text_length &&
           strcmp(text + text_length - suffix_length, suffix) == 0;
}`,
  },
  max_int: {
    includes: [],
    deps: [],
    code: `static int nl_max_int(int a, int b) {
    return a > b ? a : b;
}`,
  },
  min_int: {
    includes: [],
    deps: [],
    code: `static int nl_min_int(int a, int b) {
    return a < b ? a : b;
}`,
  },
  max_double: {
    includes: [],
    deps: [],
    code: `static double nl_max_double(double a, double b) {
    return a > b ? a : b;
}`,
  },
  min_double: {
    includes: [],
    deps: [],
    code: `static double nl_min_double(double a, double b) {
    return a < b ? a : b;
}`,
  },
};

/** Dynamic-array helpers for one element type, generated from a template. */
function listHelpers(elem: ListElem): Record<string, Helper> {
  const T = listElemCType(elem);
  const L = listTypeName(elem);
  const f = (op: string) => listFn(elem, op);
  const vaType = elem === "double" ? "double" : elem === "str" ? "const char *" : "int";
  const vaRead = elem === "bool" ? "va_arg(args, int) != 0" : `va_arg(args, ${vaType})`;
  const equals = elem === "str" ? "strcmp(list->items[i], value) == 0" : "list->items[i] == value";
  const key = (op: string) => `list_${elem}_${op}`;
  /** `T name` with C pointer spacing. */
  const V = (name: string) => (T.endsWith("*") ? `${T}${name}` : `${T} ${name}`);
  const P = (name: string) => `${T}${T.endsWith("*") ? "" : " "}*${name}`;
  const numeric = elem === "int" || elem === "double";
  const helpers: Record<string, Helper> = {
    [key("type")]: {
      includes: elem === "bool" ? ["stdbool.h"] : [],
      deps: [],
      code: `/* A growable list of ${elem === "str" ? "strings" : `${elem} values`} (like a Python list). */
typedef struct {
    ${P("items")};
    int len;
    int capacity;
} ${L};`,
    },
    [key("new")]: {
      includes: [],
      deps: [key("type"), "alloc"],
      code: `static ${L} *${f("new")}(void) {
    ${L} *list = nl_alloc(sizeof *list);
    list->items = NULL;
    list->len = 0;
    list->capacity = 0;
    return list;
}`,
    },
    [key("append")]: {
      includes: ["stdlib.h"],
      deps: [key("type"), "fail"],
      code: `static void ${f("append")}(${L} *list, ${V("value")}) {
    if (list->len == list->capacity) {
        list->capacity = list->capacity == 0 ? 4 : list->capacity * 2;
        list->items = realloc(list->items, (size_t)list->capacity * sizeof *list->items);
        if (list->items == NULL) {
            nl_fail("out of memory");
        }
    }
    list->items[list->len] = value;
    list->len++;
}`,
    },
    [key("position")]: {
      includes: [],
      deps: [key("type"), "fail"],
      code: `/* Checks an index (negative counts from the end) and returns it as a position. */
static int ${f("position")}(const ${L} *list, int index) {
    if (index < 0) {
        index += list->len;
    }
    if (index < 0 || index >= list->len) {
        nl_fail("list index out of range");
    }
    return index;
}`,
    },
    [key("of")]: {
      includes: ["stdarg.h"],
      deps: [key("new"), key("append")],
      code: `/* A new list with count values. */
static ${L} *${f("of")}(int count, ...) {
    ${L} *list = ${f("new")}();
    va_list args;
    va_start(args, count);
    for (int i = 0; i < count; i++) {
        ${f("append")}(list, ${vaRead});
    }
    va_end(args);
    return list;
}`,
    },
    [key("get")]: {
      includes: [],
      deps: [key("position")],
      code: `static ${V(f("get"))}(const ${L} *list, int index) {
    return list->items[${f("position")}(list, index)];
}`,
    },
    [key("set")]: {
      includes: [],
      deps: [key("position")],
      code: `static void ${f("set")}(${L} *list, int index, ${V("value")}) {
    list->items[${f("position")}(list, index)] = value;
}`,
    },
    [key("contains")]: {
      includes: elem === "str" ? ["string.h", "stdbool.h"] : ["stdbool.h"],
      deps: [key("type")],
      code: `static bool ${f("contains")}(const ${L} *list, ${V("value")}) {
    for (int i = 0; i < list->len; i++) {
        if (${equals}) {
            return true;
        }
    }
    return false;
}`,
    },
    [key("pop")]: {
      includes: [],
      deps: [key("type"), "fail"],
      code: `/* Removes and returns the last value. */
static ${V(f("pop"))}(${L} *list) {
    if (list->len == 0) {
        nl_fail("pop from empty list");
    }
    list->len--;
    return list->items[list->len];
}`,
    },
    [key("concat")]: {
      includes: [],
      deps: [key("new"), key("append")],
      code: `/* A new list with the values of both lists. */
static ${L} *${f("concat")}(const ${L} *left, const ${L} *right) {
    ${L} *list = ${f("new")}();
    for (int i = 0; i < left->len; i++) {
        ${f("append")}(list, left->items[i]);
    }
    for (int i = 0; i < right->len; i++) {
        ${f("append")}(list, right->items[i]);
    }
    return list;
}`,
    },
    [key("to_str")]: {
      includes: ["string.h"],
      deps: [key("type"), "format", "str_concat"],
      code: `/* The list as text, e.g. [1, 2, 3]. */
static char *${f("to_str")}(const ${L} *list) {
    char *text = nl_format("[");
    for (int i = 0; i < list->len; i++) {
        text = nl_str_concat(text, nl_format(${
          elem === "str" ? `i > 0 ? ", '%s'" : "'%s'"` : elem === "double" ? `i > 0 ? ", %g" : "%g"` : `i > 0 ? ", %d" : "%d"`
        }, list->items[i]));
    }
    return nl_str_concat(text, "]");
}`,
    },
  };
  if (numeric) {
    helpers[key("sum")] = {
      includes: [],
      deps: [key("type")],
      code: `static ${T} ${f("sum")}(const ${L} *list) {
    ${T} total = 0;
    for (int i = 0; i < list->len; i++) {
        total = total + list->items[i];
    }
    return total;
}`,
    };
    for (const [op, cmp, what] of [["max", ">", "max"], ["min", "<", "min"]] as const) {
      helpers[key(op)] = {
        includes: [],
        deps: [key("type"), "fail"],
        code: `static ${T} ${f(op)}(const ${L} *list) {
    ${T} best;
    if (list->len == 0) {
        nl_fail("${what}() arg is an empty sequence");
    }
    best = list->items[0];
    for (int i = 1; i < list->len; i++) {
        if (list->items[i] ${cmp} best) {
            best = list->items[i];
        }
    }
    return best;
}`,
      };
    }
  }
  return helpers;
}

export const HELPERS: Record<string, Helper> = Object.assign(
  {},
  BASE,
  ...LIST_ELEMS.map(listHelpers)
);

const INCLUDE_ORDER = [
  "assert.h", "ctype.h", "math.h", "stdarg.h", "stdbool.h", "stdio.h", "stdlib.h", "string.h",
];

/** Helper code for the used helpers (dependencies first) and all includes needed. */
export function renderRuntime(
  used: Iterable<string>,
  extraIncludes: Iterable<string>
): { includes: string[]; code: string[] } {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const helper = HELPERS[name];
    if (!helper) throw new Error(`unknown C runtime helper: ${name}`);
    helper.deps.forEach(visit);
    ordered.push(name);
  };
  [...used].sort().forEach(visit);
  const includes = new Set(extraIncludes);
  for (const name of ordered) HELPERS[name].includes.forEach((i) => includes.add(i));
  return {
    includes: INCLUDE_ORDER.filter((i) => includes.has(i)),
    code: ordered.map((name) => HELPERS[name].code),
  };
}
